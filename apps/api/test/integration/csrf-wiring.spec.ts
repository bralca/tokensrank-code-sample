import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';

let app: Awaited<ReturnType<typeof buildServer>>;

async function postProfileMutation(origin?: string) {
  return await app.inject({
    method: 'PATCH',
    url: '/api/me/profile',
    headers: origin ? { origin } : {},
    payload: {
      displayName: 'QC-6 CSRF Wiring',
    },
  });
}

function expectAllowedButUnauthenticated(response: Awaited<ReturnType<typeof postProfileMutation>>) {
  expect(response.statusCode).toBe(401);
  expect(response.json()).toEqual({
    error: {
      code: 'unauthorized',
      message: 'Unauthorized',
    },
  });
}

beforeAll(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('QC-6 CSRF origin whitelist wiring', () => {
  it('allows mutating requests from tokensrank.ai before auth handling', async () => {
    const response = await postProfileMutation('https://tokensrank.ai');

    expectAllowedButUnauthenticated(response);
  });

  it('allows mutating requests from www.tokensrank.ai before auth handling', async () => {
    const response = await postProfileMutation('https://www.tokensrank.ai');

    expectAllowedButUnauthenticated(response);
  });

  it('allows mutating requests from localhost:3000 before auth handling', async () => {
    const response = await postProfileMutation('http://localhost:3000');

    expectAllowedButUnauthenticated(response);
  });

  it('rejects mutating requests from disallowed origins', async () => {
    const response = await postProfileMutation('https://evil.example');

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'csrf_violation',
        message: 'Request origin not allowed',
      },
    });
  });

  it('exempts GET requests from CSRF origin validation', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: {
        origin: 'https://evil.example',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('unauthorized');
  });
});
