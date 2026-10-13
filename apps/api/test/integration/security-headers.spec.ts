import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';

let app: Awaited<ReturnType<typeof buildServer>>;

const EXPECTED_SECURITY_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'strict-origin-when-cross-origin',
} as const;

type InjectResponse = Awaited<ReturnType<typeof app.inject>>;

function expectFastifySecurityHeaders(response: InjectResponse): void {
  expect(response.headers).toMatchObject(EXPECTED_SECURITY_HEADERS);
  expect(response.headers['x-powered-by']).toBeUndefined();
}

beforeAll(async () => {
  app = await buildServer({
    logger: false,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('security headers', () => {
  it('applies Fastify-owned security headers to GET responses', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expectFastifySecurityHeaders(response);
  });

  it('applies Fastify-owned security headers to POST responses', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      headers: {
        origin: 'https://attacker.example',
      },
      payload: {
        email: 'not-an-email',
        password: '',
      },
    });

    expect(response.statusCode).toBe(403);
    expectFastifySecurityHeaders(response);
  });

  it('applies Fastify-owned security headers to 404 responses', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/not-found',
    });

    expect(response.statusCode).toBe(404);
    expectFastifySecurityHeaders(response);
  });

  it('leaves CSP to Caddy while emitting HSTS at the API layer', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.headers['content-security-policy']).toBeUndefined();
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains; preload');
  });
});
