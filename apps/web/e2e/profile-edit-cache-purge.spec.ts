import { randomUUID, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { expect, test, type BrowserContext } from '@playwright/test';

const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3000);
const webOrigin = `http://127.0.0.1:${webPort}`;
const webRoot = path.resolve(__dirname, '..');
const testPassword = 'Correct-horse-battery-staple-73!';

function loadRootEnv(): void {
  const envPath = path.resolve(__dirname, '../../../.env');

  if (!existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/u)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);

    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;

    if (key) {
      process.env[key] = rawValue.replace(/^['"]|['"]$/gu, '');
    }
  }
}

loadRootEnv();

type SeededProfile = {
  accessToken: string;
  handle: string;
  userId: string;
};

function schemaName(): string {
  return process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
}

function serviceClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('[profile-edit-e2e] Missing Supabase service env');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    db: { schema: schemaName() },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        'Accept-Profile': schemaName(),
        'Content-Profile': schemaName(),
      },
    },
  });
}

function authClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    throw new Error('[profile-edit-e2e] Missing Supabase auth env');
  }

  return createClient(supabaseUrl, anonKey, {
    db: { schema: schemaName() },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        'Accept-Profile': schemaName(),
        'Content-Profile': schemaName(),
      },
    },
  });
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isoDaysAgo(daysAgo: number): string {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  date.setUTCHours(12, 0, 0, 0);

  return date.toISOString();
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

  throw new Error(`[profile-edit-e2e] profile shell was not created for user ${userId}`);
}

async function seedUsage(profileId: string): Promise<void> {
  const service = serviceClient();
  const firstEventAt = isoDaysAgo(1);
  const { error: sessionError } = await service.from('sessions').insert({
    profile_id: profileId,
    source: 'codex',
    model: 'gpt-5-codex',
    session_id: `profile-edit-${randomUUID()}`,
    file_sha256: sha(`${profileId}-profile-edit`),
    first_event_at: firstEventAt,
    last_event_at: new Date(new Date(firstEventAt).getTime() + 20 * 60_000).toISOString(),
    input_tokens: 9000,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_create_tokens: 0,
    cached_tokens: 0,
    reasoning_tokens: 0,
    turns: 3,
    ingestion_mode: 'script_verified',
    fingerprint: {
      project_name: 'profile-edit',
    },
  });

  if (sessionError) {
    throw new Error(`[profile-edit-e2e] session insert failed: ${sessionError.message}`);
  }

  const { error: aggregateError } = await service.from('daily_aggregates').upsert({
    profile_id: profileId,
    date: firstEventAt.slice(0, 10),
    source: 'codex',
    model: 'gpt-5-codex',
    total_tokens: 9000,
    total_sessions: 1,
    derived_cost_usd: 0.09,
  });

  if (aggregateError) {
    throw new Error(`[profile-edit-e2e] aggregate upsert failed: ${aggregateError.message}`);
  }
}

async function clearNextFetchCache(): Promise<void> {
  await rm(path.join(webRoot, '.next/cache/fetch-cache'), {
    recursive: true,
    force: true,
  });
}

async function createProfile(): Promise<SeededProfile> {
  const service = serviceClient();
  const auth = authClient();
  const email = `profile-edit-${randomUUID()}@example.com`;
  const handle = `pe_${randomUUID().replace(/-/g, '').slice(0, 12)}`.toLowerCase();

  const { data: userData, error: userError } = await service.auth.admin.createUser({
    email,
    password: testPassword,
    email_confirm: true,
    user_metadata: {
      test_schema: schemaName(),
    },
  });

  if (userError || !userData.user) {
    throw new Error(`[profile-edit-e2e] createUser failed: ${userError?.message ?? 'missing user'}`);
  }

  const profileShell = await waitForProfileShell(userData.user.id);
  const { data: profile, error: profileError } = await service
    .from('profiles')
    .update({
      handle,
      display_name: 'Before Cache Purge',
      avatar_url: null,
      bio: 'Profile before cache purge.',
      x_handle: handle.slice(0, 15),
      mode: 'script_verified',
      verified: true,
      share_projects: true,
    })
    .eq('id', profileShell.id)
    .select('id,user_id,handle')
    .single();

  if (profileError || !profile) {
    throw new Error(`[profile-edit-e2e] profile update failed: ${profileError?.message ?? 'missing profile'}`);
  }

  await seedUsage(profile.id);

  const { data: signIn, error: signInError } = await auth.auth.signInWithPassword({
    email,
    password: testPassword,
  });

  if (signInError || !signIn.session) {
    throw new Error(`[profile-edit-e2e] sign-in failed: ${signInError?.message ?? 'missing session'}`);
  }

  await clearNextFetchCache();

  return {
    accessToken: signIn.session.access_token,
    handle: profile.handle,
    userId: profile.user_id,
  };
}

async function setAuthCookie(context: BrowserContext, profile: SeededProfile): Promise<void> {
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

test('profile edit purges profile cache and renders fresh public profile data', async ({ page, context, browser }) => {
  const profile = await createProfile();
  const updatedDisplayName = `After Cache Purge ${randomUUID().slice(0, 8)}`;
  await setAuthCookie(context, profile);

  await page.goto(`/u/${profile.handle}?window=all`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Before Cache Purge' })).toBeVisible();

  await page.goto('/me/settings', { waitUntil: 'networkidle' });
  await page.getByTestId('profile-display-name').fill(updatedDisplayName);
  await page.getByTestId('profile-bio').fill('Profile updated through the settings form.');
  await page.getByTestId('profile-submit').click();

  await expect(page).toHaveURL(new RegExp(`/u/${profile.handle}`));
  await expect(page.getByRole('heading', { name: updatedDisplayName })).toBeVisible();
  await expect(page.locator('[data-testid="profile-section-identity"]')).not.toContainText('Before Cache Purge');

  const publicContext = await browser.newContext({ baseURL: webOrigin });

  try {
    const publicPage = await publicContext.newPage();
    await publicPage.goto(`/u/${profile.handle}?window=all`, { waitUntil: 'networkidle' });
    await expect(publicPage.getByRole('heading', { name: updatedDisplayName })).toBeVisible();
    await expect(publicPage.locator('[data-testid="profile-section-identity"]')).not.toContainText('Before Cache Purge');
  } finally {
    await publicContext.close();
  }
});
