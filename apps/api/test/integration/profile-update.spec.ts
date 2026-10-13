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
const validPassword = 'Correct-horse-battery-staple-41!';

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

  return `profile-update-${schema}-${safeLabel}-${uniqueSuffix()}@example.com`;
}

function uniqueHandle(label: string): string {
  const safeLabel = label.replace(/[^a-z0-9_]/g, '_').slice(0, 10);

  return `pu_${safeLabel}_${crypto.randomUUID().slice(0, 8)}`.slice(0, 30);
}

function authHeaders(profile: TestProfile): Record<string, string> {
  return {
    origin: 'http://localhost:3000',
    cookie: `tr_at=${encodeURIComponent(profile.accessToken)}`,
  };
}

function responseBody(response: Awaited<ReturnType<typeof patchProfile>>) {
  return JSON.parse(response.body);
}

function cacheHeader(response: Awaited<ReturnType<typeof getMe>>): string | undefined {
  const header = response.headers['x-tokensrank-cache'];

  return Array.isArray(header) ? header[0] : header?.toString();
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

  throw new Error(`[profile-update] profile shell was not created for user ${userId}`);
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
    throw new Error(`[profile-update] createUser failed: ${error?.message ?? 'missing user'}`);
  }

  createdUserIds.add(data.user.id);

  await waitForProfile(data.user.id);

  const { data: updatedProfile, error: updateError } = await adminClient
    .from('profiles')
    .update({
      handle,
      display_name: `Display ${label}`,
      avatar_url: 'https://example.com/avatar.png',
      bio: `Bio ${label}`,
      x_handle: `${handle}`.replace(/[^A-Za-z0-9_]/g, '').slice(0, 15),
      share_projects: false,
    })
    .eq('user_id', data.user.id)
    .select('id,user_id,handle')
    .single();

  if (updateError || !updatedProfile) {
    throw new Error(`[profile-update] profile update failed: ${updateError?.message ?? 'missing profile'}`);
  }

  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({
    email,
    password: validPassword,
  });

  if (signInError || !signInData.session) {
    throw new Error(`[profile-update] signIn failed: ${signInError?.message ?? 'missing session'}`);
  }

  return {
    accessToken: signInData.session.access_token,
    email,
    handle: updatedProfile.handle,
    profileId: updatedProfile.id,
    userId: data.user.id,
  };
}

async function patchProfile(
  profile: TestProfile | null,
  payload: Record<string, unknown>,
) {
  return await app.inject({
    method: 'PATCH',
    url: '/api/me/profile',
    headers: profile ? authHeaders(profile) : { origin: 'http://localhost:3000' },
    payload,
  });
}

async function getMe(profile: TestProfile) {
  return await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: authHeaders(profile),
  });
}

async function loadProfileRow(profileId: string) {
  const { data, error } = await adminClient
    .from('profiles')
    .select('display_name,avatar_url,bio,x_handle,share_projects')
    .eq('id', profileId)
    .single();

  if (error || !data) {
    throw new Error(`[profile-update] profile lookup failed: ${error?.message ?? 'missing row'}`);
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

describe('PATCH /api/me/profile', () => {
  it('updates displayName for the authenticated profile', async () => {
    const profile = await createTestProfile('display');
    const response = await patchProfile(profile, {
      displayName: 'Updated Display Name',
    });
    const row = await loadProfileRow(profile.profileId);

    expect(response.statusCode).toBe(200);
    expect(responseBody(response)).toEqual({ data: { updated: true } });
    expect(row.display_name).toBe('Updated Display Name');
  });

  it('invalidates cached /api/me hydration after profile update', async () => {
    const profile = await createTestProfile('cache');
    const firstRead = await getMe(profile);
    const secondRead = await getMe(profile);

    expect(firstRead.statusCode).toBe(200);
    expect(secondRead.statusCode).toBe(200);
    expect(cacheHeader(firstRead)).toBe('MISS');
    expect(cacheHeader(secondRead)).toBe('HIT');

    const update = await patchProfile(profile, {
      displayName: 'Cache Purged Name',
    });
    const freshRead = await getMe(profile);
    const freshBody = JSON.parse(freshRead.body);

    expect(update.statusCode).toBe(200);
    expect(freshRead.statusCode).toBe(200);
    expect(cacheHeader(freshRead)).toBe('MISS');
    expect(freshBody.data.displayName).toBe('Cache Purged Name');
  });

  it('rejects invalid profile update fields', async () => {
    const profile = await createTestProfile('invalid');

    for (const payload of [
      { displayName: 'a'.repeat(101) },
      { avatarUrl: 'not-a-url' },
      { bio: 'b'.repeat(501) },
      { xHandle: 'invalid-handle' },
      { shareProjects: 'true' },
    ]) {
      const response = await patchProfile(profile, payload);

      expect(response.statusCode).toBe(400);
      expect(responseBody(response)).toMatchObject({
        error: {
          code: 'invalid_request',
        },
      });
    }
  });

  it('accepts avatarUrl as null', async () => {
    const profile = await createTestProfile('avatar_null');
    const response = await patchProfile(profile, {
      avatarUrl: null,
    });
    const row = await loadProfileRow(profile.profileId);

    expect(response.statusCode).toBe(200);
    expect(row.avatar_url).toBeNull();
  });

  it('rejects extra fields through strict schema validation', async () => {
    const profile = await createTestProfile('strict');
    const response = await patchProfile(profile, {
      displayName: 'Strict User',
      mode: 'self_reported',
    });
    const row = await loadProfileRow(profile.profileId);

    expect(response.statusCode).toBe(400);
    expect(responseBody(response)).toMatchObject({
      error: {
        code: 'invalid_request',
      },
    });
    expect(row.display_name).toBe('Display strict');
  });

  it('requires authentication', async () => {
    const response = await patchProfile(null, {
      displayName: 'Anonymous Update',
    });

    expect(response.statusCode).toBe(401);
    expect(responseBody(response)).toMatchObject({
      error: {
        code: 'unauthorized',
      },
    });
  });

  it('logs profile.updated audit event with info severity', async () => {
    const profile = await createTestProfile('audit');
    const response = await patchProfile(profile, {
      bio: 'Updated audit bio',
      shareProjects: true,
    });

    const { data, error } = await adminClient
      .from('audit_events')
      .select('event_type,severity,payload')
      .eq('profile_id', profile.profileId)
      .eq('event_type', 'profile.updated')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    expect(response.statusCode).toBe(200);
    expect(error).toBeNull();
    expect(data).toMatchObject({
      event_type: 'profile.updated',
      severity: 'info',
    });
    expect((data?.payload as { updated_fields?: string[] } | null)?.updated_fields).toEqual([
      'bio',
      'shareProjects',
    ]);
  });
});
