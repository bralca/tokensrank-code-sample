import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { adminClient } from '../../src/clients/supabase';
import { buildServer } from '../../src/server';
import { createDisposableAnonClient, createServiceRoleClient, resolveTestSchema } from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const createdUserIds = new Set<string>();
const validPassword = 'Correct-horse-battery-staple-38!';
const nextPassword = 'Correct-horse-battery-staple-39!';
const pwnedPassword123Suffix = 'C6008F9CAB4083784CBD1874F76618D2A97';

let app: Awaited<ReturnType<typeof buildServer>>;
let originalFetch: typeof globalThis.fetch;

type TestUser = {
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

  return `reset-confirm-${schema}-${safeLabel}-${uniqueSuffix()}@example.com`;
}

function uniqueHandle(label: string): string {
  const safeLabel = label.replace(/[^a-z0-9_]/g, '_').slice(0, 8);

  return `rc_${safeLabel}_${crypto.randomUUID().slice(0, 8)}`.slice(0, 30);
}

function mockHibpResponse(body = ''): void {
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.startsWith('https://api.pwnedpasswords.com/range/')) {
      return new Response(body, { status: 200 });
    }

    return await originalFetch(input, init);
  }) as typeof globalThis.fetch;
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

  throw new Error(`[password-reset-confirm] profile shell was not created for user ${userId}`);
}

async function createExistingUser(label: string): Promise<TestUser> {
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
    throw new Error(`[password-reset-confirm] createUser failed: ${error?.message ?? 'missing user'}`);
  }

  createdUserIds.add(data.user.id);

  const profile = await waitForProfile(data.user.id);
  const { data: updatedProfile, error: updateError } = await adminClient
    .from('profiles')
    .update({ handle })
    .eq('id', profile.id)
    .select('id,user_id,handle')
    .single();

  if (updateError || !updatedProfile) {
    throw new Error(`[password-reset-confirm] profile update failed: ${updateError?.message ?? 'missing profile'}`);
  }

  return {
    email,
    handle,
    profileId: updatedProfile.id,
    userId: data.user.id,
  };
}

async function generateRecoveryToken(email: string): Promise<string> {
  const authAdmin = createServiceRoleClient();
  const { data, error } = await authAdmin.auth.admin.generateLink({
    type: 'recovery',
    email,
  });

  if (error || !data.properties?.hashed_token) {
    throw new Error(`[password-reset-confirm] generateLink failed: ${error?.message ?? 'missing token'}`);
  }

  return data.properties.hashed_token;
}

async function postPasswordResetConfirm(payload: unknown, headers: Record<string, string> = {}) {
  return await app.inject({
    method: 'POST',
    url: '/api/auth/password-reset/confirm',
    headers: {
      origin: 'http://localhost:3000',
      ...headers,
    },
    payload: payload as Record<string, unknown>,
  });
}

function cookieHeaders(response: Awaited<ReturnType<typeof postPasswordResetConfirm>>): string[] {
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
    .limit(20);

  if (profileId !== undefined) {
    query = profileId === null ? query.is('profile_id', null) : query.eq('profile_id', profileId);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`[password-reset-confirm] audit lookup failed: ${error.message}`);
  }

  return data ?? [];
}

beforeAll(async () => {
  originalFetch = globalThis.fetch;
  app = await buildServer();
  await app.ready();
});

beforeEach(() => {
  mockHibpResponse();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await app?.close();

  globalThis.fetch = originalFetch;

  const authAdmin = createServiceRoleClient();

  for (const userId of createdUserIds) {
    await authAdmin.auth.admin.deleteUser(userId);
  }
});

describe('POST /api/auth/password-reset/confirm', () => {
  it('verifies a recovery token, updates the password, revokes old refresh tokens, and issues fresh cookies', async () => {
    const user = await createExistingUser('success');
    const oldSessionClient = createDisposableAnonClient(schema);
    const oldSession = await oldSessionClient.auth.signInWithPassword({
      email: user.email,
      password: validPassword,
    });

    expect(oldSession.error).toBeNull();
    expect(oldSession.data.session?.refresh_token).toEqual(expect.any(String));

    const token = await generateRecoveryToken(user.email);
    const response = await postPasswordResetConfirm(
      {
        token,
        new_password: nextPassword,
      },
      { origin: 'http://localhost:3000' },
    );
    const cookies = cookieHeaders(response);
    const joinedCookies = cookies.join('\n');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        message: 'Password updated. Please sign in.',
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
    expect(joinedCookies).toContain('Path=/');
    expect(joinedCookies).toContain('Path=/api/auth/refresh');

    const oldPasswordResult = await createDisposableAnonClient(schema).auth.signInWithPassword({
      email: user.email,
      password: validPassword,
    });
    expect(oldPasswordResult.error).not.toBeNull();

    const newPasswordResult = await createDisposableAnonClient(schema).auth.signInWithPassword({
      email: user.email,
      password: nextPassword,
    });
    expect(newPasswordResult.error).toBeNull();
    expect(newPasswordResult.data.user?.id).toBe(user.userId);

    const oldRefreshResult = await createDisposableAnonClient(schema).auth.refreshSession({
      refresh_token: oldSession.data.session?.refresh_token ?? '',
    });
    expect(oldRefreshResult.error).not.toBeNull();

    const auditEvents = await readAuditEvents('auth.password_reset_confirmed', user.profileId);
    expect(auditEvents).toContainEqual(expect.objectContaining({
      event_type: 'auth.password_reset_confirmed',
      severity: 'info',
      profile_id: user.profileId,
      payload: expect.objectContaining({
        reason_code: 'confirmed',
        user_id: user.userId,
      }),
    }));
  });

  it('returns 401 invalid_token for an invalid or expired recovery token', async () => {
    const response = await postPasswordResetConfirm(
      {
        token: 'not-a-real-recovery-token',
        new_password: nextPassword,
      },
      { origin: 'http://localhost:3000' },
    );

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'invalid_token',
        message: 'Password reset token is invalid or expired',
      },
    });
    expect(cookieHeaders(response)).toEqual([]);

    const auditEvents = await readAuditEvents('auth.password_reset_confirm_failed', null);
    expect(auditEvents).toContainEqual(expect.objectContaining({
      event_type: 'auth.password_reset_confirm_failed',
      severity: 'warn',
      profile_id: null,
      payload: expect.objectContaining({
        reason_code: 'invalid_token',
      }),
    }));
  });

  it('returns 400 password_breached before consuming the token when HIBP reports a hit', async () => {
    mockHibpResponse(`${pwnedPassword123Suffix}:12345`);

    const response = await postPasswordResetConfirm(
      {
        token: 'unused-token',
        new_password: 'password123',
      },
      { origin: 'http://localhost:3000' },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'password_breached',
        details: {
          field: 'new_password',
        },
      },
    });
    expect(cookieHeaders(response)).toEqual([]);
  });

  it('rejects camelCase newPassword payloads because the API contract is snake_case', async () => {
    const response = await postPasswordResetConfirm(
      {
        token: 'reset-token',
        newPassword: nextPassword,
      },
      { origin: 'http://localhost:3000' },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'schema_invalid',
      },
    });
  });
});
