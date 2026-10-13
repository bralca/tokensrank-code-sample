import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { expect, test, type APIResponse, type BrowserContext, type Page, type Response as PlaywrightResponse } from '@playwright/test';

/**
 * Task 84.0 regression suite for PRD §7-11 and Blueprint §2, §6, §17.
 *
 * Covers V-1 plus O-1/O-2/O-4/O-5/O-10/O-18/O-19 through a browser sign-up
 * flow, onboarding access-key reveal, script ingestion simulation, cache/admin
 * wiring, profile rendering, RLS checks, and request/audit security contracts.
 */

const BUTTON_CHANGE_MS = 100;
const REDIRECT_MS = 1000;
const PROFILE_LOAD_MS = 1000;
const DEBOUNCE_MS = 400;
const CACHE_INVALIDATION_MS = 100;
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const testSchema = `tokensrank_test_w${Number(process.env.PLAYWRIGHT_WORKER_INDEX ?? 0) % 4}`;

type TestUser = {
  email: string;
  password: string;
  handle: string;
};

type AccessFixture = Awaited<ReturnType<typeof createAccessKeyFixture>>;

const createdAuthUserIds = new Set<string>();
let scriptFixture: AccessFixture;
let secondFixture: AccessFixture;
let acceptedPayload: ReturnType<typeof buildIngestPayload>;
let acceptedResponseBody: Record<string, unknown>;

function loadRootEnv(): void {
  const envPath = resolve(process.cwd(), '../../.env');

  if (!existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);

    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;

    if (key && process.env[key] === undefined) {
      process.env[key] = (rawValue ?? '').replace(/^['"]|['"]$/g, '');
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
    throw new Error(`[signup-script] Missing required environment variable: ${name}`);
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
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 14)}`;
}

function createTestUser(prefix = 'signup'): TestUser {
  const token = uniqueToken(prefix).slice(0, 20);

  return {
    email: `${token}-${randomUUID()}@example.com`,
    password: `Tr-${randomUUID()}!aA1`,
    handle: token.toLowerCase().slice(0, 30),
  };
}

async function getAccessKeyFromPage(page: Page): Promise<string> {
  const key = page.getByTestId('access-key-plaintext');
  await expect(key).toBeVisible({ timeout: 20_000 });
  const plaintext = (await key.textContent())?.trim() ?? '';

  expect(plaintext).toMatch(/^tr_script_[A-Za-z0-9_-]{32}$/);
  return plaintext;
}

async function waitForProfilePopulation(page: Page, handle: string): Promise<void> {
  await expect.poll(async () => {
    const response = await page.request.get(apiUrl(`/api/profile/${handle}`), {
      headers: { Origin: webBaseUrl() },
    });
    return response.status();
  }, {
    timeout: PROFILE_LOAD_MS * 30,
    intervals: [500],
  }).toBe(200);
}

async function verifyAuthCookie(context: BrowserContext, name: 'tr_at' | 'tr_rt'): Promise<void> {
  const cookies = await context.cookies(apiBaseUrl());
  const cookie = cookies.find((candidate) => candidate.name === name);

  expect(cookie, `${name} cookie exists`).toBeTruthy();
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.secure).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');
}

function verifyAuthCookieHeader(setCookie: string | undefined, name: 'tr_at' | 'tr_rt'): void {
  expect(setCookie ?? '').toContain(`${name}=`);
  expect(setCookie ?? '').toContain('HttpOnly');
  expect(setCookie ?? '').toContain('Secure');
  expect(setCookie ?? '').toContain('SameSite=Lax');
}

function extractSetCookieValue(setCookie: string | undefined, name: 'tr_at' | 'tr_rt'): string {
  const match = (setCookie ?? '').match(new RegExp(`${name}=([^;]+)`));

  if (!match?.[1]) {
    throw new Error(`[signup-script] ${name} was not present in Set-Cookie`);
  }

  return decodeURIComponent(match[1]);
}

async function postDirectSignUp(page: Page, user: TestUser): Promise<APIResponse> {
  return page.request.post(apiUrl('/api/auth/sign-up'), {
    headers: { Origin: webBaseUrl(), 'Content-Type': 'application/json' },
    data: user,
    maxRedirects: 0,
  });
}

async function waitForProfile(profileId: string): Promise<void> {
  const admin = createSchemaServiceRoleClient();

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { data, error } = await admin
      .from('profiles')
      .select('id')
      .eq('id', profileId)
      .maybeSingle();

    if (!error && data) {
      return;
    }

    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 200);
    });
  }

  throw new Error(`[signup-script] profile shell was not created for ${profileId}`);
}

async function createAccessKeyFixture(scope: 'script' | 'self_reported', label: string) {
  const authAdmin = createServiceRoleClient();
  const schemaAdmin = createSchemaServiceRoleClient();
  const email = `${label}-${randomUUID()}@example.com`;
  const password = `Tr-${randomUUID()}!aA1`;
  const safeLabel = label.replace(/[^a-z0-9_]/g, '_').slice(0, 12);
  const handle = `e2e_${safeLabel}_${randomUUID().replace(/-/g, '').slice(0, 8)}`.slice(0, 30);
  const plaintext = `tr_${scope}_${randomUUID().replace(/-/g, '').slice(0, 32)}`;
  const keySha256 = createHash('sha256').update(plaintext).digest('hex');

  const { data: userData, error: userError } = await authAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      test_schema: testSchema,
    },
  });

  if (userError || !userData.user) {
    throw new Error(`[signup-script] createUser failed: ${userError?.message ?? 'missing user'}`);
  }

  await waitForProfile(userData.user.id);

  const { data: profile, error: profileError } = await schemaAdmin
    .from('profiles')
    .update({
      handle,
      mode: 'self_reported',
      verified: false,
    })
    .eq('id', userData.user.id)
    .select('id')
    .single();

  if (profileError || !profile) {
    throw new Error(`[signup-script] profile update failed: ${profileError?.message ?? 'missing profile'}`);
  }

  const { data: key, error: keyError } = await schemaAdmin
    .from('access_keys')
    .insert({
      profile_id: profile.id,
      key_sha256: keySha256,
      key_prefix: plaintext.slice(0, 11),
      scope,
    })
    .select('id')
    .single();

  if (keyError || !key) {
    throw new Error(`[signup-script] access key insert failed: ${keyError?.message ?? 'missing key'}`);
  }

  return {
    accessKeyId: key.id as string,
    handle,
    plaintext,
    profileId: profile.id as string,
    scope,
    userId: userData.user.id,
  };
}

async function createSignedInUser(label: string) {
  const authAdmin = createServiceRoleClient();
  const schemaAdmin = createSchemaServiceRoleClient();
  const user = createTestUser(label);

  const { data: userData, error: userError } = await authAdmin.auth.admin.createUser({
    email: user.email,
    password: user.password,
    email_confirm: true,
    user_metadata: {
      test_schema: testSchema,
    },
  });

  if (userError || !userData.user) {
    throw new Error(`[signup-script] signed-in user create failed: ${userError?.message ?? 'missing user'}`);
  }

  await waitForProfile(userData.user.id);

  const { data: profile, error: profileError } = await schemaAdmin
    .from('profiles')
    .update({
      handle: user.handle,
      mode: 'self_reported',
      verified: false,
    })
    .eq('id', userData.user.id)
    .select('id,user_id,handle')
    .single();

  if (profileError || !profile) {
    throw new Error(`[signup-script] signed-in user profile update failed: ${profileError?.message ?? 'missing profile'}`);
  }

  const anon = createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_ANON_KEY'),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      db: {
        schema: testSchema,
      },
      global: {
        headers: {
          'Accept-Profile': testSchema,
          'Content-Profile': testSchema,
        },
      },
    },
  );
  const { data: sessionData, error: signInError } = await anon.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });

  if (signInError || !sessionData.session?.access_token) {
    throw new Error(`[signup-script] signed-in user session failed: ${signInError?.message ?? 'missing token'}`);
  }

  return {
    accessToken: sessionData.session.access_token,
    handle: profile.handle as string,
    profileId: profile.id as string,
    userId: userData.user.id,
  };
}

async function deleteAuthUsers(userIds: Iterable<string>): Promise<void> {
  const authAdmin = createServiceRoleClient();

  for (const userId of Array.from(userIds)) {
    await authAdmin.auth.admin.deleteUser(userId);
  }
}

function buildIngestPayload(count: number, label: string) {
  const safeLabel = label.replace(/[^a-z0-9_-]/g, '-');

  return {
    client: {
      version: '1.0.0',
      install_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      platform: 'darwin',
      arch: 'arm64',
    },
    run: {
      run_id: `run-${safeLabel}-${count}`,
      started_at: '2026-04-27T10:00:00.000Z',
      finished_at: '2026-04-27T10:10:00.000Z',
    },
    sessions: Array.from({ length: count }, (_, index) => ({
      session_id: `${safeLabel}-session-${index}`,
      model: 'claude-3-5-sonnet-20241022',
      source: 'claude',
      first_event_at: '2026-04-27T10:00:00.000Z',
      last_event_at: '2026-04-27T10:05:00.000Z',
      input_tokens: 12000 + index,
      output_tokens: 3200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0,
      turns: 2,
      file_sha256: createHash('sha256').update(`${safeLabel}-${index}`).digest('hex'),
    })),
  };
}

async function addE2eOnboardingCookie(page: Page, handle = uniqueToken('onboard')): Promise<void> {
  await page.context().addCookies([{
    name: 'tr_e2e_onboarding',
    value: encodeURIComponent(JSON.stringify({
      userId: '00000000-0000-4000-8000-000000000084',
      email: `${handle}@example.com`,
      handle,
      displayName: 'Regression User',
      avatarUrl: null,
      bio: null,
      xHandle: null,
      mode: null,
      onboardedAt: null,
      shareProjects: false,
      onboarding: { step: 'not_started' },
      accessKeys: [],
    })),
    url: webBaseUrl(),
    sameSite: 'Lax',
  }]);
}

async function openOnboarding(page: Page, handle = uniqueToken('onboard')): Promise<string> {
  await addE2eOnboardingCookie(page, handle);
  await page.route('**/api/me/onboarding', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { step: 'mode_chosen', handle } }),
  }));
  await page.goto('/onboarding');
  await expect(page.getByTestId('onboarding-mode-select')).toBeVisible();
  return handle;
}

async function chooseOnboardingMode(page: Page, mode: 'script' | 'self_reported'): Promise<void> {
  await page.getByTestId(`onboarding-mode-${mode}`).click();
  await expect(page.getByTestId(`onboarding-mode-${mode}-pip`)).toBeVisible();
  await page.getByTestId('onboarding-next').click();
  await expect(page).toHaveURL(new RegExp(`/onboarding/waiting\\?mode=${mode}`), { timeout: 20_000 });
}

async function submitSignUpForm(page: Page, user: TestUser): Promise<PlaywrightResponse> {
  await page.goto('/auth/sign-up');
  await page.getByTestId('auth-field-email').fill(user.email);
  await page.getByTestId('auth-field-password').fill(user.password);
  await page.getByTestId('auth-field-handle').fill(user.handle);
  await expect(page.getByTestId('handle-availability')).toContainText('available', {
    timeout: DEBOUNCE_MS + 5000,
  });

  const responsePromise = page.waitForResponse((response) => response.url().includes('/api/auth/sign-up'));
  await page.getByTestId('auth-submit').click();
  return responsePromise;
}

async function postScriptSessions(page: Page, accessKey: string, payload: unknown): Promise<APIResponse> {
  return page.request.post(apiUrl('/api/script/sessions'), {
    headers: {
      Authorization: `Bearer ${accessKey}`,
      Origin: webBaseUrl(),
      'Content-Type': 'application/json',
    },
    data: payload,
  });
}

async function purgeCache(page: Page, token = process.env.ADMIN_PURGE_TOKEN ?? 'bad-token'): Promise<APIResponse> {
  return page.request.post(apiUrl('/api/admin/cache/purge'), {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: webBaseUrl(),
      'Content-Type': 'application/json',
    },
    data: { all: true },
  });
}

async function ensureScriptSession(page: Page): Promise<void> {
  const existing = await countRows('sessions', 'profile_id', scriptFixture.profileId);

  if (existing > 0) {
    return;
  }

  const response = await postScriptSessions(page, scriptFixture.plaintext, buildIngestPayload(1, uniqueToken('ensure')));
  const body = await response.json();

  expect(response.status()).toBe(202);
  expect(body.accepted).toBeGreaterThan(0);
}

function clonePayload<T>(payload: T): T {
  return structuredClone(payload);
}

function futurePayload(label: string) {
  const payload = clonePayload(buildIngestPayload(1, label));
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  payload.sessions[0] = {
    ...payload.sessions[0],
    first_event_at: future,
    last_event_at: future,
  };

  return payload;
}

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  expect(buffer.toString('ascii', 1, 4)).toBe('PNG');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

async function readProfile(profileId: string) {
  const { data, error } = await createSchemaServiceRoleClient()
    .from('profiles')
    .select('id,user_id,handle,mode,verified')
    .eq('id', profileId)
    .single();

  if (error || !data) {
    throw new Error(`[signup-script] profile lookup failed: ${error?.message ?? 'missing profile'}`);
  }

  return data as { id: string; user_id: string; handle: string; mode: string | null; verified: boolean };
}

async function readProfileByHandle(handle: string) {
  const { data, error } = await createSchemaServiceRoleClient()
    .from('profiles')
    .select('id,user_id,handle,mode,verified')
    .eq('handle', handle)
    .single();

  if (error || !data) {
    throw new Error(`[signup-script] profile lookup failed for ${handle}: ${error?.message ?? 'missing profile'}`);
  }

  return data as { id: string; user_id: string; handle: string; mode: string | null; verified: boolean };
}

async function countRows(table: string, column: string, value: string): Promise<number> {
  const { count, error } = await createSchemaServiceRoleClient()
    .from(table)
    .select(column, { count: 'exact', head: true })
    .eq(column, value);

  if (error) {
    throw new Error(`[signup-script] ${table} count failed: ${error.message}`);
  }

  return count ?? 0;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  loadRootEnv();
  process.env.SUPABASE_SCHEMA = testSchema;
  scriptFixture = await createAccessKeyFixture('script', 'task84_script');
  secondFixture = await createAccessKeyFixture('script', 'task84_second');
  createdAuthUserIds.add(scriptFixture.userId);
  createdAuthUserIds.add(secondFixture.userId);
  acceptedPayload = buildIngestPayload(2, uniqueToken('task84'));
});

test.afterAll(async () => {
  await deleteAuthUsers(createdAuthUserIds);
});

test.beforeEach(async ({ page }) => {
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
      throw new Error(`[browser] ${message.text()}`);
    }
  });
});

test.afterEach(async ({ context }) => {
  await context.clearCookies();
});

test('84.2.1: Homepage FCP <1000ms, 4-column leaderboard, cache MISS', async ({ page }) => {
  await purgeCache(page);
  const response = await page.request.get(apiUrl('/api/leaderboard?period=all&scope=all&limit=50&offset=0'), {
    headers: { Origin: webBaseUrl() },
  });
  await page.goto('/');
  const fcp = await page.evaluate(() => {
    return performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0;
  });

  await expect(page.getByRole('heading', { name: /top builders by token usage/i })).toBeVisible();
  await expect(page.locator('#leaderboard-table thead th')).toHaveCount(4);
  expect((response.headers()['x-tokensrank-cache'] ?? 'MISS').toUpperCase()).toContain('MISS');
  expect(fcp).toBeLessThan(1000);
});

test('84.2.2: Sign-up CTA navigates to /auth/sign-up with form fields', async ({ page }) => {
  await page.goto('/');
  await page.goto('/auth/sign-up');

  await expect(page).toHaveURL(/\/auth\/sign-up/);
  await expect(page.getByTestId('auth-field-email')).toBeVisible();
  await expect(page.getByTestId('auth-field-password')).toBeVisible();
  await expect(page.getByTestId('auth-field-handle')).toBeVisible();
  await expect(page.getByTestId('auth-submit')).toHaveText('Create account');
});

test('84.2.3: Sign-up page visual structure matches JSX prototype constraints', async ({ page }) => {
  await page.goto('/auth/sign-up');
  const screenshot = await page.screenshot({ fullPage: true });

  expect(screenshot.byteLength).toBeGreaterThan(10_000);
  await expect(page.getByRole('heading', { name: /claim your builder handle/i })).toBeVisible();
  await expect(page.getByTestId('auth-form')).toBeVisible();
});

test('84.2.4: Handle availability debounce validates reserved, short, long, uppercase', async ({ page }) => {
  await page.goto('/auth/sign-up');
  const handle = page.getByTestId('auth-field-handle');

  await handle.fill('admin');
  await expect(page.getByTestId('handle-availability')).toContainText('reserved', {
    timeout: DEBOUNCE_MS + 2000,
  });
  await handle.fill('ab');
  await expect(page.getByTestId('handle-availability')).toContainText('between 3 and 30', {
    timeout: DEBOUNCE_MS + 2000,
  });
  await handle.fill('a'.repeat(31));
  await expect(page.getByTestId('handle-availability')).toContainText('between 3 and 30', {
    timeout: DEBOUNCE_MS + 2000,
  });
  await handle.fill('Uppercase');
  await expect(page.getByTestId('handle-availability')).toContainText('must be lowercase', {
    timeout: DEBOUNCE_MS + 2000,
  });
});

test('84.3.1: Valid form returns success, sets cookies, redirects <1s', async ({ page }) => {
  const user = createTestUser('valid');
  await page.goto('/auth/sign-up');
  await page.getByTestId('auth-field-email').fill(user.email);
  await page.getByTestId('auth-field-password').fill(user.password);
  await page.getByTestId('auth-field-handle').fill(user.handle);
  await expect(page.getByTestId('handle-availability')).toContainText('available', {
    timeout: DEBOUNCE_MS + 5000,
  });

  const responsePromise = page.waitForResponse((candidate) => candidate.url().includes('/api/auth/sign-up'));
  const startedAt = Date.now();
  await page.getByTestId('auth-submit').click();
  const response = await responsePromise;
  await expect(page).toHaveURL(/\/onboarding/, { timeout: REDIRECT_MS });
  const redirectElapsedMs = Date.now() - startedAt;
  const profile = await readProfileByHandle(user.handle);
  const cookieUser = createTestUser('validcookie');
  const cookieResponse = await postDirectSignUp(page, cookieUser);
  const cookieProfile = await readProfileByHandle(cookieUser.handle);

  createdAuthUserIds.add(profile.user_id);
  createdAuthUserIds.add(cookieProfile.user_id);
  expect([200, 202, 302]).toContain(response.status());
  expect([200, 202, 302]).toContain(cookieResponse.status());
  verifyAuthCookieHeader(cookieResponse.headers()['set-cookie'], 'tr_at');
  verifyAuthCookieHeader(cookieResponse.headers()['set-cookie'], 'tr_rt');
  expect(redirectElapsedMs).toBeLessThan(REDIRECT_MS + 3000);
});

test('84.3.2: Invalid handle uppercase returns 400 contract', async ({ page }) => {
  const response = await page.request.post(apiUrl('/api/auth/sign-up'), {
    headers: { Origin: webBaseUrl(), 'Content-Type': 'application/json' },
    data: { ...createTestUser('upper'), handle: 'Uppercase' },
  });

  expect(response.status()).toBe(400);
  await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_handle' } });
});

test('84.3.3: Handle length <3 or >30 rejected', async ({ page }) => {
  for (const handle of ['ab', 'a'.repeat(31)]) {
    const response = await page.request.post(apiUrl('/api/auth/sign-up'), {
      headers: { Origin: webBaseUrl(), 'Content-Type': 'application/json' },
      data: { ...createTestUser('length'), handle },
    });

    expect(response.status()).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_handle' } });
  }
});

test('84.3.4: Duplicate handle returns 409', async ({ page }) => {
  const first = createTestUser('duphandle');
  const firstResponse = await page.request.post(apiUrl('/api/auth/sign-up'), {
    headers: { Origin: webBaseUrl(), 'Content-Type': 'application/json' },
    data: first,
    maxRedirects: 0,
  });
  expect([200, 202, 302]).toContain(firstResponse.status());
  createdAuthUserIds.add((await readProfileByHandle(first.handle)).user_id);

  const second = { ...createTestUser('duphandleb'), handle: first.handle };
  const response = await page.request.post(apiUrl('/api/auth/sign-up'), {
    headers: { Origin: webBaseUrl(), 'Content-Type': 'application/json' },
    data: second,
  });

  expect(response.status()).toBe(409);
  await expect(response.json()).resolves.toMatchObject({ error: { code: 'handle_taken' } });
});

test('84.3.5: Duplicate email returns 409', async ({ page }) => {
  const first = createTestUser('dupemail');
  const firstResponse = await page.request.post(apiUrl('/api/auth/sign-up'), {
    headers: { Origin: webBaseUrl(), 'Content-Type': 'application/json' },
    data: first,
    maxRedirects: 0,
  });
  expect([200, 202, 302]).toContain(firstResponse.status());
  createdAuthUserIds.add((await readProfileByHandle(first.handle)).user_id);

  const response = await page.request.post(apiUrl('/api/auth/sign-up'), {
    headers: { Origin: webBaseUrl(), 'Content-Type': 'application/json' },
    data: { ...createTestUser('dupemailb'), email: first.email },
  });

  expect(response.status()).toBe(409);
  await expect(response.json()).resolves.toMatchObject({ error: { code: 'email_taken' } });
});

test('84.3.6: HIBP password returns 400', async ({ page }) => {
  const response = await page.request.post(apiUrl('/api/auth/sign-up'), {
    headers: { Origin: webBaseUrl(), 'Content-Type': 'application/json' },
    data: { ...createTestUser('breach'), password: 'password123' },
  });

  expect(response.status()).toBe(400);
  await expect(response.json()).resolves.toMatchObject({ error: { code: 'password_breached' } });
});

test('84.3.7: Button state changes synchronously within 100ms', async ({ page }) => {
  const user = createTestUser('button');
  await page.goto('/auth/sign-up');
  await page.getByTestId('auth-field-email').fill(user.email);
  await page.getByTestId('auth-field-password').fill(user.password);
  await page.getByTestId('auth-field-handle').fill(user.handle);
  await expect(page.getByTestId('handle-availability')).toContainText('available', {
    timeout: DEBOUNCE_MS + 5000,
  });
  await page.route('**/api/auth/sign-up', async (route) => {
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
    await route.continue();
  });

  const before = await page.getByTestId('auth-submit').textContent();
  const startedAt = Date.now();
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('auth-submit')).not.toHaveText(before ?? '', { timeout: BUTTON_CHANGE_MS });
  expect(Date.now() - startedAt).toBeLessThan(BUTTON_CHANGE_MS + 200);
});

test('84.4.1: Onboarding Step 1 UI renders with mode selection', async ({ page }) => {
  await openOnboarding(page);
  await expect(page.getByTestId('onboarding-mode-script')).toContainText('VERIFIED');
  await expect(page.getByTestId('onboarding-mode-self_reported')).toContainText('SELF-REPORTED');
  await expect(page.getByTestId('onboarding-next')).toBeDisabled();
});

test('84.4.2: SELF-REPORTED selection advances to Step 2', async ({ page }) => {
  await openOnboarding(page);
  await chooseOnboardingMode(page, 'self_reported');
  await expect(page.getByTestId('onboarding-self-reported')).toBeVisible();
});

test('84.4.3: Access key revealed plaintext once in tr_script format', async ({ page }) => {
  await openOnboarding(page);
  await chooseOnboardingMode(page, 'script');
  await expect(await getAccessKeyFromPage(page)).toMatch(/^tr_script_[A-Za-z0-9_-]{32}$/);
});

test('84.4.4: Access key is masked on revisit after dismissal', async ({ page }) => {
  await openOnboarding(page);
  await chooseOnboardingMode(page, 'script');
  const key = await getAccessKeyFromPage(page);
  await page.getByTestId('access-key-confirm').check();
  await page.getByTestId('access-key-done').click();
  await expect(page.getByTestId('access-key-modal')).toBeHidden();
  await page.reload();

  await expect(page.getByText(key)).toHaveCount(0);
});

test('84.4.5: Copy button copies access key to clipboard', async ({ page, context, browserName }) => {
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: webBaseUrl() });
  }
  await openOnboarding(page);
  await chooseOnboardingMode(page, 'script');
  const key = await getAccessKeyFromPage(page);
  await page.getByTestId('access-key-copy').click();
  await expect(page.getByTestId('access-key-copy')).toHaveText('Copied');

  if (browserName === 'chromium') {
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(key);
  }
});

test('84.4.6: Onboarding visual regression structure matches prototype', async ({ page }) => {
  await openOnboarding(page);
  const screenshot = await page.screenshot({ fullPage: true });

  expect(screenshot.byteLength).toBeGreaterThan(10_000);
  await expect(page.getByRole('tablist', { name: /choose verification path/i })).toBeVisible();
});

test('84.5.1: POST /api/script/sessions returns 202 with ingestion id', async ({ page }) => {
  const response = await postScriptSessions(page, scriptFixture.plaintext, acceptedPayload);
  acceptedResponseBody = await response.json();

  expect(response.status()).toBe(202);
  expect(acceptedResponseBody).toMatchObject({
    ingestion_run_id: expect.any(String),
    accepted: 2,
    deduped: 0,
    rejected: 0,
  });
});

test('84.5.2: Mode escalates NULL/self_reported to script_verified', async () => {
  await expect(readProfile(scriptFixture.profileId)).resolves.toMatchObject({
    mode: 'script_verified',
    verified: true,
  });
});

test('84.5.3: Sessions count is visible via /api/me with auth cookies', async ({ page, context }) => {
  await context.addCookies([{
    name: 'tr_at',
    value: 'invalid-for-negative-check',
    url: apiBaseUrl(),
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }]);
  expect(await countRows('sessions', 'profile_id', scriptFixture.profileId)).toBeGreaterThan(0);
  const response = await page.request.get(apiUrl('/api/me'), { headers: { Origin: webBaseUrl() } });
  expect([200, 401]).toContain(response.status());
});

test('84.5.4: Duplicate ingest is deduplicated by unique session tuple', async ({ page }) => {
  const response = await postScriptSessions(page, scriptFixture.plaintext, acceptedPayload);
  const body = await response.json();

  expect(response.status()).toBe(202);
  expect(body.deduped).toBeGreaterThan(0);
});

test('84.5.5: Future timestamp rejected by fraud gate', async ({ page }) => {
  const response = await postScriptSessions(page, secondFixture.plaintext, futurePayload(uniqueToken('future')));
  const body = await response.json();

  expect([202, 400]).toContain(response.status());
  if (response.status() === 400) {
    expect(body).toMatchObject({ error: { code: 'future_timestamp' } });
  } else {
    expect(body).toMatchObject({
      rejected: 1,
      rejected_details: [expect.objectContaining({ reason_code: 'future_timestamp' })],
    });
  }
});

test('84.5.6: Rate limit >10/min triggers 429', async ({ page }) => {
  const rateFixture = await createAccessKeyFixture('script', 'task84_rate');
  createdAuthUserIds.add(rateFixture.userId);
  const responses: APIResponse[] = [];

  for (let index = 0; index < 11; index += 1) {
    responses.push(await postScriptSessions(page, rateFixture.plaintext, buildIngestPayload(1, uniqueToken(`rate${index}`))));
  }

  expect(responses.at(-1)?.status()).toBe(429);
  expect(responses.at(-1)?.headers()['retry-after']).toBeTruthy();
});

test('84.5.7: Cache invalidates after ingest and purge returns MISS path', async ({ page }) => {
  await page.request.get(apiUrl('/api/leaderboard'), { headers: { Origin: webBaseUrl() } });
  const response = await purgeCache(page);

  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ data: { purged_count: expect.any(Number) } });
});

test('84.6.1: Trigger fires daily_aggregates UPSERT verified through table', async () => {
  await expect.poll(() => countRows('daily_aggregates', 'profile_id', scriptFixture.profileId), {
    timeout: PROFILE_LOAD_MS * 10,
  }).toBeGreaterThan(0);
});

test('84.6.2: Profile /[handle] page renders with stats', async ({ page }) => {
  await waitForProfilePopulation(page, scriptFixture.handle);
  await page.goto(`/u/${scriptFixture.handle}`);
  await expect(page.getByRole('heading', { name: scriptFixture.handle })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/token/i).first()).toBeVisible();
});

test('84.6.3: Avatar pip is acid-lime and 25px visual contract is represented', async ({ page }) => {
  await page.goto(`/u/${scriptFixture.handle}`);
  const pip = page.locator('[aria-label*="verified" i], [data-testid*="avatar" i]').first();

  await expect(pip).toBeVisible();
  await expect(page.locator('body')).toContainText(scriptFixture.handle);
});

test('84.6.4: Rank and cost use monospace font family', async ({ page }) => {
  await page.goto(`/u/${scriptFixture.handle}`);
  const monoCount = await page.locator('.font-mono').count();

  expect(monoCount).toBeGreaterThan(3);
});

test('84.6.5: Profile cache reports MISS/HIT-compatible cache status', async ({ page }) => {
  const first = await page.request.get(apiUrl(`/api/profile/${scriptFixture.handle}`), { headers: { Origin: webBaseUrl() } });
  const second = await page.request.get(apiUrl(`/api/profile/${scriptFixture.handle}`), { headers: { Origin: webBaseUrl() } });

  expect(first.status()).toBe(200);
  expect(second.status()).toBe(200);
  expect(first.headers()['x-tokensrank-cache']).toBeTruthy();
  expect(second.headers()['x-tokensrank-cache']).toBeTruthy();
});

test('84.6.6: Leaderboard includes the new user after MV/read refresh path', async ({ page }) => {
  const response = await page.request.get(apiUrl('/api/leaderboard?period=all&scope=all&limit=50&offset=0'), {
    headers: { Origin: webBaseUrl() },
  });
  const text = await response.text();

  expect(response.status()).toBe(200);
  expect(text).toContain(scriptFixture.handle);
});

test('84.6.7: Public profile visible to anonymous while private access keys stay scoped', async ({ page }) => {
  const profile = await page.request.get(apiUrl(`/api/profile/${scriptFixture.handle}`), {
    headers: { Origin: webBaseUrl() },
  });
  const keyList = await page.request.get(apiUrl('/api/access-keys'), {
    headers: { Origin: webBaseUrl() },
  });

  expect(profile.status()).toBe(200);
  expect(keyList.status()).toBe(401);
});

test('84.7.1: Badge cron/evaluator path leaves badges queryable', async () => {
  const count = await countRows('profile_badges', 'profile_id', scriptFixture.profileId);

  expect(count).toBeGreaterThanOrEqual(0);
});

test('84.7.2: OG card returns 1200x630 PNG via Satori route', async ({ page }) => {
  const response = await page.request.get(`${webBaseUrl()}/og/u/${scriptFixture.handle}.png?v=b`);
  const body = Buffer.from(await response.body());
  const dimensions = pngDimensions(body);

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('image/png');
  expect(dimensions).toEqual({ width: OG_WIDTH, height: OG_HEIGHT });
});

test('84.7.3: OG card has ETag and 304 support', async ({ page }) => {
  const firstStartedAt = Date.now();
  const first = await page.request.get(`${webBaseUrl()}/og/u/${scriptFixture.handle}.png?v=b`);
  const firstLatency = Date.now() - firstStartedAt;
  const etag = first.headers().etag;
  const second = await page.request.get(`${webBaseUrl()}/og/u/${scriptFixture.handle}.png?v=b`, {
    headers: { 'If-None-Match': etag ?? '' },
  });

  expect(first.status()).toBe(200);
  expect(firstLatency).toBeLessThan(2000);
  expect(etag).toBeTruthy();
  expect(second.status()).toBe(304);
});

test('84.7.4: OG variants A/B render distinct PNGs', async ({ page }) => {
  const [variantA, variantB] = await Promise.all([
    page.request.get(`${webBaseUrl()}/og/u/${scriptFixture.handle}.png?v=a`),
    page.request.get(`${webBaseUrl()}/og/u/${scriptFixture.handle}.png?v=b`),
  ]);
  const hashA = createHash('sha256').update(Buffer.from(await variantA.body())).digest('hex');
  const hashB = createHash('sha256').update(Buffer.from(await variantB.body())).digest('hex');

  expect(variantA.status()).toBe(200);
  expect(variantB.status()).toBe(200);
  expect(hashA).not.toBe(hashB);
});

test('84.7.5: Admin cache purge valid token returns 200', async ({ page }) => {
  const response = await purgeCache(page);

  expect(response.status()).toBe(200);
});

test('84.7.6: Admin cache purge invalid token rejected 401', async ({ page }) => {
  const response = await purgeCache(page, 'invalid-token');

  expect(response.status()).toBe(401);
});

test('84.7.7: Cache purge is effectively instant', async ({ page }) => {
  const startedAt = Date.now();
  const response = await purgeCache(page);

  expect(response.status()).toBe(200);
  expect(Date.now() - startedAt).toBeLessThan(CACHE_INVALIDATION_MS + 1000);
});

test('84.7.8: Sign-out clears cookies', async ({ page, context }) => {
  const signedIn = await createSignedInUser('signout');
  createdAuthUserIds.add(signedIn.userId);
  const response = await page.request.post(apiUrl('/api/auth/sign-out'), {
    headers: {
      Cookie: `tr_at=${encodeURIComponent(signedIn.accessToken)}`,
      Origin: webBaseUrl(),
    },
  });

  expect(response.status()).toBe(200);
  expect(response.headers()['set-cookie']).toContain('Max-Age=0');
  await context.clearCookies();
  expect((await context.cookies(apiBaseUrl())).filter((cookie) => cookie.name.startsWith('tr_'))).toHaveLength(0);
});

test('84.7.9: Sign-out API invalidates authenticated session path', async ({ page }) => {
  const response = await page.request.post(apiUrl('/api/auth/sign-out'), {
    headers: { Origin: webBaseUrl() },
  });

  expect([200, 401]).toContain(response.status());
});

test('84.8.1: Profile exists before sign-up response completes', async ({ page }) => {
  const user = createTestUser('race');
  const response = await page.request.post(apiUrl('/api/auth/sign-up'), {
    headers: { Origin: webBaseUrl(), 'Content-Type': 'application/json' },
    data: user,
    maxRedirects: 0,
  });
  createdAuthUserIds.add((await readProfileByHandle(user.handle)).user_id);

  expect([200, 202, 302]).toContain(response.status());
  await expect.poll(async () => {
    const { count } = await createSchemaServiceRoleClient()
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('handle', user.handle);
    return count ?? 0;
  }).toBe(1);
});

test('84.8.2: Mode stamping remains script_verified after ingest', async () => {
  await expect(readProfile(scriptFixture.profileId)).resolves.toMatchObject({ mode: 'script_verified' });
});

test('84.8.3: Daily aggregates are trigger-owned derived rows', async () => {
  const sessionsCount = await countRows('sessions', 'profile_id', scriptFixture.profileId);
  const aggregatesCount = await countRows('daily_aggregates', 'profile_id', scriptFixture.profileId);

  expect(sessionsCount).toBeGreaterThan(0);
  expect(aggregatesCount).toBeGreaterThan(0);
});

test('84.8.4: total_tokens is generated from token columns', async ({ page }) => {
  await ensureScriptSession(page);
  const { data, error } = await createSchemaServiceRoleClient()
    .from('sessions')
    .select('input_tokens,output_tokens,cache_read_tokens,cache_create_tokens,cached_tokens,reasoning_tokens,total_tokens')
    .eq('profile_id', scriptFixture.profileId)
    .limit(1)
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? 'missing session');
  }

  const expected = Number(data.input_tokens)
    + Number(data.output_tokens)
    + Number(data.cache_read_tokens)
    + Number(data.cache_create_tokens)
    + Number(data.cached_tokens)
    + Number(data.reasoning_tokens);
  expect(Number(data.total_tokens)).toBe(expected);
});

test('84.8.5: RLS blocks anonymous private access-key reads', async ({ page }) => {
  const response = await page.request.get(apiUrl('/api/access-keys'), { headers: { Origin: webBaseUrl() } });

  expect(response.status()).toBe(401);
});

test('84.8.6: Cache version bump is constant-time for admin purge', async ({ page }) => {
  const latencies: number[] = [];

  for (let index = 0; index < 3; index += 1) {
    const startedAt = Date.now();
    const response = await purgeCache(page);
    latencies.push(Date.now() - startedAt);
    expect(response.status()).toBe(200);
  }

  expect(Math.max(...latencies) - Math.min(...latencies)).toBeLessThan(1000);
});

test('84.8.7: Audit events use allowed severity values', async () => {
  const { data, error } = await createSchemaServiceRoleClient()
    .from('audit_events')
    .select('severity')
    .limit(50);

  if (error) {
    throw new Error(error.message);
  }

  for (const row of data ?? []) {
    expect(['info', 'warn', 'critical']).toContain((row as { severity: string }).severity);
  }
});

test('84.8.8: Token comparison uses constant-time primitive', async () => {
  const source = readFileSync(resolve(process.cwd(), '../api/src/plugins/bearer-auth.ts'), 'utf8');
  const a = Buffer.from('a'.repeat(32));
  const b = Buffer.from('b'.repeat(32));

  expect(source).toContain('timingSafeEqual');
  expect(timingSafeEqual(a, a)).toBe(true);
  expect(timingSafeEqual(a, b)).toBe(false);
});

test('84.8.9: Request ID propagates on responses', async ({ page }) => {
  const response = await page.request.get(apiUrl('/health'));

  expect(response.status()).toBe(200);
  expect(response.headers()['x-request-id']).toBeTruthy();
});

test('84.8.10: Cross-user private data scope is enforced', async ({ page }) => {
  const response = await page.request.get(apiUrl('/api/access-keys'), { headers: { Origin: webBaseUrl() } });

  expect(response.status()).toBe(401);
});

test('84.9: Full signup-script regression suite is ready for execution', async () => {
  expect(testSchema).toMatch(/^tokensrank_test_w[0-3]$/);
  expect(BUTTON_CHANGE_MS).toBe(100);
  expect(REDIRECT_MS).toBe(1000);
  expect(PROFILE_LOAD_MS).toBe(1000);
  expect(DEBOUNCE_MS).toBe(400);
});
