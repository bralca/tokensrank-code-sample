import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../../src/clients/supabase';
import { buildServer } from '../../src/server';
import { buildIngestPayload } from './ingestion-test-helpers';
import {
  createDisposableAnonClient,
  createServiceRoleClient,
  resolveTestSchema,
} from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const createdUserIds = new Set<string>();
const password = 'Correct-horse-battery-staple-44!';
const missingKeyId = '00000000-0000-4000-8000-000000000000';

let app: Awaited<ReturnType<typeof buildServer>>;
let ownerAccessToken: string;
let ownerProfileId: string;
let ownerUserId: string;
let otherAccessToken: string;

type GeneratedAccessKeyData = {
  id: string;
  scope: 'script' | 'self_reported';
  prefix: string;
  plaintext: string;
  created_at: string;
};

type AccessKeyRow = {
  id: string;
  profile_id: string;
  key_sha256: string;
  key_prefix: string;
  scope: string;
  revoked_at: string | null;
  created_at: string;
};

function uniqueSuffix(): string {
  return `${Date.now()}_${randomUUID().slice(0, 8)}`;
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

  throw new Error(`[access-keys-revoke] profile shell was not created for user ${userId}`);
}

async function createAuthenticatedProfile(label: string) {
  const authAdmin = createServiceRoleClient();
  const anon = createDisposableAnonClient(schema);
  const suffix = uniqueSuffix();
  const safeLabel = label.replace(/[^a-z0-9_]/g, '_');
  const email = `access-key-revoke-${schema}-${safeLabel}-${suffix}@example.com`;
  const handle = `akr_${safeLabel}_${suffix.replace(/[^a-z0-9_]/g, '_')}`.slice(0, 30);

  const { data: userData, error: createError } = await authAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      test_schema: schema,
    },
  });

  if (createError || !userData.user) {
    throw new Error(`[access-keys-revoke] createUser failed: ${createError?.message ?? 'missing user'}`);
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
    throw new Error(`[access-keys-revoke] profile update failed: ${updateError?.message ?? 'missing profile'}`);
  }

  const { data: sessionData, error: signInError } = await anon.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !sessionData.session) {
    throw new Error(`[access-keys-revoke] sign-in failed: ${signInError?.message ?? 'missing session'}`);
  }

  return {
    accessToken: sessionData.session.access_token,
    profileId: updatedProfile.id as string,
    userId: userData.user.id,
  };
}

async function generateKey(
  token = ownerAccessToken,
  scope: 'script' | 'self_reported' = 'script',
): Promise<GeneratedAccessKeyData> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/access-keys/generate',
    headers: {
      origin: 'http://localhost:3000',
      authorization: `Bearer ${token}`,
    },
    payload: {
      scope,
    },
  });

  expect(response.statusCode).toBe(200);

  return response.json().data as GeneratedAccessKeyData;
}

async function deleteAccessKey(keyId: string, token = ownerAccessToken) {
  return app.inject({
    method: 'DELETE',
    url: `/api/access-keys/${keyId}`,
    headers: token
      ? {
          origin: 'http://localhost:3000',
          authorization: `Bearer ${token}`,
        }
      : { origin: 'http://localhost:3000' },
  });
}

async function readAccessKeyRow(keyId: string): Promise<AccessKeyRow> {
  const { data, error } = await adminClient
    .from('access_keys')
    .select('id,profile_id,key_sha256,key_prefix,scope,revoked_at,created_at')
    .eq('id', keyId)
    .single();

  if (error || !data) {
    throw new Error(`[access-keys-revoke] access key lookup failed: ${error?.message ?? 'missing row'}`);
  }

  return data as AccessKeyRow;
}

async function readRevokeAuditEvents(profileId = ownerProfileId) {
  const { data, error } = await adminClient
    .from('audit_events')
    .select('event_type,severity,profile_id,payload')
    .eq('event_type', 'access_key.revoked')
    .eq('profile_id', profileId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    throw new Error(`[access-keys-revoke] audit lookup failed: ${error.message}`);
  }

  return data ?? [];
}

async function postScriptSessions(accessKey: string, label: string) {
  return app.inject({
    method: 'POST',
    url: '/api/script/sessions',
    headers: {
      origin: 'http://localhost:3000',
      authorization: `Bearer ${accessKey}`,
    },
    payload: buildIngestPayload(1, label),
  });
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  const owner = await createAuthenticatedProfile('owner');
  const other = await createAuthenticatedProfile('other');

  ownerAccessToken = owner.accessToken;
  ownerProfileId = owner.profileId;
  ownerUserId = owner.userId;
  otherAccessToken = other.accessToken;
});

afterAll(async () => {
  await app?.close();

  const authAdmin = createServiceRoleClient();

  for (const userId of createdUserIds) {
    await authAdmin.auth.admin.deleteUser(userId);
  }
});

describe('DELETE /api/access-keys/:key_id', () => {
  it('soft-deletes an owned active key and logs a warn audit event', async () => {
    const key = await generateKey();
    const response = await deleteAccessKey(key.id);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    const row = await readAccessKeyRow(key.id);
    expect(row).toMatchObject({
      id: key.id,
      profile_id: ownerProfileId,
      key_prefix: key.prefix,
      scope: 'script',
    });
    expect(row.revoked_at).toEqual(expect.any(String));
    expect(new Date(row.revoked_at as string).toString()).not.toBe('Invalid Date');
    expect(row.key_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(key.plaintext);

    const auditEvents = await readRevokeAuditEvents();
    expect(auditEvents).toContainEqual(expect.objectContaining({
      event_type: 'access_key.revoked',
      severity: 'warn',
      profile_id: ownerProfileId,
      payload: expect.objectContaining({
        key_id: key.id,
        key_prefix: key.prefix,
        scope: key.scope,
        revoked_at: row.revoked_at,
      }),
    }));
    expect(JSON.stringify(auditEvents)).not.toContain(key.plaintext);
  });

  it('returns 404 for a missing key id', async () => {
    const response = await deleteAccessKey(missingKeyId);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'key_not_found',
        message: 'Access key was not found',
      },
    });
  });

  it('returns 404 for a key owned by another profile and leaves it active', async () => {
    const key = await generateKey(ownerAccessToken);
    const response = await deleteAccessKey(key.id, otherAccessToken);
    const row = await readAccessKeyRow(key.id);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'key_not_found',
        message: 'Access key was not found',
      },
    });
    expect(row.profile_id).toBe(ownerProfileId);
    expect(row.revoked_at).toBeNull();
  });

  it('returns 404 when revoking an already revoked key', async () => {
    const key = await generateKey();
    const firstResponse = await deleteAccessKey(key.id);
    const secondResponse = await deleteAccessKey(key.id);

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(404);
    expect(secondResponse.json()).toEqual({
      error: {
        code: 'key_not_found',
        message: 'Access key was not found',
      },
    });
  });

  it('returns 400 for an invalid UUID route parameter', async () => {
    const response = await deleteAccessKey('not-a-uuid');

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'schema_invalid',
        message: 'Route parameters failed validation',
      },
    });
  });

  it('returns 401 without auth', async () => {
    const response = await deleteAccessKey(missingKeyId, '');

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized',
      },
    });
  });

  it('returns 401 for an invalid auth token', async () => {
    const response = await deleteAccessKey(missingKeyId, 'invalid-session-token');

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized',
      },
    });
  });

  it('causes subsequent ingestion with the revoked plaintext key to fail with key_revoked', async () => {
    const key = await generateKey();
    const revokeResponse = await deleteAccessKey(key.id);
    const ingestResponse = await postScriptSessions(key.plaintext, `revoked-${randomUUID()}`);

    expect(revokeResponse.statusCode).toBe(200);
    expect(ingestResponse.statusCode).toBe(401);
    expect(ingestResponse.json()).toEqual({
      error: {
        code: 'key_revoked',
        message: 'This access key has been revoked',
      },
    });
  });

  it('purges the owner me cache after revocation', async () => {
    const key = await generateKey();
    const cacheKey = `me:v1:${ownerUserId}`;

    await app.cache.withCache(cacheKey, 600, async () => ({ stale: true }));

    const response = await deleteAccessKey(key.id);
    let cacheStatus: string | undefined;
    const cachedValue = await app.cache.withCache(
      cacheKey,
      600,
      async () => ({ fresh: true }),
      {
        onStatus(status) {
          cacheStatus = status;
        },
      },
    );

    expect(response.statusCode).toBe(200);
    expect(cacheStatus).toBe('MISS');
    expect(cachedValue).toEqual({ fresh: true });
  });
});
