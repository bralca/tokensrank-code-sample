import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { expect, test, type APIResponse, type Page, type Response as PlaywrightResponse } from '@playwright/test';

import { hideNextDevTools } from '../visual-helpers';

const PASSWORD = 'Tr-valid-password-85!';
const DEBOUNCE_MS = 400;
const BUTTON_CHANGE_MS = 100;
const REDIRECT_MS = 1000;
const PROFILE_LOAD_MS = 1000;
const testSchema = `tokensrank_test_w${Number(process.env.PLAYWRIGHT_WORKER_INDEX ?? 0) % 4}`;

type TestUser = {
  email: string;
  password: string;
  handle: string;
};

type SignedUpProfile = {
  id: string;
  user_id: string;
  handle: string;
  mode: 'script_verified' | 'self_reported' | null;
  verified: boolean | null;
};

const createdAuthUserIds = new Set<string>();

function loadRootEnv(): void {
  const envPath = resolve(process.cwd(), '../../.env');

  if (!existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/u)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);

    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;

    if (key && process.env[key] === undefined) {
      process.env[key] = (rawValue ?? '').replace(/^['"]|['"]$/gu, '');
    }
  }
}

function apiBaseUrl(): string {
  return `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;
}

function webBaseUrl(): string {
  return `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_PORT ?? 3000}`;
}

function apiUrl(path: string): string {
  return `${apiBaseUrl()}${path}`;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[signup-self-reported] Missing required environment variable: ${name}`);
  }

  return value;
}

function createServiceRoleClient(schema?: string) {
  return createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      ...(schema ? { db: { schema } } : {}),
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      ...(schema
        ? {
          global: {
            headers: {
              'Accept-Profile': schema,
              'Content-Profile': schema,
            },
          },
        }
        : {}),
    },
  );
}

function createSchemaServiceRoleClient() {
  return createServiceRoleClient(testSchema);
}

function uniqueToken(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 14)}`.toLowerCase();
}

function createTestUser(prefix = 'self'): TestUser {
  const token = uniqueToken(prefix).slice(0, 24);

  return {
    email: `${token}-${randomUUID()}@example.com`,
    password: PASSWORD,
    handle: token.slice(0, 30),
  };
}

async function deleteAuthUsers(userIds: Iterable<string>): Promise<void> {
  const authAdmin = createServiceRoleClient();

  for (const userId of Array.from(userIds)) {
    await authAdmin.auth.admin.deleteUser(userId);
  }
}

async function readProfileByHandle(handle: string): Promise<SignedUpProfile> {
  const { data, error } = await createSchemaServiceRoleClient()
    .from('profiles')
    .select('id,user_id,handle,mode,verified')
    .eq('handle', handle)
    .single();

  if (error || !data) {
    throw new Error(`[signup-self-reported] profile lookup failed for ${handle}: ${error?.message ?? 'missing profile'}`);
  }

  return data as SignedUpProfile;
}

async function readSessionById(profileId: string, sessionId: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { data, error } = await createSchemaServiceRoleClient()
      .from('sessions')
      .select('profile_id,session_id,ingestion_mode,total_tokens')
      .eq('profile_id', profileId)
      .eq('session_id', sessionId)
      .maybeSingle();

    if (!error && data) {
      return data as {
        profile_id: string;
        session_id: string;
        ingestion_mode: 'script_verified' | 'self_reported';
        total_tokens: number;
      };
    }

    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 250);
    });
  }

  throw new Error(`[signup-self-reported] session lookup failed for ${sessionId}: missing session`);
}

async function submitSignUpForm(page: Page, user: TestUser): Promise<PlaywrightResponse> {
  await page.goto('/auth/sign-up');
  await page.getByTestId('auth-field-email').fill(user.email);
  await page.getByTestId('auth-field-password').fill(user.password);
  await page.getByTestId('auth-field-handle').fill(user.handle);
  await expect(page.getByTestId('handle-availability')).toHaveText('✓ available', {
    timeout: DEBOUNCE_MS + 5000,
  });

  const responsePromise = page.waitForResponse((response) => response.url().includes('/api/auth/sign-up'));
  await page.getByTestId('auth-submit').click();

  return responsePromise;
}

async function postDirectSignUp(page: Page, user: TestUser): Promise<APIResponse> {
  return page.request.post(apiUrl('/api/auth/sign-up'), {
    headers: {
      Origin: webBaseUrl(),
      'Content-Type': 'application/json',
    },
    data: user,
    maxRedirects: 0,
  });
}

async function fillHandle(page: Page, handle: string): Promise<void> {
  const input = page.getByTestId('auth-field-handle');

  await input.fill('');
  await input.pressSequentially(handle, { delay: 5 });
  await expect(input).toHaveValue(handle);
}

async function observeIndicatorText(page: Page, expectedText: string, timeoutMs: number): Promise<boolean> {
  return page.evaluate(({ expectedText: expected, timeoutMs: timeout }) => {
    return new Promise<boolean>((resolvePromise) => {
      const readIndicator = () => document.querySelector('[data-testid="handle-availability"]')?.textContent;
      const currentText = readIndicator();

      if (currentText === expected) {
        resolvePromise(true);
        return;
      }

      const observer = new MutationObserver(() => {
        if (readIndicator() === expected) {
          window.clearTimeout(timer);
          observer.disconnect();
          resolvePromise(true);
        }
      });
      const timer = window.setTimeout(() => {
        observer.disconnect();
        resolvePromise(false);
      }, timeout);

      observer.observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });
  }, { expectedText, timeoutMs });
}

async function signUpThroughUi(page: Page, prefix = 'self'): Promise<TestUser> {
  const user = createTestUser(prefix);
  const response = await submitSignUpForm(page, user);

  expect([200, 202, 302]).toContain(response.status());
  await expect(page).toHaveURL(/\/onboarding/u, { timeout: REDIRECT_MS + 4000 });
  const profile = await readProfileByHandle(user.handle);

  createdAuthUserIds.add(profile.user_id);
  await addE2eOnboardingCookie(page, user, profile);
  await page.goto('/onboarding');
  await expect(page).toHaveURL(/\/onboarding/u, { timeout: REDIRECT_MS + 4000 });

  return user;
}

async function openOnboardingForSignedUpUser(page: Page, prefix = 'self'): Promise<TestUser> {
  const user = createTestUser(prefix);
  const response = await postDirectSignUp(page, user);

  expect([200, 202, 302]).toContain(response.status());
  const profile = await readProfileByHandle(user.handle);

  createdAuthUserIds.add(profile.user_id);
  await addAuthCookiesFromResponse(page, response);
  await addE2eOnboardingCookie(page, user, profile);
  await page.goto('/onboarding');
  await expect(page.getByTestId('onboarding-mode-select')).toBeVisible({ timeout: 20_000 });

  return user;
}

async function createSelfReportedApiFixture(page: Page, prefix = 'manual') {
  const user = createTestUser(prefix);
  const signUp = await postDirectSignUp(page, user);

  expect([200, 202, 302]).toContain(signUp.status());
  const accessToken = await extractSetCookieValue(signUp, 'tr_at', 'self-reported fixture sign-up');
  const profile = await readProfileByHandle(user.handle);

  createdAuthUserIds.add(profile.user_id);

  const modeResponse = await page.request.post(apiUrl('/api/me/onboarding'), {
    headers: {
      Cookie: `tr_at=${encodeURIComponent(accessToken)}`,
      Origin: webBaseUrl(),
      'Content-Type': 'application/json',
    },
    data: {
      mode: 'self_reported',
    },
  });

  expect(modeResponse.status()).toBe(200);

  const keyResponse = await page.request.post(apiUrl('/api/access-keys/generate'), {
    headers: {
      Cookie: `tr_at=${encodeURIComponent(accessToken)}`,
      Origin: webBaseUrl(),
      'Content-Type': 'application/json',
    },
    data: {
      scope: 'self_reported',
    },
  });
  const keyBody = await keyResponse.json() as { data?: { plaintext?: string } };

  expect(keyResponse.status()).toBe(200);
  expect(keyBody.data?.plaintext).toMatch(/^tr_self_reported_[A-Za-z0-9_-]{32}$/u);

  return {
    accessToken,
    accessKey: keyBody.data?.plaintext ?? '',
    profile,
    user,
  };
}

async function generateAccessKeyForToken(page: Page, accessToken: string, scope: 'script' | 'self_reported') {
  const response = await page.request.post(apiUrl('/api/access-keys/generate'), {
    headers: {
      Cookie: `tr_at=${encodeURIComponent(accessToken)}`,
      Origin: webBaseUrl(),
      'Content-Type': 'application/json',
    },
    data: {
      scope,
    },
  });
  const body = await response.json() as { data?: { plaintext?: string } };

  expect(response.status()).toBe(200);
  expect(body.data?.plaintext).toMatch(new RegExp(`^tr_${scope}_[A-Za-z0-9_-]{32}$`, 'u'));

  return body.data?.plaintext ?? '';
}

function getSetCookieHeader(response: APIResponse): string | undefined {
  const setCookieValues = response.headersArray()
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value);

  if (setCookieValues.length > 0) {
    return setCookieValues.join(', ');
  }

  return response.headers()['set-cookie'];
}

async function extractSetCookieValue(
  response: APIResponse,
  name: 'tr_at' | 'tr_rt',
  context: string,
): Promise<string> {
  const setCookie = getSetCookieHeader(response);
  const match = (setCookie ?? '').match(new RegExp(`${name}=([^;]+)`, 'u'));

  if (!match?.[1]) {
    throw new Error(
      `[signup-self-reported] ${name} was not present in Set-Cookie for ${context}; `
      + `status=${response.status()}; body=${await response.text()}`,
    );
  }

  return decodeURIComponent(match[1]);
}

async function addAuthCookiesFromResponse(page: Page, response: APIResponse): Promise<void> {
  const accessToken = await extractSetCookieValue(response, 'tr_at', 'direct sign-up access token');
  const refreshToken = await extractSetCookieValue(response, 'tr_rt', 'direct sign-up refresh token');

  await page.context().addCookies([
    {
      name: 'tr_at',
      value: accessToken,
      url: apiBaseUrl(),
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
    {
      name: 'tr_at',
      value: accessToken,
      url: webBaseUrl(),
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
    {
      name: 'tr_rt',
      value: refreshToken,
      url: `${apiBaseUrl()}/api/auth/refresh`,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
}

async function addE2eOnboardingCookie(page: Page, user: TestUser, profile: SignedUpProfile): Promise<void> {
  await page.context().addCookies([{
    name: 'tr_e2e_onboarding',
    value: encodeURIComponent(JSON.stringify({
      userId: profile.user_id,
      email: user.email,
      handle: profile.handle,
      displayName: null,
      avatarUrl: null,
      bio: null,
      xHandle: null,
      mode: profile.mode,
      onboardedAt: null,
      shareProjects: false,
      onboarding: {
        step: 'not_started',
      },
      accessKeys: [],
      recentIngestionRuns: [],
    })),
    url: webBaseUrl(),
    sameSite: 'Lax',
  }]);
}

async function chooseSelfReportedPath(page: Page): Promise<void> {
  await expect(page.getByTestId('onboarding-mode-select')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('onboarding-mode-self_reported').click();
  await expect(page.getByTestId('onboarding-mode-self_reported-pip')).toBeVisible();
  await page.getByTestId('onboarding-next').click();
  await expect(page).toHaveURL(/\/onboarding\/waiting\?mode=self_reported/u, { timeout: 20_000 });
  await expect(page.getByTestId('onboarding-self-reported')).toBeVisible({ timeout: 20_000 });
}

function buildSelfReportedPayload(label: string) {
  const safeLabel = label.replace(/[^a-z0-9_-]/gu, '-');

  return {
    client: {
      version: 'self-reported-e2e-1.0.0',
      install_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      platform: 'darwin',
      arch: 'arm64',
    },
    run: {
      run_id: `self-run-${safeLabel}`,
      started_at: '2026-04-28T10:00:00.000Z',
      finished_at: '2026-04-28T10:10:00.000Z',
    },
    sessions: [
      {
        session_id: `self-session-${safeLabel}`,
        model: 'claude-3-5-sonnet-20241022',
        source: 'claude',
        first_event_at: '2026-04-28T10:00:00.000Z',
        last_event_at: '2026-04-28T10:05:00.000Z',
        input_tokens: 8500,
        output_tokens: 1200,
        cache_read_input_tokens: 400,
        cache_creation_input_tokens: 0,
        cached_input_tokens: 0,
        reasoning_output_tokens: 0,
        turns: 4,
        file_sha256: createHash('sha256').update(`self-reported-${safeLabel}`).digest('hex'),
      },
    ],
  };
}

async function postSelfReportedSessions(page: Page, accessKey: string, payload: unknown): Promise<APIResponse> {
  return page.request.post(apiUrl('/api/self-reported/sessions'), {
    headers: {
      Authorization: `Bearer ${accessKey}`,
      Origin: webBaseUrl(),
      'Content-Type': 'application/json',
    },
    data: payload,
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  loadRootEnv();
  process.env.SUPABASE_SCHEMA = testSchema;
});

test.afterAll(async () => {
  await deleteAuthUsers(createdAuthUserIds);
});

test.beforeEach(async ({ page }) => {
  page.on('console', (message) => {
    const text = message.text();

    if (
      message.type() === 'error'
      && !text.includes('Failed to load resource')
      && !text.includes('Failed to fetch RSC payload')
      && !text.includes('Load failed')
    ) {
      throw new Error(`[browser] ${message.text()}`);
    }
  });
});

test.afterEach(async ({ context }) => {
  await context.clearCookies();
});

test('85.2: regression harness uses the worker schema and local app origins', async () => {
  expect(testSchema).toMatch(/^tokensrank_test_w[0-3]$/u);
  expect(apiBaseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  expect(webBaseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
});

test('85.3: sign-up form loads with 4 controls and no OAuth buttons', async ({ page }) => {
  await page.goto('/auth/sign-up');

  await expect(page.getByRole('heading', { name: 'Claim your builder handle' })).toBeVisible();
  await expect(page.getByTestId('auth-field-email')).toBeVisible();
  await expect(page.getByTestId('auth-field-password')).toBeVisible();
  await expect(page.getByTestId('auth-field-handle')).toBeVisible();
  await expect(page.getByTestId('auth-submit')).toHaveText('Create account');
  await expect(page.getByTestId('auth-form').locator('input, button[type="submit"]')).toHaveCount(4);
  await expect(page.getByRole('button', { name: /google|github|twitter|oauth|continue with (google|github|x|twitter)/iu })).toHaveCount(0);
});

test('85.4: handle availability check shows debounced V-2 feedback', async ({ page }) => {
  const takenUser = createTestUser('taken');
  const takenResponse = await postDirectSignUp(page, takenUser);

  expect([200, 202, 302]).toContain(takenResponse.status());
  createdAuthUserIds.add((await readProfileByHandle(takenUser.handle)).user_id);

  await page.goto('/auth/sign-up');
  const checkingSeen = observeIndicatorText(page, 'checking…', 1200);
  const requestPromise = page.waitForRequest((request) => request.url().includes('/api/handle/check'));
  const startedAt = Date.now();
  const availableHandle = uniqueToken('free');

  await fillHandle(page, availableHandle);
  await requestPromise;
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(DEBOUNCE_MS - 75);
  await expect(checkingSeen).resolves.toBe(true);
  await expect(page.getByTestId('handle-availability')).toHaveText('✓ available', { timeout: 2000 });
  await expect(page.getByTestId('handle-availability')).toHaveCSS('color', 'rgb(182, 255, 60)');

  await fillHandle(page, takenUser.handle);
  await expect(page.getByTestId('handle-availability')).toHaveText('× taken', { timeout: 2000 });
  await expect(page.getByTestId('handle-availability')).toHaveCSS('color', 'rgb(239, 68, 68)');

  await fillHandle(page, 'Uppercase');
  await expect(page.getByTestId('handle-availability')).toHaveText('× must be lowercase', { timeout: 2000 });
});

test('85.5: valid sign-up creates the trigger-owned profile shell', async ({ page }) => {
  const user = createTestUser('valid');
  const response = await postDirectSignUp(page, user);
  const body = await response.json() as { data?: { profileId?: string; handle?: string; userId?: string } };

  expect(response.status()).toBe(302);
  expect(response.headers().location).toBe('/onboarding');
  expect(getSetCookieHeader(response)).toContain('tr_at=');
  expect(getSetCookieHeader(response)).toContain('tr_rt=');
  expect(body.data).toMatchObject({
    handle: user.handle,
    profileId: expect.any(String),
    userId: expect.any(String),
  });

  const profile = await readProfileByHandle(user.handle);

  createdAuthUserIds.add(profile.user_id);
  expect(profile).toMatchObject({
    id: body.data?.profileId,
    user_id: body.data?.userId,
    handle: user.handle,
    mode: null,
  });
});

test('85.6: onboarding shows 2-step tabs with no auto-advance', async ({ page }) => {
  await openOnboardingForSignedUpUser(page, 'tabs');

  await expect(page.getByText('Step 01 / Choose mode')).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Choose verification path' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /VERIFIED/u })).toBeVisible();
  await expect(page.getByRole('tab', { name: /SELF-REPORTED/u })).toBeVisible();
  await expect(page.getByTestId('onboarding-next')).toBeDisabled();
  await page.waitForTimeout(900);
  await expect(page).toHaveURL(/\/onboarding$/u);
  await expect(page.getByTestId('onboarding-self-reported')).toHaveCount(0);
  await expect(page.getByTestId('onboarding-script-install')).toHaveCount(0);
});

test('85.7: selecting self-reported path shows endpoint configuration', async ({ page }) => {
  const user = await openOnboardingForSignedUpUser(page, 'config');

  await chooseSelfReportedPath(page);
  await expect(page.getByText('Step 02 / Self-reported').first()).toBeVisible();
  await expect(page.getByTestId('self-reported-endpoint')).toContainText('/api/self-reported/sessions');
  await expect(page.getByTestId('self-reported-token')).toHaveText(/^tr_self_reported_[A-Za-z0-9_-]{32}$/u);
  await expect(page.getByTestId('self-reported-payload')).toContainText(`"session_id": "${user.handle}-manual-session-001"`);
  await expect(page.getByTestId('self-reported-payload')).not.toContainText('ingestion_mode');
  await expect(page.getByTestId('self-reported-curl')).toContainText('Authorization: Bearer tr_self_reported_');
  await expect(page.getByTestId('onboarding-script-install')).toHaveCount(0);
  await expect(page.getByTestId('onboarding-live-log')).toHaveCount(0);
});

test('85.8: sign-up error paths return stable error envelopes', async ({ page }) => {
  const invalidHandle = await postDirectSignUp(page, {
    ...createTestUser('invalid'),
    handle: 'Uppercase',
  });

  expect(invalidHandle.status()).toBe(400);
  await expect(invalidHandle.json()).resolves.toMatchObject({ error: { code: 'invalid_handle' } });

  const first = createTestUser('duplicate');
  const firstResponse = await postDirectSignUp(page, first);

  expect([200, 202, 302]).toContain(firstResponse.status());
  createdAuthUserIds.add((await readProfileByHandle(first.handle)).user_id);

  const duplicateHandle = await postDirectSignUp(page, {
    ...createTestUser('duphandle'),
    handle: first.handle,
  });

  expect(duplicateHandle.status()).toBe(409);
  await expect(duplicateHandle.json()).resolves.toMatchObject({ error: { code: 'handle_taken' } });

  const duplicateEmail = await postDirectSignUp(page, {
    ...createTestUser('dupemail'),
    email: first.email,
  });

  expect(duplicateEmail.status()).toBe(409);
  await expect(duplicateEmail.json()).resolves.toMatchObject({ error: { code: 'email_taken' } });

  const breachedPassword = await postDirectSignUp(page, {
    ...createTestUser('breach'),
    password: 'password123',
  });

  expect(breachedPassword.status()).toBe(400);
  await expect(breachedPassword.json()).resolves.toMatchObject({ error: { code: 'password_breached' } });
});

test('85.9: self-reported user can manually POST to ingestion endpoint', async ({ page }) => {
  const fixture = await createSelfReportedApiFixture(page, 'manual');
  const { accessKey, user } = fixture;
  const payload = buildSelfReportedPayload(user.handle);
  const response = await postSelfReportedSessions(page, accessKey, payload);
  const body = await response.json() as Record<string, unknown>;
  const profile = await readProfileByHandle(user.handle);

  expect(response.status()).toBe(202);
  expect(body).toMatchObject({
    ingestion_run_id: expect.any(String),
    accepted: 1,
    deduped: 0,
    rejected: 0,
  });
  const session = await readSessionById(profile.id, payload.sessions[0].session_id);

  expect(profile).toMatchObject({
    mode: 'self_reported',
    verified: false,
  });
  expect(session).toMatchObject({
    profile_id: profile.id,
    session_id: payload.sessions[0].session_id,
    ingestion_mode: 'self_reported',
  });
  expect(Number(session.total_tokens)).toBe(10_100);
});

test('85.10: self-reported avatar shows wave glyph, not verified check', async ({ page }) => {
  const fixture = await createSelfReportedApiFixture(page, 'avatar');

  await page.goto(`/u/${fixture.user.handle}`);
  await expect(page.getByTestId('profile-section-identity')).toBeVisible({ timeout: PROFILE_LOAD_MS * 20 });
  await expect(page.getByTestId('avatar-with-badge').first()).toHaveAttribute('aria-label', 'Self-reported');
  await expect(page.getByTestId('avatar-verification-pip').first()).toHaveText('~');
  await expect(page.getByTestId('avatar-verification-pip').first()).not.toHaveText('✓');
  await expect(page.getByText('Self-reported').first()).toBeVisible();
});

test('85.11: auth form visual regression matches the JSX-derived baseline', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Auth visual baselines are browser-renderer specific.');

  await page.goto('/auth/sign-up');
  await hideNextDevTools(page);
  await expect(page).toHaveScreenshot('auth-sign-up.png', {
    maxDiffPixels: 1,
  });
});

test('85.12: integration contracts reject client-owned mode and wrong key scope', async ({ page }) => {
  const fixture = await createSelfReportedApiFixture(page, 'contracts');
  const scriptKey = await generateAccessKeyForToken(page, fixture.accessToken, 'script');
  const payload = buildSelfReportedPayload(fixture.user.handle);
  const injectedMode = {
    ...payload,
    sessions: [
      {
        ...payload.sessions[0],
        ingestion_mode: 'script_verified',
      },
    ],
  };
  const wrongScope = await postSelfReportedSessions(page, scriptKey, payload);
  const injectedModeResponse = await postSelfReportedSessions(page, fixture.accessKey, injectedMode);

  expect(wrongScope.status()).toBe(403);
  await expect(wrongScope.json()).resolves.toMatchObject({
    error: {
      code: 'wrong_key_scope',
    },
  });
  expect(injectedModeResponse.status()).toBe(400);
  await expect(injectedModeResponse.json()).resolves.toMatchObject({
    error: {
      code: 'schema_invalid',
    },
  });
});
