import { randomUUID } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';

const PASSWORD = 'Tr-valid-password-74!';
const WEB_BASE_URL = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_PORT ?? 3000}`;
const API_BASE_URL = `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;

function uniqueHandle() {
  return `modea_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function uniqueEmail(handle: string) {
  return `${handle}-${randomUUID()}@example.com`;
}

async function addE2eOnboardingCookie(page: Page, handle: string) {
  await page.context().addCookies([{
    name: 'tr_e2e_onboarding',
    value: encodeURIComponent(JSON.stringify({
      userId: '00000000-0000-4000-8000-000000000074',
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
        userId: '00000000-0000-4000-8000-000000000074',
        email: uniqueEmail(handle),
        handle,
        profileId: '00000000-0000-4000-8000-000000000174',
      },
    }),
  }));
  await page.route('**/api/me/onboarding', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      data: {
        step: 'mode_chosen',
        mode: 'script_verified',
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

test('Mode A onboarding signs up, shows access key, ships first script POST, and redirects to verified profile', async ({ page }) => {
  const handle = uniqueHandle();
  let scriptPostReceived = false;

  await addE2eOnboardingCookie(page, handle);
  await mockSignUp(page, handle);
  await page.route(`**/u/${handle}**`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<main><section data-testid="profile-section-identity"><span data-testid="avatar-with-badge" aria-label="Verified via script"><span data-testid="avatar-verification-pip" aria-hidden="true"></span></span></section></main>`,
  }));
  await page.route('**/api/script/sessions', async (route) => {
    scriptPostReceived = true;
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ data: { ingestion_run_id: randomUUID(), accepted_count: 1 } }),
    });
  });
  await page.route('**/api/onboarding/waiting', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [
        'event: connected',
        `data: ${JSON.stringify({ type: 'connected', message: 'Handshake complete.' })}`,
        '',
        'event: detected',
        `data: ${JSON.stringify({ type: 'detected', handle, ingestion_run_id: randomUUID() })}`,
        '',
      ].join('\n') + '\n',
    });
  });

  await page.goto('/auth/sign-up');
  await fillSignUp(page, handle);
  await expect(page).toHaveURL(/\/onboarding/, { timeout: 15000 });

  await page.getByTestId('onboarding-mode-script').click();
  await expect(page.getByTestId('onboarding-mode-script-pip')).toBeVisible();
  await page.getByTestId('onboarding-next').click();
  await expect(page).toHaveURL(/\/onboarding\/waiting\?mode=script/, { timeout: 15000 });
  await expect(page.getByTestId('access-key-modal')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('access-key-plaintext')).toHaveText(/tr_script_[A-Za-z0-9_-]{32}/);

  await page.evaluate(async (apiBase) => {
    await fetch(`${apiBase}/api/script/sessions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer tr_script_testtesttesttesttesttesttest12',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client: {
          version: '0.0.1',
          install_id: '11111111-1111-4111-8111-111111111111',
          platform: 'darwin',
          arch: 'arm64',
        },
        run: {
          run_id: 'onboarding-mode-a-e2e',
          started_at: '2026-04-28T10:00:00.000Z',
          finished_at: '2026-04-28T10:00:01.000Z',
        },
        sessions: [],
      }),
    });
  }, API_BASE_URL);

  expect(scriptPostReceived).toBe(true);
  await page.getByTestId('access-key-confirm').check();
  await page.getByTestId('access-key-done').click();
  await expect(page).toHaveURL(new RegExp(`/u/${handle}`), { timeout: 15000 });
  await expect(page.getByTestId('avatar-with-badge')).toHaveAttribute('aria-label', 'Verified via script');
  await expect(page.getByTestId('avatar-verification-pip')).toHaveAttribute('aria-hidden', 'true');
});
