import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { adminClient } from '../../src/clients/supabase';
import { buildServer } from '../../src/server';
import { resetCacheForTests } from '../../src/services/cache';
import {
  createServiceRoleClient,
  resolveTestSchema,
} from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const createdUserIds = new Set<string>();
const validPassword = 'Correct-horse-battery-staple-39!';

let app: Awaited<ReturnType<typeof buildServer>>;

type TestProfile = {
  handle: string;
  profileId: string;
  userId: string;
};

type InjectResponse = Awaited<ReturnType<typeof app.inject>>;

function uniqueSuffix(): string {
  return crypto.randomUUID().replace(/-/gu, '').slice(0, 10);
}

function uniqueEmail(label: string): string {
  return `og-${schema}-${label}-${uniqueSuffix()}@example.com`;
}

function uniqueHandle(label: string): string {
  return `og_${label}_${uniqueSuffix()}`.slice(0, 30).toLowerCase();
}

function sha(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function pngBuffer(response: InjectResponse): Buffer {
  const withRawPayload = response as InjectResponse & { rawPayload?: Buffer };

  return withRawPayload.rawPayload ?? Buffer.from(response.body, 'binary');
}

function pngMetadata(buffer: Buffer): { width: number; height: number } {
  expect(buffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(buffer.subarray(12, 16).toString('ascii')).toBe('IHDR');

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function bodyOf(response: InjectResponse) {
  return JSON.parse(response.body);
}

function headerValue(response: InjectResponse, name: string): string | undefined {
  const value = response.headers[name.toLowerCase()];

  return Array.isArray(value) ? value[0]?.toString() : value?.toString();
}

async function waitForProfile(userId: string) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { data, error } = await adminClient
      .from('profiles')
      .select('id,user_id,handle')
      .eq('user_id', userId)
      .maybeSingle();

    if (!error && data) {
      return data;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
  }

  throw new Error(`[og-profile-spec] profile shell was not created for user ${userId}`);
}

async function createTestProfile(label: string): Promise<TestProfile> {
  const authAdmin = createServiceRoleClient();
  const email = uniqueEmail(label);
  const handle = uniqueHandle(label);
  const { data, error } = await authAdmin.auth.admin.createUser({
    email,
    password: validPassword,
    email_confirm: true,
    user_metadata: {
      test_schema: schema,
    },
  });

  if (error || !data.user) {
    throw new Error(`[og-profile-spec] createUser failed: ${error?.message ?? 'missing user'}`);
  }

  createdUserIds.add(data.user.id);
  await waitForProfile(data.user.id);

  const { data: updatedProfile, error: updateError } = await adminClient
    .from('profiles')
    .update({
      handle,
      display_name: `OG ${label}`,
      avatar_url: null,
      bio: `OG profile ${label}`,
      x_handle: handle,
      mode: 'script_verified',
      verified: true,
      share_projects: false,
    })
    .eq('user_id', data.user.id)
    .select('id,user_id,handle')
    .single();

  if (updateError || !updatedProfile) {
    throw new Error(`[og-profile-spec] profile update failed: ${updateError?.message ?? 'missing profile'}`);
  }

  return {
    handle: updatedProfile.handle,
    profileId: updatedProfile.id,
    userId: data.user.id,
  };
}

async function seedUsage(profile: TestProfile, tokens = 1_250_000): Promise<void> {
  const now = new Date();
  const firstEventAt = new Date(now.getTime() - 60_000).toISOString();
  const lastEventAt = now.toISOString();
  const fileSha = sha(`${profile.profileId}-${tokens}`);

  const { error: sessionError } = await adminClient
    .from('sessions')
    .insert({
      profile_id: profile.profileId,
      source: 'claude',
      model: 'claude-sonnet',
      session_id: `og-${crypto.randomUUID()}`,
      file_sha256: fileSha,
      first_event_at: firstEventAt,
      last_event_at: lastEventAt,
      input_tokens: tokens,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_create_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      turns: 1,
      ingestion_mode: 'script_verified',
      fingerprint: {},
    });

  if (sessionError) {
    throw new Error(`[og-profile-spec] session seed failed: ${sessionError.message}`);
  }

  const { error: aggregateError } = await adminClient
    .from('daily_aggregates')
    .upsert({
      profile_id: profile.profileId,
      date: lastEventAt.slice(0, 10),
      source: 'claude',
      model: 'claude-sonnet',
      total_tokens: tokens,
      total_sessions: 1,
      derived_cost_usd: tokens * 0.00001,
    });

  if (aggregateError) {
    throw new Error(`[og-profile-spec] aggregate seed failed: ${aggregateError.message}`);
  }
}

async function createProfileWithUsage(label: string, tokens?: number): Promise<TestProfile> {
  const profile = await createTestProfile(label);
  await seedUsage(profile, tokens);

  return profile;
}

async function getOG(path: string, headers?: Record<string, string>) {
  return await app.inject({
    method: 'GET',
    url: path,
    headers,
  });
}

describe('GET /api/og/profile/:handle', () => {
  beforeAll(async () => {
    app = await buildServer({ logger: false });
  });

  beforeEach(() => {
    resetCacheForTests();
  });

  afterAll(async () => {
    await app.close();

    const authAdmin = createServiceRoleClient();
    await Promise.all(Array.from(createdUserIds).map(async (userId) => {
      await authAdmin.auth.admin.deleteUser(userId).catch(() => undefined);
    }));
  });

  it('renders the default variant A PNG with exact dimensions and cache headers', async () => {
    const profile = await createProfileWithUsage('default');
    const response = await getOG(`/api/og/profile/${profile.handle}`);
    const buffer = pngBuffer(response);

    expect(response.statusCode, response.body).toBe(200);
    expect(headerValue(response, 'content-type')).toContain('image/png');
    expect(headerValue(response, 'cache-control')).toBe('public, max-age=3600, stale-while-revalidate=86400');
    expect(headerValue(response, 'etag')).toMatch(/^"[a-f0-9]{64}"$/u);
    expect(pngMetadata(buffer)).toEqual({ width: 1200, height: 630 });
  });

  it('renders variant B as a distinct PNG', async () => {
    const profile = await createProfileWithUsage('variantb');
    const variantA = await getOG(`/api/og/profile/${profile.handle}?v=a`);
    const variantB = await getOG(`/api/og/profile/${profile.handle}?v=b`);

    expect(variantA.statusCode, variantA.body).toBe(200);
    expect(variantB.statusCode, variantB.body).toBe(200);
    expect(headerValue(variantA, 'etag')).not.toBe(headerValue(variantB, 'etag'));
    expect(pngBuffer(variantA).equals(pngBuffer(variantB))).toBe(false);
  });

  it('defaults invalid variants to variant A', async () => {
    const profile = await createProfileWithUsage('invalidv');
    const variantA = await getOG(`/api/og/profile/${profile.handle}?v=a`);
    const invalidVariant = await getOG(`/api/og/profile/${profile.handle}?v=invalid`);

    expect(invalidVariant.statusCode, invalidVariant.body).toBe(200);
    expect(headerValue(invalidVariant, 'etag')).toBe(headerValue(variantA, 'etag'));
    expect(pngBuffer(invalidVariant).equals(pngBuffer(variantA))).toBe(true);
  });

  it('returns 304 when If-None-Match matches the SHA256 content ETag', async () => {
    const profile = await createProfileWithUsage('etag');
    const first = await getOG(`/api/og/profile/${profile.handle}?v=b`);
    const etag = headerValue(first, 'etag');

    expect(first.statusCode, first.body).toBe(200);
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/u);

    const second = await getOG(`/api/og/profile/${profile.handle}?v=b`, {
      'if-none-match': etag ?? '',
    });

    expect(second.statusCode, second.body).toBe(304);
    expect(headerValue(second, 'etag')).toBe(etag);
    expect(second.body).toBe('');
  });

  it('returns 400 for invalid handles', async () => {
    const response = await getOG('/api/og/profile/Invalid.Handle');

    expect(response.statusCode, response.body).toBe(400);
    expect(headerValue(response, 'cache-control')).toBe('no-store');
    expect(bodyOf(response)).toEqual({
      error: {
        code: 'invalid_handle',
        message: 'Handle must be 3-30 lowercase characters',
      },
    });
  });

  it('returns 404 for missing profiles without leaking internals', async () => {
    const response = await getOG(`/api/og/profile/og_missing_${uniqueSuffix().slice(0, 8)}`);

    expect(response.statusCode, response.body).toBe(404);
    expect(headerValue(response, 'cache-control')).toBe('no-store');
    expect(bodyOf(response).error).toEqual(expect.objectContaining({
      code: 'profile_not_found',
      message: 'Profile not found',
    }));
    expect(response.body).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(response.body).not.toContain('service_role');
  });

  it('serves warm cached OG images under the 50ms p95 target', async () => {
    const profile = await createProfileWithUsage('perf', 2_500_000);
    const warmup = await getOG(`/api/og/profile/${profile.handle}?v=b`);

    expect(warmup.statusCode, warmup.body).toBe(200);

    const durations: number[] = [];

    for (let index = 0; index < 8; index += 1) {
      const startedAt = performance.now();
      const response = await getOG(`/api/og/profile/${profile.handle}?v=b`);
      durations.push(performance.now() - startedAt);
      expect(response.statusCode, response.body).toBe(200);
      expect(headerValue(response, 'x-tokensrank-cache')).toBe('HIT');
    }

    const sorted = [...durations].sort((left, right) => left - right);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;

    expect(p95).toBeLessThan(50);
  });
});
