import { expect, test, type Locator } from '@playwright/test';

const VALID_EMAIL = 'reset@example.com';
const MISSING_EMAIL = 'missing-reset@example.com';
const apiBaseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;
const CONFIRMATION_VALID = `If an account exists for ${VALID_EMAIL}, we've sent a password reset link. Check your inbox (and spam folder) within 10 minutes.`;
const CONFIRMATION_MISSING = `If an account exists for ${MISSING_EMAIL}, we've sent a password reset link. Check your inbox (and spam folder) within 10 minutes.`;

async function enterText(locator: Locator, value: string) {
  await locator.fill('');
  await locator.pressSequentially(value);
}

async function mockResetRequest(page: import('@playwright/test').Page, delayMs = 0) {
  await page.route('**/api/auth/password-reset/request', async (route) => {
    if (delayMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
}

async function fillResetRequest(page: import('@playwright/test').Page, email = VALID_EMAIL) {
  await enterText(page.getByTestId('auth-field-email'), email);
}

async function fillResetConfirm(page: import('@playwright/test').Page, password = 'Tr-new-password-58!') {
  await enterText(page.getByTestId('auth-field-new_password'), password);
  await enterText(page.getByTestId('auth-field-confirm_password'), password);
}

test.describe('auth password reset', () => {
  test('valid email request shows confirmation message', async ({ page }) => {
    await mockResetRequest(page);
    await page.goto('/auth/password-reset/request');
    await fillResetRequest(page, VALID_EMAIL);
    await page.getByTestId('auth-submit').click();

    await expect(page.getByTestId('auth-form-success')).toHaveText(CONFIRMATION_VALID);
  });

  test('non-existent email shows the same anti-enumeration style message', async ({ page }) => {
    await mockResetRequest(page);
    await page.goto('/auth/password-reset/request');
    await fillResetRequest(page, MISSING_EMAIL);
    await page.getByTestId('auth-submit').click();

    await expect(page.getByTestId('auth-form-success')).toHaveText(CONFIRMATION_MISSING);
  });

  test('email validation error renders inline', async ({ page }) => {
    await page.goto('/auth/password-reset/request');
    await fillResetRequest(page, 'not-email');
    await page.getByTestId('auth-submit').click();

    await expect(page.getByTestId('auth-error-email')).toContainText('Invalid email address');
  });

  test('sign-in link navigates from reset request', async ({ page }) => {
    await page.goto('/auth/password-reset/request');
    await page.getByRole('link', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/auth\/sign-in/);
  });

  test('request submit button enters loading state within 100ms', async ({ page }) => {
    await mockResetRequest(page, 250);
    await page.goto('/auth/password-reset/request');
    await fillResetRequest(page);

    const submit = page.getByTestId('auth-submit');
    const startedAt = Date.now();
    await submit.click();
    await expect(submit).toHaveText('Sending...', { timeout: 100 });
    expect(Date.now() - startedAt).toBeLessThan(100);
  });

  test('request network error renders form-level error', async ({ page }) => {
    await page.route('**/api/auth/password-reset/request', (route) => route.abort());
    await page.goto('/auth/password-reset/request');
    await fillResetRequest(page);
    await page.getByTestId('auth-submit').click();

    await expect(page.getByTestId('auth-form-error')).toContainText('Network error');
  });

  test('cross-origin reset request is rejected before account enumeration', async ({ request }) => {
    const response = await request.post(`${apiBaseUrl}/api/auth/password-reset/request`, {
      headers: {
        Origin: 'http://attacker.example',
        'X-Forwarded-For': '203.0.113.210',
      },
      data: {
        email: 'csrf-reset@example.com',
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
  });

  test('valid token renders reset form', async ({ page }) => {
    await page.goto('/auth/password-reset/confirm?token=valid-token');

    await expect(page.getByTestId('auth-field-new_password')).toBeVisible();
    await expect(page.getByTestId('auth-field-confirm_password')).toBeVisible();
  });

  test('password mismatch validation renders inline', async ({ page }) => {
    await page.goto('/auth/password-reset/confirm?token=valid-token');
    await enterText(page.getByTestId('auth-field-new_password'), 'Tr-new-password-58!');
    await enterText(page.getByTestId('auth-field-confirm_password'), 'Tr-other-password-58!');
    await page.getByTestId('auth-submit').click();

    await expect(page.getByTestId('auth-error-confirm_password')).toContainText('Passwords must match');
  });

  test('invalid token error renders from backend response', async ({ page }) => {
    await page.route('**/api/auth/password-reset/confirm', (route) => route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'invalid_token', message: 'Password reset token is invalid or expired' },
      }),
    }));
    await page.goto('/auth/password-reset/confirm?token=bad-token');
    await fillResetConfirm(page);
    await page.getByTestId('auth-submit').click();

    await expect(page.getByTestId('auth-form-error')).toContainText('invalid or expired');
  });

  test('missing token renders token error', async ({ page }) => {
    await page.goto('/auth/password-reset/confirm');

    await expect(page.getByTestId('missing-reset-token')).toHaveText('Invalid or missing reset token.');
  });

  test('cross-origin reset confirmation is rejected before token validation', async ({ request }) => {
    const response = await request.post(`${apiBaseUrl}/api/auth/password-reset/confirm`, {
      headers: {
        Origin: 'http://attacker.example',
      },
      data: {
        token: 'not-a-real-token',
        new_password: 'Tr-new-password-58!',
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

  test('HIBP password breach prevention renders inline', async ({ page }) => {
    await page.route('**/api/auth/password-reset/confirm', (route) => route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'password_breached',
          message: 'This password has been breached in a known data breach. Please choose another.',
        },
      }),
    }));
    await page.goto('/auth/password-reset/confirm?token=valid-token');
    await fillResetConfirm(page, 'password123');
    await page.getByTestId('auth-submit').click();

    await expect(page.getByTestId('auth-error-new_password')).toContainText('breached');
  });

  test('password validation error renders inline', async ({ page }) => {
    await page.goto('/auth/password-reset/confirm?token=valid-token');
    await fillResetConfirm(page, 'short');
    await page.getByTestId('auth-submit').click();

    await expect(page.getByTestId('auth-error-new_password')).toContainText('Password must be at least 8 characters');
  });
});
