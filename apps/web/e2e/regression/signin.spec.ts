import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test, type BrowserContext, type Locator, type Page, type Response as PlaywrightResponse } from '@playwright/test';

const PASSWORD = 'Tr-valid-password-58!';
const SIGN_IN_LOAD_MS = 2000;
const SIGN_IN_REDIRECT_MS = 2000;
const SIGN_IN_NAVIGATION_TIMEOUT_MS = 10000;
const DASHBOARD_SSR_MS = 2000;
const ACCESS_KEY_REVOKE_MS = 1000;
const SIGN_OUT_MS = 1000;
const ERROR_RESPONSE_MS = 1000;
const INVALID_CREDENTIALS_MESSAGE = 'Invalid credentials';
const testSchema = `tokensrank_test_w${Number(process.env.PLAYWRIGHT_WORKER_INDEX ?? 0) % 4}`;
const createdAuthUserIds = new Set<string>();

export type SeededSigninUser = {
  accessKeyId: string;
  email: string;
  handle: string;
  keyPrefix: string;
  password: string;
  plaintextAccessKey: string;
  profileId: string;
  userId: string;
};

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

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[signin-e2e] Missing required environment variable: ${name}`);
  }

  return value;
}

function createServiceRoleClient(schema?: string): SupabaseClient {
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

function createSchemaServiceRoleClient(): SupabaseClient {
  return createServiceRoleClient(testSchema);
}

function uniqueToken(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 14)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function waitForProfile(userId: string): Promise<void> {
  const admin = createSchemaServiceRoleClient();

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { data, error } = await admin
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    if (!error && data) {
      return;
    }

    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 200);
    });
  }

  throw new Error(`[signin-e2e] profile shell was not created for ${userId}`);
}

export async function seedUserWithOnboarding(label = 'signin'): Promise<SeededSigninUser> {
  loadRootEnv();
  const authAdmin = createServiceRoleClient();
  const schemaAdmin = createSchemaServiceRoleClient();
  const safeLabel = label.replace(/[^a-z0-9_]/g, '_').slice(0, 12);
  const token = uniqueToken(safeLabel).toLowerCase();
  const email = `${token}-${randomUUID()}@example.com`;
  const handle = `e2e_${token}`.slice(0, 30);
  const plaintext = `tr_script_${randomBytes(24).toString('base64url')}`;
  const keySha256 = createHash('sha256').update(plaintext).digest('hex');
  const keyPrefix = plaintext.slice(0, 11);
  const timestamp = nowIso();
  const runId = randomUUID();
  const sessionId = `${token}-session`;
  const firstEventAt = new Date(Date.now() - 120_000).toISOString();
  const lastEventAt = new Date(Date.now() - 60_000).toISOString();
  const inputTokens = 12_000;
  const outputTokens = 3_200;
  const totalTokens = inputTokens + outputTokens;

  console.log(`[signin-e2e] ${timestamp} seeding user`, {
    email,
    handle,
    schema: testSchema,
    keyPrefix,
  });

  const { data: userData, error: userError } = await authAdmin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: {
      test_schema: testSchema,
    },
  });

  if (userError || !userData.user) {
    throw new Error(`[signin-e2e] createUser failed: ${userError?.message ?? 'missing user'}`);
  }

  await waitForProfile(userData.user.id);

  const { data: profile, error: profileError } = await schemaAdmin
    .from('profiles')
    .update({
      handle,
      display_name: 'E2E Returning Builder',
      mode: 'script_verified',
      verified: true,
      onboarded_at: timestamp,
      share_projects: true,
    })
    .eq('id', userData.user.id)
    .select('id')
    .single();

  if (profileError || !profile) {
    throw new Error(`[signin-e2e] profile update failed: ${profileError?.message ?? 'missing profile'}`);
  }

  const { data: key, error: keyError } = await schemaAdmin
    .from('access_keys')
    .insert({
      profile_id: profile.id,
      key_sha256: keySha256,
      key_prefix: keyPrefix,
      scope: 'script',
      revoked_at: null,
    })
    .select('id')
    .single();

  if (keyError || !key) {
    throw new Error(`[signin-e2e] access key insert failed: ${keyError?.message ?? 'missing key'}`);
  }

  const { error: runError } = await schemaAdmin
    .from('ingestion_runs')
    .insert({
      id: runId,
      profile_id: profile.id,
      started_at: firstEventAt,
      finished_at: lastEventAt,
      status: 'completed',
      ingestion_mode: 'script_verified',
      session_count: 1,
      duplicate_count: 0,
      rejected_count: 0,
    });

  if (runError) {
    throw new Error(`[signin-e2e] ingestion run insert failed: ${runError.message}`);
  }

  const { error: sessionError } = await schemaAdmin
    .from('sessions')
    .insert({
      profile_id: profile.id,
      source: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      session_id: sessionId,
      file_sha256: createHash('sha256').update(sessionId).digest('hex'),
      first_event_at: firstEventAt,
      last_event_at: lastEventAt,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: 0,
      cache_create_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      turns: 2,
      ingestion_mode: 'script_verified',
      ingestion_run_id: runId,
      fingerprint: {
        project_name: 'signin-dashboard',
      },
    });

  if (sessionError) {
    throw new Error(`[signin-e2e] session insert failed: ${sessionError.message}`);
  }

  const { error: aggregateError } = await schemaAdmin
    .from('daily_aggregates')
    .upsert({
      profile_id: profile.id,
      date: lastEventAt.slice(0, 10),
      source: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      total_tokens: totalTokens,
      total_sessions: 1,
      derived_cost_usd: totalTokens * 0.00001,
    });

  if (aggregateError) {
    throw new Error(`[signin-e2e] aggregate seed failed: ${aggregateError.message}`);
  }

  return {
    accessKeyId: key.id as string,
    email,
    handle,
    keyPrefix,
    password: PASSWORD,
    plaintextAccessKey: plaintext,
    profileId: profile.id as string,
    userId: userData.user.id,
  };
}

async function enterText(locator: Locator, value: string): Promise<void> {
  await locator.fill('');
  await locator.pressSequentially(value);
}

async function fillSignInForm(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/auth/sign-in', { waitUntil: 'load' });
  await enterText(page.getByTestId('auth-field-email'), email);
  await enterText(page.getByTestId('auth-field-password'), password);
  console.log(`[signin-e2e] ${nowIso()} sign-in form state`, {
    emailValue: await page.getByTestId('auth-field-email').inputValue(),
    passwordLength: (await page.getByTestId('auth-field-password').inputValue()).length,
  });
}

function parseCookieHeader(header: string): {
  name: string;
  path: string;
  value: string;
} {
  const [pair = '', ...attributes] = header.split(';').map((part) => part.trim());
  const separator = pair.indexOf('=');
  const name = pair.slice(0, separator);
  const value = pair.slice(separator + 1);
  const pathAttribute = attributes.find((attribute) => attribute.toLowerCase().startsWith('path='));

  return {
    name,
    value,
    path: pathAttribute ? pathAttribute.slice('path='.length) : '/',
  };
}

async function bridgeSetCookieHeaders(context: BrowserContext, headersArray: Array<{ name: string; value: string }>): Promise<void> {
  const setCookieHeaders = headersArray
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value);

  expect(setCookieHeaders.length).toBeGreaterThanOrEqual(2);

  await context.addCookies(setCookieHeaders.map((header) => {
    const parsed = parseCookieHeader(header);

    return {
      name: parsed.name,
      value: decodeURIComponent(parsed.value),
      domain: '127.0.0.1',
      path: parsed.path,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax' as const,
    };
  }));
}

async function installSignInCookieBridge(page: Page): Promise<void> {
  await page.route('**/api/auth/sign-in', async (route) => {
    const response = await route.fetch();
    const headersArray = await response.headersArray();
    const responseHeaders = Object.fromEntries(
      headersArray
        .filter((header) => header.name.toLowerCase() !== 'set-cookie')
        .map((header) => [header.name, header.value]),
    );

    await bridgeSetCookieHeaders(page.context(), headersArray);
    await route.fulfill({
      body: await response.body(),
      headers: responseHeaders,
      status: response.status(),
    });
  }, { times: 1 });
}

async function installSignOutCookieBridge(page: Page, onSetCookie: (headers: string[]) => void): Promise<void> {
  await page.route('**/api/auth/sign-out', async (route) => {
    const response = await route.fetch();
    const headersArray = await response.headersArray();
    const setCookieHeaders = headersArray
      .filter((header) => header.name.toLowerCase() === 'set-cookie')
      .map((header) => header.value);
    const responseHeaders = Object.fromEntries(
      headersArray
        .filter((header) => header.name.toLowerCase() !== 'set-cookie')
        .map((header) => [header.name, header.value]),
    );

    onSetCookie(setCookieHeaders);
    await page.context().clearCookies();
    await route.fulfill({
      body: await response.body(),
      headers: responseHeaders,
      status: response.status(),
    });
  }, { times: 1 });
}

export async function signInUser(page: Page, user: SeededSigninUser): Promise<{
  redirectMs: number;
  response: PlaywrightResponse;
}> {
  console.log(`[signin-e2e] ${nowIso()} signing in`, {
    email: user.email,
    handle: user.handle,
  });

  await fillSignInForm(page, user.email, user.password);

  const signInResponsePromise = page.waitForResponse((response) => response.url().includes('/api/auth/sign-in'));
  const redirectPromise = page.waitForURL('**/me', {
    timeout: SIGN_IN_NAVIGATION_TIMEOUT_MS,
    waitUntil: 'commit',
  });

  await installSignInCookieBridge(page);
  const submittedAt = Date.now();
  await page.getByTestId('auth-submit').click();
  const signInResponse = await signInResponsePromise;
  expect(signInResponse.status()).toBe(200);
  await redirectPromise;
  await expect(page).toHaveURL(/\/me$/);

  return {
    redirectMs: Date.now() - submittedAt,
    response: signInResponse,
  };
}

async function screenshotOnFailure(page: Page, testName: string): Promise<void> {
  await page.screenshot({
    fullPage: true,
    path: `test-results/signin-${testName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`,
  });
}

async function expectAuthCookies(context: BrowserContext): Promise<void> {
  const cookies = await context.cookies();

  expect(cookies.some((cookie) => cookie.name === 'tr_at')).toBe(true);
  expect(cookies.some((cookie) => cookie.name === 'tr_rt')).toBe(true);
}

async function deleteAuthUsers(userIds: Iterable<string>): Promise<void> {
  const authAdmin = createServiceRoleClient();

  for (const userId of Array.from(userIds)) {
    await authAdmin.auth.admin.deleteUser(userId);
  }
}

test.beforeAll(() => {
  loadRootEnv();
});

test.describe('V-3 + O-3 sign-in dashboard regression', () => {
  test.afterAll(async () => {
    await deleteAuthUsers(createdAuthUserIds);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      await screenshotOnFailure(page, testInfo.title);
    }
  });

  test('Sign-in page renders with email and password form', async ({ page }) => {
    const startedAt = Date.now();
    await page.goto('/auth/sign-in', { waitUntil: 'load' });
    const loadMs = Date.now() - startedAt;

    console.log(`[signin-e2e] ${nowIso()} sign-in page loaded`, { loadMs });
    expect(loadMs).toBeLessThan(SIGN_IN_LOAD_MS);
    await expect(page.getByRole('heading', { name: 'Sign in to TokensRank' })).toBeVisible();
    await expect(page.getByTestId('auth-field-email')).toBeVisible();
    await expect(page.getByTestId('auth-field-password')).toBeVisible();
    await expect(page.getByTestId('auth-submit')).toBeVisible();
    await expect(page.getByRole('button', { name: /continue with google|sign in with google|google/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /continue with github|sign in with github|github/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /continue with x|sign in with x/i })).toHaveCount(0);
  });

  test('Valid sign-in redirects to /me dashboard', async ({ context, page }) => {
    const user = await seedUserWithOnboarding('validsignin');
    createdAuthUserIds.add(user.userId);
    const { redirectMs } = await signInUser(page, user);

    console.log(`[signin-e2e] ${nowIso()} sign-in redirect complete`, {
      handle: user.handle,
      redirectMs,
    });
    expect(redirectMs).toBeLessThan(SIGN_IN_REDIRECT_MS);
    await expect(page).toHaveURL(/\/me$/);
    await expect(page.getByRole('heading', { name: 'Your TokensRank profile' })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Sign in$/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Sign in$/i })).toHaveCount(0);
    await expectAuthCookies(context);
  });

  test('/me dashboard renders rank, recent runs, and access keys', async ({ page }) => {
    const user = await seedUserWithOnboarding('dashboard');
    createdAuthUserIds.add(user.userId);

    await signInUser(page, user);
    const startedAt = Date.now();
    await page.goto('/me', { waitUntil: 'load' });
    const ssrMs = Date.now() - startedAt;

    console.log(`[signin-e2e] ${nowIso()} dashboard SSR complete`, {
      handle: user.handle,
      ssrMs,
    });
    expect(ssrMs).toBeLessThan(DASHBOARD_SSR_MS);
    const rankSection = page.getByTestId('dashboard-rank-section');
    await expect(rankSection).toBeVisible();
    await expect(rankSection.getByRole('heading', { name: 'Rank' })).toBeVisible();
    await expect(page.getByTestId('dashboard-rank-value')).toContainText('#');
    await expect(page.getByTestId('dashboard-token-value')).toContainText(/[0-9]/);
    await expect(page.getByTestId('dashboard-cost-value')).toContainText('$');
    await expect(page.getByTestId('dashboard-runs-section')).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByTestId('ingestion-run-row')).toHaveCount(1);
    await expect(page.getByTestId('dashboard-keys-section')).toBeVisible();
    await expect(page.locator('[data-testid="access-key-row"]')).toHaveCount(1);
    await expect(page.locator(`[data-key-prefix="${user.keyPrefix}"]`)).toBeVisible();
    await expect(page.getByTestId('access-key-prefix')).toContainText(user.keyPrefix);
    await expect(page.getByTestId(`access-key-revoke-${user.accessKeyId}`)).toBeVisible();
    await expect(page.getByText(/loading|spinner/i)).toHaveCount(0);
  });

  test('Access key revocation hides key from active list', async ({ page }) => {
    const user = await seedUserWithOnboarding('revoke');
    createdAuthUserIds.add(user.userId);

    await signInUser(page, user);
    const keyRow = page.locator(`[data-testid="access-key-row"][data-key-prefix="${user.keyPrefix}"]`);
    await expect(keyRow).toBeVisible();

    const startedAt = Date.now();
    const revokeResponsePromise = page.waitForResponse((response) => (
      response.url().includes(`/api/access-keys/${user.accessKeyId}`) && response.request().method() === 'DELETE'
    ));
    await page.getByTestId(`access-key-revoke-${user.accessKeyId}`).click();
    const revokeResponse = await revokeResponsePromise;
    const revokeMs = Date.now() - startedAt;
    expect(revokeResponse.status()).toBe(200);
    await expect(keyRow).toHaveCount(0);

    console.log(`[signin-e2e] ${nowIso()} access key revoked`, {
      keyPrefix: user.keyPrefix,
      revokeMs,
    });
    expect(revokeMs).toBeLessThan(ACCESS_KEY_REVOKE_MS);
    await expect(page.locator('[data-testid="access-key-revoked-row"]').filter({
      hasText: user.keyPrefix,
    })).toBeVisible();
  });

  test('Sign out clears cookies and blocks /me', async ({ context, page }) => {
    const user = await seedUserWithOnboarding('signout');
    const setCookieHeaders: string[] = [];
    createdAuthUserIds.add(user.userId);

    await signInUser(page, user);
    await installSignOutCookieBridge(page, (headers) => {
      setCookieHeaders.push(...headers);
    });

    const startedAt = Date.now();
    const signOutResponsePromise = page.waitForResponse((response) => (
      response.url().includes('/api/auth/sign-out') && response.request().method() === 'POST'
    ));
    await page.getByTestId('sign-out-button').click();
    const signOutResponse = await signOutResponsePromise;
    const signOutMs = Date.now() - startedAt;

    console.log(`[signin-e2e] ${nowIso()} signed out`, {
      handle: user.handle,
      signOutMs,
    });
    expect(signOutResponse.status()).toBe(200);
    expect(signOutMs).toBeLessThan(SIGN_OUT_MS);
    expect(setCookieHeaders.join('\n')).toContain('tr_at=');
    expect(setCookieHeaders.join('\n')).toContain('tr_rt=');
    expect(setCookieHeaders.join('\n')).toContain('Max-Age=0');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('link', { name: /^Sign up$/i })).toBeVisible();
    expect((await context.cookies()).filter((cookie) => cookie.name.startsWith('tr_'))).toHaveLength(0);

    await page.goto('/me', { waitUntil: 'load' });
    await expect(page).toHaveURL(/\/auth\/sign-in/);
  });

  test('Invalid password returns generic anti-enumeration error', async ({ page }) => {
    const user = await seedUserWithOnboarding('badpassword');
    createdAuthUserIds.add(user.userId);

    await fillSignInForm(page, user.email, 'Tr-wrong-password-58!');
    const startedAt = Date.now();
    const responsePromise = page.waitForResponse((response) => response.url().includes('/api/auth/sign-in'));
    await page.getByTestId('auth-submit').click();
    const response = await responsePromise;
    const responseMs = Date.now() - startedAt;

    console.log(`[signin-e2e] ${nowIso()} invalid password response`, {
      responseMs,
      status: response.status(),
    });
    expect(response.status()).toBe(401);
    expect(responseMs).toBeLessThan(ERROR_RESPONSE_MS);
    await expect(page).toHaveURL(/\/auth\/sign-in/);
    await expect(page.getByTestId('auth-form-error')).toHaveText(INVALID_CREDENTIALS_MESSAGE);
    await expect(page.getByText(/password incorrect/i)).toHaveCount(0);
  });

  test('Non-existent email returns identical anti-enumeration error', async ({ page }) => {
    const email = `${uniqueToken('missing').toLowerCase()}-${randomUUID()}@example.com`;

    await fillSignInForm(page, email, 'Tr-any-password-58!');
    const startedAt = Date.now();
    const responsePromise = page.waitForResponse((response) => response.url().includes('/api/auth/sign-in'));
    await page.getByTestId('auth-submit').click();
    const response = await responsePromise;
    const responseMs = Date.now() - startedAt;

    console.log(`[signin-e2e] ${nowIso()} missing email response`, {
      responseMs,
      status: response.status(),
    });
    expect(response.status()).toBe(401);
    expect(responseMs).toBeLessThan(ERROR_RESPONSE_MS);
    await expect(page).toHaveURL(/\/auth\/sign-in/);
    await expect(page.getByTestId('auth-form-error')).toHaveText(INVALID_CREDENTIALS_MESSAGE);
    await expect(page.getByText(/password incorrect/i)).toHaveCount(0);
  });
});
