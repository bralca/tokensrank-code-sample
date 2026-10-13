import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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

type TestProfile = {
  accessToken: string;
  email: string;
  handle: string;
  profileId: string;
  userId: string;
};

function uniqueSuffix(): string {
  return `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function uniqueEmail(label: string): string {
  const safeLabel = label.replace(/[^a-z0-9_]/g, '_').slice(0, 16);

  return `profile-${schema}-${safeLabel}-${uniqueSuffix()}@example.com`;
}

function uniqueHandle(label: string): string {
  const safeLabel = label.replace(/[^a-z0-9_]/g, '_').slice(0, 10);

  return `me_${safeLabel}_${crypto.randomUUID().slice(0, 8)}`.slice(0, 30);
}

function authHeaders(profile: TestProfile): Record<string, string> {
  return {
    authorization: `Bearer ${profile.accessToken}`,
  };
}

function cacheHeader(response: Awaited<ReturnType<typeof getMe>>): string | undefined {
  const header = response.headers['x-tokensrank-cache'];

  return Array.isArray(header) ? header[0] : header?.toString();
}

function bodyOf(response: Awaited<ReturnType<typeof getMe>>) {
  return JSON.parse(response.body);
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

  throw new Error(`[profile-spec] profile shell was not created for user ${userId}`);
}

async function createTestProfile(label: string): Promise<TestProfile> {
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
    throw new Error(`[profile-spec] createUser failed: ${error?.message ?? 'missing user'}`);
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
      x_handle: `@${handle}`,
      share_projects: false,
    })
    .eq('user_id', data.user.id)
    .select('id,user_id,handle')
    .single();

  if (updateError || !updatedProfile) {
    throw new Error(`[profile-spec] profile update failed: ${updateError?.message ?? 'missing profile'}`);
  }

  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({
    email,
    password: validPassword,
  });

  if (signInError || !signInData.session) {
    throw new Error(`[profile-spec] signIn failed: ${signInError?.message ?? 'missing session'}`);
  }

  return {
    accessToken: signInData.session.access_token,
    email,
    handle: updatedProfile.handle,
    profileId: updatedProfile.id,
    userId: data.user.id,
  };
}

async function getMe(headers: Record<string, string> = {}) {
  return await app.inject({
    method: 'GET',
    url: '/api/me',
    headers,
  });
}

async function seedAccessKey(profileId: string, scope: 'script' | 'self_reported' = 'script') {
  const plaintext = `tr_${scope}_${crypto.randomBytes(24).toString('base64url')}`;
  const { data, error } = await adminClient
    .from('access_keys')
    .insert({
      profile_id: profileId,
      key_sha256: crypto.createHash('sha256').update(plaintext).digest('hex'),
      key_prefix: plaintext.slice(0, 11),
      scope,
      label: 'integration key',
    })
    .select('id,key_prefix')
    .single();

  if (error || !data) {
    throw new Error(`[profile-spec] access key seed failed: ${error?.message ?? 'missing row'}`);
  }

  return data;
}

async function seedIngestionRun(profileId: string, index: number) {
  const startedAt = new Date(Date.UTC(2026, 3, 27, 10, index, 0)).toISOString();
  const finishedAt = new Date(Date.UTC(2026, 3, 27, 10, index, 30)).toISOString();
  const { data, error } = await adminClient
    .from('ingestion_runs')
    .insert({
      profile_id: profileId,
      started_at: startedAt,
      finished_at: finishedAt,
      status: index % 2 === 0 ? 'completed' : 'partial',
      ingestion_mode: index % 2 === 0 ? 'script_verified' : 'self_reported',
      session_count: index + 1,
      duplicate_count: index,
      rejected_count: 1,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`[profile-spec] ingestion run seed failed: ${error?.message ?? 'missing row'}`);
  }

  return data;
}

beforeAll(async () => {
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

  const authAdmin = createServiceRoleClient();

  for (const userId of createdUserIds) {
    await authAdmin.auth.admin.deleteUser(userId);
  }

});

describe('GET /api/me', () => {
  it('returns 401 without authentication', async () => {
    const response = await getMe();

    expect(response.statusCode).toBe(401);
  });

  it('returns 200 with an authenticated JWT and profile data', async () => {
    const profile = await createTestProfile('happy_path');
    const response = await getMe(authHeaders(profile));
    const body = bodyOf(response);

    expect(response.statusCode).toBe(200);
    expect(body.data.userId).toBe(profile.userId);
    expect(body.data.handle).toBe(profile.handle);
    expect(body.data.displayName).toBe('Display happy_path');
  });

  it('returns access-key metadata without the stored secret hash', async () => {
    const profile = await createTestProfile('access_key');
    const seededKey = await seedAccessKey(profile.profileId);
    const response = await getMe(authHeaders(profile));
    const body = bodyOf(response);

    expect(response.statusCode).toBe(200);
    expect(body.data.accessKeys).toHaveLength(1);
    expect(body.data.accessKeys[0]).toMatchObject({
      keyId: seededKey.id,
      keyPrefix: seededKey.key_prefix,
      scope: 'script',
    });
    expect(response.body).not.toContain('key_sha256');
  });

  it('returns email from the authenticated Supabase JWT', async () => {
    const profile = await createTestProfile('jwt_email');
    const response = await getMe(authHeaders(profile));
    const body = bodyOf(response);

    expect(response.statusCode).toBe(200);
    expect(body.data.email).toBe(profile.email);
  });

  it('sets cache MISS then HIT headers for repeated reads', async () => {
    const profile = await createTestProfile('cache_header');
    const firstResponse = await getMe(authHeaders(profile));
    const secondResponse = await getMe(authHeaders(profile));

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(cacheHeader(firstResponse)).toBe('MISS');
    expect(cacheHeader(secondResponse)).toBe('HIT');
  });

  it('computes onboarding.step from mode and onboarded_at', async () => {
    const profile = await createTestProfile('onboarding');

    await adminClient
      .from('profiles')
      .update({ mode: null, onboarded_at: null })
      .eq('id', profile.profileId);
    let response = await getMe(authHeaders(profile));
    expect(bodyOf(response).data.onboarding.step).toBe('not_started');

    app.cache.purgeAll();
    await adminClient
      .from('profiles')
      .update({ mode: 'self_reported', onboarded_at: null })
      .eq('id', profile.profileId);
    response = await getMe(authHeaders(profile));
    expect(bodyOf(response).data.onboarding.step).toBe('mode_chosen');

    app.cache.purgeAll();
    await adminClient
      .from('profiles')
      .update({ onboarded_at: '2026-04-27T10:00:00.000Z' })
      .eq('id', profile.profileId);
    response = await getMe(authHeaders(profile));
    expect(bodyOf(response).data.onboarding.step).toBe('complete');
  });

  it('serves cached profile data until the key is purged', async () => {
    const profile = await createTestProfile('cache_stale');
    const firstResponse = await getMe(authHeaders(profile));

    await adminClient
      .from('profiles')
      .update({ display_name: 'Updated cache_stale' })
      .eq('id', profile.profileId);

    const cachedResponse = await getMe(authHeaders(profile));
    app.cache.purgeKey(`me:v1:${profile.userId}`);
    const freshResponse = await getMe(authHeaders(profile));

    expect(bodyOf(firstResponse).data.displayName).toBe('Display cache_stale');
    expect(cacheHeader(cachedResponse)).toBe('HIT');
    expect(bodyOf(cachedResponse).data.displayName).toBe('Display cache_stale');
    expect(cacheHeader(freshResponse)).toBe('MISS');
    expect(bodyOf(freshResponse).data.displayName).toBe('Updated cache_stale');
  });

  it('includes the last five recent ingestion runs in newest-first order', async () => {
    const profile = await createTestProfile('recent_runs');

    for (let index = 0; index < 6; index += 1) {
      await seedIngestionRun(profile.profileId, index);
    }

    const response = await getMe(authHeaders(profile));
    const body = bodyOf(response);

    expect(response.statusCode).toBe(200);
    expect(body.data.recentIngestionRuns).toHaveLength(5);
    expect(body.data.recentIngestionRuns[0]).toMatchObject({
      status: 'partial',
      acceptedCount: 6,
      dedupedCount: 5,
      rejectedCount: 1,
    });
    expect(body.data.recentIngestionRuns[0].startedAt).toBe('2026-04-27T10:05:00+00:00');
  });
});
