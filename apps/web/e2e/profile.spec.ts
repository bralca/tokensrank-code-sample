import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const apiBaseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3000);
const webOrigin = `http://127.0.0.1:${webPort}`;
const webRoot = path.resolve(__dirname, '..');
const testPassword = 'Correct-horse-battery-staple-39!';

type SeededProfile = {
  accessToken: string;
  handle: string;
  profileId: string;
  userId: string;
};

function serviceClient(schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0') {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('[profile-e2e] Missing Supabase environment variables');
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
    throw new Error('[profile-e2e] Missing Supabase auth environment variables');
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

function isoDaysAgo(daysAgo: number, hour = 12): string {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  date.setUTCHours(hour, 0, 0, 0);

  return date.toISOString();
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
    throw new Error('[profile-e2e] Missing ADMIN_PURGE_TOKEN');
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
    throw new Error(`[profile-e2e] Cache purge failed with ${response.status}`);
  }
}

async function createProfile(label: string, shareProjects: boolean, stale = false): Promise<SeededProfile> {
  const schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
  const service = serviceClient(schema);
  const auth = authClient(schema);
  const email = `profile-${label}-${randomUUID()}@example.com`;
  const handle = `pf_${label}_${randomUUID().replace(/-/g, '').slice(0, 8)}`.slice(0, 30).toLowerCase();

  const { data: userData, error: userError } = await service.auth.admin.createUser({
    email,
    password: testPassword,
    email_confirm: true,
    user_metadata: {
      test_schema: schema,
    },
  });

  if (userError || !userData.user) {
    throw new Error(`[profile-e2e] createUser failed: ${userError?.message ?? 'missing user'}`);
  }

  const profileShell = await waitForProfileShell(userData.user.id);
  const { data: profile, error: profileError } = await service
    .from('profiles')
    .update({
      handle,
      display_name: `Profile ${label}`,
      avatar_url: null,
      bio: 'AI coding usage profile seeded for the TokensRank profile page.',
      x_handle: handle,
      mode: 'script_verified',
      verified: true,
      share_projects: shareProjects,
    })
    .eq('id', profileShell.id)
    .select('id,user_id,handle')
    .single();

  if (profileError || !profile) {
    throw new Error(`[profile-e2e] profile insert failed: ${profileError?.message ?? 'missing profile'}`);
  }

  await seedUsage(profile.id, stale);
  await seedAccessKey(profile.id);
  await seedIngestionRuns(profile.id, stale);

  const { data: signIn, error: signInError } = await auth.auth.signInWithPassword({
    email,
    password: testPassword,
  });

  if (signInError || !signIn.session) {
    throw new Error(`[profile-e2e] signIn failed: ${signInError?.message ?? 'missing session'}`);
  }

  await purgeApiCache();
  await clearNextFetchCache();

  return {
    accessToken: signIn.session.access_token,
    handle: profile.handle,
    profileId: profile.id,
    userId: profile.user_id,
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

  throw new Error(`[profile-e2e] profile shell was not created for user ${userId}`);
}

async function seedUsage(profileId: string, stale: boolean) {
  const service = serviceClient();
  const sessions = [
    { label: 'app', source: 'claude', model: 'claude-3-5-sonnet', daysAgo: 1, tokens: 18_000, turns: 4, hour: 10 },
    { label: 'api', source: 'codex', model: 'gpt-5-codex', daysAgo: 2, tokens: 8_000, turns: 3, hour: 14 },
    { label: 'docs', source: 'claude', model: 'claude-3-5-sonnet', daysAgo: 12, tokens: 4_000, turns: 2, hour: 22 },
    { label: 'archive', source: 'codex', model: 'gpt-5-codex', daysAgo: stale ? 20 : 35, tokens: 6_000, turns: 1, hour: 6 },
  ] as const;

  for (const session of sessions) {
    const firstEventAt = isoDaysAgo(session.daysAgo, session.hour);
    const lastEventAt = new Date(new Date(firstEventAt).getTime() + 20 * 60_000).toISOString();
    const fileSha = sha(`${profileId}-${session.label}`);
    const { error: sessionError } = await service.from('sessions').insert({
      profile_id: profileId,
      source: session.source,
      model: session.model,
      session_id: `${session.label}-${randomUUID()}`,
      file_sha256: fileSha,
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
      throw new Error(`[profile-e2e] session insert failed: ${sessionError.message}`);
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
      throw new Error(`[profile-e2e] aggregate upsert failed: ${aggregateError.message}`);
    }
  }
}

async function seedAccessKey(profileId: string) {
  const service = serviceClient();
  const plaintext = `tr_script_${randomBytes(24).toString('base64url')}`;
  const { error } = await service.from('access_keys').insert({
    profile_id: profileId,
    key_sha256: sha(plaintext),
    key_prefix: plaintext.slice(0, 11),
    scope: 'script',
    label: 'profile e2e key',
  });

  if (error) {
    throw new Error(`[profile-e2e] access key insert failed: ${error.message}`);
  }
}

async function seedIngestionRuns(profileId: string, stale: boolean) {
  const service = serviceClient();
  const scriptDaysAgo = stale ? 16 : 1;
  const rows = [
    {
      started_at: isoDaysAgo(scriptDaysAgo, 9),
      finished_at: new Date(new Date(isoDaysAgo(scriptDaysAgo, 9)).getTime() + 30_000).toISOString(),
      status: 'completed',
      ingestion_mode: 'script_verified',
      session_count: 2,
      duplicate_count: 0,
      rejected_count: 0,
    },
    {
      started_at: isoDaysAgo(2, 11),
      finished_at: new Date(new Date(isoDaysAgo(2, 11)).getTime() + 30_000).toISOString(),
      status: 'partial',
      ingestion_mode: 'self_reported',
      session_count: 1,
      duplicate_count: 1,
      rejected_count: 1,
    },
  ];
  const { error } = await service.from('ingestion_runs').insert(rows.map((row) => ({
    profile_id: profileId,
    ...row,
  })));

  if (error) {
    throw new Error(`[profile-e2e] ingestion run insert failed: ${error.message}`);
  }
}

async function setOwnerCookie(context: BrowserContext, profile: SeededProfile) {
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

async function expectTenSections(page: Page) {
  const sections = [
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
  ];

  for (const section of sections) {
    await expect(page.locator(`[data-section="${section}"]`)).toBeVisible();
  }
}

async function expectProfileMetadata(page: Page, handle: string, window = '7d') {
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    new RegExp(`/u/${handle}\\?window=${window}$`),
  );
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    'content',
    new RegExp(`/og/u/${handle}\\.png\\?v=b$`),
  );
  await expect(page.locator('meta[name="twitter:description"]')).toHaveAttribute('content', /^.{1,125}$/);
}

test.describe.configure({ mode: 'serial' });

test('public profile SSR HTML includes all 10 open sections without client-only placeholders', async ({ request }) => {
  const profile = await createProfile('ssr', true);
  const response = await request.get(`/u/${profile.handle}?window=7d`);
  const html = await response.text();

  expect(response.status()).toBe(200);
  for (const section of [
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
  ]) {
    expect(html).toContain(`data-section="${section}"`);
  }
  expect(html).not.toContain('Loading profile');
  expect(html).not.toContain('Expand section');
});

test('profile defaults to the 7d window and carries cache, variant, and window data attributes', async ({ page }) => {
  const profile = await createProfile('default', true);

  await page.goto(`/u/${profile.handle}`, { waitUntil: 'networkidle' });

  await expectTenSections(page);
  await expect(page.locator('main')).toHaveAttribute('data-profile-window', '7d');
  await expect(page.locator('main')).toHaveAttribute('data-profile-variant', 'public_share_true');
  await expect(page.locator('main')).toHaveAttribute('data-cache-status', /^(HIT|MISS|BYPASS|HIT-DEGRADED|UNKNOWN)$/);
});

test('invalid profile window values fall back to the canonical 7d state', async ({ page }) => {
  const profile = await createProfile('badwindow', true);

  await page.goto(`/u/${profile.handle}?window=quarter`, { waitUntil: 'networkidle' });

  await expect(page.locator('main')).toHaveAttribute('data-profile-window', '7d');
  await expect(page.getByRole('tab', { name: '7D' })).toHaveAttribute('aria-selected', 'true');
});

test('window selector exposes three href tabs and no client navigation buttons', async ({ page }) => {
  const profile = await createProfile('tabs', true);

  await page.goto(`/u/${profile.handle}?window=30d`, { waitUntil: 'networkidle' });

  await expect(page.getByRole('tablist', { name: 'Profile stats window' })).toBeVisible();
  await expect(page.locator('[data-testid="profile-window-tabs"] a[role="tab"]')).toHaveCount(3);
  await expect(page.locator('[data-testid="profile-window-tabs"] button')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '7D' })).toHaveAttribute('href', `/u/${profile.handle}?window=7d`);
  await expect(page.getByRole('tab', { name: '30D' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('tab', { name: 'All' })).toHaveAttribute('href', `/u/${profile.handle}?window=all`);
});

test('all-time window re-aggregates stats beyond the 7d window', async ({ page }) => {
  const profile = await createProfile('allwindow', true);

  await page.goto(`/u/${profile.handle}?window=7d`, { waitUntil: 'networkidle' });
  const sevenDayStats = await page.locator('[data-section="at-a-glance"]').innerText();

  await Promise.all([
    page.waitForURL(`**/u/${profile.handle}?window=all`),
    page.getByRole('tab', { name: 'All' }).click(),
  ]);
  await page.waitForLoadState('networkidle');

  await expect(page.locator('main')).toHaveAttribute('data-profile-window', 'all');
  await expect.poll(async () => page.locator('[data-section="at-a-glance"]').innerText()).not.toBe(sevenDayStats);
});

test('profile metadata emits canonical URL and variant B OG image', async ({ page }) => {
  const profile = await createProfile('metadata', true);

  await page.goto(`/u/${profile.handle}?window=30d`, { waitUntil: 'networkidle' });

  await expectProfileMetadata(page, profile.handle, '30d');
});

test('profile API cache header is observable and repeated reads hit cache', async ({ request }) => {
  const profile = await createProfile('cache', true);
  const url = `${apiBaseUrl}/api/profile/${profile.handle}?window=7d`;
  const first = await request.get(url);
  const second = await request.get(url);

  expect(first.status()).toBe(200);
  expect(first.headers()['x-tokensrank-cache']).toBeTruthy();
  expect(second.status()).toBe(200);
  expect(second.headers()['x-tokensrank-cache']).toBe('HIT');
});

test('public share-on profile exposes public variant without owner controls', async ({ page }) => {
  const profile = await createProfile('shareon', true);

  await page.goto(`/u/${profile.handle}?window=all`, { waitUntil: 'networkidle' });

  await expect(page.locator('main')).toHaveAttribute('data-profile-variant', 'public_share_true');
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('tr_script_');
});

test('identity section uses AvatarWithBadge and an accessible external X handle link', async ({ page }) => {
  const profile = await createProfile('identity', true);

  await page.goto(`/u/${profile.handle}?window=7d`, { waitUntil: 'networkidle' });

  await expect(page.locator('[data-section="identity"] [data-testid="avatar-with-badge"]')).toBeVisible();
  await expect(page.locator('[data-section="identity"] [data-testid="avatar-with-badge"]')).toHaveAttribute('aria-label', 'Verified via script');
  await expect(page.locator('[data-section="identity"] [data-testid="avatar-verification-pip"]')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByRole('link', { name: `@${profile.handle}` })).toHaveAttribute(
    'href',
    `https://x.com/${profile.handle}`,
  );
});

test('sessions section renders semantic desktop table and mobile cards from the same SSR data', async ({ page }) => {
  const profile = await createProfile('sessions', true);

  await page.goto(`/u/${profile.handle}?window=all`, { waitUntil: 'networkidle' });

  await expect(page.locator('[data-section="sessions-list"] table')).toBeVisible();
  await expect(page.locator('[data-section="sessions-list"] th[scope="col"]')).toHaveCount(4);
  await expect(page.locator('[data-section="sessions-list"] tbody tr')).toHaveCount(4);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('[data-section="sessions-list"] table')).toBeHidden();
  await expect(page.locator('[data-section="sessions-list"] article').first()).toBeVisible();
});

test('owner profile renders all 10 sections and window tabs navigate by SSR href', async ({ page, context }) => {
  const profile = await createProfile('owner', true);
  await setOwnerCookie(context, profile);

  await page.goto(`/u/${profile.handle}?window=7d`, { waitUntil: 'networkidle' });

  await expectTenSections(page);
  await expect(page.getByRole('tablist', { name: 'Profile stats window' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '7D' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: '30D' })).toHaveAttribute('href', `/u/${profile.handle}?window=30d`);
  const sevenDayTokens = await page.locator('[data-section="at-a-glance"]').innerText();

  await Promise.all([
    page.waitForURL(`**/u/${profile.handle}?window=30d`),
    page.getByRole('tab', { name: '30D' }).click(),
  ]);
  await page.waitForLoadState('networkidle');

  await expect(page.getByRole('tab', { name: '30D' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => page.locator('[data-section="at-a-glance"]').innerText()).not.toBe(sevenDayTokens);
});

test('owner variant shows settings and public variant hides owner-only access keys', async ({ page, context, browser }) => {
  const profile = await createProfile('variant', false);
  await setOwnerCookie(context, profile);

  await page.goto(`/u/${profile.handle}`, { waitUntil: 'networkidle' });

  await expect(page.locator('main')).toHaveAttribute('data-profile-variant', 'owner_share_false');
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();

  const publicPage = await browser.newPage();
  await publicPage.goto(`/u/${profile.handle}`, { waitUntil: 'networkidle' });

  await expect(publicPage.locator('main')).toHaveAttribute('data-profile-variant', 'public_share_false');
  await expect(publicPage.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  await expect(publicPage.locator('body')).not.toContainText('tr_script_');
  await publicPage.close();
});

test('stale script verification banner appears for stale owner profiles', async ({ page, context }) => {
  const profile = await createProfile('stale', true, true);
  await setOwnerCookie(context, profile);

  await page.goto(`/u/${profile.handle}`, { waitUntil: 'networkidle' });

  await expect(page.getByTestId('profile-stale-sync-banner')).toBeVisible();
  await expect(page.getByText('Verification is stale.')).toBeVisible();
});

test('profile keyboard focus and mobile responsive layout remain usable', async ({ page, context }) => {
  const profile = await createProfile('mobile', true);
  await setOwnerCookie(context, profile);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/u/${profile.handle}?window=7d`, { waitUntil: 'networkidle' });

  await expectTenSections(page);
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(page.locator('[data-section="identity"]')).toHaveCSS('flex-direction', 'column');
  await expect(page.locator('[data-section="headline-pair"] > div > div')).toHaveCount(2);
  await expect(page.locator('[data-section="sessions-list"] table')).toBeHidden();
  await expect(page.locator('[data-section="cadence-heatmap"] [aria-label*="six hour bucket"]').first()).toBeVisible();
  await expect.poll(async () => page.locator('main').evaluate((node) => {
    const visibleTextNodes = Array.from(node.querySelectorAll('a, button, p, dt, dd, th, td, span, h1, h2'))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && window.getComputedStyle(element).visibility !== 'hidden';
      });

    return visibleTextNodes.every((element) => Number.parseFloat(window.getComputedStyle(element).fontSize) >= 10);
  })).toBe(true);

  await page.getByRole('tab', { name: '7D' }).focus();
  await expect(page.getByRole('tab', { name: '7D' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '30D' })).toBeFocused();
  await Promise.all([
    page.waitForURL(`**/u/${profile.handle}?window=30d`),
    page.keyboard.press('Enter'),
  ]);

  await expect(page.getByTestId('profile-share-button')).toBeVisible();
});
