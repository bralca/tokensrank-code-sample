import { rm } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import { createTestProfile, createTestUser } from './fixtures/seed-data';

const productionOrigin = 'https://tokensrank.ai';
const apiBaseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3000);
const webOrigin = `http://127.0.0.1:${webPort}`;
const webRoot = path.resolve(__dirname, '..');

function serviceClient(schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0') {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('[canonical-e2e] Missing Supabase environment variables');
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

async function expectCanonical(page: Page, href: string): Promise<void> {
  const canonical = page.locator('link[rel="canonical"]');

  await expect(canonical).toHaveCount(1);
  await expect(canonical).toHaveAttribute('href', href);
}

async function expectLeaderboardCanonicalMatchesUrl(page: Page): Promise<void> {
  const currentUrl = new URL(page.url());
  const expected = new URL('/', productionOrigin);

  expected.searchParams.set('period', currentUrl.searchParams.get('period') ?? 'all');
  expected.searchParams.set('scope', currentUrl.searchParams.get('scope') ?? 'all');

  await expectCanonical(page, expected.href);
}

async function clearNextFetchCache(): Promise<void> {
  await rm(path.join(webRoot, '.next/cache/fetch-cache'), {
    recursive: true,
    force: true,
  });
}

async function purgeApiCache(): Promise<void> {
  const adminToken = process.env.ADMIN_PURGE_TOKEN;

  if (!adminToken) {
    throw new Error('[canonical-e2e] Missing ADMIN_PURGE_TOKEN');
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
    throw new Error(`[canonical-e2e] Cache purge failed with ${response.status}`);
  }
}

async function ensureAlexProfile(): Promise<void> {
  const schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
  const client = serviceClient(schema);
  const existing = await client
    .from('profiles')
    .select('id')
    .eq('handle', 'alex')
    .maybeSingle<{ id: string }>();

  if (existing.error) {
    throw new Error(`[canonical-e2e] Failed to check alex profile: ${existing.error.message}`);
  }

  if (!existing.data) {
    const profile = await createTestProfile(await createTestUser('canonical-alex'), schema);
    const { error } = await client
      .from('profiles')
      .update({
        handle: 'alex',
        display_name: 'Alex',
        mode: 'script_verified',
        share_projects: true,
      })
      .eq('id', profile.id);

    if (error) {
      throw new Error(`[canonical-e2e] Failed to seed alex profile: ${error.message}`);
    }
  }

  await purgeApiCache();
  await clearNextFetchCache();
}

test('canonical URL reflects leaderboard filter state', async ({ page }) => {
  test.setTimeout(60000);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expectLeaderboardCanonicalMatchesUrl(page);

  await page.goto('/?period=7d&scope=claude', { waitUntil: 'domcontentloaded' });
  await expectLeaderboardCanonicalMatchesUrl(page);

  for (const period of ['24h', '7d', '30d', 'all']) {
    for (const scope of ['all', 'claude', 'codex']) {
      await page.goto(`/?period=${period}&scope=${scope}`, { waitUntil: 'domcontentloaded' });
      await expectLeaderboardCanonicalMatchesUrl(page);
    }
  }
});

test('profile canonical URL reflects window param correctly', async ({ page }) => {
  test.setTimeout(60000);

  await ensureAlexProfile();

  await page.goto('/u/alex', { waitUntil: 'domcontentloaded' });
  await expectCanonical(page, `${productionOrigin}/u/alex`);

  await page.goto('/u/alex?window=30d', { waitUntil: 'domcontentloaded' });
  await expectCanonical(page, `${productionOrigin}/u/alex?window=30d`);

  await page.goto('/u/alex?window=all', { waitUntil: 'domcontentloaded' });
  await expectCanonical(page, `${productionOrigin}/u/alex?window=all`);
});
