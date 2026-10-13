import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { hideNextDevTools } from './visual-helpers';

const apiBaseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3000);
const webOrigin = `http://127.0.0.1:${webPort}`;
const webRoot = path.resolve(__dirname, '..');
const testPassword = 'Correct-horse-battery-staple-79!';

type SeededProfile = {
  accessToken: string;
  handle: string;
};

const profileSections = [
  'identity',
  'headline-pair',
  'at-a-glance',
  'models-breakdown',
  'tools-breakdown',
  'sessions-list',
  'cadence-heatmap',
  'parallelism-dist',
  'recent-activity',
  'footer',
] as const;

test.describe('profile mobile viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('public profile renders all 10 sections stacked without horizontal scroll', async ({ page }, testInfo) => {
    const consoleErrors = collectConsoleErrors(page);
    const profile = await createProfile(`public-${testInfo.project.name}`);

    await page.goto(`/u/${profile.handle}?window=7d`, { waitUntil: 'networkidle' });

    await expectProfileMobileLayout(page);
    expect(consoleErrors).toEqual([]);
    await hideNextDevTools(page);
    await expect(page).toHaveScreenshot('profile-mobile-public-390.png', {
      mask: [
        page.locator('[data-section="headline-pair"]'),
        page.locator('[data-section="sessions-list"]'),
        page.locator('[data-section="recent-activity"]'),
      ],
      maxDiffPixels: 1,
    });
  });

  test('owner profile renders all 10 sections stacked without horizontal scroll', async ({ context, page }, testInfo) => {
    const consoleErrors = collectConsoleErrors(page);
    const profile = await createProfile(`owner-${testInfo.project.name}`);
    await setOwnerCookie(context, profile);

    await page.goto(`/u/${profile.handle}?window=7d`, { waitUntil: 'networkidle' });

    await expect(page.locator('main')).toHaveAttribute('data-profile-variant', /owner/u);
    await expectProfileMobileLayout(page);
    expect(consoleErrors).toEqual([]);
    await hideNextDevTools(page);
    await expect(page).toHaveScreenshot('profile-mobile-owner-390.png', {
      mask: [
        page.locator('[data-section="headline-pair"]'),
        page.locator('[data-section="sessions-list"]'),
        page.locator('[data-section="recent-activity"]'),
      ],
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
    throw new Error('[profile-mobile-e2e] Missing Supabase environment variables');
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

function authClient(schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0') {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    throw new Error('[profile-mobile-e2e] Missing Supabase auth environment variables');
  }

  return createClient(supabaseUrl, anonKey, {
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

async function createProfile(label: string): Promise<SeededProfile> {
  const schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
  const service = serviceClient(schema);
  const auth = authClient(schema);
  const normalizedLabel = label.replace(/[^a-z0-9_]/gu, '_').slice(0, 18);
  const email = `profile-mobile-${normalizedLabel}-${randomUUID()}@example.com`;
  const handle = `mobile_${normalizedLabel}`.slice(0, 30);

  const { data: userData, error: userError } = await service.auth.admin.createUser({
    email,
    password: testPassword,
    email_confirm: true,
    user_metadata: {
      test_schema: schema,
    },
  });

  if (userError || !userData.user) {
    throw new Error(`[profile-mobile-e2e] createUser failed: ${userError?.message ?? 'missing user'}`);
  }

  const profileShell = await waitForProfileShell(userData.user.id);
  const { data: profile, error: profileError } = await service
    .from('profiles')
    .update({
      handle,
      display_name: 'Mobile Profile',
      avatar_url: null,
      bio: 'Responsive mobile profile fixture for TokensRank.',
      x_handle: handle,
      mode: 'script_verified',
      verified: true,
      share_projects: true,
    })
    .eq('id', profileShell.id)
    .select('id,handle')
    .single();

  if (profileError || !profile) {
    throw new Error(`[profile-mobile-e2e] profile update failed: ${profileError?.message ?? 'missing profile'}`);
  }

  await seedUsage(profile.id);
  await seedAccessKey(profile.id);
  await seedIngestionRuns(profile.id);

  const { data: signIn, error: signInError } = await auth.auth.signInWithPassword({
    email,
    password: testPassword,
  });

  if (signInError || !signIn.session) {
    throw new Error(`[profile-mobile-e2e] signIn failed: ${signInError?.message ?? 'missing session'}`);
  }

  await purgeApiCache();
  await clearNextFetchCache();

  return {
    accessToken: signIn.session.access_token,
    handle: profile.handle,
  };
}

async function waitForProfileShell(userId: string): Promise<{ id: string }> {
  const service = serviceClient();

  for (let attempt = 0; attempt < 8; attempt += 1) {
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

  throw new Error(`[profile-mobile-e2e] profile shell was not created for user ${userId}`);
}

async function seedUsage(profileId: string): Promise<void> {
  const service = serviceClient();
  const sessions = [
    { label: 'app', source: 'claude', model: 'claude-3-5-sonnet', daysAgo: 1, tokens: 18_000, turns: 4, hour: 10 },
    { label: 'api', source: 'codex', model: 'gpt-5-codex', daysAgo: 2, tokens: 8_000, turns: 3, hour: 14 },
    { label: 'docs', source: 'claude', model: 'claude-3-5-sonnet', daysAgo: 4, tokens: 4_000, turns: 2, hour: 22 },
  ] as const;

  for (const session of sessions) {
    const firstEventAt = isoDaysAgo(session.daysAgo, session.hour);
    const lastEventAt = new Date(new Date(firstEventAt).getTime() + 20 * 60_000).toISOString();
    const { error: sessionError } = await service.from('sessions').insert({
      profile_id: profileId,
      source: session.source,
      model: session.model,
      session_id: `${session.label}-${randomUUID()}`,
      file_sha256: sha(`${profileId}-${session.label}`),
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
      throw new Error(`[profile-mobile-e2e] session insert failed: ${sessionError.message}`);
    }

    const { error: aggregateError } = await service.from('daily_aggregates').upsert({
      profile_id: profileId,
      date: firstEventAt.slice(0, 10),
      source: session.source,
      model: session.model,
      total_tokens: session.tokens,
      total_sessions: 1,
      derived_cost_usd: session.tokens * 0.00001,
    });

    if (aggregateError) {
      throw new Error(`[profile-mobile-e2e] aggregate upsert failed: ${aggregateError.message}`);
    }
  }
}

async function seedAccessKey(profileId: string): Promise<void> {
  const service = serviceClient();
  const plaintext = `tr_script_${randomUUID().replace(/-/gu, '').slice(0, 24)}`;
  const { error } = await service.from('access_keys').insert({
    profile_id: profileId,
    key_sha256: sha(plaintext),
    key_prefix: plaintext.slice(0, 11),
    scope: 'script',
    label: 'profile mobile e2e key',
  });

  if (error) {
    throw new Error(`[profile-mobile-e2e] access key insert failed: ${error.message}`);
  }
}

async function seedIngestionRuns(profileId: string): Promise<void> {
  const service = serviceClient();
  const startedAt = isoDaysAgo(1, 9);
  const { error } = await service.from('ingestion_runs').insert({
    profile_id: profileId,
    started_at: startedAt,
    finished_at: new Date(new Date(startedAt).getTime() + 30_000).toISOString(),
    status: 'completed',
    ingestion_mode: 'script_verified',
    session_count: 3,
    duplicate_count: 0,
    rejected_count: 0,
  });

  if (error) {
    throw new Error(`[profile-mobile-e2e] ingestion run insert failed: ${error.message}`);
  }
}

async function setOwnerCookie(context: BrowserContext, profile: SeededProfile): Promise<void> {
  await context.addCookies([
    {
      name: 'tr_at',
      value: profile.accessToken,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: false,
    },
  ]);
}

async function expectProfileMobileLayout(page: Page): Promise<void> {
  await expect(page.locator('[data-section]')).toHaveCount(profileSections.length);

  for (const section of profileSections) {
    await expect(page.locator(`[data-section="${section}"]`)).toBeVisible();
  }

  await expect.poll(async () => page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))).toEqual({ scrollWidth: 390, innerWidth: 390 });

  const sectionLayout = await page.locator('[data-section]').evaluateAll((sections) => sections.map((section) => {
    const rect = section.getBoundingClientRect();

    return {
      left: Math.round(rect.left),
      width: Math.round(rect.width),
    };
  }));
  expect(new Set(sectionLayout.map((section) => section.left)).size).toBe(1);
  expect(sectionLayout.every((section) => section.width <= 374)).toBe(true);

  for (const selector of [
    '[data-section="headline-pair"] .grid',
    '[data-section="at-a-glance"] .grid',
    '[data-section="parallelism-dist"] .grid',
    '[data-section="sessions-list"] dl.grid',
  ]) {
    const columns = await page.locator(selector).first().evaluate((element) => (
      window.getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length
    ));
    expect(columns).toBe(1);
  }
}

async function purgeApiCache(): Promise<void> {
  const adminToken = process.env.ADMIN_PURGE_TOKEN;

  if (!adminToken) {
    throw new Error('[profile-mobile-e2e] Missing ADMIN_PURGE_TOKEN');
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
    throw new Error(`[profile-mobile-e2e] Cache purge failed with ${response.status}`);
  }
}

async function clearNextFetchCache(): Promise<void> {
  await rm(path.join(webRoot, '.next/cache/fetch-cache'), {
    recursive: true,
    force: true,
  });
}

function isoDaysAgo(daysAgo: number, hour = 12): string {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  date.setUTCHours(hour, 0, 0, 0);

  return date.toISOString();
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
