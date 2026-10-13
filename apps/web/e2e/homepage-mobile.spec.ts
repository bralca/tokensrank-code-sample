import { rm } from 'node:fs/promises';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';

import { hideNextDevTools } from './visual-helpers';

const apiBaseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3000);
const webOrigin = `http://127.0.0.1:${webPort}`;
const webRoot = path.resolve(__dirname, '..');

test.describe('homepage mobile viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('renders the 4-column leaderboard, filters, ticker, and no horizontal scroll', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page);

    await clearAllAggregateRows();

    await page.goto('/?period=7d&scope=all', { waitUntil: 'networkidle' });

    await expect(page.getByRole('heading', { level: 1, name: 'Top builders by token usage' })).toBeVisible();
    await expect(page.locator('#leaderboard-table')).toBeVisible();
    await expect(page.getByRole('columnheader')).toHaveCount(4);
    await expect(page.getByRole('columnheader', { name: 'Rank' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Builder' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Tokens|Token usage/u })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Cost' })).toBeVisible();

    await expect(page.getByRole('tablist', { name: 'Filter by period' })).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Filter by source' })).toBeVisible();
    await expect(page.locator('button[role="tab"]')).toHaveCount(7);
    await expect(page.getByTestId('live-ticker')).toBeVisible();
    await expect(page.getByTestId('live-ticker')).toContainText(/Top 5 builders|No builders/u);

    await expect.poll(async () => page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }))).toEqual({ scrollWidth: 390, innerWidth: 390 });
    expect(consoleErrors).toEqual([]);

    await hideNextDevTools(page);
    await expect(page).toHaveScreenshot('homepage-mobile-390.png', {
      maxDiffPixels: 1,
    });
  });
});

function collectConsoleErrors(page: Page): string[] {
  const consoleErrors: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(error.message);
  });

  return consoleErrors;
}

function serviceClient(schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0') {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('[homepage-mobile-e2e] Missing Supabase environment variables');
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

async function clearAllAggregateRows(): Promise<void> {
  const { error } = await serviceClient()
    .from('daily_aggregates')
    .delete()
    .neq('model', '__tokensrank_noop__');

  if (error) {
    throw new Error(`[homepage-mobile-e2e] Failed to clear aggregate rows: ${error.message}`);
  }

  await purgeApiCache();
  await rm(path.join(webRoot, '.next/cache/fetch-cache'), {
    recursive: true,
    force: true,
  });
}

async function purgeApiCache(): Promise<void> {
  const adminToken = process.env.ADMIN_PURGE_TOKEN;

  if (!adminToken) {
    throw new Error('[homepage-mobile-e2e] Missing ADMIN_PURGE_TOKEN');
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
    throw new Error(`[homepage-mobile-e2e] Cache purge failed with ${response.status}`);
  }
}
