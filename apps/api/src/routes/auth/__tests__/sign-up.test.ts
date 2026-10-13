import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServiceRoleClient, resolveTestSchema } from '../../../../test/integration/setup';
import { buildServer } from '../../../server';
import { adminClient } from '../../../clients/supabase';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const createdUserIds = new Set<string>();
const originalFetch = globalThis.fetch.bind(globalThis);
const pwnedPassword123Suffix = 'C6008F9CAB4083784CBD1874F76618D2A97';
const postgrestSchemaRetryDelaysMs = [150, 300, 600] as const;

let app: Awaited<ReturnType<typeof buildServer>>;

function uniqueSuffix(): string {
  return `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

function uniqueHandle(label: string): string {
  const safeLabel = label.replace(/[^a-z0-9_]/g, '_').slice(0, 8);

  return `su_${safeLabel}_${Math.random().toString(36).slice(2, 8)}`.slice(0, 30);
}

function validPassword(): string {
  return `Tr-${crypto.randomUUID()}-Aa1!`;
}

function validPayload(label: string) {
  const safeLabel = label.replace(/[^a-z0-9_]/g, '_').slice(0, 10);
  const safeEmailLabel = label.replace(/[^a-z0-9]/g, '').slice(0, 10);
  const safeSchema = schema.replace(/[^a-z0-9]/g, '').slice(0, 14);

  return {
    email: `signup-${safeSchema}-${safeEmailLabel}-${uniqueSuffix()}@example.com`,
    password: validPassword(),
    handle: uniqueHandle(safeLabel),
  };
}

function mockHibpResponse(body: string): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.startsWith('https://api.pwnedpasswords.com/range/')) {
      return new Response(body, { status: 200 });
    }

    return originalFetch(input, init);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isTransientPostgrestSchemaCacheError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();

  return normalized.includes('schema cache')
    || normalized.includes('could not find the table')
    || normalized.includes('pgrst205')
    || normalized.includes('pgrst106');
}

async function withPostgrestSchemaRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= postgrestSchemaRetryDelaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (
        !isTransientPostgrestSchemaCacheError(message)
        || attempt === postgrestSchemaRetryDelaysMs.length
      ) {
        throw error;
      }

      lastError = error;

      const delay = postgrestSchemaRetryDelaysMs[attempt];

      if (delay === undefined) {
        throw error;
      }

      await sleep(delay);
    }
  }

  throw lastError;
}

async function postSignUp(payload: unknown) {
  return await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up',
    headers: {
      origin: 'http://localhost:3000',
    },
    payload: payload as Record<string, unknown>,
  });
}

function expectError(response: Awaited<ReturnType<typeof postSignUp>>, statusCode: number, code: string) {
  expect(response.statusCode).toBe(statusCode);
  expect(response.json()).toMatchObject({
    error: {
      code,
      message: expect.any(String),
    },
  });
}

async function signUp(label: string, override: Partial<ReturnType<typeof validPayload>> = {}) {
  const payload = {
    ...validPayload(label),
    ...override,
  };
  const response = await postSignUp(payload);
  const body = response.json();

  if (response.statusCode !== 302) {
    throw new Error(`[sign-up-test] Expected 302, received ${response.statusCode}: ${response.body}`);
  }

  createdUserIds.add(body.data.userId);

  return {
    body,
    payload,
    response,
  };
}

async function readProfile(userId: string) {
  return await withPostgrestSchemaRetry(async () => {
    const { data, error } = await adminClient
      .from('profiles')
      .select('id,user_id,handle')
      .eq('user_id', userId)
      .single();

    if (error) {
      throw new Error(`[sign-up-test] profile lookup failed: ${error.message}`);
    }

    return data;
  });
}

async function readAuditEvents(profileId: string) {
  return await withPostgrestSchemaRetry(async () => {
    const { data, error } = await adminClient
      .from('audit_events')
      .select('event_type,severity,profile_id,payload')
      .eq('profile_id', profileId)
      .eq('event_type', 'user.signed_up');

    if (error) {
      throw new Error(`[sign-up-test] audit lookup failed: ${error.message}`);
    }

    return data ?? [];
  });
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

beforeEach(() => {
  mockHibpResponse('00000000000000000000000000000000000:0');
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

describe('POST /api/auth/sign-up', () => {
  it('returns 302 with auth cookies and creates the profile shell handle', async () => {
    const { body, payload, response } = await signUp('happy');
    const setCookie = response.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];

    expect(response.headers.location).toBe('/onboarding');
    expect(cookies).toEqual(expect.arrayContaining([
      expect.stringContaining('tr_at='),
      expect.stringContaining('tr_rt='),
    ]));
    expect(cookies.join('\n')).toContain('HttpOnly');
    expect(cookies.join('\n')).toContain('Secure');
    expect(cookies.join('\n')).toContain('SameSite=Lax');
    expect(cookies.join('\n')).toContain('Max-Age=3600');
    expect(cookies.join('\n')).toContain('Max-Age=2592000');

    const profile = await readProfile(body.data.userId);

    expect(profile).toMatchObject({
      user_id: body.data.userId,
      handle: payload.handle,
    });
  });

  it('returns 409 email_taken for duplicate email', async () => {
    const first = await signUp('email_dupe');
    const response = await postSignUp({
      ...validPayload('email_dupe_retry'),
      email: first.payload.email,
    });

    expectError(response, 409, 'email_taken');
  });

  it('returns 409 handle_taken for duplicate handle', async () => {
    const first = await signUp('handle_dupe');
    const response = await postSignUp({
      ...validPayload('handle_dupe_retry'),
      handle: first.payload.handle,
    });

    expectError(response, 409, 'handle_taken');
  });

  it('returns 400 invalid_handle for reserved handles', async () => {
    const response = await postSignUp({
      ...validPayload('reserved'),
      handle: 'admin',
    });

    expectError(response, 400, 'invalid_handle');
    expect(response.json().error.details).toMatchObject({
      field: 'handle',
      reason: 'reserved',
    });
  });

  it('returns 400 invalid_handle for invalid handle format', async () => {
    const response = await postSignUp({
      ...validPayload('invalid_handle'),
      handle: 'Uppercase',
    });

    expectError(response, 400, 'invalid_handle');
  });

  it('returns 400 password_breached for HIBP-listed passwords', async () => {
    mockHibpResponse(`${pwnedPassword123Suffix}:12345`);

    const response = await postSignUp({
      ...validPayload('breached'),
      password: 'password123',
    });

    expectError(response, 400, 'password_breached');
  });

  it('returns 400 schema_invalid for invalid email', async () => {
    const response = await postSignUp({
      ...validPayload('invalid_email'),
      email: 'not-an-email',
    });

    expectError(response, 400, 'schema_invalid');
  });

  it('returns 400 schema_invalid for extra fields', async () => {
    const response = await postSignUp({
      ...validPayload('extra'),
      role: 'admin',
    });

    expectError(response, 400, 'schema_invalid');
  });

  it('sets X-Request-ID on responses', async () => {
    const response = await postSignUp({
      ...validPayload('request_id'),
      handle: 'api',
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['x-request-id']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('does not persist a user.signed_up audit event after successful profile update', async () => {
    const { body } = await signUp('audit');
    const events = await readAuditEvents(body.data.profileId);

    expect(events).toEqual([]);
  });
});
