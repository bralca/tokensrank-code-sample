import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';
import type { BrowserContext, APIRequestContext } from '@playwright/test';

const testPassword = 'Correct-horse-battery-staple-95!';
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3000);
const webOrigin = `http://127.0.0.1:${webPort}`;
const apiPort = Number(process.env.PLAYWRIGHT_API_PORT ?? 4001);
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
const webRoot = path.resolve(__dirname, '../..');

type SeededOutcomeProfile = {
  accessToken: string;
  email: string;
  handle: string;
  password: string;
  profileId: string;
  userId: string;
};

function schemaName(): string {
  return process.env.SUPABASE_SCHEMA ?? 'tokensrank_test_w0';
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[profile-outcome-e2e] Missing required environment variable: ${name}`);
  }

  return value;
}

function serviceClient() {
  const schema = schemaName();

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

function authClient() {
  const schema = schemaName();

  return createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_ANON_KEY'),
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

function isoDaysAgo(daysAgo: number, hour: number): string {
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

  throw new Error(`[profile-outcome-e2e] profile shell was not created for user ${userId}`);
}

async function seedSessions(profileId: string): Promise<void> {
  const service = serviceClient();
  const sessions = [
    {
      label: 'checkout',
      source: 'claude',
      model: 'claude-3-5-sonnet',
      daysAgo: 1,
      hour: 9,
      tokens: 24_000,
      turns: 5,
    },
    {
      label: 'pricing',
      source: 'codex',
      model: 'gpt-5-codex',
      daysAgo: 2,
      hour: 14,
      tokens: 18_500,
      turns: 4,
    },
    {
      label: 'dashboard',
      source: 'claude',
      model: 'claude-3-5-sonnet',
      daysAgo: 11,
      hour: 20,
      tokens: 12_000,
      turns: 3,
    },
  ] as const;

  for (const session of sessions) {
    const firstEventAt = isoDaysAgo(session.daysAgo, session.hour);
    const lastEventAt = new Date(new Date(firstEventAt).getTime() + 25 * 60_000).toISOString();
    const sessionId = `outcome-${session.label}-${randomUUID()}`;

    const { error: sessionError } = await service.from('sessions').insert({
      profile_id: profileId,
      source: session.source,
      model: session.model,
      session_id: sessionId,
      file_sha256: sha(`${profileId}:${session.label}`),
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
      throw new Error(`[profile-outcome-e2e] session insert failed: ${sessionError.message}`);
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
      throw new Error(`[profile-outcome-e2e] aggregate upsert failed: ${aggregateError.message}`);
    }
  }
}

async function seedAccessKey(profileId: string): Promise<void> {
  const service = serviceClient();
  const plaintext = `tr_script_${randomBytes(24).toString('base64url')}`;
  const { error } = await service.from('access_keys').insert({
    profile_id: profileId,
    key_sha256: sha(plaintext),
    key_prefix: plaintext.slice(0, 11),
    scope: 'script',
    label: 'profile outcome key',
  });

  if (error) {
    throw new Error(`[profile-outcome-e2e] access key insert failed: ${error.message}`);
  }
}

async function seedIngestionRun(profileId: string): Promise<void> {
  const service = serviceClient();
  const startedAt = isoDaysAgo(1, 10);
  const { error } = await service.from('ingestion_runs').insert({
    profile_id: profileId,
    started_at: startedAt,
    finished_at: new Date(new Date(startedAt).getTime() + 35_000).toISOString(),
    status: 'completed',
    ingestion_mode: 'script_verified',
    session_count: 3,
    duplicate_count: 0,
    rejected_count: 0,
  });

  if (error) {
    throw new Error(`[profile-outcome-e2e] ingestion run insert failed: ${error.message}`);
  }
}

export async function clearNextFetchCache(): Promise<void> {
  await rm(path.join(webRoot, '.next/cache/fetch-cache'), {
    recursive: true,
    force: true,
  });
}

export async function purgeApiCache(request?: APIRequestContext): Promise<void> {
  const adminToken = readRequiredEnv('ADMIN_PURGE_TOKEN');

  if (request) {
    const response = await request.post(`${apiBaseUrl}/api/admin/cache/purge`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
        Origin: webOrigin,
      },
      data: { all: true },
    });

    if (!response.ok()) {
      throw new Error(`[profile-outcome-e2e] cache purge failed with ${response.status()}`);
    }

    return;
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
    throw new Error(`[profile-outcome-e2e] cache purge failed with ${response.status}`);
  }
}

export async function createOutcomeProfile(
  label: string,
  shareProjects: boolean,
  options: { xHandle?: string | null } = {},
): Promise<SeededOutcomeProfile> {
  const schema = schemaName();
  const service = serviceClient();
  const auth = authClient();
  const email = `profile-outcome-${label}-${randomUUID()}@example.com`;
  const handle = `po_${label}_${randomUUID().replace(/-/g, '').slice(0, 8)}`.slice(0, 30).toLowerCase();

  const { data: userData, error: userError } = await service.auth.admin.createUser({
    email,
    password: testPassword,
    email_confirm: true,
    user_metadata: {
      test_schema: schema,
    },
  });

  if (userError || !userData.user) {
    throw new Error(`[profile-outcome-e2e] createUser failed: ${userError?.message ?? 'missing user'}`);
  }

  const shell = await waitForProfileShell(userData.user.id);
  const { data: profile, error: profileError } = await service
    .from('profiles')
    .update({
      handle,
      display_name: `Profile Outcome ${label}`,
      avatar_url: null,
      bio: 'Profile seeded for share_projects outcome regression coverage.',
      x_handle: options.xHandle === undefined ? handle.slice(0, 15) : options.xHandle,
      mode: 'script_verified',
      verified: true,
      share_projects: shareProjects,
    })
    .eq('id', shell.id)
    .select('id,user_id,handle')
    .single<{ id: string; user_id: string; handle: string }>();

  if (profileError || !profile) {
    throw new Error(`[profile-outcome-e2e] profile update failed: ${profileError?.message ?? 'missing profile'}`);
  }

  await seedSessions(profile.id);
  await seedAccessKey(profile.id);
  await seedIngestionRun(profile.id);

  const { data: signIn, error: signInError } = await auth.auth.signInWithPassword({
    email,
    password: testPassword,
  });

  if (signInError || !signIn.session) {
    throw new Error(`[profile-outcome-e2e] sign-in failed: ${signInError?.message ?? 'missing session'}`);
  }

  await purgeApiCache();
  await clearNextFetchCache();

  return {
    accessToken: signIn.session.access_token,
    email,
    handle: profile.handle,
    password: testPassword,
    profileId: profile.id,
    userId: profile.user_id,
  };
}

export async function setOwnerCookie(context: BrowserContext, profile: SeededOutcomeProfile): Promise<void> {
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

export type { SeededOutcomeProfile };
