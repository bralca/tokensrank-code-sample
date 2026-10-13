import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../../src/clients/supabase';
import { buildServer } from '../../src/server';
import { createServiceRoleClient, resolveTestSchema } from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const createdUserIds = new Set<string>();
const validPassword = 'Correct-horse-battery-staple-35!';
const invalidCredentialsResponse = {
  error: {
    code: 'invalid_credentials',
    message: 'Invalid email or password',
  },
} as const;

let app: Awaited<ReturnType<typeof buildServer>>;

type TestProfile = {
  email: string;
  handle: string;
  password: string;
  profileId: string;
  userId: string;
};

function uniqueSuffix(): string {
  return `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function uniqueEmail(label: string): string {
  const safeLabel = label.replace(/[^a-z0-9_]/g, '_').slice(0, 16);

  return `signin-${schema}-${safeLabel}-${uniqueSuffix()}@example.com`;
}

function uniqueHandle(label: string): string {
  const safeLabel = label.replace(/[^a-z0-9_]/g, '_').slice(0, 10);

  return `si_${safeLabel}_${crypto.randomUUID().slice(0, 8)}`.slice(0, 30);
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

  throw new Error(`[auth-spec] profile shell was not created for user ${userId}`);
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
    throw new Error(`[auth-spec] createUser failed: ${error?.message ?? 'missing user'}`);
  }

  createdUserIds.add(data.user.id);

  const profile = await waitForProfile(data.user.id);
  const { data: updatedProfile, error: updateError } = await adminClient
    .from('profiles')
    .update({ handle })
    .eq('user_id', data.user.id)
    .select('id,user_id,handle')
    .single();

  if (updateError || !updatedProfile) {
    throw new Error(`[auth-spec] profile update failed: ${updateError?.message ?? 'missing profile'}`);
  }

  return {
    email,
    handle,
    password: validPassword,
    profileId: updatedProfile.id,
    userId: data.user.id,
  };
}

async function postSignIn(payload: unknown) {
  return await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in',
    headers: {
      origin: 'http://localhost:3000',
    },
    payload: payload as Record<string, unknown>,
  });
}

function cookieHeaders(response: Awaited<ReturnType<typeof postSignIn>>): string[] {
  const setCookie = response.headers['set-cookie'];

  if (!setCookie) {
    return [];
  }

  return Array.isArray(setCookie) ? setCookie : [String(setCookie)];
}

async function readAuditEvents(eventType: string, profileId?: string | null) {
  let query = adminClient
    .from('audit_events')
    .select('event_type,severity,profile_id,payload,created_at')
    .eq('event_type', eventType)
    .order('created_at', { ascending: false })
    .limit(10);

  if (profileId !== undefined) {
    query = profileId === null ? query.is('profile_id', null) : query.eq('profile_id', profileId);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`[auth-spec] audit lookup failed: ${error.message}`);
  }

  return data ?? [];
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

describe('POST /api/auth/sign-in', () => {
  it('Valid email and password returns 200 with session', async () => {
    const profile = await createTestProfile('success');
    const response = await postSignIn({
      email: profile.email.toUpperCase(),
      password: profile.password,
    });
    const body = response.json();
    const cookies = cookieHeaders(response);
    const joinedCookies = cookies.join('\n');

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      data: {
        user_id: profile.userId,
        handle: profile.handle,
        profile_id: profile.profileId,
        session: {
          access_token: expect.any(String),
          refresh_token: expect.any(String),
        },
      },
    });

    expect(cookies).toHaveLength(2);
    expect(cookies).toEqual(expect.arrayContaining([
      expect.stringContaining('tr_at='),
      expect.stringContaining('tr_rt='),
    ]));
    expect(joinedCookies).toContain('HttpOnly');
    expect(joinedCookies).toContain('Secure');
    expect(joinedCookies).toContain('SameSite=Lax');
    expect(joinedCookies).toContain('Max-Age=3600');
    expect(joinedCookies).toContain('Max-Age=2592000');
    expect(joinedCookies).toContain('Path=/');
    expect(joinedCookies).toContain('Path=/api/auth/refresh');

    const auditEvents = await readAuditEvents('auth.signin_success', profile.profileId);

    expect(auditEvents).toContainEqual(expect.objectContaining({
      event_type: 'auth.signin_success',
      severity: 'info',
      profile_id: profile.profileId,
      payload: expect.objectContaining({
        email: profile.email,
        user_id: profile.userId,
      }),
    }));
  });

  it('Invalid password returns 401 with generic message', async () => {
    const profile = await createTestProfile('wrong_password');
    const response = await postSignIn({
      email: profile.email,
      password: 'Wrong-password-35!',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(invalidCredentialsResponse);
    expect(cookieHeaders(response)).toEqual([]);

    const auditEvents = await readAuditEvents('auth.signin_failed', null);

    expect(auditEvents).toContainEqual(expect.objectContaining({
      event_type: 'auth.signin_failed',
      severity: 'warn',
      profile_id: null,
      payload: expect.objectContaining({
        email: profile.email,
        user_id: null,
      }),
    }));
  });

  it('Non-existent email returns 401 with identical message', async () => {
    const existingProfile = await createTestProfile('compare');
    const missingEmail = uniqueEmail('missing');
    const wrongPasswordResponse = await postSignIn({
      email: existingProfile.email,
      password: 'Wrong-password-35!',
    });
    const missingEmailResponse = await postSignIn({
      email: missingEmail,
      password: 'Any-password-35!',
    });

    expect(missingEmailResponse.statusCode).toBe(401);
    expect(missingEmailResponse.json()).toEqual(invalidCredentialsResponse);
    expect(cookieHeaders(missingEmailResponse)).toEqual([]);

    expect({
      statusCode: missingEmailResponse.statusCode,
      body: missingEmailResponse.json(),
    }).toEqual({
      statusCode: wrongPasswordResponse.statusCode,
      body: wrongPasswordResponse.json(),
    });

    const auditEvents = await readAuditEvents('auth.signin_failed', null);

    expect(auditEvents).toContainEqual(expect.objectContaining({
      event_type: 'auth.signin_failed',
      severity: 'warn',
      profile_id: null,
      payload: expect.objectContaining({
        email: missingEmail,
        user_id: null,
      }),
    }));
  });

  it.each([
    ['missing email', { password: validPassword }],
    ['missing password', { email: uniqueEmail('missing_password') }],
    ['invalid email format', { email: 'not-an-email', password: validPassword }],
    ['extra fields', { email: uniqueEmail('extra'), password: validPassword, role: 'admin' }],
  ])('%s returns 400 schema_invalid', async (_caseName, payload) => {
    const response = await postSignIn(payload);
    const body = response.json();

    expect(response.statusCode).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: 'schema_invalid',
        message: 'Request body failed validation',
        details: {
          issues: expect.any(Array),
        },
      },
    });
    expect(body.error.details.issues.length).toBeGreaterThan(0);
    expect(cookieHeaders(response)).toEqual([]);
  });
});
