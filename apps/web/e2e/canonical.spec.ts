import { expect, test, type Page } from '@playwright/test';

const productionOrigin = 'https://tokensrank.ai';

async function expectSingleCanonical(page: Page, expectedHref: string) {
  const canonical = page.locator('link[rel="canonical"]');

  await expect(canonical).toHaveCount(1);
  await expect(canonical).toHaveAttribute('href', expectedHref);
}

function expectedLeaderboardCanonical(pathUnderTest: string): string {
  const currentUrl = new URL(pathUnderTest, productionOrigin);
  const expected = new URL('/', productionOrigin);

  expected.searchParams.set('period', currentUrl.searchParams.get('period') ?? 'all');
  expected.searchParams.set('scope', currentUrl.searchParams.get('scope') ?? 'all');

  return expected.href;
}

test('canonical link href matches active leaderboard filter query params', async ({ page }) => {
  const routes = [
    '/?period=24h&scope=all',
    '/?period=7d&scope=claude',
    '/?period=30d&scope=codex',
    '/?period=all&scope=all',
  ];

  for (const route of routes) {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expectSingleCanonical(page, expectedLeaderboardCanonical(route));
  }
});
