import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';

import { createTestProfile, createTestUser } from './fixtures/seed-data';

test.describe.configure({ mode: 'serial' });

const apiBaseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3000);
const webOrigin = `http://127.0.0.1:${webPort}`;
const repoRoot = path.resolve(__dirname, '../../..');
const webRoot = path.resolve(__dirname, '..');
const validCacheStatuses = ['HIT', 'MISS', 'BYPASS', 'HIT-DEGRADED'];

type SeededLeaderboardProfile = {
  handle: string;
  displayName: string;
};

type SeededProfile = {
  handle: string;
};

type RpcClient = {
  rpc: (
    fn: string,
    args: { schema_name: string },
  ) => PromiseLike<{ error: { message: string } | null }>;
};

function serviceClient(schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0') {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('[ssr-navigation-e2e] Missing Supabase environment variables');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    db: { schema },
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
  });
}

function publicServiceClient(): RpcClient {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('[ssr-navigation-e2e] Missing Supabase environment variables');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

async function resetActiveSchema() {
  const schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
  const client = publicServiceClient();
  const { error } = await client.rpc('reset_test_schema', {
    schema_name: schema,
  });

  if (error) {
    throw new Error(`[ssr-navigation-e2e] reset_test_schema failed for ${schema}: ${error.message}`);
  }

  await purgeApiCache();
  await clearNextFetchCache();
}

async function clearNextFetchCache() {
  await rm(path.join(webRoot, '.next/cache/fetch-cache'), {
    recursive: true,
    force: true,
  });
}

async function purgeApiCache() {
  const adminToken = process.env.ADMIN_PURGE_TOKEN;

  if (!adminToken) {
    throw new Error('[ssr-navigation-e2e] Missing ADMIN_PURGE_TOKEN');
  }

  const response = await fetch(`${apiBaseUrl}/api/admin/cache/purge`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
      Origin: webOrigin,
    },
    body: JSON.stringify({ all: true }),
  });

  if (!response.ok) {
    throw new Error(`[ssr-navigation-e2e] Cache purge failed with ${response.status}`);
  }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoDaysAgo(daysAgo: number, hour = 12): string {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  date.setUTCHours(hour, 0, 0, 0);

  return date.toISOString();
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function seedLeaderboardPair(label: string): Promise<{
  claude: SeededLeaderboardProfile;
  codex: SeededLeaderboardProfile;
}> {
  const schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
  const client = serviceClient(schema);
  const claudeProfile = await createTestProfile(await createTestUser(`ssr-${label}-claude`), schema);
  const codexProfile = await createTestProfile(await createTestUser(`ssr-${label}-codex`), schema);
  const suffix = randomUUID().replace(/-/gu, '').slice(0, 8);
  const claudeDisplayName = `SSR Claude ${label}`;
  const codexDisplayName = `SSR Codex ${label}`;

  const { error: profileError } = await client
    .from('profiles')
    .upsert([
      {
        ...claudeProfile,
        display_name: claudeDisplayName,
        mode: 'script_verified',
      },
      {
        ...codexProfile,
        display_name: codexDisplayName,
        mode: 'script_verified',
      },
    ]);

  if (profileError) {
    throw new Error(`[ssr-navigation-e2e] Failed to update profile labels: ${profileError.message}`);
  }

  const timestamp = `${todayUtc()}T10:00:00.000Z`;
  const { error: sessionError } = await client.from('sessions').insert([
    {
      profile_id: claudeProfile.id,
      source: 'claude',
      model: `ssr-${label}-claude`,
      session_id: `ssr-${label}-claude-${suffix}`,
      file_sha256: sha(`ssr-${label}-claude-${suffix}`),
      first_event_at: timestamp,
      last_event_at: timestamp,
      input_tokens: 31_000,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_create_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      turns: 2,
      ingestion_mode: 'script_verified',
    },
    {
      profile_id: codexProfile.id,
      source: 'codex',
      model: `ssr-${label}-codex`,
      session_id: `ssr-${label}-codex-${suffix}`,
      file_sha256: sha(`ssr-${label}-codex-${suffix}`),
      first_event_at: timestamp,
      last_event_at: timestamp,
      input_tokens: 41_000,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_create_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      turns: 3,
      ingestion_mode: 'script_verified',
    },
  ]);

  if (sessionError) {
    throw new Error(`[ssr-navigation-e2e] Failed to seed leaderboard sessions: ${sessionError.message}`);
  }

  const { error: aggregateError } = await client.from('daily_aggregates').upsert([
    {
      profile_id: claudeProfile.id,
      date: todayUtc(),
      source: 'claude',
      model: `ssr-${label}-claude`,
      total_tokens: 31_000,
      total_sessions: 1,
      derived_cost_usd: 0.31,
    },
    {
      profile_id: codexProfile.id,
      date: todayUtc(),
      source: 'codex',
      model: `ssr-${label}-codex`,
      total_tokens: 41_000,
      total_sessions: 1,
      derived_cost_usd: 0.41,
    },
  ]);

  if (aggregateError) {
    throw new Error(`[ssr-navigation-e2e] Failed to seed leaderboard aggregates: ${aggregateError.message}`);
  }

  await purgeApiCache();
  await clearNextFetchCache();

  return {
    claude: {
      handle: claudeProfile.handle,
      displayName: claudeDisplayName,
    },
    codex: {
      handle: codexProfile.handle,
      displayName: codexDisplayName,
    },
  };
}

async function seedProfileForWindow(label: string): Promise<SeededProfile> {
  const schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
  const client = serviceClient(schema);
  const profile = await createTestProfile(await createTestUser(`ssr-profile-${label}`), schema);
  const displayName = `SSR Profile ${label}`;

  const { error: profileError } = await client
    .from('profiles')
    .update({
      display_name: displayName,
      bio: 'SSR navigation profile fixture.',
      x_handle: profile.handle,
      mode: 'script_verified',
      verified: true,
      share_projects: true,
    })
    .eq('id', profile.id);

  if (profileError) {
    throw new Error(`[ssr-navigation-e2e] Failed to update profile fixture: ${profileError.message}`);
  }

  const sessions = [
    { label: 'recent', source: 'claude', model: 'claude-3-5-sonnet', daysAgo: 2, tokens: 12_000, turns: 3 },
    { label: 'month', source: 'codex', model: 'gpt-5-codex', daysAgo: 12, tokens: 34_000, turns: 4 },
  ] as const;

  for (const session of sessions) {
    const firstEventAt = isoDaysAgo(session.daysAgo);
    const lastEventAt = new Date(new Date(firstEventAt).getTime() + 15 * 60_000).toISOString();
    const sessionId = `ssr-profile-${label}-${session.label}-${randomUUID()}`;
    const { error: sessionError } = await client.from('sessions').insert({
      profile_id: profile.id,
      source: session.source,
      model: session.model,
      session_id: sessionId,
      file_sha256: sha(sessionId),
      first_event_at: firstEventAt,
      last_event_at: lastEventAt,
      input_tokens: session.tokens,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_create_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      turns: session.turns,
      ingestion_mode: 'script_verified',
      fingerprint: {
        project_name: session.label,
      },
    });

    if (sessionError) {
      throw new Error(`[ssr-navigation-e2e] Failed to seed profile session: ${sessionError.message}`);
    }

    const { error: aggregateError } = await client.from('daily_aggregates').upsert({
      profile_id: profile.id,
      date: firstEventAt.slice(0, 10),
      source: session.source,
      model: session.model,
      total_tokens: session.tokens,
      total_sessions: 1,
      derived_cost_usd: session.tokens * 0.00001,
    });

    if (aggregateError) {
      throw new Error(`[ssr-navigation-e2e] Failed to seed profile aggregate: ${aggregateError.message}`);
    }
  }

  await purgeApiCache();
  await clearNextFetchCache();

  return {
    handle: profile.handle,
  };
}

async function seedPaginationLeaderboard(label: string) {
  await resetActiveSchema();

  const schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
  const client = serviceClient(schema);
  const date = todayUtc();

  for (const index of [0, 1, 2]) {
    const profile = await createTestProfile(await createTestUser(`ssr-pagination-${label}-${index}`), schema);
    const displayName = `SSR Pagination ${label} ${index}`;

    const { error: profileError } = await client
      .from('profiles')
      .update({
        display_name: displayName,
        mode: 'script_verified',
        verified: true,
        share_projects: true,
      })
      .eq('id', profile.id);

    if (profileError) {
      throw new Error(`[ssr-navigation-e2e] Failed to seed pagination profile: ${profileError.message}`);
    }

    const { error: aggregateError } = await client.from('daily_aggregates').upsert({
      profile_id: profile.id,
      date,
      source: 'claude',
      model: `ssr-pagination-${label}`,
      total_tokens: 90_000 - index * 10_000,
      total_sessions: 1,
      derived_cost_usd: 0.9 - index * 0.1,
    });

    if (aggregateError) {
      throw new Error(`[ssr-navigation-e2e] Failed to seed pagination aggregate: ${aggregateError.message}`);
    }
  }

  await purgeApiCache();
  await clearNextFetchCache();
}

async function expectFullFrameNavigation(page: Page, action: () => Promise<void>) {
  const navigated = page.waitForEvent('framenavigated', {
    predicate: (frame) => frame === page.mainFrame(),
    timeout: 10000,
  });

  await action();
  await navigated;
  await page.waitForLoadState('networkidle');
}

function expectUrlSearch(page: Page, expected: Record<string, string>) {
  const url = new URL(page.url());

  for (const [key, value] of Object.entries(expected)) {
    expect(url.searchParams.get(key)).toBe(value);
  }
}

test('period filter triggers a full SSR reload with the selected period in the URL', async ({ page }) => {
  await page.goto('/?period=all&scope=all', { waitUntil: 'networkidle' });

  await expectFullFrameNavigation(page, async () => {
    await page.getByRole('tablist', { name: 'Filter by period' }).getByRole('tab', { name: '7D' }).click();
  });

  expectUrlSearch(page, { period: '7d', scope: 'all' });
  await expect(page.getByRole('tablist', { name: 'Filter by period' }).getByRole('tab', { name: '7D' })).toHaveAttribute('aria-selected', 'true');
});

test('scope filter triggers SSR navigation and preserves the active period', async ({ page }) => {
  await page.goto('/?period=7d&scope=all', { waitUntil: 'networkidle' });

  await expectFullFrameNavigation(page, async () => {
    await page.getByRole('tablist', { name: 'Filter by source' }).getByRole('tab', { name: 'Codex' }).click();
  });

  expectUrlSearch(page, { period: '7d', scope: 'codex' });
  await expect(page.getByRole('tablist', { name: 'Filter by period' }).getByRole('tab', { name: '7D' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tablist', { name: 'Filter by source' }).getByRole('tab', { name: 'Codex' })).toHaveAttribute('aria-selected', 'true');
});

test('browser back and forward restore homepage filter state from the URL', async ({ page }) => {
  await page.goto('/?period=24h&scope=all', { waitUntil: 'networkidle' });

  await expectFullFrameNavigation(page, async () => {
    await page.getByRole('tablist', { name: 'Filter by period' }).getByRole('tab', { name: '30D' }).click();
  });
  await expectFullFrameNavigation(page, async () => {
    await page.getByRole('tablist', { name: 'Filter by source' }).getByRole('tab', { name: 'Claude' }).click();
  });

  await page.goBack({ waitUntil: 'networkidle' });
  expectUrlSearch(page, { period: '30d', scope: 'all' });
  await expect(page.getByRole('tablist', { name: 'Filter by period' }).getByRole('tab', { name: '30D' })).toHaveAttribute('aria-selected', 'true');

  await page.goForward({ waitUntil: 'networkidle' });
  expectUrlSearch(page, { period: '30d', scope: 'claude' });
  await expect(page.getByRole('tablist', { name: 'Filter by source' }).getByRole('tab', { name: 'Claude' })).toHaveAttribute('aria-selected', 'true');
});

test('direct URL navigation loads data for the requested period and scope', async ({ page }) => {
  const seeded = await seedLeaderboardPair('direct');

  await page.goto('/?period=7d&scope=codex&limit=97', { waitUntil: 'networkidle' });

  await expect(page.locator('#leaderboard-table')).toContainText(seeded.codex.displayName);
  await expect(page.locator('#leaderboard-table')).not.toContainText(seeded.claude.displayName);
  await expect(page.getByRole('tablist', { name: 'Filter by source' }).getByRole('tab', { name: 'Codex' })).toHaveAttribute('aria-selected', 'true');
});

test('filter links preserve non-default pagination params during SSR navigation', async ({ page }) => {
  await page.goto('/?period=7d&scope=all&limit=25&offset=50', { waitUntil: 'networkidle' });

  await expect(page.getByRole('tablist', { name: 'Filter by source' }).getByRole('tab', { name: 'Claude' })).toHaveAttribute(
    'aria-controls',
    'leaderboard-table',
  );

  await page.getByRole('tablist', { name: 'Filter by source' }).getByRole('tab', { name: 'Claude' }).click();
  await expect(page).toHaveURL(/scope=claude/u);

  expectUrlSearch(page, {
    period: '7d',
    scope: 'claude',
    limit: '25',
    offset: '50',
  });
});

test('leaderboard API responses expose valid cache headers for SSR navigation states', async ({ request }) => {
  const first = await request.get(`${apiBaseUrl}/api/leaderboard?period=24h&scope=all&limit=1&offset=0`);
  const second = await request.get(`${apiBaseUrl}/api/leaderboard?period=24h&scope=all&limit=1&offset=0`);

  expect(first.status()).toBe(200);
  expect(validCacheStatuses).toContain(first.headers()['x-tokensrank-cache']);
  expect(second.status()).toBe(200);
  expect(validCacheStatuses).toContain(second.headers()['x-tokensrank-cache']);
});

test('profile window filter triggers a full SSR reload', async ({ page }) => {
  const profile = await seedProfileForWindow('reload');

  await page.goto(`/u/${profile.handle}?window=7d`, { waitUntil: 'networkidle' });
  const sevenDayStats = await page.locator('[data-section="at-a-glance"]').innerText();

  await expectFullFrameNavigation(page, async () => {
    await page.getByRole('tab', { name: '30D' }).click();
  });

  expectUrlSearch(page, { window: '30d' });
  await expect(page.locator('main')).toHaveAttribute('data-profile-window', '30d');
  await expect.poll(async () => page.locator('[data-section="at-a-glance"]').innerText()).not.toBe(sevenDayStats);
});

test('profile API accepts the selected window query parameter', async ({ request }) => {
  const profile = await seedProfileForWindow('api-window');
  const sevenDay = await request.get(`${apiBaseUrl}/api/profile/${profile.handle}?window=7d`);
  const thirtyDay = await request.get(`${apiBaseUrl}/api/profile/${profile.handle}?window=30d`);

  expect(sevenDay.status()).toBe(200);
  expect(thirtyDay.status()).toBe(200);

  const sevenDayBody = await sevenDay.json();
  const thirtyDayBody = await thirtyDay.json();

  expect(thirtyDayBody.at_glance.tokens_total).toBeGreaterThan(sevenDayBody.at_glance.tokens_total);
  expect(validCacheStatuses).toContain(thirtyDay.headers()['x-tokensrank-cache']);
});

test('profile window links preserve the profile handle while changing window', async ({ page }) => {
  const profile = await seedProfileForWindow('handle');

  await page.goto(`/u/${profile.handle}?window=7d`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('tab', { name: 'All' })).toHaveAttribute('href', `/u/${profile.handle}?window=all`);

  await expectFullFrameNavigation(page, async () => {
    await page.getByRole('tab', { name: 'All' }).click();
  });

  const url = new URL(page.url());
  expect(url.pathname).toBe(`/u/${profile.handle}`);
  expect(url.searchParams.get('window')).toBe('all');
});

test('browser history restores profile window URL state', async ({ page }) => {
  const profile = await seedProfileForWindow('history');

  await page.goto(`/u/${profile.handle}?window=7d`, { waitUntil: 'networkidle' });
  await expectFullFrameNavigation(page, async () => {
    await page.getByRole('tab', { name: '30D' }).click();
  });
  await expectFullFrameNavigation(page, async () => {
    await page.getByRole('tab', { name: 'All' }).click();
  });

  await page.goBack({ waitUntil: 'networkidle' });
  await expect(page.locator('main')).toHaveAttribute('data-profile-window', '30d');
  expectUrlSearch(page, { window: '30d' });

  await page.goForward({ waitUntil: 'networkidle' });
  await expect(page.locator('main')).toHaveAttribute('data-profile-window', 'all');
  expectUrlSearch(page, { window: 'all' });
});

test('pagination next link triggers a full SSR reload with the next offset', async ({ page }) => {
  await seedPaginationLeaderboard('next');
  await page.goto('/?period=7d&scope=claude&limit=1&offset=0', { waitUntil: 'networkidle' });

  await expect(page.getByTestId('leaderboard-next-link')).toHaveAttribute('href', '/?period=7d&scope=claude&limit=1&offset=1');
  await expectFullFrameNavigation(page, async () => {
    await page.getByTestId('leaderboard-next-link').click();
  });

  expectUrlSearch(page, {
    period: '7d',
    scope: 'claude',
    limit: '1',
    offset: '1',
  });
});

test('pagination previous link changes the offset through SSR navigation', async ({ page }) => {
  await seedPaginationLeaderboard('previous');
  await page.goto('/?period=7d&scope=claude&limit=1&offset=1', { waitUntil: 'networkidle' });

  await expect(page.getByTestId('leaderboard-prev-link')).toHaveAttribute('href', '/?period=7d&scope=claude&limit=1&offset=0');
  await expectFullFrameNavigation(page, async () => {
    await page.getByTestId('leaderboard-prev-link').click();
  });

  expectUrlSearch(page, {
    period: '7d',
    scope: 'claude',
    limit: '1',
    offset: '0',
  });
});

test('pagination previous control is disabled on the first page', async ({ page }) => {
  await seedPaginationLeaderboard('first');
  await page.goto('/?period=7d&scope=claude&limit=1&offset=0', { waitUntil: 'networkidle' });

  await expect(page.getByTestId('leaderboard-prev-disabled')).toBeDisabled();
  await expect(page.getByTestId('leaderboard-prev-link')).toHaveCount(0);
});

test('pagination next control is disabled on the last page', async ({ page }) => {
  await seedPaginationLeaderboard('last');
  await page.goto('/?period=7d&scope=claude&limit=1&offset=2', { waitUntil: 'networkidle' });

  await expect(page.getByTestId('leaderboard-next-disabled')).toBeDisabled();
  await expect(page.getByTestId('leaderboard-next-link')).toHaveCount(0);
});

test('pagination preserves period and scope filters in generated links', async ({ page }) => {
  await seedPaginationLeaderboard('filters');
  await page.goto('/?period=7d&scope=claude&limit=1&offset=0', { waitUntil: 'networkidle' });

  await expect(page.getByTestId('leaderboard-next-link')).toHaveAttribute('href', '/?period=7d&scope=claude&limit=1&offset=1');
});

test('pagination displays accurate page count information', async ({ page }) => {
  await seedPaginationLeaderboard('page-info');
  await page.goto('/?period=7d&scope=claude&limit=1&offset=1', { waitUntil: 'networkidle' });

  await expect(page.getByTestId('leaderboard-page-info')).toHaveText('Page 2 of 3');
});

test('filter click performs frame navigation without prevented-navigation console errors', async ({ page }) => {
  const consoleErrors: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  await page.goto('/?period=all&scope=all&limit=96', { waitUntil: 'networkidle' });
  await expectFullFrameNavigation(page, async () => {
    await page.getByRole('tablist', { name: 'Filter by period' }).getByRole('tab', { name: '24H' }).click();
  });

  expectUrlSearch(page, {
    period: '24h',
    scope: 'all',
  });
  expect(consoleErrors.filter((message) => /prevent|navigation|router/iu.test(message))).toEqual([]);
});

test('cached leaderboard API response is served within the T-3 budget', async ({ request }) => {
  await seedPaginationLeaderboard('cached-budget');
  const url = `${apiBaseUrl}/api/leaderboard?period=7d&scope=claude&limit=1&offset=0`;
  const warmup = await request.get(url);

  expect(warmup.status()).toBe(200);

  const startedAt = Date.now();
  const cached = await request.get(url);
  const elapsedMs = Date.now() - startedAt;

  expect(cached.status()).toBe(200);
  expect(cached.headers()['x-tokensrank-cache']).toBe('HIT');
  expect(elapsedMs).toBeLessThan(200);
});

test('uncached leaderboard API response is served within the T-3 miss budget', async ({ request }) => {
  await seedPaginationLeaderboard('uncached-budget');
  await purgeApiCache();
  const url = `${apiBaseUrl}/api/leaderboard?period=7d&scope=claude&limit=1&offset=0`;
  const startedAt = Date.now();
  const response = await request.get(url);
  const elapsedMs = Date.now() - startedAt;

  expect(response.status()).toBe(200);
  expect(validCacheStatuses).toContain(response.headers()['x-tokensrank-cache']);
  expect(elapsedMs).toBeLessThan(1000);
});

test('cache headers are present and valid on leaderboard and profile responses', async ({ request }) => {
  await seedPaginationLeaderboard('headers');
  const profile = await seedProfileForWindow('headers');
  const responses = [
    await request.get(`${apiBaseUrl}/api/leaderboard?period=7d&scope=claude&limit=1&offset=0`),
    await request.get(`${apiBaseUrl}/api/profile/${profile.handle}?window=30d`),
  ];

  for (const response of responses) {
    expect(response.status()).toBe(200);
    expect(validCacheStatuses).toContain(response.headers()['x-tokensrank-cache']);
  }
});

test('cache header values stay within the documented status enum', async ({ request }) => {
  await seedPaginationLeaderboard('header-values');
  const url = `${apiBaseUrl}/api/leaderboard?period=7d&scope=claude&limit=1&offset=0`;
  const first = await request.get(url);
  const second = await request.get(url);

  expect(validCacheStatuses).toContain(first.headers()['x-tokensrank-cache']);
  expect(validCacheStatuses).toContain(second.headers()['x-tokensrank-cache']);
});

test('SSR apiFetch calls include sixty second revalidation', async () => {
  const homeSource = readFileSync(path.join(repoRoot, 'apps/web/app/page.tsx'), 'utf8');
  const profileSource = readFileSync(path.join(repoRoot, 'apps/web/app/(public)/u/[handle]/page.tsx'), 'utf8');

  expect(homeSource).toContain('revalidate: 60');
  expect(profileSource).toContain('revalidate: 60');
});

test('URL remains the source of truth for filters after a hard reload', async ({ page }) => {
  await seedPaginationLeaderboard('url-source');
  await page.goto('/?period=7d&scope=claude&limit=1&offset=1', { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });

  expectUrlSearch(page, {
    period: '7d',
    scope: 'claude',
    limit: '1',
    offset: '1',
  });
  await expect(page.getByRole('tablist', { name: 'Filter by period' }).getByRole('tab', { name: '7D' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tablist', { name: 'Filter by source' }).getByRole('tab', { name: 'Claude' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('leaderboard-page-info')).toHaveText('Page 2 of 3');
});
