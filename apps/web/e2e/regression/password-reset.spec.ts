import { expect, test, type Page } from '@playwright/test';

import {
  NEW_PASSWORD,
  apiBaseUrl,
  deleteAuthUsers,
  expectAuditEventEventually,
  generateRecoveryToken,
  installCookieBridge,
  loadRootEnv,
  parseSetCookieHeader,
  seedPasswordResetUser,
  signInViaUi,
  tokenFingerprint,
  type SeededPasswordResetUser,
} from '../helpers/auth-helpers';
import {
  clearEmails,
  extractResetLink,
  getEmails,
  getLatestEmail,
  isMailpitAvailable,
} from '../helpers/mailpit-client';
import { hideNextDevTools } from '../visual-helpers';

const createdAuthUserIds = new Set<string>();
const browserConsoleMessages = new WeakMap<Page, string[]>();
const RESET_CONFIRM_PATH = '/auth/password-reset/confirm';
const GENERIC_RESET_BODY = { ok: true };
const TIMING_LEAK_TOLERANCE_MS = 500;
const EXPECTED_RESET_CONFIRM_401_CONSOLE = '[error] Failed to load resource: the server responded with a status of 401 (Unauthorized)';
let mailpitAvailable = false;

function isAllowedConsoleMessage(message: string): boolean {
  return message === EXPECTED_RESET_CONFIRM_401_CONSOLE
    || (
      message.startsWith('[error]')
      && message.includes('/api/auth/password-reset/confirm')
      && message.includes('401')
    );
}

function expectRequestId(headers: Record<string, string>): void {
  expect(headers['x-request-id']).toMatch(/[0-9A-Z]{26}/);
}

async function enterText(page: Page, testId: string, value: string): Promise<void> {
  const field = page.getByTestId(testId);

  await expect(field).toBeVisible();
  await field.fill(value);
}

async function gotoVisualPage(page: Page, path: string): Promise<void> {
  await page.goto('about:blank');
  await page.goto(path, { waitUntil: 'load' });
  await hideNextDevTools(page);
}

async function submitResetRequest(page: Page, email: string) {
  await page.goto('/auth/password-reset/request', { waitUntil: 'load' });
  await enterText(page, 'auth-field-email', email);

  const responsePromise = page.waitForResponse((response) => (
    response.url().includes('/api/auth/password-reset/request') && response.request().method() === 'POST'
  ));

  await page.getByTestId('auth-submit').click();
  const response = await responsePromise;

  expect(response.status()).toBe(200);
  expectRequestId(response.headers());
  await expect(response.json()).resolves.toEqual(GENERIC_RESET_BODY);
  await expect(page.getByTestId('auth-form-success')).toHaveText(
    `If an account exists for ${email}, we've sent a password reset link. Check your inbox (and spam folder) within 10 minutes.`,
  );

  return response;
}

async function submitResetConfirm(page: Page, resetLink: string, newPassword = NEW_PASSWORD): Promise<string[]> {
  const url = new URL(resetLink);

  await page.goto(`${url.pathname}${url.search}`, { waitUntil: 'load' });
  await enterText(page, 'auth-field-new_password', newPassword);
  await enterText(page, 'auth-field-confirm_password', newPassword);

  const getSetCookieHeaders = await installCookieBridge(page, '/api/auth/password-reset/confirm');
  const responsePromise = page.waitForResponse((response) => (
    response.url().includes('/api/auth/password-reset/confirm') && response.request().method() === 'POST'
  ));

  await page.getByTestId('auth-submit').click();
  const response = await responsePromise;

  expect(response.status()).toBe(200);
  expectRequestId(response.headers());
  await page.waitForURL('**/auth/sign-in', { timeout: 10_000, waitUntil: 'commit' });
  return await getSetCookieHeaders();
}

async function resolveResetLinkForUser(page: Page, user: SeededPasswordResetUser): Promise<string> {
  await submitResetRequest(page, user.email);

  if (mailpitAvailable) {
    const resetEmail = await getLatestEmail(user.email);

    expect(resetEmail.Subject ?? '').toMatch(/password|reset/i);
    return extractResetLink(resetEmail);
  }

  return `http://127.0.0.1${RESET_CONFIRM_PATH}?token=${await generateRecoveryToken(user.email)}`;
}

function expectFreshAuthCookieHeaders(setCookieHeaders: string[]): void {
  const cookies = setCookieHeaders.map(parseSetCookieHeader);
  const accessCookie = cookies.find((cookie) => cookie.name === 'tr_at');
  const refreshCookie = cookies.find((cookie) => cookie.name === 'tr_rt');

  expect(accessCookie).toMatchObject({
    httpOnly: true,
    maxAge: 3600,
    path: '/',
    sameSite: 'Lax',
    secure: true,
  });
  expect(refreshCookie).toMatchObject({
    httpOnly: true,
    maxAge: 2592000,
    path: '/api/auth/refresh',
    sameSite: 'Lax',
    secure: true,
  });
}

async function postResetRequestApi(page: Page, email: string, ipSuffix: number) {
  const startedAt = Date.now();
  const response = await page.request.post(`${apiBaseUrl()}/api/auth/password-reset/request`, {
    headers: {
      Origin: `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_PORT ?? 3000}`,
      'X-Forwarded-For': `203.0.113.${ipSuffix}`,
    },
    data: {
      email,
    },
  });

  return {
    body: await response.json() as unknown,
    durationMs: Date.now() - startedAt,
    response,
  };
}

test.beforeAll(() => {
  loadRootEnv();
});

test.beforeEach(async ({ page }) => {
  const unexpectedMessages: string[] = [];

  browserConsoleMessages.set(page, unexpectedMessages);
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      unexpectedMessages.push(`[${message.type()}] ${message.text()}`);
    }
  });

  mailpitAvailable = await isMailpitAvailable();

  if (mailpitAvailable) {
    await clearEmails();
  }
});

test.afterEach(async ({ page }) => {
  expect((browserConsoleMessages.get(page) ?? []).filter((message) => !isAllowedConsoleMessage(message))).toEqual([]);
});

test.afterAll(async () => {
  await deleteAuthUsers(createdAuthUserIds);
});

test.describe('V-4 + O-4 password reset regression', () => {
  test('request reset, consume recovery link, confirm password, and sign in with the new password', async ({ page }) => {
    const user: SeededPasswordResetUser = await seedPasswordResetUser('mainflow');
    createdAuthUserIds.add(user.userId);

    const resetLink = await resolveResetLinkForUser(page, user);

    expect(resetLink).toContain(RESET_CONFIRM_PATH);
    expect(tokenFingerprint(resetLink)).toHaveLength(12);

    const setCookieHeaders = await submitResetConfirm(page, resetLink);

    expectFreshAuthCookieHeaders(setCookieHeaders);
    await expectAuditEventEventually('auth.password_reset_requested');
    await expectAuditEventEventually('auth.password_reset_confirmed', user.profileId);
    await expect(page).toHaveURL(/\/auth\/sign-in$/);

    await page.goto('/me', { waitUntil: 'load' });
    await expect(page.getByRole('heading', { name: 'Your TokensRank profile' })).toBeVisible();

    const signOutResponsePromise = page.waitForResponse((response) => (
      response.url().includes('/api/auth/sign-out') && response.request().method() === 'POST'
    ));

    await page.getByTestId('sign-out-button').click();
    const signOutResponse = await signOutResponsePromise;

    expect(signOutResponse.status()).toBe(200);
    await page.context().clearCookies();
    await expect(page).toHaveURL(/\/$/);

    const signInResponse = await signInViaUi(page, user.email, NEW_PASSWORD);

    expect(signInResponse.status()).toBe(200);
    await expect(page).toHaveURL(/\/me$/);
    await expect(page.getByRole('heading', { name: 'Your TokensRank profile' })).toBeVisible();
    expect((await page.context().cookies()).some((cookie) => cookie.name === 'tr_at')).toBe(true);
    expect((await page.context().cookies()).some((cookie) => cookie.name === 'tr_rt')).toBe(true);
  });

  test('old password fails after a successful reset', async ({ page }) => {
    const user: SeededPasswordResetUser = await seedPasswordResetUser('oldpass');
    createdAuthUserIds.add(user.userId);
    const resetLink = await resolveResetLinkForUser(page, user);

    await submitResetConfirm(page, resetLink);
    await page.context().clearCookies();
    await page.goto('/auth/sign-in', { waitUntil: 'load' });
    await enterText(page, 'auth-field-email', user.email);
    await enterText(page, 'auth-field-password', user.originalPassword);

    const responsePromise = page.waitForResponse((response) => (
      response.url().includes('/api/auth/sign-in') && response.request().method() === 'POST'
    ));

    await page.getByTestId('auth-submit').click();
    const response = await responsePromise;

    expect(response.status()).toBe(401);
    await expect(page.getByTestId('auth-form-error')).toHaveText(/invalid/i);
    await expect(page.getByText(/old password|previous password|password changed/i)).toHaveCount(0);
  });

  test('valid and invalid reset requests return identical generic responses without enumeration', async ({ page }) => {
    const user: SeededPasswordResetUser = await seedPasswordResetUser('antienum');
    createdAuthUserIds.add(user.userId);
    const missingEmail = `missing-${Date.now()}@example.com`;

    const validResult = await postResetRequestApi(page, user.email, 71);
    const missingResult = await postResetRequestApi(page, missingEmail, 72);

    expect(validResult.response.status()).toBe(200);
    expect(missingResult.response.status()).toBe(200);
    expectRequestId(validResult.response.headers());
    expectRequestId(missingResult.response.headers());
    expect(validResult.body).toEqual(GENERIC_RESET_BODY);
    expect(missingResult.body).toEqual(validResult.body);
    expect(Math.abs(validResult.durationMs - missingResult.durationMs)).toBeLessThan(TIMING_LEAK_TOLERANCE_MS);

    if (mailpitAvailable) {
      const validEmail = await getLatestEmail(user.email);

      expect(extractResetLink(validEmail)).toContain(RESET_CONFIRM_PATH);
      expect(await getEmails(missingEmail)).toHaveLength(0);
    }
  });

  test('invalid reset token shows a user-visible error and does not set auth cookies', async ({ page, context }) => {
    await page.goto('/auth/password-reset/confirm?token=tampered-token', { waitUntil: 'load' });
    await enterText(page, 'auth-field-new_password', NEW_PASSWORD);
    await enterText(page, 'auth-field-confirm_password', NEW_PASSWORD);

    const responsePromise = page.waitForResponse((response) => (
      response.url().includes('/api/auth/password-reset/confirm') && response.request().method() === 'POST'
    ));

    await page.getByTestId('auth-submit').click();
    const response = await responsePromise;
    const body = await response.json() as { error: { code: string; message: string } };

    expect(response.status()).toBe(401);
    expectRequestId(response.headers());
    await expectAuditEventEventually('auth.password_reset_confirm_failed', null);
    expect(body).toEqual({
      error: {
        code: 'invalid_token',
        message: 'Password reset token is invalid or expired',
      },
    });
    await expect(page.getByTestId('auth-form-error')).toContainText('invalid or expired');
    await expect(page.getByRole('link', { name: 'Request a new reset link' })).toBeVisible();
    expect((await context.cookies()).filter((cookie) => cookie.name.startsWith('tr_'))).toHaveLength(0);
  });

  test('request and confirm forms match desktop and mobile visual baselines', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await gotoVisualPage(page, '/auth/password-reset/request');
    await expect(page).toHaveScreenshot('password-reset-request-desktop.png', {
      maxDiffPixels: 100,
    });

    await gotoVisualPage(page, '/auth/password-reset/confirm?token=visual-token');
    await expect(page).toHaveScreenshot('password-reset-confirm-desktop.png', {
      maxDiffPixels: 100,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await gotoVisualPage(page, '/auth/password-reset/request');
    await expect(page).toHaveScreenshot('password-reset-request-mobile.png', {
      maxDiffPixels: 100,
    });

    await gotoVisualPage(page, '/auth/password-reset/confirm?token=visual-token');
    await expect(page).toHaveScreenshot('password-reset-confirm-mobile.png', {
      maxDiffPixels: 100,
    });
  });
});
