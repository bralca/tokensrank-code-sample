import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';

import { createTestProfile, createTestUser } from './fixtures/seed-data';

test.use({ viewport: { width: 390, height: 844 } });

const apiBaseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3000);
const webOrigin = `http://127.0.0.1:${webPort}`;
const webRoot = path.resolve(__dirname, '..');

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[mobile-e2e] Missing required environment variable: ${name}`);
  }

  return value;
}

function serviceClient(schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0') {
  return createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
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
    },
  );
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function uniqueHandle(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

async function clearNextFetchCache() {
  await rm(path.join(webRoot, '.next/cache/fetch-cache'), {
    recursive: true,
    force: true,
  });
}

async function purgeApiCache() {
  const response = await fetch(`${apiBaseUrl}/api/admin/cache/purge`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${readRequiredEnv('ADMIN_PURGE_TOKEN')}`,
      'Content-Type': 'application/json',
      Origin: webOrigin,
    },
    body: JSON.stringify({ all: true }),
  });

  if (!response.ok) {
    throw new Error(`[mobile-e2e] Cache purge failed with ${response.status}`);
  }
}

async function seedProfile(): Promise<string> {
  const schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
  const client = serviceClient(schema);
  const profile = await createTestProfile(await createTestUser('qc7-mobile'), schema);
  const handle = uniqueHandle('mobile');
  const firstEventAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const lastEventAt = new Date(Date.now() - 90 * 60_000).toISOString();
  const sessionId = `qc7-mobile-${randomUUID()}`;

  const { data: updatedProfile, error: profileError } = await client
    .from('profiles')
    .update({
      handle,
      display_name: 'Mobile Accessibility Profile',
      bio: 'Profile seeded for mobile viewport verification.',
      mode: 'script_verified',
      verified: true,
      share_projects: true,
    })
    .eq('id', profile.id)
    .select('handle')
    .single<{ handle: string }>();

  if (profileError || !updatedProfile) {
    throw new Error(`[mobile-e2e] Profile seed failed: ${profileError?.message ?? 'missing profile'}`);
  }

  const { error: sessionError } = await client.from('sessions').insert({
    profile_id: profile.id,
    source: 'codex',
    model: 'qc7-mobile-codex',
    session_id: sessionId,
    file_sha256: sha(sessionId),
    first_event_at: firstEventAt,
    last_event_at: lastEventAt,
    input_tokens: 22_000,
    output_tokens: 6_000,
    cache_read_tokens: 1_500,
    cache_create_tokens: 500,
    cached_tokens: 0,
    reasoning_tokens: 2_000,
    turns: 7,
    ingestion_mode: 'script_verified',
  });

  if (sessionError) {
    throw new Error(`[mobile-e2e] Session seed failed: ${sessionError.message}`);
  }

  const { error: aggregateError } = await client.from('daily_aggregates').upsert({
    profile_id: profile.id,
    date: firstEventAt.slice(0, 10),
    source: 'codex',
    model: 'qc7-mobile-codex',
    total_tokens: 32_000,
    total_sessions: 1,
    derived_cost_usd: 0.32,
  }, {
    onConflict: 'profile_id,date,source,model',
  });

  if (aggregateError) {
    throw new Error(`[mobile-e2e] Aggregate seed failed: ${aggregateError.message}`);
  }

  await purgeApiCache();
  await clearNextFetchCache();

  return updatedProfile.handle;
}

async function addE2eOnboardingCookie(page: Page, handle: string) {
  await page.context().addCookies([{
    name: 'tr_e2e_onboarding',
    value: encodeURIComponent(JSON.stringify({
      userId: '00000000-0000-4000-8000-000000000079',
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

async function expectNoHorizontalScroll(page: Page) {
  const viewport = page.viewportSize();
  expect(viewport?.width).toBe(390);

  const metrics = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    overflowingElements: Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((element) => {
        const rect = element.getBoundingClientRect();

        return rect.left < -1 || rect.right > window.innerWidth + 1;
      })
      .slice(0, 8)
      .map((element) => ({
        className: element.className.toString(),
        tagName: element.tagName,
        text: element.textContent?.trim().slice(0, 80) ?? '',
      })),
  }));

  expect(metrics.documentScrollWidth, JSON.stringify(metrics.overflowingElements, null, 2)).toBe(metrics.innerWidth);
  expect(metrics.bodyScrollWidth, JSON.stringify(metrics.overflowingElements, null, 2)).toBe(metrics.innerWidth);
}

test('homepage, profile, and onboarding render at 390px without horizontal scroll', async ({ page }) => {
  const handle = await seedProfile();
  await addE2eOnboardingCookie(page, uniqueHandle('mobile_onboarding'));

  for (const pathUnderTest of ['/?period=24h&scope=all', `/u/${handle}?window=7d`, '/onboarding']) {
    await page.goto(pathUnderTest, { waitUntil: 'networkidle' });
    await expectNoHorizontalScroll(page);
  }
});
