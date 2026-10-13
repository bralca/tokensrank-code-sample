import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';

import { createTestProfile, createTestUser } from '../fixtures/seed-data';
import { hideNextDevTools } from '../visual-helpers';

test.describe.configure({ mode: 'serial' });

const apiBaseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3000);
const webOrigin = `http://127.0.0.1:${webPort}`;
const webRoot = path.resolve(__dirname, '../..');

type Rgb = {
  r: number;
  g: number;
  b: number;
};

type AuditedElement = {
  backgroundColor: string;
  color: string;
  label: string;
  ratio: number;
};

function serviceClient(schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0') {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('[contrast-e2e] Missing Supabase environment variables');
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

function isoDaysAgo(daysAgo: number, hour = 12): string {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  date.setUTCHours(hour, 0, 0, 0);

  return date.toISOString();
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
    throw new Error('[contrast-e2e] Missing ADMIN_PURGE_TOKEN');
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
    throw new Error(`[contrast-e2e] Cache purge failed with ${response.status}`);
  }
}

async function expectNoColorContrastViolations(page: Page) {
  await hideNextDevTools(page);
  const results = await new AxeBuilder({ page })
    .include('body')
    .withRules(['color-contrast'])
    .analyze();

  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

function srgbToLinear(value: number): number {
  const channel = value / 255;

  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(foreground: Rgb, background: Rgb): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);

  return (lighter + 0.05) / (darker + 0.05);
}

function parseRgb(color: string): Rgb {
  const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/u);

  if (!match) {
    throw new Error(`[contrast-e2e] Unable to parse color: ${color}`);
  }

  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
  };
}

async function auditElementContrast(page: Page, selector: string, label: string): Promise<AuditedElement> {
  const computed = await page.locator(selector).first().evaluate((element, elementLabel) => {
    function isTransparent(color: string): boolean {
      return color === 'transparent' || color === 'rgba(0, 0, 0, 0)';
    }

    function effectiveBackgroundColor(node: Element): string {
      let current: Element | null = node;

      while (current) {
        const backgroundColor = window.getComputedStyle(current).backgroundColor;

        if (!isTransparent(backgroundColor)) {
          return backgroundColor;
        }

        current = current.parentElement;
      }

      return window.getComputedStyle(document.body).backgroundColor;
    }

    const style = window.getComputedStyle(element);

    return {
      backgroundColor: effectiveBackgroundColor(element),
      color: style.color,
      label: elementLabel,
    };
  }, label);
  const ratio = contrastRatio(parseRgb(computed.color), parseRgb(computed.backgroundColor));

  return {
    ...computed,
    ratio,
  };
}

async function expectElementContrast(
  page: Page,
  selector: string,
  label: string,
  minimumRatio: number,
): Promise<AuditedElement> {
  const result = await auditElementContrast(page, selector, label);

  expect(result.ratio, `${label}: ${result.color} on ${result.backgroundColor}`).toBeGreaterThanOrEqual(minimumRatio);

  return result;
}

async function seedUsage(profileId: string, label: string) {
  const client = serviceClient();
  const sessions = [
    { source: 'claude', model: `contrast-${label}-claude`, tokens: 24_000, daysAgo: 1, hour: 10 },
    { source: 'codex', model: `contrast-${label}-codex`, tokens: 11_500, daysAgo: 2, hour: 14 },
  ] as const;

  for (const session of sessions) {
    const firstEventAt = isoDaysAgo(session.daysAgo, session.hour);
    const lastEventAt = new Date(new Date(firstEventAt).getTime() + 20 * 60_000).toISOString();
    const sessionId = `${label}-${session.source}-${randomUUID()}`;

    const { error: sessionError } = await client.from('sessions').insert({
      profile_id: profileId,
      source: session.source,
      model: session.model,
      session_id: sessionId,
      file_sha256: sha(sessionId),
      first_event_at: firstEventAt,
      last_event_at: lastEventAt,
      input_tokens: session.tokens,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_create_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      turns: 3,
      ingestion_mode: 'script_verified',
    });

    if (sessionError) {
      throw new Error(`[contrast-e2e] Session seed failed: ${sessionError.message}`);
    }

    const { error: aggregateError } = await client.from('daily_aggregates').upsert({
      profile_id: profileId,
      date: firstEventAt.slice(0, 10),
      source: session.source,
      model: session.model,
      total_tokens: session.tokens,
      total_sessions: 1,
      derived_cost_usd: session.tokens * 0.00001,
    });

    if (aggregateError) {
      throw new Error(`[contrast-e2e] Aggregate seed failed: ${aggregateError.message}`);
    }
  }
}

async function seedProfile(label: string) {
  const schema = process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
  const profile = await createTestProfile(await createTestUser(`contrast-${label}`), schema);
  const client = serviceClient(schema);

  const { error } = await client
    .from('profiles')
    .update({
      bio: 'Contrast audit profile seeded with verified usage.',
      display_name: `Contrast ${label}`,
      share_projects: true,
      verified: true,
      x_handle: profile.handle,
    })
    .eq('id', profile.id);

  if (error) {
    throw new Error(`[contrast-e2e] Profile update failed: ${error.message}`);
  }

  await seedUsage(profile.id, label);
  await purgeApiCache();
  await clearNextFetchCache();

  return profile;
}

test('homepage has no WCAG color-contrast violations', async ({ page }) => {
  await seedProfile('homepage');
  await page.goto('/?period=24h&scope=all', { waitUntil: 'networkidle' });

  await expect(page.getByRole('heading', { level: 1, name: 'Top builders by token usage' })).toBeVisible();
  await expectNoColorContrastViolations(page);
});

test('profile page has no WCAG color-contrast violations', async ({ page }) => {
  const profile = await seedProfile('profile');
  await page.goto(`/u/${profile.handle}?window=7d`, { waitUntil: 'networkidle' });

  await expect(page.locator('[data-section]')).toHaveCount(10);
  await expectNoColorContrastViolations(page);
});

test('sign-up page has no WCAG color-contrast violations', async ({ page }) => {
  await page.goto('/auth/sign-up', { waitUntil: 'networkidle' });

  await expect(page.getByRole('heading', { level: 1, name: 'Claim your builder handle' })).toBeVisible();
  await expectNoColorContrastViolations(page);
});

test('leaderboard filtered state has no WCAG color-contrast violations', async ({ page }) => {
  await seedProfile('leaderboard');
  await page.goto('/?period=all&scope=all', { waitUntil: 'networkidle' });

  await expect(page.locator('#leaderboard-table')).toBeVisible();
  await expectNoColorContrastViolations(page);
});

test('key accent and neutral UI elements meet computed WCAG contrast ratios', async ({ page }) => {
  const profile = await seedProfile('computed');
  await page.goto('/?period=all&scope=all', { waitUntil: 'networkidle' });

  await expect(page.locator('[data-testid="avatar-verification-pip"]').first()).toBeVisible();
  const leaderboardAudit = [
    await expectElementContrast(page, '[data-testid="avatar-verification-pip"]', 'verified avatar pip', 3),
    await expectElementContrast(page, '#leaderboard-table th', 'table header neutral text', 4.5),
    await expectElementContrast(page, '#leaderboard-table tbody td', 'table body text', 4.5),
    await expectElementContrast(page, '#leaderboard-table tbody a[href^="/u/"] span span:last-child', 'leaderboard handle text', 4.5),
  ];

  await page.goto(`/u/${profile.handle}?window=7d`, { waitUntil: 'networkidle' });

  await expect(page.locator('[data-testid="profile-section-headline-pair"]')).toBeVisible();
  const profileAudit = [
    await expectElementContrast(page, '[data-testid="profile-section-headline-pair"] p:first-of-type', 'profile rank display', 3),
    await expectElementContrast(page, '[data-testid="profile-section-identity"] a', 'profile external link', 4.5),
  ];

  test.info().annotations.push({
    type: 'contrast-audit',
    description: JSON.stringify([...leaderboardAudit, ...profileAudit], null, 2),
  });
});
