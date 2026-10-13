import crypto from 'node:crypto';
import { parse as parseCookie } from 'cookie';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { adminClient } from '../../src/clients/supabase';
import { buildServer } from '../../src/server';
import {
  createDisposableAnonClient,
  createServiceRoleClient,
  resolveTestSchema,
} from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const createdUserIds = new Set<string>();
const originalFetch = globalThis.fetch.bind(globalThis);
const validPassword = 'Correct-horse-battery-staple-66!';

let app: Awaited<ReturnType<typeof buildServer>>;

type TestProfile = {
  accessToken: string;
  email: string;
  handle: string;
  profileId: string;
  refreshToken: string;
  userId: string;
};

function uniqueSuffix(): string {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function safeLabel(label: string, maxLength: number): string {
  return label.replace(/[^a-z0-9_]/g, '_').slice(0, maxLength);
}

function safeEmailSegment(value: string, maxLength: number): string {
  return value.replace(/[^a-z0-9.-]/g, '-').slice(0, maxLength);
}

function uniqueEmail(prefix: string, label: string, domain = 'example.com'): string {
  return [
    safeEmailSegment(prefix, 24),
    safeEmailSegment(schema, 32),
    safeEmailSegment(label, 14),
    uniqueSuffix(),
  ].join('-') + `@${domain}`;
}

function uniqueHandle(label: string): string {
  return `ck_${safeLabel(label, 9)}_${crypto.randomUUID().slice(0, 8)}`.slice(0, 30);
}

function mockHibpResponse(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.startsWith('https://api.pwnedpasswords.com/range/')) {
      return new Response('00000000000000000000000000000000000:0', { status: 200 });
    }

    return originalFetch(input, init);
  });
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

  throw new Error(`[auth-cookies] profile shell was not created for user ${userId}`);
}

async function createTestProfile(label: string): Promise<TestProfile> {
  const authAdmin = createServiceRoleClient();
  const anon = createDisposableAnonClient(schema);
  const email = uniqueEmail('cookies', label);
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
    throw new Error(`[auth-cookies] createUser failed: ${error?.message ?? 'missing user'}`);
  }

  createdUserIds.add(data.user.id);

  await waitForProfile(data.user.id);

  const { data: updatedProfile, error: updateError } = await adminClient
    .from('profiles')
    .update({ handle })
    .eq('user_id', data.user.id)
    .select('id,user_id,handle')
    .single();

  if (updateError || !updatedProfile) {
    throw new Error(`[auth-cookies] profile update failed: ${updateError?.message ?? 'missing profile'}`);
  }

  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({
    email,
    password: validPassword,
  });

  if (signInError || !signInData.session) {
    throw new Error(`[auth-cookies] signIn failed: ${signInError?.message ?? 'missing session'}`);
  }

  return {
    accessToken: signInData.session.access_token,
    email,
    handle: updatedProfile.handle,
    profileId: updatedProfile.id,
    refreshToken: signInData.session.refresh_token,
    userId: data.user.id,
  };
}

async function postSignUp(label: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up',
    headers: {
      origin: 'http://localhost:3000',
    },
    payload: {
      email: uniqueEmail('signupcookies', label, 'tokensrank.dev'),
      password: `Tr-${crypto.randomUUID()}-Aa1!`,
      handle: uniqueHandle(label),
    },
  });

  if (response.statusCode === 302) {
    createdUserIds.add(response.json().data.userId);
  }

  return response;
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

async function postRefresh(cookie: string | undefined) {
  return await app.inject({
    method: 'POST',
    url: '/api/auth/refresh',
    headers: {
      origin: 'http://localhost:3000',
      ...(cookie ? { cookie } : {}),
    },
  });
}

async function postSignOut(cookie: string) {
  return await app.inject({
    method: 'POST',
    url: '/api/auth/sign-out',
    headers: {
      origin: 'http://localhost:3000',
      cookie,
    },
  });
}

function cookieHeaders(response: Awaited<ReturnType<typeof app.inject>>): string[] {
  const setCookie = response.headers['set-cookie'];

  if (!setCookie) {
    return [];
  }

  return Array.isArray(setCookie) ? setCookie : [String(setCookie)];
}

function cookieHeaderFor(response: Awaited<ReturnType<typeof app.inject>>, name: string): string {
  const header = cookieHeaders(response).find((value) => value.startsWith(`${name}=`));

  if (!header) {
    throw new Error(`[auth-cookies] missing Set-Cookie header for ${name}`);
  }

  return header;
}

function cookieValue(header: string, name: string): string {
  const [pair] = header.split(';');
  const [, rawValue = ''] = pair?.split('=') ?? [];

  expect(pair?.startsWith(`${name}=`)).toBe(true);

  return decodeURIComponent(rawValue);
}

function hasCookieAttribute(header: string, attribute: string): boolean {
  return header
    .split(';')
    .map((part) => part.trim().toLowerCase())
    .includes(attribute.toLowerCase());
}

function expectAccessCookie(header: string): void {
  const parsed = parseCookie(header);

  expect(cookieValue(header, 'tr_at').length).toBeGreaterThan(20);
  expect(parsed['Max-Age']).toBe('3600');
  expect(parsed.Path).toBe('/');
  expect(parsed.SameSite).toBe('Lax');
  expect(hasCookieAttribute(header, 'HttpOnly')).toBe(true);
  expect(hasCookieAttribute(header, 'Secure')).toBe(true);
  expect(header).not.toContain('SameSite=None');
}

function expectRefreshCookie(header: string): void {
  const parsed = parseCookie(header);

  expect(cookieValue(header, 'tr_rt').length).toBeGreaterThan(0);
  expect(parsed['Max-Age']).toBe('2592000');
  expect(parsed.Path).toBe('/api/auth/refresh');
  expect(parsed.SameSite).toBe('Lax');
  expect(hasCookieAttribute(header, 'HttpOnly')).toBe(true);
  expect(hasCookieAttribute(header, 'Secure')).toBe(true);
  expect(header).not.toContain('SameSite=None');
}

function expectAuthCookies(response: Awaited<ReturnType<typeof app.inject>>): void {
  const cookies = cookieHeaders(response);

  expect(cookies).toHaveLength(2);
  expectAccessCookie(cookieHeaderFor(response, 'tr_at'));
  expectRefreshCookie(cookieHeaderFor(response, 'tr_rt'));
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

beforeEach(() => {
  process.env.SUPABASE_SCHEMA = schema;
  mockHibpResponse();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app?.close();

  const authAdmin = createServiceRoleClient();

  for (const userId of createdUserIds) {
    await authAdmin.auth.admin.deleteUser(userId);
  }
});

describe('authentication cookies', () => {
  it('sign-up success issues tr_at and tr_rt with required flags', async () => {
    const response = await postSignUp('signup');

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/onboarding');
    expectAuthCookies(response);
  });

  it('sign-in success issues tr_at and tr_rt with required flags', async () => {
    const profile = await createTestProfile('signin');
    const response = await postSignIn({
      email: profile.email,
      password: validPassword,
    });

    expect(response.statusCode).toBe(200);
    expectAuthCookies(response);
  });

  it('refresh uses the tr_rt cookie and reissues both authentication cookies', async () => {
    const profile = await createTestProfile('refresh');
    const response = await postRefresh(`tr_rt=${encodeURIComponent(profile.refreshToken)}`);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        user_id: profile.userId,
        session: {
          access_token: expect.any(String),
          refresh_token: expect.any(String),
        },
      },
    });
    expectAuthCookies(response);
  });

  it('refresh without tr_rt returns 401 without Set-Cookie', async () => {
    const response = await postRefresh(undefined);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: 'missing_refresh_token',
      },
    });
    expect(cookieHeaders(response)).toEqual([]);
  });

  it('sign-out clears tr_at and tr_rt using matching paths and secure flags', async () => {
    const profile = await createTestProfile('signout');
    const response = await postSignOut(`tr_at=${encodeURIComponent(profile.accessToken)}`);
    const accessCookie = parseCookie(cookieHeaderFor(response, 'tr_at'));
    const refreshCookie = parseCookie(cookieHeaderFor(response, 'tr_rt'));

    expect(response.statusCode).toBe(200);
    expect(accessCookie.tr_at).toBe('');
    expect(accessCookie['Max-Age']).toBe('0');
    expect(accessCookie.Path).toBe('/');
    expect(refreshCookie.tr_rt).toBe('');
    expect(refreshCookie['Max-Age']).toBe('0');
    expect(refreshCookie.Path).toBe('/api/auth/refresh');

    for (const header of cookieHeaders(response)) {
      expect(parseCookie(header).SameSite).toBe('Lax');
      expect(hasCookieAttribute(header, 'HttpOnly')).toBe(true);
      expect(hasCookieAttribute(header, 'Secure')).toBe(true);
      expect(header).not.toContain('SameSite=None');
    }
  });

  it('tr_rt cookie is HttpOnly', async () => {
    const profile = await createTestProfile('rt_httponly');
    const response = await postSignIn({
      email: profile.email,
      password: validPassword,
    });

    expect(response.statusCode).toBe(200);
    expect(hasCookieAttribute(cookieHeaderFor(response, 'tr_rt'), 'HttpOnly')).toBe(true);
  });

  it('tr_rt cookie is scoped to /api/auth/refresh', async () => {
    const profile = await createTestProfile('rt_path');
    const response = await postSignIn({
      email: profile.email,
      password: validPassword,
    });
    const refreshCookie = parseCookie(cookieHeaderFor(response, 'tr_rt'));

    expect(response.statusCode).toBe(200);
    expect(refreshCookie.Path).toBe('/api/auth/refresh');
  });
});
