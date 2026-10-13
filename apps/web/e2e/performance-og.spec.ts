import { expect, test } from '@playwright/test';

import { getPngMetadata, seedOGProfile } from './og-test-data';

const FIRST_RENDER_BUDGET_MS = Number.parseFloat(process.env.PERF_OG_FIRST_RENDER_MS ?? '200');
const CACHED_RENDER_BUDGET_MS = Number.parseFloat(process.env.PERF_OG_CACHED_RENDER_MS ?? '10');

async function timedRequest<T>(operation: () => Promise<T>): Promise<{ result: T; latencyMs: number }> {
  const startedAt = performance.now();
  const result = await operation();

  return {
    result,
    latencyMs: performance.now() - startedAt,
  };
}

test.describe.configure({ mode: 'serial' });

test.skip(({ browserName }) => browserName !== 'chromium', 'Server-generated PNG performance runs once in Chromium.');

test.beforeAll(async () => {
  await seedOGProfile('alex');
});

test('GET /og/u/:handle.png meets first-render and ETag cache performance budgets', async ({ request }) => {
  const fontWarmup = await request.get('/og/u/alex.png?v=a');

  expect(fontWarmup.status()).toBe(200);

  const first = await timedRequest(async () => await request.get('/og/u/alex.png?v=b'));
  const firstResponse = first.result;

  expect(firstResponse.status()).toBe(200);
  expect(firstResponse.headers()['content-type']).toContain('image/png');
  expect(firstResponse.headers()['cache-control']).toContain('max-age=3600');
  expect(first.latencyMs, `OG first render ${first.latencyMs.toFixed(2)}ms exceeded ${FIRST_RENDER_BUDGET_MS}ms`).toBeLessThan(FIRST_RENDER_BUDGET_MS);

  const body = Buffer.from(await firstResponse.body());
  await expect(getPngMetadata(body)).resolves.toEqual({
    width: 1200,
    height: 630,
  });

  const etag = firstResponse.headers().etag;

  expect(etag).toBeDefined();

  const cached = await timedRequest(async () => await request.get('/og/u/alex.png?v=b', {
    headers: {
      'If-None-Match': etag ?? '',
    },
  }));

  expect(cached.result.status()).toBe(304);
  expect(cached.result.headers().etag).toBe(etag);
  expect(cached.latencyMs, `OG cached render ${cached.latencyMs.toFixed(2)}ms exceeded ${CACHED_RENDER_BUDGET_MS}ms`).toBeLessThan(CACHED_RENDER_BUDGET_MS);
});
