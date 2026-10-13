import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import { seedOGProfile } from '../og-test-data';
import { hideNextDevTools } from '../visual-helpers';
import {
  clearNextFetchCache,
  createOutcomeProfile,
  purgeApiCache,
  setOwnerCookie,
} from './profile-outcome-fixtures';

test.describe.configure({ mode: 'serial' });

function serviceClient(schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0') {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('[visual-seo-e2e] Missing Supabase environment variables');
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

async function clearLeaderboardRows(): Promise<void> {
  const client = serviceClient();
  const { error } = await client
    .from('daily_aggregates')
    .delete()
    .neq('model', '__tokensrank_noop__');

  if (error) {
    throw new Error(`[visual-seo-e2e] Failed to clear leaderboard rows: ${error.message}`);
  }

  await purgeApiCache();
  await clearNextFetchCache();
}

test('homepage table layout matches the dark design reference', async ({ page }) => {
  await clearLeaderboardRows();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?period=24h&scope=codex', { waitUntil: 'networkidle' });
  await hideNextDevTools(page);

  await expect(page).toHaveScreenshot(['__screenshots__', 'homepage-table-dark.png'], {
    maxDiffPixels: 1,
  });
});

test('profile page renders the 10-section visual structure', async ({ page, context }) => {
  const profile = await createOutcomeProfile('seo_visual', true, { xHandle: null });

  await setOwnerCookie(context, profile);
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto(`/u/${profile.handle}?window=all`, { waitUntil: 'networkidle' });
  await hideNextDevTools(page);

  await expect(page.locator('[data-section]')).toHaveCount(10);
  await expect(page).toHaveScreenshot(['__screenshots__', 'profile-10-sections.png'], {
    fullPage: true,
    maxDiffPixels: 1,
    mask: [
      page.locator('[data-section="identity"] p').first(),
      page.locator('[data-section="headline-pair"] p').first(),
      page.locator('[data-section="sessions-list"] tbody td:first-child'),
      page.locator('[data-section="sessions-list"] article p:first-child'),
      page.locator('[data-section="recent-activity"] article p:first-child'),
    ],
  });
});

test('OG card variant B matches the Satori-rendered baseline', async ({ request }) => {
  await seedOGProfile('alex');

  const response = await request.get('/og/u/alex.png?v=b');

  expect(response.status()).toBe(200);
  expect(await response.body()).toMatchSnapshot(['__screenshots__', 'og-card-variant-b.png'], {
    maxDiffPixels: 1,
  });
});

test('homepage mobile 390px layout remains stable', async ({ page }) => {
  await clearLeaderboardRows();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?period=all&scope=all', { waitUntil: 'networkidle' });
  await hideNextDevTools(page);

  await expect(page).toHaveScreenshot(['__screenshots__', 'homepage-mobile-390.png'], {
    fullPage: true,
    maxDiffPixels: 1,
  });
});

test('focus-visible outline remains stable on the search control', async ({ page }) => {
  await clearLeaderboardRows();
  await page.goto('/?period=all&scope=all', { waitUntil: 'networkidle' });
  await hideNextDevTools(page);

  const searchInput = page.locator('#handle-search');
  await searchInput.focus();

  await expect(searchInput).toHaveScreenshot(['__screenshots__', 'search-focus-visible.png'], {
    maxDiffPixels: 1,
  });
});
