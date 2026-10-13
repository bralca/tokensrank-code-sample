import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProfileResponseSchema } from '@tokensrank/shared';

import { adminClient } from '../../src/clients/supabase';
import { buildServer } from '../../src/server';
import {
  createDisposableAnonClient,
  createServiceRoleClient,
  resolveTestSchema,
} from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const createdUserIds = new Set<string>();
const validPassword = 'Correct-horse-battery-staple-39!';

let app: Awaited<ReturnType<typeof buildServer>>;
let originalCacheTtlSeconds: string | undefined;

type TestProfile = {
  accessToken: string;
  email: string;
  handle: string;
  profileId: string;
  userId: string;
};

type SeedSessionOptions = {
  daysAgo: number;
  fileLabel: string;
  model?: string;
  source?: 'claude' | 'codex';
  tokens?: number;
};

function uniqueSuffix(): string {
  return `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function uniqueEmail(label: string): string {
  const safeLabel = label.replace(/[^a-z0-9_]/giu, '_').slice(0, 16);

  return `profile-get-${schema}-${safeLabel}-${uniqueSuffix()}@example.com`;
}

function uniqueHandle(label: string): string {
  const safeLabel = label.replace(/[^a-z0-9_]/giu, '_').slice(0, 10);

  return `pg_${safeLabel}_${crypto.randomUUID().slice(0, 8)}`.slice(0, 30).toLowerCase();
}

function sha(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isoDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

function bodyOf(response: Awaited<ReturnType<typeof getProfile>>) {
  return JSON.parse(response.body);
}

function cacheHeader(response: Awaited<ReturnType<typeof getProfile>>): string | undefined {
  const header = response.headers['x-tokensrank-cache'];

  return Array.isArray(header) ? header[0] : header?.toString();
}

function authHeaders(profile: TestProfile): Record<string, string> {
  return {
    authorization: `Bearer ${profile.accessToken}`,
  };
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

  throw new Error(`[profile-get-spec] profile shell was not created for user ${userId}`);
}

async function createTestProfile(label: string, shareProjects: boolean): Promise<TestProfile> {
  const authAdmin = createServiceRoleClient();
  const anon = createDisposableAnonClient(schema);
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
    throw new Error(`[profile-get-spec] createUser failed: ${error?.message ?? 'missing user'}`);
  }

  createdUserIds.add(data.user.id);
  await waitForProfile(data.user.id);

  const { data: updatedProfile, error: updateError } = await adminClient
    .from('profiles')
    .update({
      handle,
      display_name: `Display ${label}`,
      avatar_url: null,
      bio: `Bio ${label}`,
      x_handle: handle,
      mode: 'script_verified',
      verified: true,
      share_projects: shareProjects,
    })
    .eq('user_id', data.user.id)
    .select('id,user_id,handle')
    .single();

  if (updateError || !updatedProfile) {
    throw new Error(`[profile-get-spec] profile update failed: ${updateError?.message ?? 'missing profile'}`);
  }

  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({
    email,
    password: validPassword,
  });

  if (signInError || !signInData.session) {
    throw new Error(`[profile-get-spec] signIn failed: ${signInError?.message ?? 'missing session'}`);
  }

  return {
    accessToken: signInData.session.access_token,
    email,
    handle: updatedProfile.handle,
    profileId: updatedProfile.id,
    userId: data.user.id,
  };
}

async function seedSession(profileId: string, options: SeedSessionOptions) {
  const lastEventAt = isoDaysAgo(options.daysAgo);
  const firstEventAt = new Date(new Date(lastEventAt).getTime() - 60_000).toISOString();
  const tokens = options.tokens ?? 100;
  const source = options.source ?? 'claude';
  const model = options.model ?? 'claude-sonnet';
  const fileSha = sha(`${profileId}-${options.fileLabel}`);

  const { error: sessionError } = await adminClient
    .from('sessions')
    .insert({
      profile_id: profileId,
      source,
      model,
      session_id: `${options.fileLabel}-${crypto.randomUUID()}`,
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
      fingerprint: {
        project_name: options.fileLabel,
      },
    });

  if (sessionError) {
    throw new Error(`[profile-get-spec] session seed failed: ${sessionError.message}`);
  }

  const { error: aggregateError } = await adminClient
    .from('daily_aggregates')
    .upsert({
      profile_id: profileId,
      date: lastEventAt.slice(0, 10),
      source,
      model,
      total_tokens: tokens,
      total_sessions: 1,
      derived_cost_usd: tokens * 0.00001,
    });

  if (aggregateError) {
    throw new Error(`[profile-get-spec] aggregate seed failed: ${aggregateError.message}`);
  }
}

async function seedProfileUsage(profile: TestProfile) {
  await seedSession(profile.profileId, {
    daysAgo: 1,
    fileLabel: 'app',
    tokens: 100,
    source: 'claude',
    model: 'claude-sonnet',
  });
  await seedSession(profile.profileId, {
    daysAgo: 10,
    fileLabel: 'api',
    tokens: 200,
    source: 'codex',
    model: 'gpt-5-codex',
  });
  await seedSession(profile.profileId, {
    daysAgo: 45,
    fileLabel: 'archive',
    tokens: 300,
    source: 'claude',
    model: 'claude-opus',
  });
}

async function seedAccessKey(profileId: string) {
  const plaintext = `tr_script_${crypto.randomBytes(24).toString('base64url')}`;
  const { data, error } = await adminClient
    .from('access_keys')
    .insert({
      profile_id: profileId,
      key_sha256: sha(plaintext),
      key_prefix: plaintext.slice(0, 11),
      scope: 'script',
      label: 'profile get integration key',
    })
    .select('id,key_prefix')
    .single();

  if (error || !data) {
    throw new Error(`[profile-get-spec] access key seed failed: ${error?.message ?? 'missing row'}`);
  }

  return data;
}

async function seedIngestionRun(profileId: string, daysAgo = 1) {
  const startedAt = isoDaysAgo(daysAgo);
  const finishedAt = new Date(new Date(startedAt).getTime() + 30_000).toISOString();
  const { data, error } = await adminClient
    .from('ingestion_runs')
    .insert({
      profile_id: profileId,
      started_at: startedAt,
      finished_at: finishedAt,
      status: 'completed',
      ingestion_mode: 'script_verified',
      session_count: 1,
      duplicate_count: 0,
      rejected_count: 0,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`[profile-get-spec] ingestion run seed failed: ${error?.message ?? 'missing row'}`);
  }

  return data;
}

async function getProfile(
  handle: string,
  query = '',
  headers: Record<string, string> = {},
) {
  return await app.inject({
    method: 'GET',
    url: `/api/profile/${handle}${query}`,
    headers,
  });
}

function parseProfileResponse(response: Awaited<ReturnType<typeof getProfile>>) {
  expect(response.statusCode, response.body).toBe(200);
  const body = bodyOf(response);

  return ProfileResponseSchema.parse(body);
}

function projectNames(body: ReturnType<typeof parseProfileResponse>): string[] {
  return [
    ...body.tools.items.map((item) => item.project_name),
    ...body.sessions.items.map((item) => item.project_name),
    ...body.at_glance.project_breakdown.map((item) => item.project_name),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

beforeAll(async () => {
  originalCacheTtlSeconds = process.env.CACHE_TTL_SECONDS;
  process.env.CACHE_TTL_SECONDS = '5';
  app = await buildServer({
    logger: false,
  });
  await app.ready();
});

beforeEach(() => {
  app.cache.purgeAll();
});

afterAll(async () => {
  await app?.close();

  if (originalCacheTtlSeconds === undefined) {
    delete process.env.CACHE_TTL_SECONDS;
  } else {
    process.env.CACHE_TTL_SECONDS = originalCacheTtlSeconds;
  }

  const authAdmin = createServiceRoleClient();

  for (const userId of createdUserIds) {
    await authAdmin.auth.admin.deleteUser(userId);
  }
});

describe('GET /api/profile/:handle', () => {
  it('variant 1: hides project names from a public viewer when share_projects=false', async () => {
    const profile = await createTestProfile('public_hidden', false);
    await seedProfileUsage(profile);

    const body = parseProfileResponse(await getProfile(profile.handle, '?window=all'));

    expect(body.variant).toBe('public_share_false');
    expect(projectNames(body)).toEqual([]);
    expect(body.access_keys).toEqual([]);
    expect(body.last_sync_at).toBeNull();
    expect(body.sync_status).toBeNull();
  });

  it('variant 2: shows project breakdown to a public viewer when share_projects=true', async () => {
    const profile = await createTestProfile('public_shared', true);
    await seedProfileUsage(profile);

    const body = parseProfileResponse(await getProfile(profile.handle, '?window=all'));

    expect(body.variant).toBe('public_share_true');
    expect(projectNames(body)).toEqual(expect.arrayContaining(['app', 'api', 'archive']));
    expect(body.access_keys).toEqual([]);
  });

  it('variant 3: shows owner fields but hides projects for owner when share_projects=false', async () => {
    const profile = await createTestProfile('owner_hidden', false);
    await seedProfileUsage(profile);
    const key = await seedAccessKey(profile.profileId);
    await seedIngestionRun(profile.profileId);

    const body = parseProfileResponse(await getProfile(profile.handle, '?window=all', authHeaders(profile)));

    expect(body.variant).toBe('owner_share_false');
    expect(projectNames(body)).toEqual([]);
    expect(body.access_keys[0]).toMatchObject({ key_id: key.id, key_prefix: key.key_prefix });
    expect(body.last_sync_at).not.toBeNull();
    expect(body.sync_status).toBe('SYNCED');
  });

  it('variant 4: shows owner fields and project names for owner when share_projects=true', async () => {
    const profile = await createTestProfile('owner_shared', true);
    await seedProfileUsage(profile);
    await seedAccessKey(profile.profileId);
    await seedIngestionRun(profile.profileId);

    const body = parseProfileResponse(await getProfile(profile.handle, '?window=all', authHeaders(profile)));

    expect(body.variant).toBe('owner_share_true');
    expect(body.access_keys).toHaveLength(1);
    expect(projectNames(body)).toEqual(expect.arrayContaining(['app', 'api', 'archive']));
  });

  it('caches 7d and 30d windows as separate entries', async () => {
    const profile = await createTestProfile('cache_windows', false);
    await seedProfileUsage(profile);

    const first7d = await getProfile(profile.handle, '?window=7d');
    const second7d = await getProfile(profile.handle, '?window=7d');
    const first30d = await getProfile(profile.handle, '?window=30d');

    expect(cacheHeader(first7d)).toBe('MISS');
    expect(cacheHeader(second7d)).toBe('HIT');
    expect(cacheHeader(first30d)).toBe('MISS');
    expect(parseProfileResponse(first7d).headline.tokens_total).toBe(100);
    expect(parseProfileResponse(first30d).headline.tokens_total).toBe(300);
  });

  it('filters token totals by 7d, 30d, and all windows', async () => {
    const profile = await createTestProfile('window_filter', false);
    await seedProfileUsage(profile);

    const seven = parseProfileResponse(await getProfile(profile.handle, '?window=7d'));
    const thirty = parseProfileResponse(await getProfile(profile.handle, '?window=30d'));
    const all = parseProfileResponse(await getProfile(profile.handle, '?window=all'));

    expect(seven.headline.tokens_total).toBeLessThan(thirty.headline.tokens_total);
    expect(thirty.headline.tokens_total).toBeLessThan(all.headline.tokens_total);
  });

  it('looks up handles case-insensitively', async () => {
    const profile = await createTestProfile('case_lookup', false);
    await seedProfileUsage(profile);

    const body = parseProfileResponse(await getProfile(profile.handle.toUpperCase()));

    expect(body.identity.handle).toBe(profile.handle);
  });

  it('returns 404 for missing handles', async () => {
    const response = await getProfile(`missing_${crypto.randomUUID().slice(0, 8)}`);
    const body = bodyOf(response);

    expect(response.statusCode).toBe(404);
    expect(body.error.code).toBe('profile_not_found');
  });

  it('returns 400 for invalid windows', async () => {
    const profile = await createTestProfile('invalid_window', false);
    const response = await getProfile(profile.handle, '?window=24h');
    const body = bodyOf(response);

    expect(response.statusCode).toBe(400);
    expect(body.error.code).toBe('invalid_window');
  });

  it('gates owner-only fields between public and owner viewers', async () => {
    const profile = await createTestProfile('owner_gate', false);
    await seedAccessKey(profile.profileId);
    await seedIngestionRun(profile.profileId);

    const publicBody = parseProfileResponse(await getProfile(profile.handle));
    const ownerBody = parseProfileResponse(await getProfile(profile.handle, '', authHeaders(profile)));

    expect(publicBody.access_keys).toEqual([]);
    expect(publicBody.last_sync_at).toBeNull();
    expect(publicBody.sync_status).toBeNull();
    expect(ownerBody.access_keys).toHaveLength(1);
    expect(ownerBody.last_sync_at).not.toBeNull();
    expect(ownerBody.sync_status).toBe('SYNCED');
  });

  it('returns all 10 profile sections', async () => {
    const profile = await createTestProfile('sections', true);
    await seedProfileUsage(profile);

    const body = parseProfileResponse(await getProfile(profile.handle));

    expect(body).toHaveProperty('identity');
    expect(body).toHaveProperty('headline');
    expect(body).toHaveProperty('at_glance');
    expect(body).toHaveProperty('models');
    expect(body).toHaveProperty('tools');
    expect(body).toHaveProperty('sessions');
    expect(body).toHaveProperty('cadence');
    expect(body).toHaveProperty('parallelism');
    expect(body).toHaveProperty('recent_activity');
    expect(body).toHaveProperty('footer');
  });

  it('sets X-TokensRank-Cache MISS then HIT headers', async () => {
    const profile = await createTestProfile('cache_header', false);
    await seedProfileUsage(profile);

    const first = await getProfile(profile.handle);
    const second = await getProfile(profile.handle);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(cacheHeader(first)).toBe('MISS');
    expect(cacheHeader(second)).toBe('HIT');
  });
});
