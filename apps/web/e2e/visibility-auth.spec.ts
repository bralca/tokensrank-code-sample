import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

import {
  apiBaseUrl,
  deleteAuthUsers,
  parseSetCookieHeader,
  seedPasswordResetUser,
  signInViaUi,
  webBaseUrl,
} from './helpers/auth-helpers';

const SIGN_OUT_RESPONSE_MS = 1000;
const RESET_RESPONSE_MS = 1000;
const VALID_RESET_LABEL = 'visibility-reset-valid';
const MISSING_RESET_EMAIL = 'missing-visibility-reset@example.com';

type PasswordResetResponse = {
  ok: true;
};

const createdAuthUserIds = new Set<string>();

async function installSignOutCookieBridge(page: Page): Promise<() => string[]> {
  const capturedSetCookieHeaders: string[] = [];

  await page.route('**/api/auth/sign-out', async (route) => {
    const response = await route.fetch();
    const headersArray = await response.headersArray();
    const responseHeaders = Object.fromEntries(
      headersArray
        .filter((header) => header.name.toLowerCase() !== 'set-cookie')
        .map((header) => [header.name, header.value]),
    );
    const setCookieHeaders = headersArray
      .filter((header) => header.name.toLowerCase() === 'set-cookie')
      .map((header) => header.value);

    capturedSetCookieHeaders.push(...setCookieHeaders);
    await page.context().clearCookies();
    await route.fulfill({
      body: await response.body(),
      headers: responseHeaders,
      status: response.status(),
    });
  }, { times: 1 });

  return () => capturedSetCookieHeaders;
}

async function expectNoAuthCookies(context: BrowserContext): Promise<void> {
  const cookies = await context.cookies();

  expect(cookies.filter((cookie) => cookie.name === 'tr_at' || cookie.name === 'tr_rt')).toHaveLength(0);
}

function expectClearedAuthCookie(setCookieHeaders: string[], name: 'tr_at' | 'tr_rt', path: string): void {
  const cookie = setCookieHeaders
    .map((header) => parseSetCookieHeader(header))
    .find((parsed) => parsed.name === name);

  expect(cookie).toBeDefined();
  expect(cookie?.value).toBe('');
  expect(cookie?.maxAge).toBe(0);
  expect(cookie?.path).toBe(path);
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.secure).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');
}

async function submitPasswordResetRequest(
  request: APIRequestContext,
  email: string,
  forwardedIp: string,
) {
  return await request.post(`${apiBaseUrl()}/api/auth/password-reset/request`, {
    headers: {
      Origin: webBaseUrl(),
      'X-Forwarded-For': forwardedIp,
    },
    data: { email },
  });
}

async function mockResetRequest(page: Page, delayMs = 0): Promise<void> {
  await page.route('**/api/auth/password-reset/request', async (route) => {
    if (delayMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }

    await route.fulfill({
      body: JSON.stringify({ ok: true }),
      contentType: 'application/json',
      status: 200,
    });
  });
}

function confirmationText(email: string): string {
  return `If an account exists for ${email}, we've sent a password reset link. Check your inbox (and spam folder) within 10 minutes.`;
}

test.describe('V-15 + V-16 visibility auth', () => {
  test.afterAll(async () => {
    await deleteAuthUsers(createdAuthUserIds);
  });

  test('V-15 sign-out redirects home, clears auth cookies, and protects /me', async ({ context, page }) => {
    const user = await seedPasswordResetUser('visibility-signout');
    createdAuthUserIds.add(user.userId);

    const signInResponse = await signInViaUi(page, user.email, user.originalPassword);
    expect(signInResponse.status()).toBe(200);
    await expect(page).toHaveURL(/\/me$/);

    const readSignOutCookies = await installSignOutCookieBridge(page);
    const startedAt = Date.now();
    const signOutResponsePromise = page.waitForResponse((response) => (
      response.url().includes('/api/auth/sign-out') && response.request().method() === 'POST'
    ));

    await page.getByTestId('sign-out-button').click();
    const signOutResponse = await signOutResponsePromise;
    const signOutMs = Date.now() - startedAt;
    const setCookieHeaders = readSignOutCookies();

    expect(signOutResponse.status()).toBe(200);
    expect(signOutMs).toBeLessThan(SIGN_OUT_RESPONSE_MS);
    expectClearedAuthCookie(setCookieHeaders, 'tr_at', '/');
    expectClearedAuthCookie(setCookieHeaders, 'tr_rt', '/api/auth/refresh');
    await expect(page).toHaveURL(/\/$/);
    await expectNoAuthCookies(context);

    await page.goto('/me', { waitUntil: 'load' });
    await expect(page).toHaveURL(/\/auth\/sign-in/);
  });

  test('V-16 password reset request returns identical success for valid and missing emails', async ({ browserName, request }) => {
    const user = await seedPasswordResetUser(`${VALID_RESET_LABEL}-${browserName}`);
    createdAuthUserIds.add(user.userId);

    const validStartedAt = Date.now();
    const validResponse = await submitPasswordResetRequest(
      request,
      user.email,
      browserName === 'webkit' ? '203.0.113.62' : '203.0.113.61',
    );
    const validMs = Date.now() - validStartedAt;
    const missingStartedAt = Date.now();
    const missingResponse = await submitPasswordResetRequest(
      request,
      MISSING_RESET_EMAIL,
      browserName === 'webkit' ? '203.0.113.72' : '203.0.113.71',
    );
    const missingMs = Date.now() - missingStartedAt;
    const validBody = await validResponse.json() as PasswordResetResponse;
    const missingBody = await missingResponse.json() as PasswordResetResponse;

    expect(validResponse.status()).toBe(200);
    expect(missingResponse.status()).toBe(200);
    expect(validBody).toEqual({ ok: true });
    expect(missingBody).toEqual(validBody);
    expect(validMs).toBeLessThan(RESET_RESPONSE_MS);
    expect(missingMs).toBeLessThan(RESET_RESPONSE_MS);
  });

  test('V-16 reset request UI keeps the same success state for valid and missing emails', async ({ page }) => {
    await mockResetRequest(page, 250);
    await page.goto('/auth/password-reset/request');

    await page.getByTestId('auth-field-email').fill('visible-reset@example.com');
    const submit = page.getByTestId('auth-submit');
    await submit.click();
    await expect(submit).toHaveText('Sending...', { timeout: 100 });
    await expect(page.getByTestId('auth-form-success')).toHaveText(confirmationText('visible-reset@example.com'));

    await page.goto('/auth/password-reset/request');
    await page.getByTestId('auth-field-email').fill(MISSING_RESET_EMAIL);
    await page.getByTestId('auth-submit').click();
    await expect(page.getByTestId('auth-form-success')).toHaveText(confirmationText(MISSING_RESET_EMAIL));
    await expect(page.getByTestId('auth-form-error')).toHaveCount(0);
  });
});
