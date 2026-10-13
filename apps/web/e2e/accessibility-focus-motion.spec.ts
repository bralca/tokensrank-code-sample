import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';

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
    throw new Error('[accessibility-focus-motion] Missing Supabase environment variables');
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

async function clearNextFetchCache() {
  await rm(path.join(webRoot, '.next/cache/fetch-cache'), {
    recursive: true,
    force: true,
  });
}

async function purgeApiCache() {
  const adminToken = process.env.ADMIN_PURGE_TOKEN;

  if (!adminToken) {
    throw new Error('[accessibility-focus-motion] Missing ADMIN_PURGE_TOKEN');
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
    throw new Error(`[accessibility-focus-motion] Cache purge failed with ${response.status}`);
  }
}

async function seedTopBuilders() {
  const schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
  const client = serviceClient(schema);
  const today = new Date().toISOString().slice(0, 10);
  const label = `focus_motion_${randomUUID().replace(/-/g, '').slice(0, 8)}`;

  for (let index = 0; index < 6; index += 1) {
    const profile = await createTestProfile(await createTestUser(`${label}_${index}`), schema);
    const tokens = 90_000 - index * 10_000;

    const { error } = await client.from('daily_aggregates').insert({
      profile_id: profile.id,
      date: today,
      source: index % 2 === 0 ? 'claude' : 'codex',
      model: `${label}_${index}`,
      total_tokens: tokens,
      total_sessions: index + 1,
      derived_cost_usd: tokens * 0.00001,
    });

    if (error) {
      throw new Error(`[accessibility-focus-motion] Failed to seed aggregate row: ${error.message}`);
    }
  }

  await purgeApiCache();
  await clearNextFetchCache();
}

async function getFocusedOutline(page: Page) {
  return page.evaluate(() => {
    const activeElement = document.activeElement;

    if (!(activeElement instanceof HTMLElement)) {
      return null;
    }

    const style = window.getComputedStyle(activeElement);

    return {
      id: activeElement.id,
      outlineColor: style.outlineColor,
      outlineOffset: style.outlineOffset,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
}

function cssTimeToMs(value: string): number {
  const trimmed = value.trim();

  if (trimmed.endsWith('ms')) {
    return Number.parseFloat(trimmed);
  }

  if (trimmed.endsWith('s')) {
    return Number.parseFloat(trimmed) * 1000;
  }

  return Number.NaN;
}

test('Tab focus exposes the acid-lime focus-visible outline on homepage controls', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await hideNextDevTools(page);

  await page.keyboard.press('Tab');

  const outline = await getFocusedOutline(page);

  expect(outline).toEqual(expect.objectContaining({
    id: 'handle-search',
    outlineColor: 'rgb(182, 255, 60)',
    outlineOffset: '2px',
    outlineStyle: 'solid',
    outlineWidth: '2px',
  }));
});

test('prefers-reduced-motion clamps animations and transitions to 0.01ms', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/', { waitUntil: 'networkidle' });

  const durations = await page.evaluate(() => {
    const element = document.createElement('div');
    element.className = 'tr-live-dot-pulse';
    element.style.transitionDuration = '2s';
    document.body.appendChild(element);

    const style = window.getComputedStyle(element);

    return {
      animationDuration: style.animationDuration,
      transitionDuration: style.transitionDuration,
    };
  });

  expect(cssTimeToMs(durations.animationDuration)).toBeCloseTo(0.01, 5);
  expect(cssTimeToMs(durations.transitionDuration)).toBeCloseTo(0.01, 5);
});

test('keyboard navigation moves through leaderboard filter tabs', async ({ page }) => {
  await page.goto('/?period=24h&scope=all', { waitUntil: 'networkidle' });
  await hideNextDevTools(page);

  const periodTabs = page.getByRole('tablist', { name: 'Filter by period' });
  await expect(periodTabs).toBeVisible();

  await page.getByRole('tab', { name: '24H' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '7D' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '30D' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: '24H' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'All' }).first()).toBeFocused();
});

test('live ticker exposes polite status semantics and renders only the top 5 builders', async ({ page }) => {
  await seedTopBuilders();
  await page.goto('/?period=24h&scope=all', { waitUntil: 'networkidle' });

  const ticker = page.getByTestId('live-ticker');

  await expect(ticker).toHaveAttribute('role', 'status');
  await expect(ticker).toHaveAttribute('aria-live', 'polite');
  await expect(ticker).toHaveAttribute('aria-atomic', 'true');
  await expect(ticker).toContainText(/Top 5 builders \(Updated/);
  await expect(ticker.locator('li')).toHaveCount(5);
});
