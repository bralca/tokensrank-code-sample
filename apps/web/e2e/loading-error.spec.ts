import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

const WEB_BASE_URL = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_PORT ?? 3000}`;

function uniqueHandle(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

async function addE2eOnboardingCookie(page: Page, handle: string): Promise<void> {
  await page.context().addCookies([{
    name: 'tr_e2e_onboarding',
    value: encodeURIComponent(JSON.stringify({
      userId: '00000000-0000-4000-8000-000000000083',
      email: `${handle}-${randomUUID()}@example.com`,
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
      recentIngestionRuns: [],
    })),
    url: WEB_BASE_URL,
    sameSite: 'Lax',
  }]);
}

async function openScriptWaiting(page: Page, handle: string): Promise<void> {
  await addE2eOnboardingCookie(page, handle);
  await page.goto('/onboarding/waiting?mode=script');
  await expect(page.getByTestId('onboarding-script-install')).toBeVisible({ timeout: 15000 });
}

test.describe('QC-7 loading and error feedback', () => {
  test('homepage shows the leaderboard skeleton while slow leaderboard data resolves', async ({ page }) => {
    const navigation = page.goto('/?period=24h&scope=all&__qc_slow_leaderboard_ms=1500', {
      waitUntil: 'commit',
    });

    await expect(page.getByTestId('leaderboard-skeleton')).toBeVisible({ timeout: 5000 });
    await navigation;
    await expect(page.locator('#leaderboard-table')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('leaderboard-skeleton')).toHaveCount(0);
  });

  test('missing public profile renders the 404 profile feedback boundary', async ({ page }) => {
    const missingHandle = uniqueHandle('missing');

    await page.goto(`/u/${missingHandle}`);

    await expect(page.getByRole('heading', { name: 'Profile not found' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('error-boundary-home')).toHaveText('View all builders');
    await expect(page.getByTestId('error-boundary-retry')).toHaveText('Try again');
    await expect(page.locator('body')).not.toContainText(`profile_not_found:${missingHandle}`);
  });

  test('onboarding polling failures render the retry fallback', async ({ page }) => {
    test.setTimeout(45000);

    const handle = uniqueHandle('retry');

    await page.route('**/api/onboarding/waiting', (route) => route.abort());
    await page.route(`**/api/profile/${handle}?window=all`, (route) => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'profile_unavailable', message: 'Unavailable' } }),
    }));
    await openScriptWaiting(page, handle);

    await expect(page.getByTestId('onboarding-retry')).toBeVisible({ timeout: 28000 });
    await expect(page.getByTestId('onboarding-retry-button')).toHaveText('Retry');
  });
});
