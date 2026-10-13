import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { expect, test, type Locator, type Page, type Response as PlaywrightResponse } from '@playwright/test';

const PASSWORD = 'Tr-valid-password-QC6!';
const API_BASE_URL = `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;
const WEB_PORT = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3000);
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const WEB_ROOT = path.resolve(__dirname, '..');

type SeededLeaderboardUser = {
  email: string;
  handle: string;
  profileId: string;
  userId: string;
};

type LeaderboardPeriod = '24h' | '7d';

const createdUserIds = new Set<string>();

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[qc6-leaderboard-e2e] Missing required environment variable: ${name}`);
  }

  return value;
}

function serviceClient(schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0') {
  return createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      db: {
        schema,
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        headers: {
          'Accept-Profile': schema,
          'Content-Profile': schema,
        },
      },
    },
  );
}

function authAdminClient() {
  return createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function uniqueHandle(): string {
  return `qc6lb_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function leaderboardPeriodForProject(projectName: string): LeaderboardPeriod {
  return projectName === 'webkit' ? '7d' : '24h';
}

async function waitForProfileShell(userId: string): Promise<{ id: string }> {
  const service = serviceClient();

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { data, error } = await service
      .from('profiles')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle<{ id: string }>();

    if (!error && data) {
      return data;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
  }

  throw new Error(`[qc6-leaderboard-e2e] Profile shell was not created for ${userId}`);
}

async function purgeApiCache(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/admin/cache/purge`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${readRequiredEnv('ADMIN_PURGE_TOKEN')}`,
      Origin: WEB_ORIGIN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ all: true }),
  });

  if (!response.ok) {
    throw new Error(`[qc6-leaderboard-e2e] Cache purge failed with ${response.status}`);
  }
}

async function clearNextFetchCache(): Promise<void> {
  await rm(path.join(WEB_ROOT, '.next/cache/fetch-cache'), {
    recursive: true,
    force: true,
  });
}

async function seedLeaderboardUser(): Promise<SeededLeaderboardUser> {
  const schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
  const auth = authAdminClient();
  const service = serviceClient(schema);
  const handle = uniqueHandle();
  const email = `${handle}-${randomUUID()}@tokensrank.dev`;

  const { data: userData, error: userError } = await auth.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: {
      test_schema: schema,
    },
  });

  if (userError || !userData.user) {
    throw new Error(`[qc6-leaderboard-e2e] createUser failed: ${userError?.message ?? 'missing user'}`);
  }

  createdUserIds.add(userData.user.id);

  const profileShell = await waitForProfileShell(userData.user.id);
  const { data: profile, error: profileError } = await service
    .from('profiles')
    .update({
      handle,
      display_name: `QC6 ${handle}`,
      mode: 'script_verified',
      verified: true,
      share_projects: true,
    })
    .eq('id', profileShell.id)
    .select('id,user_id,handle')
    .single<{ id: string; user_id: string; handle: string }>();

  if (profileError || !profile) {
    throw new Error(`[qc6-leaderboard-e2e] profile update failed: ${profileError?.message ?? 'missing profile'}`);
  }

  const startedAt = '2026-04-28T09:00:00.000Z';
  const finishedAt = '2026-04-28T09:05:00.000Z';
  const tokens = 48_250;
  const model = 'claude-3-5-sonnet-20241022';
  const source = 'claude';

  const { error: sessionError } = await service.from('sessions').insert({
    profile_id: profile.id,
    source,
    model,
    session_id: `qc6-leaderboard-${handle}`,
    file_sha256: sha256(`qc6-leaderboard-${handle}`),
    first_event_at: startedAt,
    last_event_at: finishedAt,
    input_tokens: tokens,
    output_tokens: 3200,
    cache_read_tokens: 0,
    cache_create_tokens: 0,
    cached_tokens: 0,
    reasoning_tokens: 0,
    turns: 4,
    ingestion_mode: 'script_verified',
  });

  if (sessionError) {
    throw new Error(`[qc6-leaderboard-e2e] session seed failed: ${sessionError.message}`);
  }

  const { error: aggregateError } = await service.from('daily_aggregates').upsert({
    profile_id: profile.id,
    date: startedAt.slice(0, 10),
    source,
    model,
    total_tokens: tokens,
    total_sessions: 1,
    derived_cost_usd: 0.48,
  });

  if (aggregateError) {
    throw new Error(`[qc6-leaderboard-e2e] aggregate seed failed: ${aggregateError.message}`);
  }

  await purgeApiCache();
  await clearNextFetchCache();

  return {
    email,
    handle: profile.handle,
    profileId: profile.id,
    userId: userData.user.id,
  };
}

async function enterText(locator: Locator, value: string): Promise<void> {
  await locator.fill('');
  await locator.pressSequentially(value);
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

async function readMeFromBrowser(page: Page): Promise<{ status: number; handle: string | null }> {
  return page.evaluate(async (apiBaseUrl) => {
    const response = await fetch(`${apiBaseUrl}/api/me`, {
      credentials: 'include',
      headers: {
        Accept: 'application/json',
      },
    });
    const body = await response.json().catch(() => ({}));
    const handle = (
      body as {
        data?: {
          handle?: string;
        };
      }
    ).data?.handle ?? null;

    return {
      status: response.status,
      handle,
    };
  }, API_BASE_URL);
}

async function signInThroughUi(page: Page, user: SeededLeaderboardUser): Promise<void> {
  await page.goto('/auth/sign-in');
  await enterText(page.getByTestId('auth-field-email'), user.email);
  await enterText(page.getByTestId('auth-field-password'), PASSWORD);

  const signInResponsePromise = page.waitForResponse((response) => (
    response.url().includes('/api/auth/sign-in')
  ));
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
  await expect.poll(async () => readMeFromBrowser(page), {
    timeout: 10000,
  }).toEqual({
    status: 200,
    handle: user.handle,
  });
}

test.afterAll(async () => {
  const auth = authAdminClient();

  for (const userId of createdUserIds) {
    await auth.auth.admin.deleteUser(userId).catch(() => undefined);
  }
});

test('sign-in keeps the session on the leaderboard and satisfies T-1/T-3 timing', async ({ page }) => {
  test.setTimeout(60000);

  const user = await seedLeaderboardUser();
  const period = leaderboardPeriodForProject(test.info().project.name);
  const leaderboardUrl = `${API_BASE_URL}/api/leaderboard?period=${period}&scope=claude&limit=50&offset=0`;

  await signInThroughUi(page, user);

  const cookies = await page.context().cookies(WEB_ORIGIN);

  expect(cookies.some((cookie) => cookie.name === 'tr_at' && cookie.value.length > 0)).toBe(true);
  expect(cookies.some((cookie) => cookie.name === 'tr_rt' && cookie.value.length > 0)).toBe(true);

  await page.request.get(leaderboardUrl);
  const loadStartedAt = Date.now();
  const leaderboardResponse = await page.request.get(leaderboardUrl);
  const loadDurationMs = Date.now() - loadStartedAt;
  const leaderboardBody = await leaderboardResponse.json() as { data?: Array<{ handle?: string }> };

  expect(leaderboardResponse.status()).toBe(200);
  expect(loadDurationMs).toBeLessThan(200);
  expect(leaderboardBody.data?.some((row) => row.handle === user.handle)).toBe(true);

  await purgeApiCache();
  await clearNextFetchCache();
  await page.goto(`/?period=${period}&scope=claude&limit=50&offset=0`);
  await expect(page.locator('#leaderboard-table')).toContainText(`/u/${user.handle}`, { timeout: 15000 });
  await expect(page.getByRole('heading', { name: 'Top builders by token usage' })).toBeVisible();
});
