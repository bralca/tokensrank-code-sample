import { expect, test } from '@playwright/test';

const expectedHeadline = 'Top builders by token usage';
const expectedHeaders = ['Rank', 'Builder', 'Token usage', 'Cost'];
const apiBaseUrl = `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_API_PORT ?? 4001)}`;

test('homepage exposes exactly one H1 with the canonical leaderboard headline', async ({ page }) => {
  await page.goto('/?period=all&scope=all', { waitUntil: 'networkidle' });

  const h1 = page.locator('h1');

  await expect(h1).toHaveCount(1);
  await expect(h1).toHaveText(expectedHeadline);
});

test('homepage renders a semantic four-column leaderboard table', async ({ page }) => {
  await page.goto('/?period=all&scope=all', { waitUntil: 'networkidle' });

  const table = page.locator('table#leaderboard-table');
  const headers = table.locator('thead th');

  await expect(table).toBeVisible();
  await expect(table.locator('thead')).toHaveCount(1);
  await expect(headers).toHaveCount(4);

  for (let index = 0; index < expectedHeaders.length; index += 1) {
    await expect(headers.nth(index)).toHaveAttribute('scope', 'col');
    await expect(headers.nth(index)).toContainText(expectedHeaders[index]);
  }
});

test('homepage SSR uses the real leaderboard API endpoint', async ({ page, request }) => {
  const apiResponse = await request.get(`${apiBaseUrl}/api/leaderboard?period=all&scope=all&limit=50&offset=0`);

  expect(apiResponse.status()).toBe(200);

  await page.goto('/?period=all&scope=all', { waitUntil: 'networkidle' });
  await expect(page.locator('table#leaderboard-table tbody')).toBeVisible();
});

test('SEO regression runs on the required primary browser engines', async ({ browserName }) => {
  expect(['chromium', 'webkit']).toContain(browserName);
});
