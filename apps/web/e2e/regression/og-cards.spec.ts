import { createHash } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { getPngMetadata, seedOGProfile } from '../og-test-data';

test.describe.configure({ mode: 'serial' });

const ogHandle = 'alex';
const cacheControlPattern = /public,.*max-age=3600.*stale-while-revalidate=86400/u;

async function readPngHash(responseBody: Buffer): Promise<string> {
  return createHash('sha256').update(responseBody).digest('hex');
}

test.beforeAll(async () => {
  await seedOGProfile(ogHandle);
});

test('OG card variant A renders as a cached 1200x630 PNG with ETag', async ({ request }) => {
  const response = await request.get(`/og/u/${ogHandle}.png?v=a`);
  const body = Buffer.from(await response.body());

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('image/png');
  expect(response.headers().etag).toMatch(/^"[a-f0-9]{16}"$/u);
  expect(response.headers()['cache-control']).toMatch(cacheControlPattern);
  expect(await getPngMetadata(body)).toEqual({
    width: 1200,
    height: 630,
  });
  expect(await readPngHash(body)).toHaveLength(64);
});

test('OG card variant B renders statement mode and visually differs from variant A', async ({ request }) => {
  const [variantAResponse, variantBResponse] = await Promise.all([
    request.get(`/og/u/${ogHandle}.png?v=a`),
    request.get(`/og/u/${ogHandle}.png?v=b`),
  ]);
  const variantABody = Buffer.from(await variantAResponse.body());
  const variantBBody = Buffer.from(await variantBResponse.body());
  const variantAHash = await readPngHash(variantABody);
  const variantBHash = await readPngHash(variantBBody);

  expect(variantBResponse.status()).toBe(200);
  expect(variantBResponse.headers()['content-type']).toContain('image/png');
  expect(variantBResponse.headers().etag).toMatch(/^"[a-f0-9]{16}"$/u);
  expect(await getPngMetadata(variantBBody)).toEqual({
    width: 1200,
    height: 630,
  });
  expect(variantBHash).not.toBe(variantAHash);
  expect(variantBResponse.headers().etag).not.toBe(variantAResponse.headers().etag);
});

test('OG cards honor ETag validators and stale-while-revalidate caching', async ({ request }) => {
  const firstResponse = await request.get(`/og/u/${ogHandle}.png?v=b`);
  const etag = firstResponse.headers().etag;

  expect(firstResponse.status()).toBe(200);
  expect(etag).toBeDefined();
  expect(firstResponse.headers()['cache-control']).toMatch(cacheControlPattern);

  const validatedResponse = await request.get(`/og/u/${ogHandle}.png?v=b`, {
    headers: {
      'If-None-Match': etag,
    },
  });

  expect(validatedResponse.status()).toBe(304);
  expect(validatedResponse.headers().etag).toBe(etag);
  expect(validatedResponse.headers()['cache-control']).toMatch(cacheControlPattern);
});

test('OG card variants match visual baselines', async ({ request, browserName }) => {
  test.skip(browserName !== 'chromium', 'Server-generated PNG visual snapshots run once in Chromium.');

  const [variantAResponse, variantBResponse] = await Promise.all([
    request.get(`/og/u/${ogHandle}.png?v=a`),
    request.get(`/og/u/${ogHandle}.png?v=b`),
  ]);

  expect(variantAResponse.status()).toBe(200);
  expect(variantBResponse.status()).toBe(200);
  expect(await variantAResponse.body()).toMatchSnapshot('og-outcome-variant-a.png', {
    maxDiffPixels: 1,
  });
  expect(await variantBResponse.body()).toMatchSnapshot('og-outcome-variant-b.png', {
    maxDiffPixels: 1,
  });
});

test('OG card route handles invalid params, missing profiles, and concurrent requests', async ({ request }) => {
  const invalidHandle = await request.get('/og/u/x.png?v=a');
  const missingProfile = await request.get('/og/u/missingprofile.png?v=b');
  const invalidVariant = await request.get(`/og/u/${ogHandle}.png?v=statement`);
  const concurrentResponses = await Promise.all(
    Array.from({ length: 6 }, () => request.get(`/og/u/${ogHandle}.png?v=a`)),
  );

  expect(invalidHandle.status()).toBe(400);
  expect(invalidHandle.headers()['cache-control']).toBe('no-store');
  expect(missingProfile.status()).toBe(404);
  expect(missingProfile.headers()['cache-control']).toBe('no-store');
  expect(invalidVariant.status()).toBe(200);
  expect(invalidVariant.headers()['content-type']).toContain('image/png');

  const etags = new Set(concurrentResponses.map((response) => response.headers().etag));
  expect(concurrentResponses.every((response) => response.status() === 200)).toBe(true);
  expect(etags.size).toBe(1);
});
