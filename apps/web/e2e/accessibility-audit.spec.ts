import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';

import { createTestProfile, createTestUser } from './fixtures/seed-data';
import { hideNextDevTools } from './visual-helpers';

test.describe.configure({ mode: 'serial' });

const apiBaseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3000);
const webOrigin = `http://127.0.0.1:${webPort}`;
const webRoot = path.resolve(__dirname, '..');

type SeededProfile = {
  handle: string;
  id: string;
};

function serviceClient(schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0') {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('[accessibility-audit] Missing Supabase environment variables');
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

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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
    throw new Error('[accessibility-audit] Missing ADMIN_PURGE_TOKEN');
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
    throw new Error(`[accessibility-audit] Cache purge failed with ${response.status}`);
  }
}

function axeViolationSummary(violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations']): string {
  return violations.map((violation) => {
    const nodes = violation.nodes.map((node) => node.target.join(' ')).join(', ');

    return `${violation.id}: ${violation.help} -> ${nodes}`;
  }).join('\n');
}

async function expectNoAxeViolations(page: Page) {
  await hideNextDevTools(page);
  const results = await new AxeBuilder({ page }).analyze();

  expect(results.violations, axeViolationSummary(results.violations)).toEqual([]);
}

async function seedProfile(label: string): Promise<SeededProfile> {
  const schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
  const client = serviceClient(schema);
  const profile = await createTestProfile(await createTestUser(`audit-${label}`), schema);
  const firstEventAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const lastEventAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const sessionId = `audit-${label}-${randomUUID()}`;

  const { error: sessionError } = await client.from('sessions').insert({
    profile_id: profile.id,
    source: 'claude',
    model: `audit-${label}`,
    session_id: sessionId,
    file_sha256: sha(sessionId),
    first_event_at: firstEventAt,
    last_event_at: lastEventAt,
    input_tokens: 25_000,
    output_tokens: 1_000,
    cache_read_tokens: 0,
    cache_create_tokens: 0,
    cached_tokens: 0,
    reasoning_tokens: 0,
    turns: 4,
    ingestion_mode: 'script_verified',
  });

  if (sessionError) {
    throw new Error(`[accessibility-audit] Session seed failed: ${sessionError.message}`);
  }

  const { error: aggregateError } = await client.from('daily_aggregates').upsert({
    profile_id: profile.id,
    date: firstEventAt.slice(0, 10),
    source: 'claude',
    model: `audit-${label}`,
    total_tokens: 26_000,
    total_sessions: 1,
    derived_cost_usd: 0.26,
  });

  if (aggregateError) {
    throw new Error(`[accessibility-audit] Aggregate seed failed: ${aggregateError.message}`);
  }

  await purgeApiCache();
  await clearNextFetchCache();

  return {
    handle: profile.handle,
    id: profile.id,
  };
}

async function addE2eOnboardingCookie(page: Page, handle: string) {
  await page.context().addCookies([{
    name: 'tr_e2e_onboarding',
    value: encodeURIComponent(JSON.stringify({
      userId: '00000000-0000-4000-8000-000000000078',
      email: `${handle}@example.com`,
      handle,
      displayName: null,
      avatarUrl: null,
      bio: null,
      xHandle: null,
      mode: null,
      onboardedAt: null,
      shareProjects: false,
      onboarding: {
        step: 'not_started',
      },
      accessKeys: [],
    })),
    url: webOrigin,
    sameSite: 'Lax',
  }]);
}

test('homepage has zero axe violations', async ({ page }) => {
  await page.goto('/?period=24h&scope=all', { waitUntil: 'networkidle' });

  await expect(page.getByRole('heading', { level: 1, name: 'Top builders by token usage' })).toBeVisible();
  await expectNoAxeViolations(page);
});

test('public profile has zero axe violations', async ({ page }) => {
  const profile = await seedProfile('profile');

  await page.goto(`/u/${profile.handle}?window=7d`, { waitUntil: 'networkidle' });

  await expect(page.locator('[data-section]')).toHaveCount(10);
  await expectNoAxeViolations(page);
});

test('auth sign-up page has zero axe violations', async ({ page }) => {
  await page.goto('/auth/sign-up', { waitUntil: 'networkidle' });

  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Handle', { exact: true })).toBeVisible();
  await expectNoAxeViolations(page);
});

test('onboarding mode selection has zero axe violations', async ({ page }) => {
  await addE2eOnboardingCookie(page, `audit_${randomUUID().replace(/-/g, '').slice(0, 10)}`);
  await page.goto('/onboarding', { waitUntil: 'networkidle' });

  await expect(page.getByRole('tablist', { name: 'Choose verification path' })).toBeVisible();
  await expectNoAxeViolations(page);
});
