import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';

type App = Awaited<ReturnType<typeof buildServer>>;
type InjectOptions = Parameters<App['inject']>[0];
type InjectResponse = Awaited<ReturnType<App['inject']>>;

let app: App;

function jsonOf(response: InjectResponse): unknown {
  return JSON.parse(response.body);
}

function expectCanonicalErrorEnvelope(response: InjectResponse, statusCode: number): void {
  expect(response.statusCode, response.body).toBe(statusCode);
  expect(jsonOf(response)).toEqual(expect.objectContaining({
    error: expect.objectContaining({
      code: expect.any(String) as string,
      message: expect.any(String) as string,
    }),
  }));
  expect(response.body).not.toContain('stack');
  expect(response.body).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  expect(response.body).not.toContain('service_role');
}

function withAllowedOrigin(request: InjectOptions): InjectOptions {
  const method = String(request.method ?? 'GET').toUpperCase();

  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return request;
  }

  return {
    ...request,
    headers: {
      origin: 'http://localhost:3000',
      ...(request.headers as Record<string, string> | undefined),
    },
  };
}

beforeAll(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('QC-4 Fastify route failure envelope coherence', () => {
  const cases: Array<{
    name: string;
    expectedStatus: number;
    request: InjectOptions;
  }> = [
    {
      name: 'POST /api/auth/sign-up rejects invalid body',
      expectedStatus: 400,
      request: {
        method: 'POST',
        url: '/api/auth/sign-up',
        payload: { email: 'not-an-email', password: 'short', handle: 'UPPER' },
      },
    },
    {
      name: 'POST /api/auth/sign-in rejects invalid body',
      expectedStatus: 400,
      request: {
        method: 'POST',
        url: '/api/auth/sign-in',
        payload: { email: 'not-an-email', password: 'pw' },
      },
    },
    {
      name: 'POST /api/auth/sign-out rejects missing auth',
      expectedStatus: 401,
      request: {
        method: 'POST',
        url: '/api/auth/sign-out',
      },
    },
    {
      name: 'POST /api/auth/password-reset/confirm rejects invalid body',
      expectedStatus: 400,
      request: {
        method: 'POST',
        url: '/api/auth/password-reset/confirm',
        payload: { token: '', new_password: 'short' },
      },
    },
    {
      name: 'GET /api/admin/metrics rejects missing admin token',
      expectedStatus: 401,
      request: {
        method: 'GET',
        url: '/api/admin/metrics',
      },
    },
    {
      name: 'POST /api/admin/cache/purge rejects missing admin token',
      expectedStatus: 401,
      request: {
        method: 'POST',
        url: '/api/admin/cache/purge',
        payload: { all: true },
      },
    },
    {
      name: 'GET /api/access-keys rejects missing auth',
      expectedStatus: 401,
      request: {
        method: 'GET',
        url: '/api/access-keys',
      },
    },
    {
      name: 'POST /api/access-keys/generate rejects missing auth',
      expectedStatus: 401,
      request: {
        method: 'POST',
        url: '/api/access-keys/generate',
        payload: { scope: 'script' },
      },
    },
    {
      name: 'DELETE /api/access-keys/:key_id rejects missing auth',
      expectedStatus: 401,
      request: {
        method: 'DELETE',
        url: '/api/access-keys/not-a-uuid',
      },
    },
    {
      name: 'POST /api/script/sessions rejects missing access key',
      expectedStatus: 401,
      request: {
        method: 'POST',
        url: '/api/script/sessions',
        payload: { client: {}, run: {}, sessions: [] },
      },
    },
    {
      name: 'POST /api/self-reported/sessions rejects missing access key',
      expectedStatus: 401,
      request: {
        method: 'POST',
        url: '/api/self-reported/sessions',
        payload: { client: {}, run: {}, sessions: [] },
      },
    },
    {
      name: 'GET /api/leaderboard rejects invalid query',
      expectedStatus: 400,
      request: {
        method: 'GET',
        url: '/api/leaderboard?period=lifetime&scope=all&limit=20&offset=0',
      },
    },
    {
      name: 'GET /api/handle/check rejects missing handle query',
      expectedStatus: 400,
      request: {
        method: 'GET',
        url: '/api/handle/check',
      },
    },
    {
      name: 'GET /api/handles/check rejects missing handle query',
      expectedStatus: 400,
      request: {
        method: 'GET',
        url: '/api/handles/check',
      },
    },
    {
      name: 'PATCH /api/me/profile rejects missing auth',
      expectedStatus: 401,
      request: {
        method: 'PATCH',
        url: '/api/me/profile',
        payload: { display_name: 'QC Builder' },
      },
    },
    {
      name: 'GET /api/me rejects missing auth',
      expectedStatus: 401,
      request: {
        method: 'GET',
        url: '/api/me',
      },
    },
    {
      name: 'GET /api/profile/:handle rejects invalid handle',
      expectedStatus: 400,
      request: {
        method: 'GET',
        url: '/api/profile/Invalid.Handle',
      },
    },
    {
      name: 'GET /api/og/profile/:handle rejects invalid handle',
      expectedStatus: 400,
      request: {
        method: 'GET',
        url: '/api/og/profile/Invalid.Handle',
      },
    },
    {
      name: 'GET /api/og/u/:handle.png rejects invalid handle',
      expectedStatus: 400,
      request: {
        method: 'GET',
        url: '/api/og/u/Invalid.Handle.png',
      },
    },
  ];

  it.each(cases)('$name', async ({ expectedStatus, request }) => {
    const response = await app.inject(withAllowedOrigin(request));

    expectCanonicalErrorEnvelope(response, expectedStatus);
  });

  it('keeps password reset request responses anti-enumerable for invalid input', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/request',
      headers: {
        origin: 'http://localhost:3000',
      },
      payload: { email: 'not-an-email' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(jsonOf(response)).toEqual({ ok: true });
  });
});
