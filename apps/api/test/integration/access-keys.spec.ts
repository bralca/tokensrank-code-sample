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
const password = 'Correct-horse-battery-staple-43!';

let app: Awaited<ReturnType<typeof buildServer>>;
let accessToken: string;
let profileId: string;

type GeneratedAccessKeyData = {
  id: string;
  scope: 'script' | 'self_reported';
  prefix: string;
  plaintext: string;
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

  throw new Error(`[access-keys-spec] profile shell was not created for user ${userId}`);
}

async function createAuthenticatedProfile() {
  const authAdmin = createServiceRoleClient();
  const anon = createDisposableAnonClient(schema);
  const suffix = uniqueSuffix();
  const email = `access-key-${schema}-${suffix}@example.com`;
  const handle = `ak_${suffix.replace(/[^a-z0-9_]/g, '_')}`.slice(0, 30);

  const { data: userData, error: createError } = await authAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      test_schema: schema,
    },
  });

  if (createError || !userData.user) {
    throw new Error(`[access-keys-spec] createUser failed: ${createError?.message ?? 'missing user'}`);
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
    throw new Error(`[access-keys-spec] profile update failed: ${updateError?.message ?? 'missing profile'}`);
  }

  const { data: sessionData, error: signInError } = await anon.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !sessionData.session) {
    throw new Error(`[access-keys-spec] sign-in failed: ${signInError?.message ?? 'missing session'}`);
  }

  return {
    accessToken: sessionData.session.access_token,
    profileId: updatedProfile.id as string,
  };
}

async function postGenerate(scope: 'script' | 'self_reported' | string, token = accessToken) {
  return app.inject({
    method: 'POST',
    url: '/api/access-keys/generate',
    headers: token
      ? {
          origin: 'http://localhost:3000',
          authorization: `Bearer ${token}`,
        }
      : { origin: 'http://localhost:3000' },
    payload: {
      scope,
    },
  });
}

async function generateKey(scope: 'script' | 'self_reported'): Promise<GeneratedAccessKeyData> {
  const response = await postGenerate(scope);

  expect(response.statusCode).toBe(200);

  return response.json().data as GeneratedAccessKeyData;
}

async function readAccessKeyRow(keyId: string) {
  const { data, error } = await adminClient
    .from('access_keys')
    .select('id,profile_id,key_sha256,key_prefix,scope,revoked_at,created_at')
    .eq('id', keyId)
    .single();

  if (error || !data) {
    throw new Error(`[access-keys-spec] access key lookup failed: ${error?.message ?? 'missing row'}`);
  }

  return data as {
    id: string;
    profile_id: string;
    key_sha256: string;
    key_prefix: string;
    scope: string;
    revoked_at: string | null;
    created_at: string;
  };
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  const auth = await createAuthenticatedProfile();
  accessToken = auth.accessToken;
  profileId = auth.profileId;
});

afterAll(async () => {
  await app?.close();

  const authAdmin = createServiceRoleClient();

  for (const userId of createdUserIds) {
    await authAdmin.auth.admin.deleteUser(userId);
  }
});

describe('POST /api/access-keys/generate', () => {
  it('creates a script key and returns the plaintext once', async () => {
    const body = await generateKey('script');

    expect(body).toEqual({
      id: expect.any(String),
      scope: 'script',
      prefix: body.plaintext.slice(0, 11),
      plaintext: expect.stringMatching(/^tr_script_[A-Za-z0-9_-]{32}$/),
      created_at: expect.any(String),
    });
    expect(new Date(body.created_at).toString()).not.toBe('Invalid Date');
  });

  it('creates a self-reported key and returns the plaintext once', async () => {
    const body = await generateKey('self_reported');

    expect(body).toEqual({
      id: expect.any(String),
      scope: 'self_reported',
      prefix: body.plaintext.slice(0, 11),
      plaintext: expect.stringMatching(/^tr_self_reported_[A-Za-z0-9_-]{32}$/),
      created_at: expect.any(String),
    });
  });

  it('logs an audit event for generated keys', async () => {
    const body = await generateKey('script');
    const { data, error } = await adminClient
      .from('audit_events')
      .select('event_type,severity,profile_id,payload')
      .eq('event_type', 'access_key.created')
      .eq('profile_id', profileId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) {
      throw new Error(`[access-keys-spec] audit lookup failed: ${error.message}`);
    }

    expect(data ?? []).toContainEqual(expect.objectContaining({
      event_type: 'access_key.created',
      severity: 'info',
      profile_id: profileId,
      payload: expect.objectContaining({
        key_id: body.id,
        key_prefix: body.prefix,
        scope: body.scope,
      }),
    }));
    expect(JSON.stringify(data)).not.toContain(body.plaintext);
  });

  it('persists the hash and prefix without storing plaintext', async () => {
    const body = await generateKey('script');
    const row = await readAccessKeyRow(body.id);

    expect(row).toMatchObject({
      id: body.id,
      profile_id: profileId,
      key_prefix: body.prefix,
      scope: 'script',
      revoked_at: null,
    });
    expect(row.key_sha256).toBe(createHash('sha256').update(body.plaintext).digest('hex'));
    expect(row.key_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(body.plaintext);
  });

  it('does not expose plaintext in GET /api/access-keys', async () => {
    const body = await generateKey('script');
    const response = await app.inject({
      method: 'GET',
      url: '/api/access-keys',
      headers: {
        origin: 'http://localhost:3000',
        authorization: `Bearer ${accessToken}`,
      },
    });
    const listBody = response.json();
    const serialized = JSON.stringify(listBody);

    expect(response.statusCode).toBe(200);
    expect(listBody.data).toContainEqual(expect.objectContaining({
      keyId: body.id,
      keyPrefix: body.prefix,
      scope: body.scope,
    }));
    expect(serialized).not.toContain(body.plaintext);
    expect(serialized).not.toContain('key_sha256');
  });

  it('returns 401 without auth', async () => {
    const response = await postGenerate('script', '');

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized',
      },
    });
  });

  it('returns 400 with an invalid scope', async () => {
    const response = await postGenerate('admin');

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'invalid_scope',
        message: 'Scope must be script or self_reported',
      },
    });
  });
});
