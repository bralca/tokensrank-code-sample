import { expect, test, type Locator, type Page, type Response as PlaywrightResponse } from '@playwright/test';

import { createTestProfile, createTestUser } from './fixtures/seed-data';

const INVALID_CREDENTIALS_MESSAGE = 'Invalid credentials';
const apiBaseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;

async function enterText(locator: Locator, value: string) {
  await locator.fill('');
  await locator.pressSequentially(value);
}

async function fillSignInForm(page: Page, input?: {
  email?: string;
  password?: string;
}) {
  await enterText(page.getByTestId('auth-field-email'), input?.email ?? 'builder@example.com');
  await enterText(page.getByTestId('auth-field-password'), input?.password ?? 'Tr-valid-password-58!');
}

async function mockSignIn(page: Page, status: number, body: unknown, delayMs = 0) {
  await page.route('**/api/auth/sign-in', async (route) => {
    if (delayMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }

    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

async function bridgeAuthCookies(page: Page, response: PlaywrightResponse): Promise<void> {
  const setCookieHeaders = (await response.headersArray())
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value);

  expect(setCookieHeaders.length).toBeGreaterThanOrEqual(2);

  await page.context().addCookies(setCookieHeaders.map((header) => {
    const [pair = ''] = header.split(';');
    const separator = pair.indexOf('=');

    return {
      name: pair.slice(0, separator),
      value: pair.slice(separator + 1),
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax' as const,
    };
  }));
}

test.describe('auth sign-in', () => {
  test('valid credentials redirect to /me', async ({ page }) => {
    const user = await createTestUser('signin');
    await createTestProfile(user);
    await page.goto('/auth/sign-in');
    await fillSignInForm(page, {
      email: user.email,
      password: user.password,
    });

    const signInResponsePromise = page.waitForResponse((response) => response.url().includes('/api/auth/sign-in'));
    const postSignInNavigationPromise = page.waitForURL('**/me', {
      timeout: 10000,
      waitUntil: 'load',
    });
    const submit = page.getByTestId('auth-submit');
    const startedAt = Date.now();
    await submit.click();
    await expect(submit).toHaveText('Signing in...', { timeout: 100 });
    expect(Date.now() - startedAt).toBeLessThan(100);
    const signInResponse = await signInResponsePromise;

    expect(signInResponse.status()).toBe(200);
    await bridgeAuthCookies(page, signInResponse);
    await postSignInNavigationPromise;
    await expect(page).toHaveURL(/\/me/);
  });

  test('invalid password 401 renders anti-enumeration error', async ({ page }) => {
    await mockSignIn(page, 401, {
      error: { code: 'invalid_credentials', message: INVALID_CREDENTIALS_MESSAGE },
    });
    await page.goto('/auth/sign-in');
    await fillSignInForm(page, { password: 'wrong-password' });
    await page.getByTestId('auth-submit').click();

    await expect(page.getByTestId('auth-form-error')).toHaveText(INVALID_CREDENTIALS_MESSAGE);
  });

  test('non-existent email 401 renders identical anti-enumeration error', async ({ page }) => {
    await mockSignIn(page, 401, {
      error: { code: 'invalid_credentials', message: INVALID_CREDENTIALS_MESSAGE },
    });
    await page.goto('/auth/sign-in');
    await fillSignInForm(page, { email: 'missing@example.com' });
    await page.getByTestId('auth-submit').click();

    await expect(page.getByTestId('auth-form-error')).toHaveText(INVALID_CREDENTIALS_MESSAGE);
  });

  test('email validation error renders inline', async ({ page }) => {
    await page.goto('/auth/sign-in');
    await fillSignInForm(page, { email: 'invalid-email' });
    await page.getByTestId('auth-submit').click();

    await expect(page.getByTestId('auth-error-email')).toContainText('Invalid email address');
  });

  test('password validation error renders inline', async ({ page }) => {
    await page.goto('/auth/sign-in');
    await fillSignInForm(page, { password: 'short' });
    await page.getByTestId('auth-submit').click();

    await expect(page.getByTestId('auth-error-password')).toContainText('Password must be at least 8 characters');
  });

  test('forgot password link navigates to reset request', async ({ page }) => {
    await page.goto('/auth/sign-in');
    await page.getByRole('link', { name: 'Forgot password?' }).click();

    await expect(page).toHaveURL(/\/auth\/password-reset\/request/);
    await expect(page.getByRole('heading', { name: 'Send a reset link' })).toBeVisible();
  });

  test('sign-up link navigates to sign-up page', async ({ page }) => {
    await page.goto('/auth/sign-in');
    await page.getByRole('link', { name: 'Sign up' }).click();

    await expect(page).toHaveURL(/\/auth\/sign-up/);
    await expect(page.getByRole('heading', { name: 'Claim your builder handle' })).toBeVisible();
  });

  test('submit button loading label changes within 100ms', async ({ page }) => {
    await mockSignIn(page, 200, { data: { ok: true } }, 250);
    await page.goto('/auth/sign-in');
    await fillSignInForm(page);

    const submit = page.getByTestId('auth-submit');
    const startedAt = Date.now();
    await submit.click();
    await expect(submit).toHaveText('Signing in...', { timeout: 100 });
    expect(Date.now() - startedAt).toBeLessThan(100);
  });

  test('network error renders form-level message', async ({ page }) => {
    await page.route('**/api/auth/sign-in', (route) => route.abort());
    await page.goto('/auth/sign-in');
    await fillSignInForm(page);
    await page.getByTestId('auth-submit').click();

    await expect(page.getByTestId('auth-form-error')).toContainText('Network error');
  });

  test('cross-origin API sign-in is rejected before credential enumeration', async ({ request }) => {
    const response = await request.post(`${apiBaseUrl}/api/auth/sign-in`, {
      headers: {
        Origin: 'http://attacker.example',
      },
      data: {
        email: 'builder@example.com',
        password: 'Tr-valid-password-58!',
      },
    });
    const body = await response.json() as { error: { code: string; message: string } };

    expect(response.status()).toBe(403);
    expect(body).toEqual({
      error: {
        code: 'csrf_violation',
        message: 'Request origin not allowed',
      },
    });
    expect(response.headers()['set-cookie']).toBeUndefined();
  });

  test('multi-session tabs keep independent field state', async ({ browser }) => {
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();

    try {
      const firstPage = await firstContext.newPage();
      const secondPage = await secondContext.newPage();

      await firstPage.goto('/auth/sign-in');
      await secondPage.goto('/auth/sign-in');
      await enterText(firstPage.getByTestId('auth-field-email'), 'first@example.com');
      await enterText(secondPage.getByTestId('auth-field-email'), 'second@example.com');

      await expect(firstPage.getByTestId('auth-field-email')).toHaveValue('first@example.com');
      await expect(secondPage.getByTestId('auth-field-email')).toHaveValue('second@example.com');
    } finally {
      await firstContext.close();
      await secondContext.close();
    }
  });
});
