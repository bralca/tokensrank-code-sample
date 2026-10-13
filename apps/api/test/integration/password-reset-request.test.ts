import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { adminClient } from '../../src/clients/supabase';
import { passwordResetLimiter } from '../../src/services/rate-limit';
import { buildServer } from '../../src/server';
import { createServiceRoleClient, resolveTestSchema } from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const createdUserIds = new Set<string>();
const validPassword = 'Correct-horse-battery-staple-37!';

let app: Awaited<ReturnType<typeof buildServer>>;

type AuditEventRow = {
  event_type: string;
  payload: Record<string, unknown>;
  severity: string;
};

function uniqueSuffix(): string {
  return `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function uniqueEmail(label: string): string {
  const safeLabel = label.replace(/[^a-z0-9_]/g, '_').slice(0, 16);

  return `reset-${schema}-${safeLabel}-${uniqueSuffix()}@example.com`;
}

async function createExistingUser(label: string): Promise<{ email: string; userId: string }> {
  const authAdmin = createServiceRoleClient();
  const email = uniqueEmail(label);
  const { data, error } = await authAdmin.auth.admin.createUser({
    email,
    password: validPassword,
    email_confirm: true,
    user_metadata: {
      test_schema: schema,
    },
  });

  if (error || !data.user) {
    throw new Error(`[password-reset-request] createUser failed: ${error?.message ?? 'missing user'}`);
  }

  createdUserIds.add(data.user.id);

  return {
    email,
    userId: data.user.id,
  };
}

async function postPasswordReset(payload: unknown, headers: Record<string, string> = {}) {
  return await app.inject({
    method: 'POST',
    url: '/api/auth/password-reset/request',
    headers,
    payload: payload as Record<string, unknown>,
  });
}

async function readPasswordResetAuditEvents(): Promise<AuditEventRow[]> {
  const { data, error } = await adminClient
    .from('audit_events')
    .select('event_type,severity,payload')
    .eq('event_type', 'auth.password_reset_requested')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    throw new Error(`[password-reset-request] audit lookup failed: ${error.message}`);
  }

  return (data ?? []) as AuditEventRow[];
}

function expectGenericOk(response: Awaited<ReturnType<typeof postPasswordReset>>): void {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true });
  expect(response.headers['retry-after']).toBeUndefined();
}

function expireRateLimitEntry(ip: string): void {
  const limiterWithEntries = passwordResetLimiter as unknown as {
    entries: Map<string, { count: number; resetAtMs: number }>;
  };
  const entry = limiterWithEntries.entries.get(ip);

  if (!entry) {
    throw new Error(`[password-reset-request] missing rate limit entry for ${ip}`);
  }

  entry.resetAtMs = Date.now() - 1;
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

beforeEach(() => {
  passwordResetLimiter.reset();
});

afterAll(async () => {
  await app?.close();

  const authAdmin = createServiceRoleClient();

  for (const userId of createdUserIds) {
    await authAdmin.auth.admin.deleteUser(userId);
  }
});

describe('POST /api/auth/password-reset/request', () => {
  it('returns 200 with a generic body for an existing account email', async () => {
    const user = await createExistingUser('existing');
    const response = await postPasswordReset(
      { email: user.email },
      { 'x-forwarded-for': '203.0.113.10', origin: 'http://localhost:3000' },
    );

    expectGenericOk(response);
  });

  it('returns the same 200 body for a non-existent valid email', async () => {
    const response = await postPasswordReset(
      { email: uniqueEmail('missing') },
      { 'x-forwarded-for': '203.0.113.11', origin: 'http://localhost:3000' },
    );

    expectGenericOk(response);
  });

  it('returns the same 200 body for a malformed email', async () => {
    const response = await postPasswordReset(
      { email: 'not-an-email' },
      { 'x-forwarded-for': '203.0.113.12', origin: 'http://localhost:3000' },
    );

    expectGenericOk(response);
  });

  it('returns the same 200 body when the email field is missing', async () => {
    const response = await postPasswordReset(
      {},
      { 'x-forwarded-for': '203.0.113.13', origin: 'http://localhost:3000' },
    );

    expectGenericOk(response);
  });

  it('returns the same 200 body when strict request validation rejects extra fields', async () => {
    const response = await postPasswordReset(
      { email: uniqueEmail('extra'), unexpected: true },
      { 'x-forwarded-for': '203.0.113.14', origin: 'http://localhost:3000' },
    );

    expectGenericOk(response);
  });

  it('rate limits the 6th request from the same client IP and includes Retry-After', async () => {
    const ip = '203.0.113.20';

    for (let i = 0; i < 5; i += 1) {
      expectGenericOk(await postPasswordReset(
        { email: uniqueEmail(`limit_${i}`) },
        { 'x-forwarded-for': ip, origin: 'http://localhost:3000' },
      ));
    }

    const response = await postPasswordReset(
      { email: uniqueEmail('limit_blocked') },
      { 'x-forwarded-for': ip, origin: 'http://localhost:3000' },
    );

    expect(response.statusCode).toBe(429);
    expect(Number.parseInt(String(response.headers['retry-after']), 10)).toBeGreaterThan(0);
    expect(response.json()).toMatchObject({
      error: {
        code: 'rate_limited',
        message: expect.any(String),
        details: {
          reset_at: expect.any(String),
        },
      },
    });
  });

  it('does not throttle a different IP when one IP is exhausted', async () => {
    const throttledIp = '203.0.113.21';

    for (let i = 0; i < 5; i += 1) {
      await postPasswordReset(
        { email: uniqueEmail(`different_ip_${i}`) },
        { 'x-forwarded-for': throttledIp, origin: 'http://localhost:3000' },
      );
    }

    expect((await postPasswordReset(
      { email: uniqueEmail('different_ip_blocked') },
      { 'x-forwarded-for': throttledIp, origin: 'http://localhost:3000' },
    )).statusCode).toBe(429);

    expectGenericOk(await postPasswordReset(
      { email: uniqueEmail('different_ip_allowed') },
      { 'x-forwarded-for': '203.0.113.22', origin: 'http://localhost:3000' },
    ));
  });

  it('allows requests again after the rate limit window expires', async () => {
    const ip = '203.0.113.23';

    for (let i = 0; i < 5; i += 1) {
      await postPasswordReset(
        { email: uniqueEmail(`window_${i}`) },
        { 'x-forwarded-for': ip, origin: 'http://localhost:3000' },
      );
    }

    expect((await postPasswordReset(
      { email: uniqueEmail('window_blocked') },
      { 'x-forwarded-for': ip, origin: 'http://localhost:3000' },
    )).statusCode).toBe(429);

    expireRateLimitEntry(ip);

    expectGenericOk(await postPasswordReset(
      { email: uniqueEmail('window_allowed') },
      { 'x-forwarded-for': ip, origin: 'http://localhost:3000' },
    ));
  });

  it('logs audit events for accepted password reset requests', async () => {
    const email = uniqueEmail('audit_success');
    await postPasswordReset(
      { email },
      { 'cf-connecting-ip': '203.0.113.30', origin: 'http://localhost:3000' },
    );

    const events = await readPasswordResetAuditEvents();

    expect(events).toContainEqual(expect.objectContaining({
      event_type: 'auth.password_reset_requested',
      severity: 'info',
      payload: expect.objectContaining({
        client_ip: '203.0.113.30',
        email_domain: 'example.com',
        reason: 'requested',
      }),
    }));
  });

  it('logs warn audit events for validation failures without leaking the raw email', async () => {
    await postPasswordReset(
      { email: 'bad-email' },
      { 'x-real-ip': '203.0.113.31', origin: 'http://localhost:3000' },
    );

    const events = await readPasswordResetAuditEvents();

    expect(events).toContainEqual(expect.objectContaining({
      event_type: 'auth.password_reset_requested',
      severity: 'warn',
      payload: expect.objectContaining({
        client_ip: '203.0.113.31',
        email_domain: null,
        reason: 'validation_failed',
      }),
    }));
  });

  it('logs warn audit events when rate limiting blocks a request', async () => {
    const ip = '203.0.113.32';

    for (let i = 0; i < 6; i += 1) {
      await postPasswordReset(
        { email: uniqueEmail(`audit_limit_${i}`) },
        { 'x-forwarded-for': ip, origin: 'http://localhost:3000' },
      );
    }

    const events = await readPasswordResetAuditEvents();

    expect(events).toContainEqual(expect.objectContaining({
      event_type: 'auth.password_reset_requested',
      severity: 'warn',
      payload: expect.objectContaining({
        client_ip: ip,
        email_domain: 'example.com',
        reason: 'rate_limited',
      }),
    }));
  });

  it('keeps response timing consistent for existing and missing emails', async () => {
    const user = await createExistingUser('timing');
    const startedExisting = Date.now();

    expectGenericOk(await postPasswordReset(
      { email: user.email },
      { 'x-forwarded-for': '203.0.113.40', origin: 'http://localhost:3000' },
    ));

    const existingDuration = Date.now() - startedExisting;
    const startedMissing = Date.now();

    expectGenericOk(await postPasswordReset(
      { email: uniqueEmail('timing_missing') },
      { 'x-forwarded-for': '203.0.113.41', origin: 'http://localhost:3000' },
    ));

    const missingDuration = Date.now() - startedMissing;

    expect(existingDuration).toBeGreaterThanOrEqual(90);
    expect(missingDuration).toBeGreaterThanOrEqual(90);
    expect(Math.abs(existingDuration - missingDuration)).toBeLessThan(250);
  });

  it('applies CSRF origin protection without exposing account existence', async () => {
    const response = await postPasswordReset(
      { email: uniqueEmail('csrf') },
      { 'x-forwarded-for': '203.0.113.42', origin: 'http://attacker.example' },
    );

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'csrf_violation',
        message: 'Request origin not allowed',
      },
    });
  });
});
