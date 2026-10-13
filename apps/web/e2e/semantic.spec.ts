import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3000);
const webOrigin = `http://127.0.0.1:${webPort}`;

function uniqueHandle(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

async function addE2eOnboardingCookie(page: Page, handle: string) {
  await page.context().addCookies([{
    name: 'tr_e2e_onboarding',
    value: encodeURIComponent(JSON.stringify({
      userId: '00000000-0000-4000-8000-000000000077',
      email: `${handle}@example.com`,
      handle,
      displayName: null,
      avatarUrl: null,
      bio: null,
      xHandle: null,
      mode: null,
      onboardedAt: null,
      shareProjects: false,
      onboarding: {
        step: 'not_started',
      },
      accessKeys: [],
    })),
    url: webOrigin,
    sameSite: 'Lax',
  }]);
}

test('leaderboard exposes semantic tabs, table headers, aria-sort, and live ticker status', async ({ page }) => {
  await page.goto('/?period=24h&scope=all', { waitUntil: 'networkidle' });

  await expect(page.getByRole('tablist', { name: 'Filter by period' })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Filter by source' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '24H' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'All' }).nth(1)).toHaveAttribute('aria-selected', 'true');

  const table = page.locator('table#leaderboard-table');
  await expect(table).toBeVisible();
  await expect(table.locator('caption')).toContainText('Leaderboard ranking by token usage');
  await expect(table.locator('thead tr th')).toHaveCount(4);
  await expect(table.locator('tbody')).toBeVisible();

  const headers = table.locator('thead th');
  await expect(headers.nth(0)).toHaveAttribute('scope', 'col');
  await expect(headers.nth(1)).toHaveAttribute('scope', 'col');
  await expect(headers.nth(2)).toHaveAttribute('scope', 'col');
  await expect(headers.nth(3)).toHaveAttribute('scope', 'col');
  await expect(headers.nth(0)).toHaveAttribute('aria-sort', 'none');
  await expect(headers.nth(1)).toHaveAttribute('aria-sort', 'none');
  await expect(headers.nth(2)).toHaveAttribute('aria-sort', 'descending');
  await expect(headers.nth(3)).toHaveAttribute('aria-sort', 'none');

  const ticker = page.getByTestId('live-ticker');
  await expect(ticker).toHaveAttribute('role', 'status');
  await expect(ticker).toHaveAttribute('aria-live', 'polite');
  await expect(ticker).toHaveAttribute('aria-atomic', 'true');
});

test('onboarding mode picker uses tablist, tabs, and selected tabpanel semantics', async ({ page }) => {
  await addE2eOnboardingCookie(page, uniqueHandle('semantic_onboarding'));
  await page.goto('/onboarding', { waitUntil: 'networkidle' });

  const tablist = page.getByRole('tablist', { name: 'Choose verification path' });
  await expect(tablist).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(2);

  const verifiedTab = page.getByRole('tab', { name: /VERIFIED/ });
  await verifiedTab.click();
  await expect(verifiedTab).toHaveAttribute('aria-selected', 'true');

  const controls = await verifiedTab.getAttribute('aria-controls');
  const tabId = await verifiedTab.getAttribute('id');
  expect(controls).toBeTruthy();
  expect(tabId).toBeTruthy();

  const panel = page.locator(`#${controls}`);
  await expect(panel).toHaveAttribute('role', 'tabpanel');
  await expect(panel).toHaveAttribute('aria-labelledby', tabId ?? '');
  await expect(panel).toBeVisible();
});
