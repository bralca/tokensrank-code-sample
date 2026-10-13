import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';

const VALID_PROFILE_UPDATE = {
  displayName: 'CSRF Check',
};

let app: Awaited<ReturnType<typeof buildServer>>;

async function patchProfile(origin?: string) {
  return await app.inject({
    method: 'PATCH',
    url: '/api/me/profile',
    headers: origin ? { origin } : {},
    payload: VALID_PROFILE_UPDATE,
  });
}

function expectCsrfViolation(response: Awaited<ReturnType<typeof patchProfile>>) {
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({
    error: {
      code: 'csrf_violation',
      message: 'Request origin not allowed',
    },
  });
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

describe('CSRF origin validation', () => {
  it('allows mutating requests from the apex production origin', async () => {
    const response = await patchProfile('https://tokensrank.ai');

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized',
      },
    });
  });

  it('rejects mutating requests from invalid origins', async () => {
    const response = await patchProfile('https://attacker.example');

    expectCsrfViolation(response);
  });

  it('rejects mutating requests with a missing Origin header before auth middleware', async () => {
    const response = await patchProfile();

    expectCsrfViolation(response);
  });

  it('bypasses CSRF validation for GET requests', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.statusCode).toBe(200);
  });

  it('allows mutating requests from the www production origin', async () => {
    const response = await patchProfile('https://www.tokensrank.ai');

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('unauthorized');
  });

  it('allows mutating requests from the localhost development origin', async () => {
    const response = await patchProfile('http://localhost:3000');

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('unauthorized');
  });

  it('returns the canonical csrf_violation error envelope', async () => {
    const response = await patchProfile('http://malicious.localhost');

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'csrf_violation',
        message: 'Request origin not allowed',
      },
    });
  });

  it('bypasses CSRF validation for HEAD requests', async () => {
    const response = await app.inject({
      method: 'HEAD',
      url: '/healthz',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
  });

  it('bypasses CSRF validation for OPTIONS requests', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/me/profile',
    });

    expect(response.statusCode).not.toBe(403);
  });
});
