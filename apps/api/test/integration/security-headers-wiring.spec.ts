import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';

let app: Awaited<ReturnType<typeof buildServer>>;

const requiredHeaders = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
} as const;

type InjectResponse = Awaited<ReturnType<typeof app.inject>>;

function expectRequiredSecurityHeaders(response: InjectResponse): void {
  expect(response.headers).toMatchObject(requiredHeaders);
  expect(response.headers['x-powered-by']).toBeUndefined();
}

beforeAll(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('QC-6 security header wiring', () => {
  it('sets required security headers on successful GET responses', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expectRequiredSecurityHeaders(response);
  });

  it('sets required security headers on auth failures', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
    });

    expect(response.statusCode).toBe(401);
    expectRequiredSecurityHeaders(response);
  });

  it('sets required security headers on CSRF rejections', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      headers: {
        origin: 'https://evil.example',
      },
      payload: {
        email: 'builder@example.com',
        password: 'not-used',
      },
    });

    expect(response.statusCode).toBe(403);
    expectRequiredSecurityHeaders(response);
  });

  it('sets required security headers on 404 responses', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/not-found-for-qc6',
    });

    expect(response.statusCode).toBe(404);
    expectRequiredSecurityHeaders(response);
  });
});
