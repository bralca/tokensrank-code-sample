import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

const WEB_BASE_URL = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_PORT ?? 3000}`;

function uniqueHandle(prefix = 'err'): string {
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

async function openSelfReportedWaiting(page: Page, handle: string): Promise<void> {
  await addE2eOnboardingCookie(page, handle);
  await page.goto('/onboarding/waiting?mode=self_reported');
  await expect(page.getByTestId('onboarding-self-reported')).toBeVisible({ timeout: 15000 });
}

async function closeAccessKeyModal(page: Page): Promise<void> {
  const modal = page.getByTestId('access-key-modal');

  if (await modal.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
    await page.getByTestId('access-key-confirm').check();
    await expect(page.getByTestId('access-key-done')).toBeEnabled();
    await page.getByTestId('access-key-done').click();
    await expect(modal).toBeHidden();
  }
}

async function enterText(page: Page, testId: string, value: string): Promise<void> {
  const field = page.getByTestId(testId);

  await field.fill('');
  await field.pressSequentially(value);
}

function sseBody(handle: string): string {
  return [
    'event: connected',
    `data: ${JSON.stringify({ type: 'connected', message: 'Handshake complete.' })}`,
    '',
    'event: detected',
    `data: ${JSON.stringify({ type: 'detected', handle, ingestion_run_id: randomUUID() })}`,
    '',
  ].join('\n') + '\n';
}

test.describe('public error boundaries and loading states', () => {
  test('invalid profile handle renders the public profile-not-found boundary', async ({ page }) => {
    await page.goto('/u/INVALID_HANDLE');

    await expect(page.getByRole('heading', { name: 'Profile not found' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('error-boundary-home')).toHaveText('View all builders');
    await expect(page.getByTestId('error-boundary-retry')).toHaveText('Try again');
  });

  test('public profile error boundary keeps raw server details out of the UI', async ({ page }) => {
    await page.goto('/u/INVALID_HANDLE');

    await expect(page.getByRole('heading', { name: 'Profile not found' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('body')).not.toContainText('profile_not_found:INVALID_HANDLE');
  });

  test('profile error boundary home action returns to the leaderboard', async ({ page }) => {
    await page.goto('/u/INVALID_HANDLE');
    await page.getByTestId('error-boundary-home').click();

    await expect(page).toHaveURL(/\/$/u);
    await expect(page.getByRole('heading', { name: 'Top builders by token usage' })).toBeVisible();
  });

  test('homepage renders final leaderboard content without persistent skeletons', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    await expect(page.locator('#leaderboard-table')).toBeVisible();
    await expect(page.getByTestId('leaderboard-skeleton')).toHaveCount(0);
  });

  test('leaderboard cache degradation banner copy is not replaced by internal headers', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    await expect(page.locator('body')).not.toContainText('X-TokensRank-Cache');
    await expect(page.locator('body')).not.toContainText('HIT-DEGRADED');
    await expect(page.locator('#leaderboard-table')).toBeVisible();
  });
});

test.describe('onboarding script install errors', () => {
  test('SSE connection appends live log lines', async ({ page }) => {
    const handle = uniqueHandle('sse');

    await page.route('**/api/onboarding/waiting', (route) => route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sseBody(handle),
    }));
    await page.route(`**/u/${handle}`, (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<main>profile loaded</main>',
    }));
    await openScriptWaiting(page, handle);

    await expect(page.getByTestId('onboarding-live-log')).toContainText('Handshake complete.', { timeout: 15000 });
  });

  test('first_session detected event redirects after access key gate closes', async ({ page }) => {
    const handle = uniqueHandle('detect');

    await page.route('**/api/onboarding/waiting', (route) => route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sseBody(handle),
    }));
    await page.route(`**/u/${handle}`, (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<main>profile loaded</main>',
    }));
    await openScriptWaiting(page, handle);
    await closeAccessKeyModal(page);

    await expect(page).toHaveURL(new RegExp(`/u/${handle}`), { timeout: 15000 });
  });

  test('SSE failure falls back to profile polling within T-2 timing', async ({ page }) => {
    const handle = uniqueHandle('poll');
    const startedAt = Date.now();

    await page.route('**/api/onboarding/waiting', (route) => route.abort());
    await page.route(`**/api/profile/${handle}?window=all`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        identity: { handle },
        at_glance: { sessions_count: 0 },
      }),
    }));
    await openScriptWaiting(page, handle);

    await expect(page.getByTestId('onboarding-live-log')).toContainText('Polling every 5 seconds.', {
      timeout: 1500,
    });
    expect(Date.now() - startedAt).toBeLessThan(2500);
  });

  test('profile polling redirects when sessions_count becomes positive', async ({ page }) => {
    const handle = uniqueHandle('found');

    await page.route('**/api/onboarding/waiting', (route) => route.abort());
    await page.route(`**/api/profile/${handle}?window=all`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        identity: { handle },
        at_glance: { sessions_count: 1 },
      }),
    }));
    await page.route(`**/u/${handle}`, (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<main>profile loaded</main>',
    }));
    await openScriptWaiting(page, handle);
    await closeAccessKeyModal(page);

    await expect(page).toHaveURL(new RegExp(`/u/${handle}`), { timeout: 15000 });
  });

  test('five polling failures show retry affordance', async ({ page }) => {
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

test.describe('self-reported onboarding POST errors', () => {
  test('self-reported setup renders a Test now button', async ({ page }) => {
    await openSelfReportedWaiting(page, uniqueHandle('self'));

    await expect(page.getByTestId('self-reported-test-now')).toBeVisible();
  });

  test('self-reported Test now shows success confirmation', async ({ page }) => {
    await page.route('**/api/self-reported/sessions', (route) => route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ data: { accepted: 1, deduped: 0, rejected: 0 } }),
    }));
    await openSelfReportedWaiting(page, uniqueHandle('selfok'));
    await page.getByTestId('self-reported-test-now').click();

    await expect(page.getByTestId('self-reported-success')).toContainText('Self-reported test accepted');
  });

  test('self-reported unauthorized error maps to retry guidance', async ({ page }) => {
    await page.route('**/api/self-reported/sessions', (route) => route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'unauthorized', message: 'Invalid or missing access key' } }),
    }));
    await openSelfReportedWaiting(page, uniqueHandle('self401'));
    await page.getByTestId('self-reported-test-now').click();

    await expect(page.getByTestId('onboarding-retry')).toContainText('session or access key');
  });

  test('self-reported rate limit error maps to retry guidance', async ({ page }) => {
    await page.route('**/api/self-reported/sessions', (route) => route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'rate_limited', message: 'Rate limit exceeded' } }),
    }));
    await openSelfReportedWaiting(page, uniqueHandle('self429'));
    await page.getByTestId('self-reported-test-now').click();

    await expect(page.getByTestId('onboarding-retry')).toContainText('Too many attempts');
  });

  test('self-reported schema error maps to JSON schema guidance', async ({ page }) => {
    await page.route('**/api/self-reported/sessions', (route) => route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'schema_invalid', message: 'Invalid request schema' } }),
    }));
    await openSelfReportedWaiting(page, uniqueHandle('self400'));
    await page.getByTestId('self-reported-test-now').click();

    await expect(page.getByTestId('onboarding-retry')).toContainText('required session schema');
  });
});

test.describe('auth form validation error states', () => {
  test('sign-up invalid email shows inline field error', async ({ page }) => {
    await page.goto('/auth/sign-up');
    await enterText(page, 'auth-field-email', 'not-an-email');
    await enterText(page, 'auth-field-password', 'Tr-valid-password-83!');
    await enterText(page, 'auth-field-handle', uniqueHandle('form'));

    await expect(page.getByTestId('auth-error-email')).toContainText('Invalid email address');
  });

  test('sign-up short password shows inline field error', async ({ page }) => {
    await page.goto('/auth/sign-up');
    await enterText(page, 'auth-field-email', `${randomUUID()}@example.com`);
    await enterText(page, 'auth-field-password', 'short');

    await expect(page.getByTestId('auth-error-password')).toContainText('Password must be at least 8 characters');
  });
});
