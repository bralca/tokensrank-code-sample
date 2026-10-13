import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { expect, test, type APIRequestContext } from '@playwright/test';

import { createTestProfile, createTestUser } from '../fixtures/seed-data';

const apiBaseUrl = `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_API_PORT ?? 4001)}`;
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3000);
const webOrigin = `http://127.0.0.1:${webPort}`;
const webRoot = path.resolve(__dirname, '../..');

const seededHandles: string[] = [];

test.describe.configure({ mode: 'serial' });

function serviceClient(schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0') {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('[sitemap-e2e] Missing Supabase environment variables');
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

async function purgeApiCache() {
  const adminToken = process.env.ADMIN_PURGE_TOKEN;

  if (!adminToken) {
    throw new Error('[sitemap-e2e] Missing ADMIN_PURGE_TOKEN');
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
    throw new Error(`[sitemap-e2e] Cache purge failed with ${response.status}`);
  }
}

async function clearNextFetchCache() {
  await rm(path.join(webRoot, '.next/cache/fetch-cache'), {
    recursive: true,
    force: true,
  });
}

async function seedSitemapProfile() {
  const schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
  const client = serviceClient(schema);
  const profile = await createTestProfile(await createTestUser('sitemap'), schema);
  const today = new Date().toISOString().slice(0, 10);

  const { error } = await client.from('daily_aggregates').insert({
    profile_id: profile.id,
    date: today,
    source: 'codex',
    model: `sitemap-${randomUUID()}`,
    total_tokens: 88_000,
    total_sessions: 4,
    derived_cost_usd: 0.88,
  });

  if (error) {
    throw new Error(`[sitemap-e2e] Failed to seed profile aggregate: ${error.message}`);
  }

  seededHandles.push(profile.handle);
  await purgeApiCache();
  await clearNextFetchCache();
}

async function loadSitemap(request: APIRequestContext) {
  const response = await request.get('/sitemap.xml');
  const body = await response.text();

  return { response, body };
}

test.beforeAll(async () => {
  await seedSitemapProfile();
});

test('sitemap.xml returns 200 and valid XML', async ({ page, request }) => {
  const { response, body } = await loadSitemap(request);
  const parserResult = await page.evaluate((xml) => {
    const parsed = new DOMParser().parseFromString(xml, 'application/xml');

    return parsed.querySelector('parsererror')?.textContent ?? null;
  }, body);

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/xml');
  expect(parserResult).toBeNull();
  expect(body).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
});

test('sitemap includes the homepage URL', async ({ request }) => {
  const { body } = await loadSitemap(request);
  const homepageUrl = body.match(/<loc>([^<]+)<\/loc>/)?.[1];

  expect(homepageUrl).toBeTruthy();
  expect(body).toContain(`<loc>${homepageUrl}</loc>`);
});

test('sitemap includes public profile URLs from the leaderboard endpoint', async ({ request }) => {
  const { body } = await loadSitemap(request);

  expect(seededHandles.length).toBeGreaterThan(0);
  expect(body).toMatch(/\/u\/[a-z0-9_-]{3,30}/u);
});

test('sitemap excludes auth, dashboard, and onboarding routes', async ({ request }) => {
  const { body } = await loadSitemap(request);

  expect(body).not.toContain('/auth');
  expect(body).not.toContain('/me');
  expect(body).not.toContain('/onboarding');
});

test('robots.txt references the sitemap location', async ({ request }) => {
  const response = await request.get('/robots.txt');
  const body = await response.text();

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/plain');
  expect(body).toContain('Sitemap: ');
  expect(body).toContain('/sitemap.xml');
});
