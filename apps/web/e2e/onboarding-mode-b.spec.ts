import { randomUUID } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';

const PASSWORD = 'Tr-valid-password-74!';
const WEB_BASE_URL = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_PORT ?? 3000}`;

function uniqueHandle() {
  return `modeb_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function uniqueEmail(handle: string) {
  return `${handle}-${randomUUID()}@example.com`;
}

async function addE2eOnboardingCookie(page: Page, handle: string) {
  await page.context().addCookies([{
    name: 'tr_e2e_onboarding',
    value: encodeURIComponent(JSON.stringify({
      userId: '00000000-0000-4000-8000-000000000075',
      email: uniqueEmail(handle),
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

async function mockSignUp(page: Page, handle: string) {
  await page.route('**/api/handle/check**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { available: true } }),
  }));
  await page.route('**/api/auth/sign-up', (route) => route.fulfill({
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      data: {
        userId: '00000000-0000-4000-8000-000000000075',
        email: uniqueEmail(handle),
        handle,
        profileId: '00000000-0000-4000-8000-000000000175',
      },
    }),
  }));
  await page.route('**/api/me/onboarding', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      data: {
        step: 'mode_chosen',
        mode: 'self_reported',
        onboarded_at: null,
        handle,
      },
    }),
  }));
}

async function enterText(locator: Locator, value: string) {
  await locator.fill('');
  await locator.pressSequentially(value);
  await expect(locator).toHaveValue(value);
}

async function fillSignUp(page: Page, handle: string) {
  await enterText(page.getByTestId('auth-field-email'), uniqueEmail(handle));
  await enterText(page.getByTestId('auth-field-password'), PASSWORD);
  await enterText(page.getByTestId('auth-field-handle'), handle);
  await expect(page.getByTestId('handle-availability')).toHaveText('✓ available', { timeout: 5000 });
  await expect(page.getByTestId('auth-submit')).toBeEnabled({ timeout: 10000 });
  await page.getByTestId('auth-submit').click();
}

test('Mode B onboarding shows endpoint materials without SSE and renders self-reported profile pip', async ({ page }) => {
  const handle = uniqueHandle();
  let sseRequests = 0;

  await addE2eOnboardingCookie(page, handle);
  await mockSignUp(page, handle);
  await page.route('**/api/onboarding/waiting', (route) => {
    sseRequests += 1;
    void route.abort();
  });
  await page.route(`**/u/${handle}**`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<main><section data-testid="profile-section-identity"><span data-testid="avatar-with-badge" aria-label="Self-reported"><span data-testid="avatar-verification-pip" aria-hidden="true"></span></span></section></main>`,
  }));

  await page.goto('/auth/sign-up');
  await fillSignUp(page, handle);
  await expect(page).toHaveURL(/\/onboarding/, { timeout: 15000 });

  await page.getByTestId('onboarding-mode-self_reported').click();
  await expect(page.getByTestId('onboarding-mode-self_reported-pip')).toBeVisible();
  await page.getByTestId('onboarding-next').click();
  await expect(page).toHaveURL(/\/onboarding\/waiting\?mode=self_reported/, { timeout: 15000 });

  await expect(page.getByTestId('onboarding-self-reported')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('self-reported-endpoint')).toContainText('/api/self-reported/sessions');
  await expect(page.getByTestId('self-reported-token')).toHaveText(/tr_self_reported_[A-Za-z0-9_-]+/);
  await expect(page.getByTestId('self-reported-payload')).toContainText('"sessions"');
  expect(sseRequests).toBe(0);

  await page.goto(`/u/${handle}`);
  await expect(page.getByTestId('avatar-with-badge')).toHaveAttribute('aria-label', 'Self-reported');
  await expect(page.getByTestId('avatar-verification-pip')).toHaveAttribute('aria-hidden', 'true');
});
