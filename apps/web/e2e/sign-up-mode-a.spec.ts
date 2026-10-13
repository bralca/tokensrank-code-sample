import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { createTestProfile, createTestUser } from './fixtures/seed-data';
import { hideNextDevTools } from './visual-helpers';

const PASSWORD = 'Tr-valid-password-58!';
const WEB_BASE_URL = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_PORT ?? 3000}`;

function uniqueHandle(prefix = 'modea') {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function uniqueEmail(prefix = 'modea') {
  return `${prefix}-${randomUUID()}@example.com`;
}

async function signUpToOnboarding(page: Page, handle = uniqueHandle()) {
  await addE2eOnboardingCookie(page, handle);
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
  await page.goto('/onboarding');
  await expect(page).toHaveURL(/\/onboarding/, { timeout: 20000 });
  await expect(page.getByTestId('onboarding-mode-select')).toBeVisible({ timeout: 20000 });

  return handle;
}

async function addE2eOnboardingCookie(page: Page, handle: string) {
  await page.context().addCookies([{
    name: 'tr_e2e_onboarding',
    value: encodeURIComponent(JSON.stringify({
      userId: '00000000-0000-4000-8000-000000000001',
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
    })),
    url: WEB_BASE_URL,
    sameSite: 'Lax',
  }]);
}

async function chooseVerified(page: Page, options: { waitForWaitingUrl?: boolean } = {}) {
  const waitForWaitingUrl = options.waitForWaitingUrl ?? true;

  await page.getByTestId('onboarding-mode-script').click();
  await expect(page.getByTestId('onboarding-mode-script-pip')).toBeVisible();
  await page.getByTestId('onboarding-next').click();

  if (waitForWaitingUrl) {
    await expect(page).toHaveURL(/\/onboarding\/waiting\?mode=script/, { timeout: 20000 });
  }
}

async function dismissAccessKeyModal(page: Page) {
  await expect(page.getByTestId('access-key-modal')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('access-key-plaintext')).toHaveText(/tr_script_[A-Za-z0-9_-]{32}/);
  await expect(page.getByTestId('access-key-done')).toBeDisabled();
  await page.getByTestId('access-key-confirm').check();
  await expect(page.getByTestId('access-key-done')).toBeEnabled();
  await page.getByTestId('access-key-done').click();
  await expect(page.getByTestId('access-key-modal')).toBeHidden();
}

async function mockCompletedPolling(page: Page, handle: string) {
  await page.route('**/api/me', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      data: {
        handle,
        recentIngestionRuns: [{
          status: 'completed',
          acceptedCount: 1,
        }],
      },
    }),
  }));
}

async function mockPendingPolling(page: Page, handle: string) {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'EventSource', {
      configurable: true,
      value: undefined,
    });
  });
  await page.route('**/api/me', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      data: {
        handle,
        recentIngestionRuns: [],
      },
    }),
  }));
}

test.describe('sign-up Mode A onboarding', () => {
  test.describe.configure({ mode: 'serial' });

  test('1. sign-up lands on Step 1 with both onboarding tiles', async ({ page }) => {
    await signUpToOnboarding(page);

    await expect(page.getByRole('heading', { name: /choose how tokensrank receives/i })).toBeVisible();
    await expect(page.getByTestId('onboarding-mode-script')).toContainText('VERIFIED');
    await expect(page.getByTestId('onboarding-mode-self_reported')).toContainText('SELF-REPORTED');
  });

  test('2. VERIFIED selection highlights tile and does not auto-advance', async ({ page }) => {
    await signUpToOnboarding(page);
    await page.getByTestId('onboarding-mode-script').click();

    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByTestId('onboarding-mode-script-pip')).toBeVisible();
    await expect(page.getByTestId('onboarding-next')).toBeEnabled();
    await expect(page.getByTestId('onboarding-mode-details')).toContainText('VERIFIED');
  });

  test('3. VERIFIED selection persists in sessionStorage after reload', async ({ page }) => {
    await signUpToOnboarding(page);
    await page.getByTestId('onboarding-mode-script').click();
    await page.reload();

    await expect(page.getByTestId('onboarding-mode-script-pip')).toBeVisible();
    await expect(page.getByTestId('onboarding-next')).toBeEnabled();
  });

  test('4. Next opens Step 2a script install screen', async ({ page }) => {
    await signUpToOnboarding(page);
    await chooseVerified(page, { waitForWaitingUrl: false });

    await expect(page.getByTestId('onboarding-script-install')).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('Install the sync agent')).toBeVisible();
  });

  test('5. access key modal gates dismissal until saved confirmation', async ({ page }) => {
    await signUpToOnboarding(page);
    await chooseVerified(page);

    await dismissAccessKeyModal(page);
  });

  test('6. script install copy button reports copied state', async ({ page }) => {
    await signUpToOnboarding(page);
    await chooseVerified(page);
    await dismissAccessKeyModal(page);

    await page.getByTestId('copy-install-command').click();
    await expect(page.getByTestId('copy-install-command')).toHaveText('Copied');
  });

  test('7. first_session detection redirects to profile', async ({ page }) => {
    const profile = await createTestProfile(await createTestUser('modea-sse'));
    const handle = profile.handle;

    await page.addInitScript(() => {
      Object.defineProperty(window, 'EventSource', {
        configurable: true,
        value: undefined,
      });
    });
    await page.route(`**/u/${handle}**`, (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<main><h1>Profile redirect target</h1></main>',
    }));
    await mockCompletedPolling(page, handle);

    await signUpToOnboarding(page, handle);
    await chooseVerified(page);
    await dismissAccessKeyModal(page);

    await expect(page).toHaveURL(new RegExp(`/u/${handle}`), { timeout: 20000 });
  });

  test('8. SSE failure falls back to 5-second polling', async ({ page }) => {
    await page.route('**/api/onboarding/waiting', (route) => route.abort());

    await signUpToOnboarding(page);
    await chooseVerified(page);
    await dismissAccessKeyModal(page);

    await expect(page.getByTestId('onboarding-live-log')).toContainText(/Polling every 5 seconds|Polling failed/i, {
      timeout: 10000,
    });
  });

  test('9. listening indicator and live log are visible within 500ms', async ({ page }) => {
    await signUpToOnboarding(page);
    await chooseVerified(page);
    await dismissAccessKeyModal(page);

    await expect(page.getByText(/Listening for connection|Polling for connection/i)).toBeVisible({ timeout: 500 });
    await expect(page.getByTestId('onboarding-live-log')).toBeVisible({ timeout: 500 });
  });

  test('10. Step 1 visual regression', async ({ page }) => {
    await signUpToOnboarding(page, 'visual_step1');
    await hideNextDevTools(page);

    await expect(page).toHaveScreenshot('onboarding-step1.png', {
      maxDiffPixels: 1,
    });
  });

  test('11. Step 2a visual regression', async ({ page }) => {
    const handle = 'visual_step2a';

    await mockPendingPolling(page, handle);
    await signUpToOnboarding(page, handle);
    await chooseVerified(page);
    await dismissAccessKeyModal(page);
    await hideNextDevTools(page);

    await expect(page).toHaveScreenshot('onboarding-step2a.png', {
      mask: [page.getByTestId('onboarding-live-log')],
      maskColor: '#0A0A0A',
      maxDiffPixels: 1,
    });
  });

  test('12. access key modal visual regression', async ({ page }) => {
    await signUpToOnboarding(page, 'visual_modal');
    await chooseVerified(page);
    await hideNextDevTools(page);

    await expect(page).toHaveScreenshot('access-key-modal.png', {
      maxDiffPixels: 1,
    });
  });
});
