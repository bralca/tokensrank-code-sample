import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { hideNextDevTools } from './visual-helpers';

const WEB_BASE_URL = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_PORT ?? 3000}`;

function uniqueHandle(prefix = 'modeb') {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function uniqueEmail(prefix = 'modeb') {
  return `${prefix}-${randomUUID()}@example.com`;
}

async function addE2eOnboardingCookie(page: Page, handle: string) {
  await page.context().addCookies([{
    name: 'tr_e2e_onboarding',
    value: encodeURIComponent(JSON.stringify({
      userId: '00000000-0000-4000-8000-000000000002',
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

async function openOnboarding(page: Page, handle = uniqueHandle()) {
  await addE2eOnboardingCookie(page, handle);
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
  await page.goto('/onboarding');
  await expect(page.getByTestId('onboarding-mode-select')).toBeVisible();

  return handle;
}

async function chooseSelfReported(page: Page) {
  await page.getByTestId('onboarding-mode-self_reported').click();
  await expect(page.getByTestId('onboarding-mode-self_reported-pip')).toBeVisible();
  await page.getByTestId('onboarding-next').click();
  await expect(page).toHaveURL(/\/onboarding\/waiting\?mode=self_reported/);
  await expect(page.getByTestId('onboarding-self-reported')).toBeVisible();
}

test.describe('sign-up Mode B onboarding', () => {
  test.describe.configure({ mode: 'serial' });

  test('1. SELF-REPORTED selection highlights the right tile', async ({ page }) => {
    await openOnboarding(page);
    await page.getByTestId('onboarding-mode-self_reported').click();

    await expect(page.getByTestId('onboarding-mode-self_reported-pip')).toBeVisible();
    await expect(page.getByTestId('onboarding-mode-details')).toContainText('SELF-REPORTED');
    await expect(page.getByTestId('onboarding-next')).toBeEnabled();
  });

  test('2. Next opens Step 2b self-reported setup', async ({ page }) => {
    await openOnboarding(page);
    await chooseSelfReported(page);

    await expect(page.getByText('Post sessions from your own tooling')).toBeVisible();
  });

  test('3. endpoint URL block is visible and copyable', async ({ page }) => {
    await openOnboarding(page);
    await chooseSelfReported(page);

    await expect(page.getByTestId('self-reported-endpoint')).toContainText('/api/self-reported/sessions');
    await page.getByTestId('copy-endpoint').click();
    await expect(page.getByTestId('copy-endpoint')).toHaveText('Copied');
  });

  test('4. bearer token block is plaintext and copyable', async ({ page }) => {
    await openOnboarding(page);
    await chooseSelfReported(page);

    await expect(page.getByTestId('self-reported-token')).toHaveText(/tr_self_reported_[A-Za-z0-9_-]+/);
    await page.getByTestId('copy-token').click();
    await expect(page.getByTestId('copy-token')).toHaveText('Copied');
  });

  test('5. JSON payload template is valid and copyable', async ({ page }) => {
    await openOnboarding(page);
    await chooseSelfReported(page);

    const payloadText = await page.getByTestId('self-reported-payload').innerText();
    const payload = JSON.parse(payloadText) as { sessions?: unknown[] };

    expect(payload.sessions).toHaveLength(1);
    expect(payloadText).not.toContain('ingestion_mode');
    await page.getByTestId('copy-payload').click();
    await expect(page.getByTestId('copy-payload')).toHaveText('Copied');
  });

  test('6. request preview is copyable', async ({ page }) => {
    await openOnboarding(page);
    await chooseSelfReported(page);

    await expect(page.getByTestId('self-reported-curl')).toContainText('Authorization: Bearer');
    await page.getByTestId('copy-curl').click();
    await expect(page.getByTestId('copy-curl')).toHaveText('Copied');
  });

  test('7. Mode B screen does not render Mode A script listener', async ({ page }) => {
    await openOnboarding(page);
    await chooseSelfReported(page);

    await expect(page.getByTestId('onboarding-script-install')).toHaveCount(0);
    await expect(page.getByTestId('onboarding-live-log')).toHaveCount(0);
  });

  test('8. Step 2b visual regression', async ({ page }) => {
    await openOnboarding(page, 'visual_step2b');
    await chooseSelfReported(page);
    await hideNextDevTools(page);

    await expect(page).toHaveScreenshot('onboarding-step2b.png', {
      maxDiffPixels: 1,
    });
  });
});
