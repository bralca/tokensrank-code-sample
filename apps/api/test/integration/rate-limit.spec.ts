import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';
import {
  buildIngestPayload,
  createAccessKeyFixture,
  deleteAuthUsers,
} from './ingestion-test-helpers';

const createdUserIds = new Set<string>();
const originalFraudRateLimitMaxRequests = process.env.FRAUD_RATE_LIMIT_MAX_REQUESTS;
const originalGlobalRateLimitMaxRequests = process.env.INGESTION_GLOBAL_RATE_LIMIT_MAX_REQUESTS;
const originalGlobalRateLimitWindowSeconds = process.env.INGESTION_GLOBAL_RATE_LIMIT_WINDOW_SECONDS;

let app: Awaited<ReturnType<typeof buildServer>>;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function createFixture(scope: 'script' | 'self_reported', _label: string) {
  const shortScopeLabel = scope === 'script' ? 'sc' : 'sr';
  const fixture = await createAccessKeyFixture(scope, shortScopeLabel);
  createdUserIds.add(fixture.userId);
  return fixture;
}

async function postSessions(url: string, accessKey: string, label: string) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      origin: 'http://localhost:3000',
      authorization: `Bearer ${accessKey}`,
    },
    payload: buildIngestPayload(1, label),
  });
}

function expectRateLimited(response: Awaited<ReturnType<typeof postSessions>>) {
  const body = response.json();
  const retryAfter = Number.parseInt(String(response.headers['retry-after']), 10);

  expect(response.statusCode).toBe(429);
  expect(Number.isFinite(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThan(0);
  expect(body).toMatchObject({
    error: {
      code: 'rate_limited',
      message: 'Rate limit exceeded (3 req/sec)',
      details: {
        reset_at: expect.any(String),
        retry_after_seconds: retryAfter,
      },
    },
  });
  expect(new Date(body.error.details.reset_at).toString()).not.toBe('Invalid Date');
}

function expectThreeAllowedOneLimited(responses: Array<Awaited<ReturnType<typeof postSessions>>>) {
  const allowed = responses.filter((response) => response.statusCode === 202);
  const limited = responses.filter((response) => response.statusCode === 429);

  expect(allowed).toHaveLength(3);
  expect(limited).toHaveLength(1);
  expectRateLimited(limited[0]!);
}

beforeAll(async () => {
  process.env.FRAUD_RATE_LIMIT_MAX_REQUESTS = '0';
  process.env.INGESTION_GLOBAL_RATE_LIMIT_MAX_REQUESTS = '3';
  process.env.INGESTION_GLOBAL_RATE_LIMIT_WINDOW_SECONDS = '1';

  app = await buildServer({ logger: false });
  await app.ready();
});

beforeEach(async () => {
  await wait(1100);
});

afterAll(async () => {
  await app?.close();
  await deleteAuthUsers(createdUserIds);

  if (originalFraudRateLimitMaxRequests === undefined) {
    delete process.env.FRAUD_RATE_LIMIT_MAX_REQUESTS;
  } else {
    process.env.FRAUD_RATE_LIMIT_MAX_REQUESTS = originalFraudRateLimitMaxRequests;
  }

  if (originalGlobalRateLimitMaxRequests === undefined) {
    delete process.env.INGESTION_GLOBAL_RATE_LIMIT_MAX_REQUESTS;
  } else {
    process.env.INGESTION_GLOBAL_RATE_LIMIT_MAX_REQUESTS = originalGlobalRateLimitMaxRequests;
  }

  if (originalGlobalRateLimitWindowSeconds === undefined) {
    delete process.env.INGESTION_GLOBAL_RATE_LIMIT_WINDOW_SECONDS;
  } else {
    process.env.INGESTION_GLOBAL_RATE_LIMIT_WINDOW_SECONDS = originalGlobalRateLimitWindowSeconds;
  }
});

describe.sequential('global ingestion rate limiting middleware', () => {
  it('allows three script ingestion requests and rejects the fourth with Retry-After', async () => {
    const fixture = await createFixture('script', 'rate_script');
    const responses = await Promise.all(Array.from({ length: 4 }, (_, index) => (
      postSessions('/api/script/sessions', fixture.plaintext, `rate-script-${index}`)
    )));

    expectThreeAllowedOneLimited(responses);
  }, 120000);

  it('applies the same global ceiling across script and self-reported ingestion', async () => {
    const scriptFixture = await createFixture('script', 'rate_global_script');
    const selfReportedFixture = await createFixture('self_reported', 'rate_global_self');

    const [first, second, third, limited] = await Promise.all([
      postSessions('/api/script/sessions', scriptFixture.plaintext, 'rate-global-0'),
      postSessions('/api/self-reported/sessions', selfReportedFixture.plaintext, 'rate-global-1'),
      postSessions('/api/script/sessions', scriptFixture.plaintext, 'rate-global-2'),
      postSessions('/api/self-reported/sessions', selfReportedFixture.plaintext, 'rate-global-3'),
    ]);

    expectThreeAllowedOneLimited([first, second, third, limited]);
  }, 120000);

  it('does not count non-ingestion routes against the global ingestion limiter', async () => {
    const fixture = await createFixture('script', 'rate_non_ingest');

    for (let index = 0; index < 8; index += 1) {
      const healthResponse = await app.inject({
        method: 'GET',
        url: '/health',
        headers: {
          origin: 'http://localhost:3000',
          authorization: `Bearer ${fixture.plaintext}`,
        },
      });
      expect(healthResponse.statusCode).toBe(200);
    }

    const responses = await Promise.all(Array.from({ length: 4 }, (_, index) => (
      postSessions('/api/script/sessions', fixture.plaintext, `rate-non-ingest-${index}`)
    )));

    expectThreeAllowedOneLimited(responses);
  }, 20000);
});
