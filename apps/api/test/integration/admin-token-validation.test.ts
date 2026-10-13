import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';

const adminToken = 'test-admin-token-32-characters-long';

let app: Awaited<ReturnType<typeof buildServer>>;
let originalAdminToken: string | undefined;

async function purgeWithToken(token: string) {
  return app.inject({
    method: 'POST',
    url: '/api/admin/cache/purge',
    headers: {
      origin: 'http://localhost:3000',
      authorization: `Bearer ${token}`,
    },
    payload: {
      all: true,
    },
  });
}

beforeAll(async () => {
  originalAdminToken = process.env.ADMIN_PURGE_TOKEN;
  process.env.ADMIN_PURGE_TOKEN = adminToken;

  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  if (originalAdminToken === undefined) {
    delete process.env.ADMIN_PURGE_TOKEN;
  } else {
    process.env.ADMIN_PURGE_TOKEN = originalAdminToken;
  }

  await app?.close();
});

describe('admin token validation', () => {
  it('accepts the configured admin purge token', async () => {
    const response = await purgeWithToken(adminToken);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        purged_count: 0,
      },
    });
  });

  it('rejects an invalid admin token with a generic 401', async () => {
    const response = await purgeWithToken('test-admin-token-32-characters-wrong');

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized',
      },
    });
  });

  it('rejects an empty admin token with a generic 401', async () => {
    const response = await purgeWithToken('');

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized',
      },
    });
  });

  it('rejects a wrong-length admin token with a generic 401', async () => {
    const response = await purgeWithToken('short');

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized',
      },
    });
  });
});
