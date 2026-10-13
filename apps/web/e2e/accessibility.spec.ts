import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';

import { createTestProfile, createTestUser } from './fixtures/seed-data';

test.describe.configure({ mode: 'serial' });

const apiBaseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3000);
const webOrigin = `http://127.0.0.1:${webPort}`;
const webRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(webRoot, '../..');
const testPassword = 'Correct-horse-battery-staple-39!';

type SeededProfile = {
  accessToken: string;
  handle: string;
  profileId: string;
};

type AxeAnalyzeResult = Awaited<ReturnType<AxeBuilder['analyze']>>;
type AxeViolation = AxeAnalyzeResult['violations'][number];

function serviceClient(schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0') {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('[accessibility-e2e] Missing Supabase environment variables');
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
    throw new Error('[accessibility-e2e] Missing Supabase auth environment variables');
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

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@example.com`;
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
  const adminToken = process.env.ADMIN_PURGE_TOKEN;

  if (!adminToken) {
    throw new Error('[accessibility-e2e] Missing ADMIN_PURGE_TOKEN');
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
    throw new Error(`[accessibility-e2e] Cache purge failed with ${response.status}`);
  }
}

async function hideNextDevTools(page: Page) {
  const css = `
    nextjs-portal,
    [data-nextjs-toast],
    [data-nextjs-dialog],
    [data-nextjs-dialog-overlay],
    [aria-label="Open Next.js Dev Tools"],
    [aria-label="Next.js Dev Tools"] {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
    }
  `;

  await page.addStyleTag({ content: css });
  await page.evaluate((shadowCss) => {
    const selectors = [
      'nextjs-portal',
      '[data-nextjs-toast]',
      '[data-nextjs-dialog]',
      '[data-nextjs-dialog-overlay]',
      '[aria-label="Open Next.js Dev Tools"]',
      '[aria-label="Next.js Dev Tools"]',
    ];

    const apply = (root: Document | ShadowRoot) => {
      if (root instanceof ShadowRoot && !root.querySelector('[data-tr-hide-next-devtools]')) {
        const style = document.createElement('style');
        style.setAttribute('data-tr-hide-next-devtools', 'true');
        style.textContent = shadowCss;
        root.appendChild(style);
      }

      for (const selector of selectors) {
        root.querySelectorAll<HTMLElement>(selector).forEach((element) => {
          element.style.setProperty('display', 'none', 'important');
          element.style.setProperty('visibility', 'hidden', 'important');
          element.style.setProperty('opacity', '0', 'important');
          element.style.setProperty('pointer-events', 'none', 'important');
        });
      }

      root.querySelectorAll<HTMLElement>('*').forEach((element) => {
        if (element.shadowRoot) {
          apply(element.shadowRoot);
        }
      });
    };

    apply(document);
  }, css);
}

function violationSummary(violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations']): string {
  return violations.map((violation) => {
    const nodes = violation.nodes.map((node) => node.target.join(' ')).join(', ');

    return `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help} -> ${nodes}`;
  }).join('\n');
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

function cssTimeListMaxMs(value: string): number {
  return Math.max(...value.split(',').map(cssTimeToMs).filter(Number.isFinite));
}

async function expectNoAxeViolations(page: Page) {
  await hideNextDevTools(page);
  const results = await new AxeBuilder({ page }).analyze();

  expect(results.violations, violationSummary(results.violations)).toEqual([]);
}

async function criticalSeriousAxeViolations(page: Page): Promise<AxeViolation[]> {
  await hideNextDevTools(page);
  const results = await new AxeBuilder({ page }).analyze();

  return results.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious');
}

async function expectVisibleFocus(page: Page, selector: string) {
  const target = page.locator(selector).first();
  await expect(target).toBeVisible();
  await target.focus();
  await expect(target).toBeFocused();
  const focusStyle = await target.evaluate((element) => {
    const style = window.getComputedStyle(element);

    return {
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
  const hasOutline = focusStyle.outlineStyle !== 'none' && Number.parseFloat(focusStyle.outlineWidth) >= 2;
  const hasLimeBorder = focusStyle.borderColor === 'rgb(182, 255, 60)';
  const hasLimeRing = focusStyle.boxShadow.includes('182, 255, 60') || focusStyle.boxShadow.includes('132, 204, 22');

  expect(hasOutline || hasLimeBorder || hasLimeRing).toBe(true);
}

async function expectTouchTargets(page: Page, selector: string) {
  const result = await page.locator(selector).evaluateAll((elements) => elements
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);

      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    })
    .map((element) => {
      const rect = element.getBoundingClientRect();

      return {
        height: rect.height,
        label: element.textContent?.trim() || element.getAttribute('aria-label') || element.tagName,
        width: rect.width,
      };
    })
    .filter((rect) => rect.width < 40 || rect.height < 40));

  expect(result).toEqual([]);
}

async function seedLeaderboardRows(label: string) {
  const schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
  const client = serviceClient(schema);
  const claudeProfile = await createTestProfile(await createTestUser(`a11y-${label}-claude`), schema);
  const codexProfile = await createTestProfile(await createTestUser(`a11y-${label}-codex`), schema);
  const today = new Date().toISOString().slice(0, 10);
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const timestamp = `${today}T10:00:00.000Z`;

  const { error: sessionError } = await client.from('sessions').insert([
    {
      profile_id: claudeProfile.id,
      source: 'claude',
      model: `a11y-${label}-claude-${suffix}`,
      session_id: `a11y-${label}-claude-${suffix}`,
      file_sha256: sha(`a11y-${label}-claude-${suffix}`),
      first_event_at: timestamp,
      last_event_at: timestamp,
      input_tokens: 12_500,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_create_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      turns: 2,
      ingestion_mode: 'script_verified',
    },
    {
      profile_id: codexProfile.id,
      source: 'codex',
      model: `a11y-${label}-codex-${suffix}`,
      session_id: `a11y-${label}-codex-${suffix}`,
      file_sha256: sha(`a11y-${label}-codex-${suffix}`),
      first_event_at: timestamp,
      last_event_at: timestamp,
      input_tokens: 42_500,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_create_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      turns: 3,
      ingestion_mode: 'script_verified',
    },
  ]);

  if (sessionError) {
    throw new Error(`[accessibility-e2e] Failed to seed leaderboard sessions: ${sessionError.message}`);
  }

  const { error: aggregateError } = await client.from('daily_aggregates').upsert([
    {
      profile_id: claudeProfile.id,
      date: today,
      source: 'claude',
      model: `a11y-${label}-claude-${suffix}`,
      total_tokens: 12_500,
      total_sessions: 2,
      derived_cost_usd: 0.125,
    },
    {
      profile_id: codexProfile.id,
      date: today,
      source: 'codex',
      model: `a11y-${label}-codex-${suffix}`,
      total_tokens: 42_500,
      total_sessions: 3,
      derived_cost_usd: 0.425,
    },
  ]);

  if (aggregateError) {
    throw new Error(`[accessibility-e2e] Failed to seed leaderboard rows: ${aggregateError.message}`);
  }

  await purgeApiCache();
  await clearNextFetchCache();
}

async function seedSampleHandleProfile(): Promise<string> {
  const schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
  const client = serviceClient(schema);
  const existing = await client
    .from('profiles')
    .select('id,handle')
    .eq('handle', 'sample-handle')
    .maybeSingle<{ id: string; handle: string }>();

  if (existing.error) {
    throw new Error(`[accessibility-e2e] Failed to check sample profile: ${existing.error.message}`);
  }

  let profile = existing.data;

  if (!profile) {
    const createdProfile = await createTestProfile(await createTestUser('qc7-sample'), schema);
    const update = await client
      .from('profiles')
      .update({
        handle: 'sample-handle',
        display_name: 'Sample Handle',
        avatar_url: null,
        bio: 'Sample profile used for accessibility verification.',
        x_handle: 'sample_handle',
        mode: 'script_verified',
        verified: true,
        share_projects: true,
      })
      .eq('id', createdProfile.id)
      .select('id,handle')
      .single<{ id: string; handle: string }>();

    if (update.error) {
      const duplicate = await client
        .from('profiles')
        .select('id,handle')
        .eq('handle', 'sample-handle')
        .maybeSingle<{ id: string; handle: string }>();

      if (duplicate.error || !duplicate.data) {
        throw new Error(`[accessibility-e2e] Failed to create sample profile: ${update.error.message}`);
      }

      profile = duplicate.data;
    } else {
      profile = update.data;
    }
  }

  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  const sessionId = `qc7-sample-${randomUUID()}`;
  const firstEventAt = new Date(now.getTime() - 60 * 60_000).toISOString();
  const lastEventAt = new Date(now.getTime() - 30 * 60_000).toISOString();

  const { error: sessionError } = await client.from('sessions').insert({
    profile_id: profile.id,
    source: 'claude',
    model: 'qc7-claude-sonnet',
    session_id: sessionId,
    file_sha256: sha(sessionId),
    first_event_at: firstEventAt,
    last_event_at: lastEventAt,
    input_tokens: 31_000,
    output_tokens: 4_500,
    cache_read_tokens: 2_000,
    cache_create_tokens: 500,
    cached_tokens: 0,
    reasoning_tokens: 1_250,
    turns: 8,
    ingestion_mode: 'script_verified',
  });

  if (sessionError) {
    throw new Error(`[accessibility-e2e] Failed to seed sample session: ${sessionError.message}`);
  }

  const { error: aggregateError } = await client.from('daily_aggregates').upsert({
    profile_id: profile.id,
    date: firstEventAt.slice(0, 10),
    source: 'claude',
    model: 'qc7-claude-sonnet',
    total_tokens: 39_250,
    total_sessions: 1,
    derived_cost_usd: 0.3925,
  }, {
    onConflict: 'profile_id,date,source,model',
  });

  if (aggregateError) {
    throw new Error(`[accessibility-e2e] Failed to seed sample aggregate: ${aggregateError.message}`);
  }

  await purgeApiCache();
  await clearNextFetchCache();

  return profile.handle;
}

async function writeAxeReport(testInfo: TestInfo, report: unknown) {
  const reportDir = path.join(repoRoot, 'test-results');
  await mkdir(reportDir, { recursive: true });
  await writeFile(
    path.join(reportDir, `qc-7-axe-report-${testInfo.project.name}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
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

  throw new Error(`[accessibility-e2e] profile shell was not created for user ${userId}`);
}

async function seedUsage(profileId: string) {
  const service = serviceClient();
  const sessions = [
    { label: 'app', source: 'claude', model: 'claude-3-5-sonnet', daysAgo: 1, tokens: 18_000, turns: 4, hour: 10 },
    { label: 'api', source: 'codex', model: 'gpt-5-codex', daysAgo: 2, tokens: 8_000, turns: 3, hour: 14 },
    { label: 'docs', source: 'claude', model: 'claude-3-5-sonnet', daysAgo: 12, tokens: 4_000, turns: 2, hour: 22 },
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
      throw new Error(`[accessibility-e2e] session insert failed: ${sessionError.message}`);
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
      throw new Error(`[accessibility-e2e] aggregate upsert failed: ${aggregateError.message}`);
    }
  }
}

async function createProfile(label: string, shareProjects = true): Promise<SeededProfile> {
  const schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
  const service = serviceClient(schema);
  const auth = authClient(schema);
  const email = uniqueEmail(`a11y-profile-${label}`);
  const handle = `ay_${label}_${randomUUID().replace(/-/g, '').slice(0, 8)}`.slice(0, 30).toLowerCase();

  const { data: userData, error: userError } = await service.auth.admin.createUser({
    email,
    password: testPassword,
    email_confirm: true,
    user_metadata: {
      test_schema: schema,
    },
  });

  if (userError || !userData.user) {
    throw new Error(`[accessibility-e2e] createUser failed: ${userError?.message ?? 'missing user'}`);
  }

  const profileShell = await waitForProfileShell(userData.user.id);
  const { data: profile, error: profileError } = await service
    .from('profiles')
    .update({
      handle,
      display_name: `Accessibility ${label}`,
      avatar_url: null,
      bio: 'Accessibility audit profile seeded with realistic usage.',
      x_handle: handle,
      mode: 'script_verified',
      verified: true,
      share_projects: shareProjects,
    })
    .eq('id', profileShell.id)
    .select('id,handle')
    .single();

  if (profileError || !profile) {
    throw new Error(`[accessibility-e2e] profile update failed: ${profileError?.message ?? 'missing profile'}`);
  }

  await seedUsage(profile.id);
  await seedAccessKey(profile.id);

  const { data: signIn, error: signInError } = await auth.auth.signInWithPassword({
    email,
    password: testPassword,
  });

  if (signInError || !signIn.session) {
    throw new Error(`[accessibility-e2e] signIn failed: ${signInError?.message ?? 'missing session'}`);
  }

  await purgeApiCache();
  await clearNextFetchCache();

  return {
    accessToken: signIn.session.access_token,
    handle: profile.handle,
    profileId: profile.id,
  };
}

async function seedAccessKey(profileId: string) {
  const service = serviceClient();
  const plaintext = `tr_script_${randomBytes(24).toString('base64url')}`;
  const { error } = await service.from('access_keys').insert({
    profile_id: profileId,
    key_sha256: sha(plaintext),
    key_prefix: plaintext.slice(0, 11),
    scope: 'script',
    label: 'accessibility e2e key',
  });

  if (error) {
    throw new Error(`[accessibility-e2e] access key insert failed: ${error.message}`);
  }
}

async function setOwnerCookie(context: BrowserContext, profile: SeededProfile) {
  await context.addCookies([{
    name: 'tr_at',
    value: profile.accessToken,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: false,
  }]);
}

async function addE2eOnboardingCookie(page: Page, handle: string) {
  await page.context().addCookies([{
    name: 'tr_e2e_onboarding',
    value: encodeURIComponent(JSON.stringify({
      userId: '00000000-0000-4000-8000-000000000009',
      email: uniqueEmail(handle),
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

test('QC-7 public pages have zero critical and serious axe violations', async ({ page }, testInfo) => {
  const handle = await seedSampleHandleProfile();
  await addE2eOnboardingCookie(page, uniqueHandle('qc7_onboarding'));

  const pages = [
    { name: 'homepage', path: '/' },
    { name: 'profile', path: `/u/${handle}` },
    { name: 'sign-up', path: '/auth/sign-up' },
    { name: 'onboarding', path: '/onboarding' },
  ];
  const report: Array<{
    name: string;
    path: string;
    criticalSerious: Array<{
      help: string;
      id: string;
      impact: string | null | undefined;
      targets: string[];
    }>;
  }> = [];

  for (const pageUnderTest of pages) {
    await page.goto(pageUnderTest.path, { waitUntil: 'networkidle' });

    const violations = await criticalSeriousAxeViolations(page);
    report.push({
      ...pageUnderTest,
      criticalSerious: violations.map((violation) => ({
        help: violation.help,
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.flatMap((node) => node.target.map((target) => (
          typeof target === 'string' ? target : JSON.stringify(target)
        ))),
      })),
    });
  }

  await writeAxeReport(testInfo, report);

  const failures = report.filter((entry) => entry.criticalSerious.length > 0);
  expect(failures).toEqual([]);
});

test('QC-7 reduced-motion request clamps active animations and transitions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await addE2eOnboardingCookie(page, uniqueHandle('qc7_motion'));
  await page.goto('/onboarding/waiting?mode=script', { waitUntil: 'networkidle' });

  const motionStyles = await page
    .locator('.animate-ping, .animate-pulse, .tr-live-dot-pulse, .tr-skeleton-shimmer')
    .evaluateAll((elements) => elements.map((element) => {
      const style = window.getComputedStyle(element);

      return {
        className: element.className.toString(),
        animationDuration: style.animationDuration,
        animationIterationCount: style.animationIterationCount,
        transitionDuration: style.transitionDuration,
      };
    }));

  expect(motionStyles.length).toBeGreaterThan(0);

  const activeMotion = motionStyles.filter((style) => {
    const animationDuration = cssTimeListMaxMs(style.animationDuration);
    const transitionDuration = cssTimeListMaxMs(style.transitionDuration);

    return animationDuration > 0.01
      || transitionDuration > 0.01
      || style.animationIterationCount === 'infinite';
  });

  expect(activeMotion).toEqual([]);
});

test('QC-7 Tab navigation exposes visible acid-lime focus state', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await hideNextDevTools(page);

  for (let tabIndex = 0; tabIndex < 5; tabIndex += 1) {
    await page.keyboard.press('Tab');

    if (await page.locator('#handle-search').evaluate((element) => element === document.activeElement)) {
      break;
    }
  }

  await expect(page.locator('#handle-search')).toBeFocused();

  const focusStyle = await page.locator('#handle-search').evaluate((activeElement) => {
    const style = window.getComputedStyle(activeElement);

    return {
      id: activeElement.id,
      outlineColor: style.outlineColor,
      outlineOffset: style.outlineOffset,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });

  expect(focusStyle).toEqual(expect.objectContaining({
    id: 'handle-search',
    outlineColor: 'rgb(182, 255, 60)',
    outlineOffset: '2px',
    outlineStyle: 'solid',
    outlineWidth: '2px',
  }));
});

test('homepage 24H state passes axe and exposes accessible leaderboard semantics', async ({ page }) => {
  await seedLeaderboardRows('home-default');
  await page.goto('/?period=24h&scope=all');

  await expect(page.getByRole('heading', { level: 1, name: 'Top builders by token usage' })).toBeVisible();
  await expect(page.locator('caption')).toContainText('Leaderboard ranking by token usage');
  await expect(page.getByRole('group', { name: /Verified|Self-reported/ }).first()).toBeVisible();
  await expect(page.locator('[data-testid="avatar-verification-pip"]').first()).toHaveAttribute('aria-hidden', 'true');
  await expectNoAxeViolations(page);
});

test('homepage filtered state passes axe with tab aria-selected values', async ({ page }) => {
  await seedLeaderboardRows('home-filtered');
  await page.goto('/?period=7d&scope=codex');

  await expect(page.getByRole('tablist', { name: 'Filter by period' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '7D' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Codex' })).toHaveAttribute('aria-selected', 'true');
  await expectNoAxeViolations(page);
});

test('homepage mobile viewport passes axe and keeps filter touch targets usable', async ({ page }) => {
  await seedLeaderboardRows('home-mobile');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?period=30d&scope=all');

  await expect(page.locator('#leaderboard-table')).toBeVisible();
  await expectTouchTargets(page, 'button[role="tab"]');
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectNoAxeViolations(page);
});

test('homepage keyboard focus ring remains visible on filter tabs', async ({ page }) => {
  await seedLeaderboardRows('home-focus');
  await page.goto('/');

  await expectVisibleFocus(page, 'button[role="tab"]:has-text("24H")');
  await expectNoAxeViolations(page);
});

test('public profile passes axe with all sections and avatar labels', async ({ page }) => {
  const profile = await createProfile('public', true);
  await page.goto(`/u/${profile.handle}?window=7d`, { waitUntil: 'networkidle' });

  await expect(page.locator('[data-section]')).toHaveCount(10);
  await expect(page.getByRole('group', { name: 'Verified via script' })).toBeVisible();
  await expect(page.locator('[data-testid="avatar-verification-pip"]')).toHaveAttribute('aria-hidden', 'true');
  await expectNoAxeViolations(page);
});

test('owner profile passes axe with owner controls visible', async ({ page, context }) => {
  const profile = await createProfile('owner', false);
  await setOwnerCookie(context, profile);
  await page.goto(`/u/${profile.handle}?window=30d`, { waitUntil: 'networkidle' });

  await expect(page.locator('main')).toHaveAttribute('data-profile-variant', 'owner_share_false');
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expectNoAxeViolations(page);
});

test('profile mobile viewport passes axe and keeps visible controls touch-friendly', async ({ page, context }) => {
  const profile = await createProfile('profile-mobile', true);
  await setOwnerCookie(context, profile);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/u/${profile.handle}?window=all`, { waitUntil: 'networkidle' });

  await expectTouchTargets(page, 'main a, main button');
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectNoAxeViolations(page);
});

test('profile window tabs pass axe and support roving keyboard focus', async ({ page }) => {
  const profile = await createProfile('tabs', true);
  await page.goto(`/u/${profile.handle}?window=7d`, { waitUntil: 'networkidle' });

  await page.getByRole('tab', { name: '7D' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '30D' })).toBeFocused();
  await expectNoAxeViolations(page);
});

test('sign-up page passes axe with labels, disabled submit, and focus-visible handle input', async ({ page }) => {
  await page.goto('/auth/sign-up');

  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Handle', { exact: true })).toBeVisible();
  await expect(page.getByTestId('auth-submit')).toBeDisabled();
  await expectVisibleFocus(page, '[data-testid="auth-field-handle"]');
  await expectNoAxeViolations(page);
});

test('sign-up validation state passes axe with inline handle status', async ({ page }) => {
  await page.goto('/auth/sign-up');
  await page.getByTestId('auth-field-handle').pressSequentially('admin');

  await expect(page.getByTestId('handle-availability')).toHaveText("× that handle's reserved");
  await expectNoAxeViolations(page);
});

test('sign-in validation state passes axe with anti-enumeration form error semantics', async ({ page }) => {
  await page.route('**/api/auth/sign-in', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'invalid_credentials', message: 'Invalid email or password' } }),
  }));
  await page.goto('/auth/sign-in');
  await page.getByTestId('auth-field-email').pressSequentially('builder@example.com');
  await page.getByTestId('auth-field-password').pressSequentially('Tr-valid-password-58!');
  await page.getByTestId('auth-submit').click();

  await expect(page.getByTestId('auth-form-error')).toHaveText('Invalid credentials');
  await expectNoAxeViolations(page);
});

test('password reset request page passes axe with success status feedback', async ({ page }) => {
  await page.route('**/api/auth/password-reset/request', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }));
  await page.goto('/auth/password-reset/request');
  await page.getByTestId('auth-field-email').pressSequentially('reset-a11y@example.com');
  await page.getByTestId('auth-submit').click();

  await expect(page.getByTestId('auth-form-success')).toContainText('If an account exists');
  await expectNoAxeViolations(page);
});

test('password reset confirm page passes axe with missing-token alert and valid-token form', async ({ page }) => {
  await page.goto('/auth/password-reset/confirm');
  await expect(page.getByTestId('missing-reset-token')).toHaveAttribute('role', 'alert');
  await expectNoAxeViolations(page);

  await page.goto('/auth/password-reset/confirm?token=valid-token');
  await expect(page.getByTestId('auth-field-new_password')).toBeVisible();
  await expectNoAxeViolations(page);
});

test('onboarding mode selection passes axe with two keyboard-focusable tabs', async ({ page }) => {
  await addE2eOnboardingCookie(page, uniqueHandle('onboarding'));
  await page.goto('/onboarding');

  await expect(page.getByRole('tablist', { name: 'Choose verification path' })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expectVisibleFocus(page, '[data-testid="onboarding-mode-script"]');
  await expectNoAxeViolations(page);
});

test('onboarding verified script setup passes axe with live region and modal controls', async ({ page }) => {
  await addE2eOnboardingCookie(page, uniqueHandle('script'));
  await page.goto('/onboarding/waiting?mode=script');

  await expect(page.getByTestId('onboarding-script-install')).toBeVisible();
  await expect(page.getByRole('status')).toBeVisible();
  await expect(page.getByTestId('access-key-modal')).toHaveAttribute('role', 'dialog');
  await expectNoAxeViolations(page);
});

test('onboarding self-reported setup passes axe with copy controls and mobile touch targets', async ({ page }) => {
  await addE2eOnboardingCookie(page, uniqueHandle('self'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/onboarding/waiting?mode=self_reported');

  await expect(page.getByTestId('onboarding-self-reported')).toBeVisible();
  await expectTouchTargets(page, 'main button');
  await expectNoAxeViolations(page);
});
