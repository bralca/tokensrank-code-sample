import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

import { createTestProfile, createTestUser } from './fixtures/seed-data';
import { hideNextDevTools } from './visual-helpers';

test.describe.configure({ mode: 'serial' });

const apiBaseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3000);
const webOrigin = `http://127.0.0.1:${webPort}`;
const webRoot = path.resolve(__dirname, '..');

function serviceClient(schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0') {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('[homepage-e2e] Missing Supabase environment variables');
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

function uniqueLeaderboardLimit(): number {
  return 40 + Math.floor(Math.random() * 50);
}

async function seedLeaderboardRows() {
  const schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
  const client = serviceClient(schema);
  const claudeProfile = await createTestProfile(await createTestUser('homepage-claude'), schema);
  const codexProfile = await createTestProfile(await createTestUser('homepage-codex'), schema);
  const today = new Date().toISOString().slice(0, 10);
  const uniqueModel = `homepage-${randomUUID()}`;

  const { error } = await client.from('daily_aggregates').insert([
    {
      profile_id: claudeProfile.id,
      date: today,
      source: 'claude',
      model: `${uniqueModel}-claude`,
      total_tokens: 12_500,
      total_sessions: 2,
      derived_cost_usd: 0.125,
    },
    {
      profile_id: codexProfile.id,
      date: today,
      source: 'codex',
      model: `${uniqueModel}-codex`,
      total_tokens: 42_500,
      total_sessions: 3,
      derived_cost_usd: 0.425,
    },
  ]);

  if (error) {
    throw new Error(`[homepage-e2e] Failed to seed leaderboard rows: ${error.message}`);
  }

  await purgeApiCache();
  await clearNextFetchCache();

  return { claudeProfile, codexProfile };
}

async function purgeApiCache() {
  const adminToken = process.env.ADMIN_PURGE_TOKEN;

  if (!adminToken) {
    throw new Error('[homepage-e2e] Missing ADMIN_PURGE_TOKEN');
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
    throw new Error(`[homepage-e2e] Cache purge failed with ${response.status}`);
  }
}

async function clearNextFetchCache() {
  await rm(path.join(webRoot, '.next/cache/fetch-cache'), {
    recursive: true,
    force: true,
  });
}

async function clearHomepageAggregateRows() {
  const schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
  const client = serviceClient(schema);
  const { error } = await client
    .from('daily_aggregates')
    .delete()
    .like('model', 'homepage-%');

  if (error) {
    throw new Error(`[homepage-e2e] Failed to clear homepage aggregate rows: ${error.message}`);
  }

  await purgeApiCache();
  await clearNextFetchCache();
}

async function clearAllAggregateRows() {
  const schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
  const client = serviceClient(schema);
  const { error } = await client
    .from('daily_aggregates')
    .delete()
    .neq('model', '__tokensrank_noop__');

  if (error) {
    throw new Error(`[homepage-e2e] Failed to clear aggregate rows: ${error.message}`);
  }

  await purgeApiCache();
  await clearNextFetchCache();
}

test('SSR homepage renders one H1 and a semantic 4-column leaderboard table', async ({ page }) => {
  const response = await page.goto('/', { waitUntil: 'networkidle' });

  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Top builders by token usage' })).toBeVisible();
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('table thead tbody')).toHaveCount(0);
  await expect(page.locator('table')).toHaveCount(1);
  await expect(page.locator('thead')).toHaveCount(1);
  await expect(page.locator('tbody')).toHaveCount(1);
  await expect(page.getByRole('columnheader')).toHaveCount(4);
  await expect(page.getByRole('columnheader', { name: 'Rank' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Builder' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Token usage' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Cost' })).toBeVisible();
});

test('SSR HTML contains the leaderboard table without client-only skeleton content', async ({ request }) => {
  const response = await request.get('/?period=all&scope=all');
  const html = await response.text();

  expect(response.status()).toBe(200);
  expect(html).toContain('<table');
  expect(html).toContain('<thead');
  expect(html).toContain('<tbody');
  expect(html).toContain('Rank');
  expect(html).toContain('Builder');
  expect(html).toContain('Token usage');
  expect(html).toContain('Cost');
  expect(html).not.toContain('loading leaderboard');
  expect(html).not.toContain('Loading...');
});

test('filter pill groups expose selected state and button navigation', async ({ page }) => {
  await seedLeaderboardRows();

  await page.goto('/?period=7d&scope=all', { waitUntil: 'networkidle' });

  await expect(page.getByRole('tablist', { name: 'Filter by period' })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Filter by source' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '7D' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'All' }).last()).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Codex' })).toHaveAttribute('aria-controls', 'leaderboard-table');
  await expect(page.locator('#leaderboard-table tbody')).not.toContainText('No builders have reported usage');
  const allRowsText = await page.locator('#leaderboard-table tbody').innerText();

  await Promise.all([
    page.waitForURL('**/?period=7d&scope=codex'),
    page.getByRole('tab', { name: 'Codex' }).click(),
  ]);
  await page.waitForLoadState('networkidle');

  await expect(page.getByRole('tab', { name: 'Codex' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => page.locator('#leaderboard-table tbody').innerText()).not.toBe(allRowsText);
});

test('filter controls are button tabs and expose all period and source choices', async ({ page }) => {
  await page.goto('/?period=30d&scope=claude', { waitUntil: 'networkidle' });

  await expect(page.locator('button[role="tab"]')).toHaveCount(7);
  await expect(page.locator('a[role="tab"]')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '24H' })).toHaveAttribute('aria-controls', 'leaderboard-table');
  await expect(page.getByRole('tab', { name: '7D' })).toHaveAttribute('aria-controls', 'leaderboard-table');
  await expect(page.getByRole('tab', { name: '30D' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'All' }).first()).toHaveAttribute('aria-controls', 'leaderboard-table');
  await expect(page.getByRole('tab', { name: 'Claude' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Codex' })).toHaveAttribute('aria-controls', 'leaderboard-table');
});

test('seeded leaderboard rows render builder links, AvatarWithBadge pips, token usage, and cost', async ({ page }) => {
  const { claudeProfile, codexProfile } = await seedLeaderboardRows();
  const limit = uniqueLeaderboardLimit();

  await page.goto(`/?period=all&scope=all&limit=${limit}&offset=0`, { waitUntil: 'networkidle' });

  await expect(page.getByRole('link', { name: new RegExp(`@${claudeProfile.handle}`) })).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(`@${codexProfile.handle}`) })).toBeVisible();
  await expect(page.locator('[data-testid="avatar-with-badge"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="avatar-verification-pip"]').first()).toHaveAttribute(
    'aria-hidden',
    'true',
  );
  await expect(page.getByRole('group', { name: 'Verified via script' }).first()).toBeVisible();
  await expect(page.locator('#leaderboard-table tbody')).toContainText('42.5K');
  await expect(page.locator('#leaderboard-table tbody')).toContainText('$0.43');
});

test('rank deltas are exposed with accessible labels instead of color-only status', async ({ page }) => {
  await seedLeaderboardRows();
  const limit = uniqueLeaderboardLimit();

  await page.goto(`/?period=all&scope=all&limit=${limit}&offset=0`, { waitUntil: 'networkidle' });

  await expect(page.locator('#leaderboard-table tbody')).not.toContainText('No builders have reported usage');
  await expect.poll(async () => page.locator('#leaderboard-table tbody [aria-label]').first().getAttribute('aria-label')).toMatch(
    /^(No rank change|Up \d+|Down \d+)$/,
  );
});

test('invalid query parameters fall back to safe defaults without leaving SSR state', async ({ page }) => {
  await page.goto('/?period=year&scope=unknown&limit=5000&offset=-50', { waitUntil: 'networkidle' });

  await expect(page.getByRole('tab', { name: 'All' }).first()).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'All' }).last()).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('leaderboard-page-info')).toContainText('Page 1 of');
  await expect(page.locator('#leaderboard-table')).toBeVisible();
});

test('leaderboard API emits cache header and repeated reads hit cache', async ({ request }) => {
  const url = `${apiBaseUrl}/api/leaderboard?period=24h&scope=all&limit=1&offset=37`;
  const first = await request.get(url);
  const second = await request.get(url);

  expect(first.status()).toBe(200);
  expect(first.headers()['x-tokensrank-cache']).toBeTruthy();
  expect(second.status()).toBe(200);
  expect(second.headers()['x-tokensrank-cache']).toBe('HIT');
});

test('pagination renders disabled previous on the first page', async ({ page }) => {
  await seedLeaderboardRows();

  await page.goto('/?period=all&scope=all&limit=1&offset=0', { waitUntil: 'networkidle' });

  await expect(page.getByTestId('leaderboard-prev-disabled')).toBeDisabled();
  await expect(page.getByTestId('leaderboard-page-info')).toContainText('Page 1 of');
});

test('pagination previous control preserves filter params and performs URL-driven SSR navigation', async ({ page }) => {
  await seedLeaderboardRows();

  await page.goto('/?period=7d&scope=claude&limit=10&offset=10', { waitUntil: 'networkidle' });
  await expect(page.getByTestId('leaderboard-prev-link')).toHaveAttribute(
    'href',
    '/?period=7d&scope=claude&limit=10&offset=0',
  );

  await Promise.all([
    page.waitForURL('**/?period=7d&scope=claude&limit=10&offset=0'),
    page.getByTestId('leaderboard-prev-link').click(),
  ]);
  await page.waitForLoadState('networkidle');

  await expect(page.getByTestId('leaderboard-prev-disabled')).toBeDisabled();
});

test('mobile 390px viewport keeps all 4 leaderboard columns visible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/', { waitUntil: 'networkidle' });

  await expect(page.locator('#leaderboard-table')).toBeVisible();
  await expect(page.locator('th[scope="col"]')).toHaveCount(4);
  await expect(page.getByRole('columnheader', { name: 'Rank' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Builder' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /Tokens|Token usage/u })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Cost' })).toBeVisible();
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('sub-390px mobile layout keeps compact table columns visible and prevents horizontal scroll', async ({ page }) => {
  await seedLeaderboardRows();
  const limit = uniqueLeaderboardLimit();

  await page.setViewportSize({ width: 380, height: 844 });
  await page.goto(`/?period=all&scope=all&limit=${limit}&offset=0`, { waitUntil: 'networkidle' });

  await expect(page.locator('#leaderboard-table tbody')).not.toContainText('No builders have reported usage');
  await expect(page.locator('#leaderboard-table tbody tr').first()).toHaveCSS('display', 'table-row');
  await expect(page.getByRole('columnheader', { name: 'Rank' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /Tokens|Token usage/u })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Cost' })).toBeVisible();
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('homepage screenshot remains stable against the dark JSX prototype contract', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Visual baseline is browser-renderer specific and is stored for Chromium only.');

  await clearAllAggregateRows();
  await page.goto('/?period=24h&scope=codex', { waitUntil: 'networkidle' });
  await hideNextDevTools(page);

  await expect(page).toHaveScreenshot('homepage-dark-4-column.png', {
    maxDiffPixels: 1,
  });
});
