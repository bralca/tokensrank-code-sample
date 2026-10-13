import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';

const apiBaseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3000);
const webOrigin = `http://127.0.0.1:${webPort}`;
const webRoot = path.resolve(__dirname, '..');
const testPassword = 'Correct-horse-battery-staple-39!';
const PROFILE_SSR_P95_BUDGET_MS = Number.parseInt(process.env.PERF_PROFILE_SSR_P95_MS ?? '1000', 10);
const SAMPLE_COUNT = Number.parseInt(process.env.PERF_PROFILE_SSR_SAMPLES ?? '5', 10);

type SeededProfile = {
  handle: string;
  profileId: string;
  userId: string;
};

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[performance-profile-e2e] Missing required environment variable: ${name}`);
  }

  return value;
}

function schemaName(): string {
  return process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
}

function serviceClient(schema = schemaName()) {
  return createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      db: {
        schema,
      },
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

function authAdminClient() {
  return createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}

function percentile(values: number[], percentileValue: number): number {
  const sortedValues = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil((percentileValue / 100) * sortedValues.length) - 1,
  );

  return sortedValues[index] ?? 0;
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isoDaysAgo(daysAgo: number, hour = 12): string {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  date.setUTCHours(hour, 0, 0, 0);

  return date.toISOString();
}

async function waitForProfileShell(userId: string): Promise<{ id: string }> {
  const service = serviceClient();

  for (let attempt = 0; attempt < 10; attempt += 1) {
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

  throw new Error(`[performance-profile-e2e] profile shell was not created for user ${userId}`);
}

async function seedUsage(profileId: string): Promise<void> {
  const service = serviceClient();
  const sessions = Array.from({ length: 20 }, (_value, index) => {
    const source = index % 2 === 0 ? 'claude' : 'codex';
    return {
      source,
      model: source === 'claude' ? 'claude-3-5-sonnet' : 'gpt-5-codex',
      daysAgo: (index % 30) + 1,
      tokens: 1_250 + index * 50,
      turns: 2 + (index % 3),
      project: `perf-profile-${index % 5}`,
    };
  });

  for (const [index, session] of sessions.entries()) {
    const firstEventAt = isoDaysAgo(session.daysAgo, 8 + (index % 10));
    const lastEventAt = new Date(new Date(firstEventAt).getTime() + 15 * 60_000).toISOString();
    const sessionId = `profile-perf-${index}-${randomUUID()}`;
    const { error: sessionError } = await service.from('sessions').insert({
      profile_id: profileId,
      source: session.source,
      model: session.model,
      session_id: sessionId,
      file_sha256: sha(sessionId),
      first_event_at: firstEventAt,
      last_event_at: lastEventAt,
      input_tokens: session.tokens,
      output_tokens: 250,
      cache_read_tokens: 0,
      cache_create_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      turns: session.turns,
      ingestion_mode: 'script_verified',
      fingerprint: {
        project_name: session.project,
      },
    });

    if (sessionError) {
      throw new Error(`[performance-profile-e2e] session insert failed: ${sessionError.message}`);
    }

    const { error: aggregateError } = await service.from('daily_aggregates').upsert({
      profile_id: profileId,
      date: firstEventAt.slice(0, 10),
      source: session.source,
      model: session.model,
      total_tokens: session.tokens + 250,
      total_sessions: 1,
      derived_cost_usd: (session.tokens + 250) * 0.00001,
    });

    if (aggregateError) {
      throw new Error(`[performance-profile-e2e] aggregate upsert failed: ${aggregateError.message}`);
    }
  }
}

async function purgeApiCache(): Promise<void> {
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
    throw new Error(`[performance-profile-e2e] Cache purge failed with ${response.status}: ${await response.text()}`);
  }
}

async function clearNextFetchCache(): Promise<void> {
  await rm(path.join(webRoot, '.next/cache/fetch-cache'), {
    recursive: true,
    force: true,
  });
}

async function createProfile(label: string): Promise<SeededProfile> {
  const schema = schemaName();
  const service = serviceClient(schema);
  const auth = authAdminClient();
  const email = `profile-perf-${label}-${randomUUID()}@example.com`;
  const handle = `perfpf_${label}_${randomUUID().replace(/-/g, '').slice(0, 8)}`.slice(0, 30).toLowerCase();

  const { data: userData, error: userError } = await auth.auth.admin.createUser({
    email,
    password: testPassword,
    email_confirm: true,
    user_metadata: {
      test_schema: schema,
    },
  });

  if (userError || !userData.user) {
    throw new Error(`[performance-profile-e2e] createUser failed: ${userError?.message ?? 'missing user'}`);
  }

  const shell = await waitForProfileShell(userData.user.id);
  const { data: profile, error: profileError } = await service
    .from('profiles')
    .update({
      handle,
      display_name: `Performance ${label}`,
      avatar_url: null,
      bio: 'Profile seeded for SSR performance acceptance.',
      x_handle: handle,
      mode: 'script_verified',
      verified: true,
      share_projects: true,
    })
    .eq('id', shell.id)
    .select('id,user_id,handle')
    .single();

  if (profileError || !profile) {
    throw new Error(`[performance-profile-e2e] profile update failed: ${profileError?.message ?? 'missing profile'}`);
  }

  await seedUsage(profile.id);
  await purgeApiCache();
  await clearNextFetchCache();

  return {
    handle: profile.handle,
    profileId: profile.id,
    userId: profile.user_id,
  };
}

test.describe.configure({ mode: 'serial' });

test.describe('profile SSR performance', () => {
  let profile: SeededProfile;

  test.beforeAll(async () => {
    profile = await createProfile('ssr');
  });

  test.afterAll(async () => {
    if (profile?.userId) {
      await authAdminClient().auth.admin.deleteUser(profile.userId);
    }
  });

  test('renders cached profile pages under the p95 budget', async ({ page }) => {
    const pathName = `/u/${profile.handle}?window=all`;

    await page.goto(pathName, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('profile-section-identity')).toBeVisible();

    const latenciesMs: number[] = [];

    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const startedAt = performance.now();
      await page.goto(pathName, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('profile-section-identity')).toBeVisible();
      latenciesMs.push(performance.now() - startedAt);
    }

    const p95Ms = percentile(latenciesMs, 95);

    const apiResponse = await page.request.get(`${apiBaseUrl}/api/profile/${profile.handle}?window=all`);

    expect(apiResponse.status()).toBe(200);
    expect(apiResponse.headers()['x-tokensrank-cache']).toBe('HIT');
    expect(p95Ms, `profile SSR p95 ${p95Ms.toFixed(2)}ms exceeded ${PROFILE_SSR_P95_BUDGET_MS}ms`).toBeLessThan(PROFILE_SSR_P95_BUDGET_MS);
  });
});
