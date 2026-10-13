import crypto from 'node:crypto';
import { parse as parseCookie } from 'cookie';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../../src/server';
import {
  createTestUser,
  deleteTestUsers,
  getAuthCookies,
} from './fixtures/auth-fixtures';

const createdUserIds = new Set<string>();
const originalFetch = globalThis.fetch.bind(globalThis);

let app: Awaited<ReturnType<typeof buildServer>>;

function uniqueHandle(label: string): string {
  return `qc6_${label}_${crypto.randomUUID().slice(0, 8)}`.slice(0, 30);
}

function uniqueEmail(label: string): string {
  return `qc6-${label}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@tokensrank.dev`;
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

function setCookieHeaders(response: Awaited<ReturnType<typeof app.inject>>): string[] {
  const raw = response.headers['set-cookie'];

  if (!raw) {
    return [];
  }

  return Array.isArray(raw) ? raw : [String(raw)];
}

function clearedCookie(response: Awaited<ReturnType<typeof app.inject>>, name: 'tr_at' | 'tr_rt') {
  const header = setCookieHeaders(response).find((value) => value.startsWith(`${name}=`));

  if (!header) {
    throw new Error(`[auth-wiring] Missing cleared cookie header for ${name}`);
  }

  return {
    header,
    parsed: parseCookie(header),
  };
}

beforeAll(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
});

beforeEach(() => {
  mockHibpResponse();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app?.close();
  await deleteTestUsers(createdUserIds);
});

describe('QC-6 auth round-trip wiring', () => {
  it('sets hardened auth cookies after successful sign-up', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up',
      headers: {
        origin: 'http://localhost:3000',
      },
      payload: {
        email: uniqueEmail('signup'),
        password: `Tr-${crypto.randomUUID()}-Aa1!`,
        handle: uniqueHandle('signup'),
      },
    });
    expect(response.statusCode, response.body).toBe(302);
    expect(response.headers.location).toBe('/onboarding');

    const body = response.json();
    createdUserIds.add(body.data.userId);

    const cookies = getAuthCookies(setCookieHeaders(response));

    expect(cookies.access.value).toBeTruthy();
    expect(cookies.refresh.value).toBeTruthy();
    expect(cookies.access.header).not.toContain('SameSite=None');
    expect(cookies.refresh.header).not.toContain('SameSite=None');
  });

  it('hydrates GET /api/me with a valid tr_at cookie', async () => {
    const user = await createTestUser({ label: 'me_valid', mode: 'self_reported' });
    createdUserIds.add(user.userId);

    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: {
        cookie: getAuthCookies(user).cookieHeader,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        userId: user.userId,
        email: user.email,
        handle: user.handle,
        mode: 'self_reported',
        onboarding: {
          step: 'mode_chosen',
        },
      },
    });
  });

  it('rejects GET /api/me without an auth token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized',
      },
    });
  });

  it('clears tr_at and tr_rt cookies on sign-out', async () => {
    const user = await createTestUser({ label: 'signout', mode: 'self_reported' });
    createdUserIds.add(user.userId);

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: {
        cookie: getAuthCookies(user).cookieHeader,
        origin: 'http://localhost:3000',
      },
    });
    const access = clearedCookie(response, 'tr_at');
    const refresh = clearedCookie(response, 'tr_rt');

    expect(response.statusCode).toBe(200);
    expect(access.parsed.tr_at).toBe('');
    expect(access.parsed['Max-Age']).toBe('0');
    expect(access.parsed.Path).toBe('/');
    expect(refresh.parsed.tr_rt).toBe('');
    expect(refresh.parsed['Max-Age']).toBe('0');
    expect(refresh.parsed.Path).toBe('/api/auth/refresh');
    expect(access.header).toContain('HttpOnly');
    expect(refresh.header).toContain('HttpOnly');
    expect(access.header).toContain('Secure');
    expect(refresh.header).toContain('Secure');
    expect(access.header).toContain('SameSite=Lax');
    expect(refresh.header).toContain('SameSite=Lax');
  });
});
