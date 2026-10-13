import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createServiceRoleClient, resolveTestSchema } from '../../../../test/integration/setup';
import { buildServer } from '../../../server';
import { adminClient } from '../../../clients/supabase';
import { createPostgresClient, quoteIdentifier } from '../../../lib/postgres';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const qs = quoteIdentifier(schema);
const createdUserIds = new Set<string>();
const originalFetch = globalThis.fetch.bind(globalThis);

// requireAuth → verifySessionToken → createDisposableAnonClient().auth.getUser.
// Stub it so any bearer resolves to our test user (no real Supabase session).
const mockState = vi.hoisted(() => ({
  getUser: null as null | (() => Promise<unknown>),
  githubRepos: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../clients/supabase', async (importActual) => {
  const actual = await importActual<typeof import('../../../clients/supabase')>();

  return {
    ...actual,
    createDisposableAnonClient: () => ({
      auth: {
        getUser: async () => {
          if (!mockState.getUser) {
            throw new Error('mockState.getUser not configured');
          }
          return mockState.getUser();
        },
      },
    }),
  };
});

let app: Awaited<ReturnType<typeof buildServer>>;
let profileId = '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Intercept only api.github.com; PostgREST (adminClient) must reach the network.
function installGithubFetchMock(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.startsWith('https://api.github.com/user/repos')) {
      return new Response(JSON.stringify(mockState.githubRepos), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.startsWith('https://api.github.com/repos/')) {
      // Commit list/detail for the on-connect backfill → nothing to ingest.
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }

    return originalFetch(input, init);
  });
}

async function mirrorTable(table: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const client = await createPostgresClient();
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS ${qs}.${table} (LIKE public.${table} INCLUDING ALL)`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${qs}.${table} TO anon, authenticated, service_role`);
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

// Poll the WRITE path the handler uses, so a freshly mirrored table is serve-ready
// (PostgREST serves reads a beat before writes after a NOTIFY reload).
async function waitForWriteReady(probe: () => Promise<{ error: unknown }>, table: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { error } = await probe();
    if (!error) {
      return;
    }
    await sleep(300);
  }

  throw new Error(`[github-repos-test] PostgREST did not pick up ${table} (write) in time`);
}

async function waitForTablesWritable(): Promise<void> {
  const sentinelProfile = '00000000-0000-0000-0000-0000000000fe';

  await waitForWriteReady(async () => {
    const { error } = await adminClient
      .from('connected_repos')
      .upsert({ profile_id: sentinelProfile, repo_id: -1, full_name: '__probe__', prod_branch: '__probe__' }, { onConflict: 'profile_id,repo_id' });
    if (!error) {
      await adminClient.from('connected_repos').delete().eq('profile_id', sentinelProfile);
    }
    return { error };
  }, 'connected_repos');

  await waitForWriteReady(async () => {
    const { error } = await adminClient
      .from('github_identities')
      .upsert({ profile_id: sentinelProfile, github_user_id: -1, login: '__probe__' }, { onConflict: 'profile_id' });
    if (!error) {
      await adminClient.from('github_identities').delete().eq('profile_id', sentinelProfile);
    }
    return { error };
  }, 'github_identities');
}

async function createAuthUserWithProfile(): Promise<string> {
  const authAdmin = createServiceRoleClient();
  const safeSchema = schema.replace(/[^a-z0-9]/g, '').slice(0, 14);
  const email = `ghrepos-${safeSchema}-${Math.random().toString(36).slice(2, 10)}@example.com`;

  const { data, error } = await authAdmin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { test_schema: schema },
  });

  if (error || !data.user) {
    throw new Error(`[github-repos-test] createUser failed: ${error?.message ?? 'no user'}`);
  }

  createdUserIds.add(data.user.id);

  // Wait for the on_auth_users_insert trigger to seed the profile shell.
  for (const delay of [0, 100, 200, 400, 800]) {
    if (delay) {
      await sleep(delay);
    }
    const { data: profile } = await adminClient
      .from('profiles')
      .select('id')
      .eq('user_id', data.user.id)
      .maybeSingle<{ id: string }>();

    if (profile) {
      return data.user.id;
    }
  }

  throw new Error('[github-repos-test] profile shell was not created');
}

async function insertIdentity(): Promise<void> {
  const { error } = await adminClient.from('github_identities').upsert({
    profile_id: profileId,
    github_user_id: Math.floor(Math.random() * 1_000_000_000) + 1,
    login: 'testlogin',
    verified_emails: [],
    provider_token: 'gho_test',
    followers: 0,
  }, { onConflict: 'profile_id' });

  if (error) {
    throw new Error(`[github-repos-test] identity insert failed: ${error.message}`);
  }
}

function authedGet(url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: 'Bearer test-token' } });
}

function authedPost(url: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: 'Bearer test-token', origin: 'http://localhost:3000' },
    payload: payload as Record<string, unknown>,
  });
}

async function readConnectedRepos() {
  const { data } = await adminClient
    .from('connected_repos')
    .select('repo_id,full_name,prod_branch,enabled')
    .eq('profile_id', profileId)
    .returns<Array<{ repo_id: number; full_name: string; prod_branch: string; enabled: boolean }>>();

  return data ?? [];
}

beforeAll(async () => {
  installGithubFetchMock();
  await mirrorTable('github_identities');
  await mirrorTable('connected_repos');
  await waitForTablesWritable();

  const userId = await createAuthUserWithProfile();
  mockState.getUser = async () => ({ data: { user: { id: userId, email: 'gh@example.com' } }, error: null });

  app = await buildServer();
  await app.ready();

  const { data: profile } = await adminClient
    .from('profiles')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle<{ id: string }>();
  profileId = profile?.id ?? '';

  await insertIdentity();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();

  const authAdmin = createServiceRoleClient();
  for (const userId of createdUserIds) {
    await authAdmin.auth.admin.deleteUser(userId);
  }
});

describe('GET /api/github/repos', () => {
  it('lists the user repos merged with connection state', async () => {
    mockState.githubRepos = [
      { id: 111, full_name: 'acme/web', private: false, default_branch: 'main', stargazers_count: 5 },
      { id: 222, full_name: 'acme/api', private: true, default_branch: 'release', stargazers_count: 0 },
    ];

    const res = await authedGet('/api/github/repos');

    expect(res.statusCode).toBe(200);
    const repos = res.json().data as Array<Record<string, unknown>>;
    expect(repos).toHaveLength(2);

    const web = repos.find((repo) => repo.full_name === 'acme/web');
    expect(web).toMatchObject({
      repo_id: 111,
      is_private: false,
      default_branch: 'main',
      stars: 5,
      connected: false,
      prod_branch: 'main', // defaults to default_branch when not yet connected
    });
  });
});

describe('POST /api/github/repos', () => {
  it('connects selected repos then disables de-selected ones', async () => {
    const connect = await authedPost('/api/github/repos', {
      repos: [
        { repo_id: 111, full_name: 'acme/web', prod_branch: 'main', is_private: false, stars: 5 },
        { repo_id: 222, full_name: 'acme/api', prod_branch: 'release', is_private: true, stars: 0 },
      ],
    });

    expect(connect.statusCode).toBe(200);
    expect(connect.json().data).toMatchObject({ connected: 2 });

    const afterConnect = await readConnectedRepos();
    expect(afterConnect.filter((repo) => repo.enabled)).toHaveLength(2);
    expect(afterConnect.find((repo) => repo.repo_id === 222)).toMatchObject({
      prod_branch: 'release',
      enabled: true,
    });

    // Re-submit with only one repo → the other is disabled (composite upsert + disable).
    const reselect = await authedPost('/api/github/repos', {
      repos: [{ repo_id: 111, full_name: 'acme/web', prod_branch: 'main', is_private: false, stars: 5 }],
    });

    expect(reselect.statusCode).toBe(200);
    expect(reselect.json().data).toMatchObject({ connected: 1, disabled: 1 });

    const afterReselect = await readConnectedRepos();
    expect(afterReselect.find((repo) => repo.repo_id === 111)?.enabled).toBe(true);
    expect(afterReselect.find((repo) => repo.repo_id === 222)?.enabled).toBe(false);
  });

  it('rejects an invalid selection with 400', async () => {
    const res = await authedPost('/api/github/repos', { repos: [{ full_name: 'acme/web' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'schema_invalid' } });
  });
});
