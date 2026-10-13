import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';
import { createServiceRoleClient, resolveTestSchema } from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const createdUserIds = new Set<string>();

let app: Awaited<ReturnType<typeof buildServer>>;

function validSignUpPayload(label: string) {
  const safeLabel = label.replace(/[^a-z0-9_]/g, '_').slice(0, 16);
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    email: `signup-${schema}-${safeLabel}-${unique}@example.com`,
    password: 'correct-horse-battery-staple',
    handle: `signup_${safeLabel}_${unique}`.slice(0, 30),
  };
}

async function postSignUp(payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/sign-up',
    headers: {
      origin: 'http://localhost:3000',
    },
    payload,
  });
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();

  const admin = createServiceRoleClient();

  for (const userId of createdUserIds) {
    await admin.auth.admin.deleteUser(userId);
  }
});

describe('POST /api/auth/sign-up schema validation', () => {
  it.each([
    ['invalid email', { email: 'not-an-email' }],
    ['missing password', { password: undefined }],
    ['invalid handle', { handle: 'Uppercase' }],
    ['reserved handle', { handle: 'admin' }],
    ['extra field', { role: 'admin' }],
  ])('rejects %s before creating an account', async (_caseName, override) => {
    const payload = {
      ...validSignUpPayload('invalid'),
      ...override,
    };

    const response = await postSignUp(payload);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: expect.any(String),
        message: expect.any(String),
      },
    });
  });

  it('passes a valid sign-up payload through schema validation to the auth layer', async () => {
    const payload = validSignUpPayload('valid');
    const response = await postSignUp(payload);
    const body = response.json();

    expect(body.error?.code).not.toBe('schema_invalid');
    expect(body.error?.code).not.toBe('invalid_handle');

    if (response.statusCode === 302) {
      expect(body.data).toMatchObject({
        email: payload.email,
        handle: payload.handle,
      });

      createdUserIds.add(body.data.userId);
    }
  });
});
