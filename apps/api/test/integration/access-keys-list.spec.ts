import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../../src/clients/supabase';
import { buildServer } from '../../src/server';
import {
  createDisposableAnonClient,
  createServiceRoleClient,
  resolveTestSchema,
} from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const createdUserIds = new Set<string>();
const password = 'Correct-horse-battery-staple-45!';

let app: Awaited<ReturnType<typeof buildServer>>;

type TestProfile = {
  accessToken: string;
  profileId: string;
  userId: string;
};

type SeededAccessKey = {
  id: string;
  keyPrefix: string;
  plaintext: string;
  keySha256: string;
  scope: 'script' | 'self_reported';
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

function uniqueSuffix(): string {
  return `${Date.now()}_${randomUUID().slice(0, 8)}`;
}

function hashPlaintext(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

async function waitForProfile(userId: string) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { data, error } = await adminClient
      .from('profiles')
      .select('id,user_id,handle')
      .eq('user_id', userId)
      .maybeSingle();

    if (!error && data) {
      return data as { id: string; user_id: string; handle: string | null };
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
  }

  throw new Error(`[access-keys-list] profile shell was not created for user ${userId}`);
}

async function createAuthenticatedProfile(label: string): Promise<TestProfile> {
  const authAdmin = createServiceRoleClient();
  const anon = createDisposableAnonClient(schema);
  const suffix = uniqueSuffix();
  const safeLabel = label.replace(/[^a-z0-9_]/g, '_');
  const email = `access-key-list-${schema}-${safeLabel}-${suffix}@example.com`;
  const handle = `akl_${safeLabel}_${suffix.replace(/[^a-z0-9_]/g, '_')}`.slice(0, 30);

  const { data: userData, error: createError } = await authAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      test_schema: schema,
    },
  });

  if (createError || !userData.user) {
    throw new Error(`[access-keys-list] createUser failed: ${createError?.message ?? 'missing user'}`);
  }

  createdUserIds.add(userData.user.id);

  const profile = await waitForProfile(userData.user.id);
  const { data: updatedProfile, error: updateError } = await adminClient
    .from('profiles')
    .update({
      handle,
      mode: 'self_reported',
      verified: false,
    })
    .eq('id', profile.id)
    .select('id')
    .single();

  if (updateError || !updatedProfile) {
    throw new Error(`[access-keys-list] profile update failed: ${updateError?.message ?? 'missing profile'}`);
  }

  const { data: sessionData, error: signInError } = await anon.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !sessionData.session) {
    throw new Error(`[access-keys-list] sign-in failed: ${signInError?.message ?? 'missing session'}`);
  }

  return {
    accessToken: sessionData.session.access_token,
    profileId: updatedProfile.id as string,
    userId: userData.user.id,
  };
}

async function seedAccessKey(
  profileId: string,
  options: {
    scope?: 'script' | 'self_reported';
    createdAt?: string;
    revokedAt?: string | null;
    lastUsedAt?: string | null;
  } = {},
): Promise<SeededAccessKey> {
  const scope = options.scope ?? 'script';
  const plaintext = `tr_${scope}_${randomUUID().replace(/-/g, '').slice(0, 32)}`;
  const keySha256 = hashPlaintext(plaintext);
  const keyPrefix = plaintext.slice(0, 11);
  const createdAt = options.createdAt ?? new Date().toISOString();
  const revokedAt = options.revokedAt ?? null;
  const lastUsedAt = options.lastUsedAt ?? null;

  const { data, error } = await adminClient
    .from('access_keys')
    .insert({
      profile_id: profileId,
      key_sha256: keySha256,
      key_prefix: keyPrefix,
      scope,
      created_at: createdAt,
      revoked_at: revokedAt,
      last_used_at: lastUsedAt,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`[access-keys-list] access key seed failed: ${error?.message ?? 'missing row'}`);
  }

  return {
    id: data.id as string,
    keyPrefix,
    plaintext,
    keySha256,
    scope,
    createdAt: new Date(createdAt).toISOString(),
    revokedAt: revokedAt ? new Date(revokedAt).toISOString() : null,
    lastUsedAt: lastUsedAt ? new Date(lastUsedAt).toISOString() : null,
  };
}

async function listAccessKeys(token: string | null) {
  return app.inject({
    method: 'GET',
    url: '/api/access-keys',
    headers: token
      ? {
          authorization: `Bearer ${token}`,
        }
      : undefined,
  });
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();

  const authAdmin = createServiceRoleClient();

  for (const userId of createdUserIds) {
    await authAdmin.auth.admin.deleteUser(userId);
  }
});

describe('GET /api/access-keys', () => {
  it('returns all access keys for the authenticated user only', async () => {
    const owner = await createAuthenticatedProfile('owner_all');
    const other = await createAuthenticatedProfile('other_all');
    const activeKey = await seedAccessKey(owner.profileId, {
      scope: 'script',
      createdAt: '2026-04-20T10:00:00.000Z',
      lastUsedAt: '2026-04-21T10:00:00.000Z',
    });
    const revokedKey = await seedAccessKey(owner.profileId, {
      scope: 'self_reported',
      createdAt: '2026-04-22T10:00:00.000Z',
      revokedAt: '2026-04-23T10:00:00.000Z',
    });
    await seedAccessKey(other.profileId, {
      scope: 'script',
      createdAt: '2026-04-24T10:00:00.000Z',
    });

    const response = await listAccessKeys(owner.accessToken);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [
        {
          keyId: revokedKey.id,
          keyPrefix: revokedKey.keyPrefix,
          scope: 'self_reported',
          createdAt: revokedKey.createdAt,
          revokedAt: revokedKey.revokedAt,
          lastUsedAt: null,
        },
        {
          keyId: activeKey.id,
          keyPrefix: activeKey.keyPrefix,
          scope: 'script',
          createdAt: activeKey.createdAt,
          revokedAt: null,
          lastUsedAt: activeKey.lastUsedAt,
        },
      ],
    });
  });

  it('orders keys by createdAt descending', async () => {
    const owner = await createAuthenticatedProfile('owner_order');
    const oldest = await seedAccessKey(owner.profileId, { createdAt: '2026-04-20T10:00:00.000Z' });
    const newest = await seedAccessKey(owner.profileId, { createdAt: '2026-04-22T10:00:00.000Z' });
    const middle = await seedAccessKey(owner.profileId, { createdAt: '2026-04-21T10:00:00.000Z' });

    const response = await listAccessKeys(owner.accessToken);

    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((key: { keyId: string }) => key.keyId)).toEqual([
      newest.id,
      middle.id,
      oldest.id,
    ]);
  });

  it('returns an empty data array when the user has no access keys', async () => {
    const owner = await createAuthenticatedProfile('owner_empty');
    const response = await listAccessKeys(owner.accessToken);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: [] });
  });

  it('rejects unauthenticated requests with the error envelope', async () => {
    const response = await listAccessKeys(null);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized',
      },
    });
  });

  it('rejects invalid JWTs with the error envelope', async () => {
    const response = await listAccessKeys('not-a-valid-jwt');

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized',
      },
    });
  });

  it('never exposes plaintext keys or key_sha256 values', async () => {
    const owner = await createAuthenticatedProfile('owner_safe');
    const key = await seedAccessKey(owner.profileId);

    const response = await listAccessKeys(owner.accessToken);
    const serialized = JSON.stringify(response.json());

    expect(response.statusCode).toBe(200);
    expect(serialized).toContain(key.keyPrefix);
    expect(serialized).not.toContain(key.plaintext);
    expect(serialized).not.toContain(key.keySha256);
    expect(serialized).not.toContain('plaintext');
    expect(serialized).not.toContain('key_sha256');
  });
});
