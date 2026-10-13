import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createServiceRoleClient, resolveTestSchema } from '../../../../test/integration/setup';
import { buildServer } from '../../../server';
import { adminClient } from '../../../clients/supabase';
import { createPostgresClient, quoteIdentifier } from '../../../lib/postgres';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const qs = quoteIdentifier(schema);
const createdUserIds = new Set<string>();
const postgrestRetryDelaysMs = [150, 300, 600] as const;

// Per-test override for the Supabase anon client's getUser — there is no real
// GitHub session token in CI, so we stand in for Supabase's token verification.
const mockState = vi.hoisted(() => ({
  getUser: null as null | ((token: string) => Promise<unknown>),
}));

vi.mock('../../../clients/supabase', async (importActual) => {
  const actual = await importActual<typeof import('../../../clients/supabase')>();

  return {
    ...actual,
    // adminClient stays real (writes hit the test schema); only the disposable
    // anon client used for token verification is stubbed.
    createDisposableAnonClient: () => ({
      auth: {
        getUser: async (token: string) => {
          if (!mockState.getUser) {
            throw new Error('mockState.getUser not configured for this test');
          }
          return mockState.getUser(token);
        },
      },
    }),
  };
});

let app: Awaited<ReturnType<typeof buildServer>>;
// Profiles created directly in the test schema by the self-heal path (no auth
// user to cascade-clean), tracked so afterAll can remove them.
const selfHealedProfileIds = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isTransientSchemaCacheError(message: string): boolean {
  const normalized = message.toLowerCase();

  return normalized.includes('schema cache')
    || normalized.includes('could not find the table')
    || normalized.includes('pgrst205')
    || normalized.includes('pgrst106');
}

async function withSchemaRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= postgrestRetryDelaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (!isTransientSchemaCacheError(message) || attempt === postgrestRetryDelaysMs.length) {
        throw error;
      }

      lastError = error;
      await sleep(postgrestRetryDelaysMs[attempt] ?? 0);
    }
  }

  throw lastError;
}

async function createGithubAuthUser(): Promise<{ userId: string }> {
  const authAdmin = createServiceRoleClient();
  const safeSchema = schema.replace(/[^a-z0-9]/g, '').slice(0, 14);
  const email = `gh-${safeSchema}-${Math.random().toString(36).slice(2, 10)}@example.com`;

  const { data, error } = await authAdmin.auth.admin.createUser({
    email,
    email_confirm: true,
    // Mirrors sign-up's options.data.test_schema so the on_auth_users_insert
    // trigger seeds the profile shell into the test schema (not public).
    user_metadata: { test_schema: schema },
  });

  if (error || !data.user) {
    throw new Error(`[github-test] createUser failed: ${error?.message ?? 'no user'}`);
  }

  createdUserIds.add(data.user.id);

  return { userId: data.user.id };
}

function postSession(payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/github/session',
    headers: { origin: 'http://localhost:3000' },
    payload: payload as Record<string, unknown>,
  });
}

async function readIdentity(profileId: string) {
  return await withSchemaRetry(async () => {
    const { data, error } = await adminClient
      .from('github_identities')
      .select('profile_id,github_user_id,login,verified_emails,provider_token,followers')
      .eq('profile_id', profileId)
      .maybeSingle();

    if (error) {
      throw new Error(`[github-test] identity lookup failed: ${error.message}`);
    }

    return data;
  });
}

// reset_test_schema predates migration 0022, so the test schema lacks
// github_identities. Mirror it from public (structure only — LIKE never copies
// FKs) and reload the PostgREST cache, matching the ranking-pipeline spec.
async function mirrorGithubIdentities(): Promise<void> {
  if (schema === 'public') {
    return;
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const client = await createPostgresClient();
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS ${qs}.github_identities (LIKE public.github_identities INCLUDING ALL)`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${qs}.github_identities TO anon, authenticated, service_role`);
      await client.query("NOTIFY pgrst, 'reload schema'");
      return;
    } catch (error) {
      lastError = error;
      if (!/tuple concurrently updated/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
      await sleep(150 * (attempt + 1));
    } finally {
      await client.end();
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// Probe the WRITE path (the op the handler performs), not just read visibility —
// PostgREST can answer a HEAD count a beat before it serves an upsert on a freshly
// mirrored table, which would silently soft-fail the handler's first insert.
async function waitForGithubIdentities(): Promise<void> {
  if (schema === 'public') {
    return;
  }

  const sentinelProfile = '00000000-0000-0000-0000-0000000000ff';

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { error } = await adminClient
      .from('github_identities')
      .upsert({ profile_id: sentinelProfile, github_user_id: -1, login: '__probe__' }, { onConflict: 'profile_id' });

    if (!error) {
      await adminClient.from('github_identities').delete().eq('profile_id', sentinelProfile);
      return;
    }
    await sleep(300);
  }

  throw new Error('[github-test] PostgREST did not pick up github_identities (write) in time');
}

beforeAll(async () => {
  await mirrorGithubIdentities();
  await waitForGithubIdentities();
  app = await buildServer();
  await app.ready();
});

afterEach(() => {
  mockState.getUser = null;
});

afterAll(async () => {
  await app?.close();

  const authAdmin = createServiceRoleClient();

  // Deleting the auth user cascades to profiles → github_identities (FK ON DELETE CASCADE).
  for (const userId of createdUserIds) {
    await authAdmin.auth.admin.deleteUser(userId);
  }

  // Self-healed profiles were created directly in the mirrored schema (no FK to
  // auth.users), so clean them explicitly.
  for (const profileId of selfHealedProfileIds) {
    await adminClient.from('github_identities').delete().eq('profile_id', profileId);
    await adminClient.from('profiles').delete().eq('id', profileId);
  }
});

describe('POST /api/auth/github/session', () => {
  it('returns 400 invalid_session when tokens are missing', async () => {
    const response = await postSession({});

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_session' } });
  });

  it('returns 401 invalid_session when the token fails verification', async () => {
    mockState.getUser = async () => ({ data: { user: null }, error: { message: 'invalid token' } });

    const response = await postSession({ access_token: 'bad', refresh_token: 'bad' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_session' } });
  });

  it('persists the github identity, seeds the handle, sets cookies, and is idempotent', async () => {
    const { userId } = await createGithubAuthUser();
    const githubUserId = Math.floor(Math.random() * 1_000_000_000) + 1;
    const login = `ghuser${Math.random().toString(36).slice(2, 8)}`;
    const email = `verified-${Math.random().toString(36).slice(2, 8)}@example.com`;

    mockState.getUser = async () => ({
      data: {
        user: {
          id: userId,
          email,
          user_metadata: { provider_id: String(githubUserId), user_name: login, followers: 7 },
        },
      },
      error: null,
    });

    const response = await postSession({
      access_token: 'real-looking-access',
      refresh_token: 'real-looking-refresh',
      provider_token: 'gho_devtoken',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.handle).toBe(login);

    // Session cookies set with the same scheme as the email/password flow.
    const setCookie = response.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
    expect(cookies).toEqual(expect.arrayContaining([
      expect.stringContaining('tr_at='),
      expect.stringContaining('tr_rt='),
    ]));
    expect(cookies.join('\n')).toContain('HttpOnly');

    const profileId: string = body.data.profile_id;
    const identity = await readIdentity(profileId);
    expect(identity).toMatchObject({
      profile_id: profileId,
      github_user_id: githubUserId,
      login,
      provider_token: 'gho_devtoken',
      followers: 7,
    });
    expect(identity?.verified_emails).toContain(email);

    // Re-auth with a renamed login + rotated token → upsert updates the single row.
    const renamedLogin = `${login}x`;
    mockState.getUser = async () => ({
      data: {
        user: {
          id: userId,
          email,
          user_metadata: { provider_id: String(githubUserId), user_name: renamedLogin, followers: 9 },
        },
      },
      error: null,
    });

    const second = await postSession({
      access_token: 'real-looking-access-2',
      refresh_token: 'real-looking-refresh-2',
      provider_token: 'gho_rotated',
    });

    expect(second.statusCode).toBe(200);

    const updated = await readIdentity(profileId);
    expect(updated).toMatchObject({
      github_user_id: githubUserId,
      login: renamedLogin,
      provider_token: 'gho_rotated',
      followers: 9,
    });
  });

  it('self-heals: creates the profile shell in this schema when the trigger seeded a different one', async () => {
    // A real OAuth login carries no test_schema metadata, so the trigger seeds the
    // shell into public — not this test schema. Simulate that by pointing getUser at
    // a user_id that has no profile here; the handler must create one.
    const userId = crypto.randomUUID();
    const githubUserId = Math.floor(Math.random() * 1_000_000_000) + 1;
    const login = `selfheal${Math.random().toString(36).slice(2, 8)}`;

    mockState.getUser = async () => ({
      data: {
        user: {
          id: userId,
          email: `${login}@example.com`,
          user_metadata: { provider_id: String(githubUserId), user_name: login },
        },
      },
      error: null,
    });

    const response = await postSession({
      access_token: 'real-looking-access',
      refresh_token: 'real-looking-refresh',
      provider_token: 'gho_selfheal',
    });

    expect(response.statusCode).toBe(200);
    const profileId: string = response.json().data.profile_id;
    selfHealedProfileIds.add(profileId);

    const { data: profile } = await adminClient
      .from('profiles')
      .select('id,user_id,handle')
      .eq('user_id', userId)
      .maybeSingle<{ id: string; user_id: string; handle: string | null }>();

    expect(profile?.id).toBe(profileId);
    expect(profile?.handle).toBe(login.toLowerCase());

    // The identity still persists against the freshly-created shell.
    const identity = await readIdentity(profileId);
    expect(identity).toMatchObject({ github_user_id: githubUserId, login });
  });
});
