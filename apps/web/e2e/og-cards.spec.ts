import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';

import { getPngMetadata, seedOGProfile } from './og-test-data';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await seedOGProfile('alex');
});

test('GET /og/u/alex.png returns a PNG response', async ({ request }) => {
  const response = await request.get('/og/u/alex.png');

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('image/png');
});

test('OG PNG dimensions are exactly 1200x630', async ({ request }) => {
  const response = await request.get('/og/u/alex.png?v=b');
  const body = Buffer.from(await response.body());
  const metadata = await getPngMetadata(body);

  expect(metadata).toEqual({
    width: 1200,
    height: 630,
  });
});

test('OG route sets one-hour cache and one-day stale headers', async ({ request }) => {
  const response = await request.get('/og/u/alex.png?v=b');
  const cacheControl = response.headers()['cache-control'];

  expect(cacheControl).toContain('max-age=3600');
  expect(cacheControl).toContain('stale-while-revalidate=86400');
});

test('Variant A and Variant B produce different PNG images', async ({ request }) => {
  const [variantA, variantB] = await Promise.all([
    request.get('/og/u/alex.png?v=a'),
    request.get('/og/u/alex.png?v=b'),
  ]);
  const hashA = createHash('sha256').update(Buffer.from(await variantA.body())).digest('hex');
  const hashB = createHash('sha256').update(Buffer.from(await variantB.body())).digest('hex');

  expect(hashA).not.toBe(hashB);
});

test('Invalid handle returns 400', async ({ request }) => {
  const response = await request.get('/og/u/x.png');

  expect(response.status()).toBe(400);
});

test('Missing profile returns 404', async ({ request }) => {
  const response = await request.get('/og/u/missingprofile.png');

  expect(response.status()).toBe(404);
});

test('ETag caching returns 304 Not Modified for a matching validator', async ({ request }) => {
  const firstResponse = await request.get('/og/u/alex.png?v=b');
  const etag = firstResponse.headers().etag;

  expect(firstResponse.status()).toBe(200);
  expect(etag).toBeDefined();

  const secondResponse = await request.get('/og/u/alex.png?v=b', {
    headers: {
      'If-None-Match': etag,
    },
  });

  expect(secondResponse.status()).toBe(304);
});

