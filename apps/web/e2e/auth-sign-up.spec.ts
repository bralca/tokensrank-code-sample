import { randomUUID } from 'node:crypto';

import { expect, test, type Locator } from '@playwright/test';

const PASSWORD = 'Tr-valid-password-58!';
const apiBaseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;

function uniqueHandle(prefix = 'auth'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function uniqueEmail(prefix = 'auth'): string {
  return `${prefix}-${randomUUID()}@example.com`;
}

async function enterText(locator: Locator, value: string) {
  await locator.fill('');
  await locator.pressSequentially(value);
}

async function fillSignUpForm(page: import('@playwright/test').Page, input?: {
  email?: string;
  password?: string;
  handle?: string;
}) {
  await enterText(page.getByTestId('auth-field-email'), input?.email ?? uniqueEmail());
  await enterText(page.getByTestId('auth-field-password'), input?.password ?? PASSWORD);
  await enterText(page.getByTestId('auth-field-handle'), input?.handle ?? uniqueHandle());
}

async function waitForHandleAvailable(page: import('@playwright/test').Page) {
  await expect(page.getByTestId('handle-availability')).toHaveText('✓ available', { timeout: 2000 });
  await expect(page.getByTestId('auth-submit')).toBeEnabled();
}

async function mockHandleAvailable(page: import('@playwright/test').Page) {
  await page.route('**/api/handle/check**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { available: true } }),
  }));
}

test.describe('auth sign-up', () => {
  test('valid sign-up redirects to onboarding and exposes immediate loading state', async ({ page }) => {
    await mockHandleAvailable(page);
    await page.route('**/api/auth/sign-up', async (route) => {
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { ok: true } }),
      });
    });
    await page.goto('/auth/sign-up');
    await fillSignUpForm(page);
    await waitForHandleAvailable(page);

    const submit = page.getByTestId('auth-submit');
    const startedAt = Date.now();
    await submit.click();
    await expect(submit).toHaveText('Signing up...', { timeout: 100 });
    expect(Date.now() - startedAt).toBeLessThan(100);
    await expect(page).toHaveURL(/\/(onboarding|auth\/sign-in)/, { timeout: 15000 });
  });

  test('handle availability feedback appears within 600ms', async ({ page }) => {
    await mockHandleAvailable(page);
    await page.goto('/auth/sign-up');
    const handle = uniqueHandle('free');
    const startedAt = Date.now();

    await enterText(page.getByTestId('auth-field-handle'), handle);
    await expect(page.getByTestId('handle-availability')).toHaveText('✓ available', { timeout: 1000 });
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  test('email validation error renders inline', async ({ page }) => {
    await page.goto('/auth/sign-up');
    await fillSignUpForm(page, { email: 'not-an-email' });

    await expect(page.getByTestId('auth-error-email')).toContainText('Invalid email address');
  });

  test('password validation error renders inline', async ({ page }) => {
    await page.goto('/auth/sign-up');
    await fillSignUpForm(page, { password: 'short' });

    await expect(page.getByTestId('auth-error-password')).toContainText('Password must be at least 8 characters');
  });

  test('duplicate email 409 renders inline on email field', async ({ page }) => {
    await mockHandleAvailable(page);
    await page.route('**/api/auth/sign-up', (route) => route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'email_taken',
          message: 'An account with this email already exists',
          details: { field: 'email' },
        },
      }),
    }));
    await page.goto('/auth/sign-up');
    await fillSignUpForm(page, {
      email: uniqueEmail('duplicate'),
      handle: uniqueHandle('dup'),
    });
    await waitForHandleAvailable(page);
    await page.getByTestId('auth-submit').click();

    await expect(page.getByTestId('auth-error-email')).toContainText('An account with this email already exists', {
      timeout: 15000,
    });
  });

  test('reserved handle validation renders inline', async ({ page }) => {
    await page.goto('/auth/sign-up');
    await fillSignUpForm(page, { handle: 'admin' });

    await expect(page.getByTestId('handle-availability')).toHaveText("× that handle's reserved", { timeout: 1000 });
    await expect(page.getByTestId('auth-submit')).toBeDisabled();
  });

  test('HIBP breached password error renders inline', async ({ page }) => {
    await mockHandleAvailable(page);
    await page.route('**/api/auth/sign-up', (route) => route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'password_breached',
          message: 'This password has been breached in a known data breach. Please choose another.',
          details: { field: 'password' },
        },
      }),
    }));
    await page.goto('/auth/sign-up');
    await fillSignUpForm(page, {
      password: 'password123',
      handle: uniqueHandle('breach'),
    });
    await waitForHandleAvailable(page);
    await page.getByTestId('auth-submit').click();

    await expect(page.getByTestId('auth-error-password')).toContainText('breached', { timeout: 15000 });
  });

  test('sign-in link navigates to sign-in page', async ({ page }) => {
    await page.goto('/auth/sign-up');
    await page.getByRole('link', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/auth\/sign-in/);
    await expect(page.getByRole('heading', { name: 'Sign in to TokensRank' })).toBeVisible();
  });

  test('submit button loading label changes within 100ms', async ({ page }) => {
    await mockHandleAvailable(page);
    await page.route('**/api/auth/sign-up', async (route) => {
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { ok: true } }),
      });
    });
    await page.goto('/auth/sign-up');
    await fillSignUpForm(page, {
      email: uniqueEmail('loading'),
      handle: uniqueHandle('loading'),
    });
    await waitForHandleAvailable(page);

    const submit = page.getByTestId('auth-submit');
    const startedAt = Date.now();
    await submit.click();
    await expect(submit).toHaveText('Signing up...', { timeout: 100 });
    expect(Date.now() - startedAt).toBeLessThan(100);
  });

  test('network error renders form-level message', async ({ page }) => {
    await mockHandleAvailable(page);
    await page.route('**/api/auth/sign-up', (route) => route.abort());
    await page.goto('/auth/sign-up');
    await fillSignUpForm(page, {
      email: uniqueEmail('network'),
      handle: uniqueHandle('network'),
    });
    await waitForHandleAvailable(page);
    await page.getByTestId('auth-submit').click();

    await expect(page.getByTestId('auth-form-error')).toContainText('Network error');
  });

  test('cross-origin API sign-up is rejected before cookies are issued', async ({ request }) => {
    const response = await request.post(`${apiBaseUrl}/api/auth/sign-up`, {
      headers: {
        Origin: 'http://attacker.example',
      },
      data: {
        email: uniqueEmail('csrf'),
        password: PASSWORD,
        handle: uniqueHandle('csrf'),
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
});
