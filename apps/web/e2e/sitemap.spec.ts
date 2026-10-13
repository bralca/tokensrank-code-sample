import { expect, test } from '@playwright/test';

test('serves the sitemap XML with required public URLs', async ({ request }) => {
  const response = await request.get('/sitemap.xml');
  const body = await response.text();
  const siteUrl = body.match(/<loc>([^<]+)<\/loc>/)?.[1];

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/xml');
  expect(response.headers()['cache-control']).toContain('max-age=3600');
  expect(body).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  expect(siteUrl).toBeTruthy();
  expect(body).toContain(`<loc>${siteUrl}</loc>`);
  expect(body).toContain(`${siteUrl}/leaderboard?period=all&amp;scope=all`);
  expect(body).toContain(`${siteUrl}/leaderboard?period=24h&amp;scope=codex`);
});

test('serves robots.txt with the sitemap location', async ({ request }) => {
  const response = await request.get('/robots.txt');
  const body = await response.text();

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/plain');
  expect(body).toContain('User-Agent: *');
  expect(body).toContain('Disallow: /auth');
  expect(body).toContain('Sitemap: ');
  expect(body).toContain('/sitemap.xml');
});
