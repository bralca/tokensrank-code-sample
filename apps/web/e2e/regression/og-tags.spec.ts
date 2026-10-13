import { expect, test, type Page } from '@playwright/test';

import { getPngMetadata, seedOGProfile } from '../og-test-data';

const productionOrigin = 'https://tokensrank.ai';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await seedOGProfile('alex');
});

async function metaContent(page: Page, selector: string): Promise<string> {
  const content = await page.locator(selector).first().getAttribute('content');

  expect(content).toBeTruthy();
  return content ?? '';
}

test('OG image is exactly 1200x630 pixels', async ({ request }) => {
  const response = await request.get('/og/u/alex.png?v=b');
  const body = Buffer.from(await response.body());
  const metadata = await getPngMetadata(body);

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('image/png');
  expect(metadata).toEqual({
    width: 1200,
    height: 630,
  });
});

test('profile og:title stays within the 200 character SEO limit', async ({ page }) => {
  await page.goto('/u/alex?window=30d', { waitUntil: 'domcontentloaded' });

  const title = await metaContent(page, 'meta[property="og:title"]');

  expect(title.length).toBeGreaterThan(0);
  expect(title.length).toBeLessThanOrEqual(200);
});

test('profile twitter:description stays within the 125 character SEO limit', async ({ page }) => {
  await page.goto('/u/alex?window=30d', { waitUntil: 'domcontentloaded' });

  const description = await metaContent(page, 'meta[name="twitter:description"]');

  expect(description.length).toBeGreaterThan(0);
  expect(description.length).toBeLessThanOrEqual(125);
});

test('leaderboard canonical URL includes period and scope params', async ({ page }) => {
  await page.goto('/?period=7d&scope=codex', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    `${productionOrigin}/?period=7d&scope=codex`,
  );
});

test('profile canonical URL includes the selected window param', async ({ page }) => {
  await page.goto('/u/alex?window=30d', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    `${productionOrigin}/u/alex?window=30d`,
  );
});

test('OG image ETag returns 304 on a matching second fetch', async ({ request }) => {
  const firstResponse = await request.get('/og/u/alex.png?v=b');
  const etag = firstResponse.headers().etag;

  expect(firstResponse.status()).toBe(200);
  expect(etag).toBeDefined();

  const secondResponse = await request.get('/og/u/alex.png?v=b', {
    headers: {
      'If-None-Match': etag ?? '',
    },
  });

  expect(secondResponse.status()).toBe(304);
});

test('cached OG image response latency stays under 200ms', async ({ request }) => {
  await request.get('/og/u/alex.png?v=b');

  const startedAt = Date.now();
  const response = await request.get('/og/u/alex.png?v=b');
  const latencyMs = Date.now() - startedAt;

  expect(response.status()).toBe(200);
  expect(latencyMs).toBeLessThan(200);
});
