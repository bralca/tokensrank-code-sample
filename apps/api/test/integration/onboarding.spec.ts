import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { adminClient } from '../../src/clients/supabase';
import { buildServer } from '../../src/server';
import { generateAccessKey } from '../../src/services/access-keys';
import {
  buildIngestPayload,
  createAccessKeyFixture,
  createSchemaServiceRoleClient,
  deleteAuthUsers,
} from './ingestion-test-helpers';
import {
  createDisposableAnonClient,
  createServiceRoleClient,
  resolveTestSchema,
} from './setup';

type GeneratedAccessKeyData = {
  id: string;
  scope: 'script' | 'self_reported';
  prefix: string;
  plaintext: string;
  created_at: string;
};

type TestProfile = {
  accessToken: string;
  profileId: string;
  userId: string;
};

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const password = 'Correct-horse-battery-staple-59!';
const signUpEmailDomain = 'example.com';
const createdUserIds = new Set<string>();

let app: Awaited<ReturnType<typeof buildServer>>;
let schemaAdmin: ReturnType<typeof createSchemaServiceRoleClient>;

function uniqueSuffix(): string {
  return `${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
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

  throw new Error(`[onboarding-spec] profile shell was not created for user ${userId}`);
}

async function createAuthenticatedProfile(label: string): Promise<TestProfile> {
  const authAdmin = createServiceRoleClient();
  const anon = createDisposableAnonClient(schema);
  const suffix = uniqueSuffix();
  const safeLabel = label.replace(/[^a-z0-9_]/g, '_').slice(0, 12);
  const email = `onboarding-${schema}-${safeLabel}-${suffix}@example.com`;
  const handle = `onboarding_${safeLabel}_${suffix.replace(/[^a-z0-9_]/g, '_')}`.slice(0, 30);

  const { data: userData, error: createError } = await authAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      test_schema: schema,
    },
  });

  if (createError || !userData.user) {
    throw new Error(`[onboarding-spec] createUser failed: ${createError?.message ?? 'missing user'}`);
  }

  createdUserIds.add(userData.user.id);

  const profile = await waitForProfile(userData.user.id);
  const { data: updatedProfile, error: updateError } = await adminClient
    .from('profiles')
    .update({
      handle,
      mode: null,
      verified: false,
      onboarded_at: null,
    })
    .eq('id', profile.id)
    .select('id')
    .single();

  if (updateError || !updatedProfile) {
    throw new Error(`[onboarding-spec] profile update failed: ${updateError?.message ?? 'missing profile'}`);
  }

  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !signInData.session) {
    throw new Error(`[onboarding-spec] sign-in failed: ${signInError?.message ?? 'missing session'}`);
  }

  return {
    accessToken: signInData.session.access_token,
    profileId: updatedProfile.id as string,
    userId: userData.user.id,
  };
}

async function postGenerate(profile: TestProfile, scope: 'script' | 'self_reported') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/access-keys/generate',
    headers: {
      origin: 'http://localhost:3000',
      authorization: `Bearer ${profile.accessToken}`,
    },
    payload: {
      scope,
    },
  });

  expect(response.statusCode).toBe(200);

  return response.json().data as GeneratedAccessKeyData;
}

async function getMe(profile: TestProfile) {
  return await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: {
      origin: 'http://localhost:3000',
      authorization: `Bearer ${profile.accessToken}`,
    },
  });
}

function buildCookieHeader(setCookie: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];

  return cookies
    .map((cookie) => cookie.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

async function postSignUp(label: string) {
  const suffix = uniqueSuffix().replace(/[^a-z0-9_]/g, '_');
  const safeLabel = label.replace(/[^a-z0-9_]/g, '_').slice(0, 10);
  const handle = `ob_${safeLabel}_${suffix}`.slice(0, 30);
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up',
    headers: {
      origin: 'http://localhost:3000',
    },
    payload: {
      email: `onboarding-signup-${schema}-${safeLabel}-${suffix}@${signUpEmailDomain}`,
      password,
      handle,
    },
  });

  if (response.statusCode !== 302) {
    throw new Error(`[onboarding-spec] Expected 302, received ${response.statusCode}: ${response.body}`);
  }

  const body = response.json() as { data: { userId: string } };
  createdUserIds.add(body.data.userId);

  return {
    cookie: buildCookieHeader(response.headers['set-cookie']),
    handle,
  };
}

async function readAccessKey(keyId: string) {
  const { data, error } = await schemaAdmin
    .from('access_keys')
    .select('id,profile_id,key_sha256,key_prefix,scope,revoked_at')
    .eq('id', keyId)
    .single();

  if (error || !data) {
    throw new Error(`[onboarding-spec] access key lookup failed: ${error?.message ?? 'missing row'}`);
  }

  return data as {
    id: string;
    profile_id: string;
    key_sha256: string;
    key_prefix: string;
    scope: string;
    revoked_at: string | null;
  };
}

async function readAuditEvents(profileId: string, eventType: string) {
  const { data, error } = await schemaAdmin
    .from('audit_events')
    .select('event_type,severity,payload')
    .eq('profile_id', profileId)
    .eq('event_type', eventType)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`[onboarding-spec] audit lookup failed: ${error.message}`);
  }

  return (data ?? []) as Array<{
    event_type: string;
    severity: string;
    payload: Record<string, unknown>;
  }>;
}

async function seedCompletedIngestionRun(profileId: string) {
  const finishedAt = new Date().toISOString();
  const startedAt = new Date(Date.now() - 30_000).toISOString();
  const { data, error } = await schemaAdmin
    .from('ingestion_runs')
    .insert({
      profile_id: profileId,
      started_at: startedAt,
      finished_at: finishedAt,
      completed_at: finishedAt,
      status: 'completed',
      ingestion_mode: 'script_verified',
      session_count: 1,
      duplicate_count: 0,
      rejected_count: 0,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`[onboarding-spec] ingestion run seed failed: ${error?.message ?? 'missing row'}`);
  }

  return data as { id: string };
}

beforeAll(async () => {
  app = await buildServer({
    logger: false,
  });
  await app.ready();
  schemaAdmin = createSchemaServiceRoleClient();
});

beforeEach(() => {
  app.cache.purgeAll();
});

afterAll(async () => {
  await app?.close();
  await deleteAuthUsers(createdUserIds);
});

describe('onboarding backend contracts', () => {
  it('derives GET /api/me/onboarding from profile mode and onboarded_at after sign-up', async () => {
    const signup = await postSignUp('status');
    const { error: updateError } = await adminClient
      .from('profiles')
      .update({ mode: 'self_reported', onboarded_at: null })
      .eq('handle', signup.handle);

    if (updateError) {
      throw new Error(`[onboarding-spec] mode choice update failed: ${updateError.message}`);
    }

    const response = await app.inject({
      method: 'GET',
      url: '/api/me/onboarding',
      headers: {
        cookie: signup.cookie,
      },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-tokensrank-cache']).toBe('MISS');
    expect(body).toMatchObject({
      data: {
        step: 'mode_chosen',
        mode: 'self_reported',
        handle: signup.handle,
        onboarded_at: null,
      },
    });
  });

  it('serves onboarding waiting as an authenticated SSE stream and sends detected', async () => {
    const profile = await createAuthenticatedProfile('sse_headers');
    const run = await seedCompletedIngestionRun(profile.profileId);
    const response = await app.inject({
      method: 'GET',
      url: '/api/onboarding/waiting',
      headers: {
        authorization: `Bearer ${profile.accessToken}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['cache-control']).toContain('no-cache');
    expect(response.headers.connection).toBe('keep-alive');
    expect(response.body).toContain('event: connected');
    expect(response.body).toContain('event: detected');
    expect(response.body).toContain(run.id);
  });

  it('generates onboarding access keys in the correct public formats and persists only hashes', async () => {
    const profile = await createAuthenticatedProfile('key_formats');
    const scriptKey = await postGenerate(profile, 'script');
    const selfReportedKey = await postGenerate(profile, 'self_reported');
    const helperKey = generateAccessKey('script');
    const scriptRow = await readAccessKey(scriptKey.id);
    const selfReportedRow = await readAccessKey(selfReportedKey.id);

    expect(scriptKey.plaintext).toMatch(/^tr_script_[A-Za-z0-9_-]{32}$/);
    expect(selfReportedKey.plaintext).toMatch(/^tr_self_reported_[A-Za-z0-9_-]{32}$/);
    expect(helperKey.key_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(scriptRow).toMatchObject({
      profile_id: profile.profileId,
      key_prefix: scriptKey.prefix,
      scope: 'script',
      revoked_at: null,
    });
    expect(selfReportedRow).toMatchObject({
      profile_id: profile.profileId,
      key_prefix: selfReportedKey.prefix,
      scope: 'self_reported',
      revoked_at: null,
    });
    expect(scriptRow.key_sha256).not.toContain(scriptKey.plaintext);
    expect(selfReportedRow.key_sha256).not.toContain(selfReportedKey.plaintext);
  });

  it('returns masked access-key metadata from GET /api/me without plaintext or hashes', async () => {
    const profile = await createAuthenticatedProfile('me_masking');
    const key = await postGenerate(profile, 'script');
    const response = await getMe(profile);
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.data.accessKeys).toEqual([
      expect.objectContaining({
        keyId: key.id,
        keyPrefix: key.prefix,
        scope: 'script',
      }),
    ]);
    expect(response.body).not.toContain(key.plaintext);
    expect(response.body).not.toContain('key_sha256');
  });

  it('escalates a self-reported onboarding profile to script_verified after first script ingestion', async () => {
    const fixture = await createAccessKeyFixture('script', 'onboarding_escalation');
    createdUserIds.add(fixture.userId);
    const response = await app.inject({
      method: 'POST',
      url: '/api/script/sessions',
      headers: {
        origin: 'http://localhost:3000',
        authorization: `Bearer ${fixture.plaintext}`,
      },
      payload: buildIngestPayload(1, `onboarding-${fixture.profileId}`),
    });
    const { data: profile, error } = await schemaAdmin
      .from('profiles')
      .select('mode,verified')
      .eq('id', fixture.profileId)
      .single();

    if (error || !profile) {
      throw new Error(`[onboarding-spec] profile lookup failed: ${error?.message ?? 'missing profile'}`);
    }

    expect(response.statusCode).toBe(202);
    expect(profile).toMatchObject({
      mode: 'script_verified',
      verified: true,
    });
  });

  it('records onboarding audit events for access key creation and mode escalation', async () => {
    const profile = await createAuthenticatedProfile('audit_key');
    const key = await postGenerate(profile, 'self_reported');
    const keyEvents = await readAuditEvents(profile.profileId, 'access_key.created');
    const fixture = await createAccessKeyFixture('script', 'onboarding_audit');
    createdUserIds.add(fixture.userId);

    await app.inject({
      method: 'POST',
      url: '/api/script/sessions',
      headers: {
        origin: 'http://localhost:3000',
        authorization: `Bearer ${fixture.plaintext}`,
      },
      payload: buildIngestPayload(1, `onboarding-audit-${fixture.profileId}`),
    });

    const modeEvents = await readAuditEvents(fixture.profileId, 'profile.mode_escalation');

    expect(keyEvents).toEqual([
      expect.objectContaining({
        event_type: 'access_key.created',
        severity: 'info',
        payload: expect.objectContaining({
          key_id: key.id,
          key_prefix: key.prefix,
          scope: 'self_reported',
        }),
      }),
    ]);
    expect(modeEvents).toEqual([
      expect.objectContaining({
        event_type: 'profile.mode_escalation',
        severity: 'info',
        payload: expect.objectContaining({
          previous_mode: 'self_reported',
          next_mode: 'script_verified',
        }),
      }),
    ]);
  });
});
