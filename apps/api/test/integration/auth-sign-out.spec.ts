import crypto from 'node:crypto';
import Fastify from 'fastify';
import { parse as parseCookie } from 'cookie';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { adminClient } from '../../src/clients/supabase';
import { authSignOutRoutes } from '../../src/routes/auth/sign-out';
import {
  createDisposableAnonClient,
  createServiceRoleClient,
  resolveTestSchema,
  teardownTestSchema,
} from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const teardownTestDatabase = teardownTestSchema;
const createdUserIds = new Set<string>();
const validPassword = 'Correct-horse-battery-staple-36!';

let app: ReturnType<typeof Fastify>;

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

  return `signout-${schema}-${safeLabel}-${uniqueSuffix()}@example.com`;
}

function uniqueHandle(label: string): string {
  const safeLabel = label.replace(/[^a-z0-9_]/g, '_').slice(0, 10);

  return `so_${safeLabel}_${crypto.randomUUID().slice(0, 8)}`.slice(0, 30);
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

  throw new Error(`[auth-sign-out] profile shell was not created for user ${userId}`);
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
    throw new Error(`[auth-sign-out] createUser failed: ${error?.message ?? 'missing user'}`);
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
    throw new Error(`[auth-sign-out] profile update failed: ${updateError?.message ?? 'missing profile'}`);
  }

  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({
    email,
    password: validPassword,
  });

  if (signInError || !signInData.session) {
    throw new Error(`[auth-sign-out] signIn failed: ${signInError?.message ?? 'missing session'}`);
  }

  return {
    accessToken: signInData.session.access_token,
    email,
    handle: updatedProfile.handle,
    profileId: updatedProfile.id,
    userId: data.user.id,
  };
}

async function postSignOut(headers: Record<string, string> = {}) {
  return await app.inject({
    method: 'POST',
    url: '/api/auth/sign-out',
    headers: {
      origin: 'http://localhost:3000',
      ...headers,
    },
  });
}

function cookieHeaders(response: Awaited<ReturnType<typeof postSignOut>>): string[] {
  const setCookie = response.headers['set-cookie'];

  if (!setCookie) {
    return [];
  }

  return Array.isArray(setCookie) ? setCookie : [String(setCookie)];
}

function cookieHeaderFor(response: Awaited<ReturnType<typeof postSignOut>>, name: string): string {
  const header = cookieHeaders(response).find((value) => value.startsWith(`${name}=`));

  if (!header) {
    throw new Error(`[auth-sign-out] missing Set-Cookie header for ${name}`);
  }

  return header;
}

function parsedCookie(header: string): Record<string, string> {
  return parseCookie(header);
}

function hasCookieAttribute(header: string, attribute: string): boolean {
  return header
    .split(';')
    .map((part) => part.trim().toLowerCase())
    .includes(attribute.toLowerCase());
}

async function readAuditEvents(profileId: string) {
  const { data, error } = await adminClient
    .from('audit_events')
    .select('event_type,severity,profile_id,payload,created_at')
    .eq('event_type', 'auth.sign_out')
    .eq('profile_id', profileId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    throw new Error(`[auth-sign-out] audit lookup failed: ${error.message}`);
  }

  return data ?? [];
}

beforeAll(async () => {
  app = Fastify({
    logger: false,
  });
  await app.register(authSignOutRoutes);
  await app.ready();
});

beforeEach(() => {
  process.env.SUPABASE_SCHEMA = schema;
});

afterAll(async () => {
  await app?.close();

  const authAdmin = createServiceRoleClient();

  for (const userId of createdUserIds) {
    await authAdmin.auth.admin.deleteUser(userId);
  }

  if (schema !== 'public') {
    await teardownTestDatabase(schema);
  }
});

describe('POST /api/auth/sign-out', () => {
  it('Unauthenticated requests return 401', async () => {
    const response = await postSignOut();

    expect(response.statusCode).toBe(401);
    expect(cookieHeaders(response)).toEqual([]);
  });

  it('tr_at cookie is cleared with Max-Age=0 and Path=/', async () => {
    const profile = await createTestProfile('access_cookie');
    const response = await postSignOut({
      cookie: `tr_at=${profile.accessToken}`,
    });
    const accessCookie = parsedCookie(cookieHeaderFor(response, 'tr_at'));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(accessCookie.tr_at).toBe('');
    expect(accessCookie['Max-Age']).toBe('0');
    expect(accessCookie.Path).toBe('/');
  });

  it('tr_rt cookie is cleared with Path=/api/auth/refresh', async () => {
    const profile = await createTestProfile('refresh_cookie');
    const response = await postSignOut({
      cookie: `tr_at=${profile.accessToken}`,
    });
    const refreshCookie = parsedCookie(cookieHeaderFor(response, 'tr_rt'));

    expect(response.statusCode).toBe(200);
    expect(refreshCookie.tr_rt).toBe('');
    expect(refreshCookie['Max-Age']).toBe('0');
    expect(refreshCookie.Path).toBe('/api/auth/refresh');
  });

  it('Both cleared cookies include SameSite=Lax, Secure, and HttpOnly', async () => {
    const profile = await createTestProfile('security_flags');
    const response = await postSignOut({
      cookie: `tr_at=${profile.accessToken}`,
    });

    expect(response.statusCode).toBe(200);

    for (const header of cookieHeaders(response)) {
      const parsed = parsedCookie(header);

      expect(parsed.SameSite).toBe('Lax');
      expect(hasCookieAttribute(header, 'Secure')).toBe(true);
      expect(hasCookieAttribute(header, 'HttpOnly')).toBe(true);
    }
  });

  it('Domain attribute is omitted outside production and present in production', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const profile = await createTestProfile('domain');

    try {
      process.env.NODE_ENV = 'test';
      const devResponse = await postSignOut({
        cookie: `tr_at=${profile.accessToken}`,
      });

      expect(devResponse.statusCode).toBe(200);
      expect(cookieHeaders(devResponse).join('\n')).not.toContain('Domain=');

      process.env.NODE_ENV = 'production';
      const prodResponse = await postSignOut({
        cookie: `tr_at=${profile.accessToken}`,
      });

      expect(prodResponse.statusCode).toBe(200);
      expect(cookieHeaders(prodResponse)).toEqual(expect.arrayContaining([
        expect.stringContaining('Domain=.tokensrank.ai'),
      ]));
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('Audit event is logged with severity=info', async () => {
    const profile = await createTestProfile('audit');
    const response = await postSignOut({
      cookie: `tr_at=${profile.accessToken}`,
    });
    const auditEvents = await readAuditEvents(profile.profileId);

    expect(response.statusCode).toBe(200);
    expect(auditEvents).toContainEqual(expect.objectContaining({
      event_type: 'auth.sign_out',
      severity: 'info',
      profile_id: profile.profileId,
      payload: expect.objectContaining({
        user_id: profile.userId,
      }),
    }));
  });

  it('Subsequent requests with cleared cookies fail authentication', async () => {
    const profile = await createTestProfile('cleared_cookie');
    const response = await postSignOut({
      cookie: `tr_at=${profile.accessToken}`,
    });
    const clearedCookie = cookieHeaders(response)
      .map((header) => header.split(';')[0])
      .join('; ');
    const subsequentResponse = await postSignOut({
      cookie: clearedCookie,
    });

    expect(response.statusCode).toBe(200);
    expect(subsequentResponse.statusCode).toBe(401);
  });
});
