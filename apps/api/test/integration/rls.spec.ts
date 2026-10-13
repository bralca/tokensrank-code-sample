import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDisposableAnonClient, createServiceRoleClient, resolveTestSchema, setupTestSchema } from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../supabase/migrations/0012_enable_rls.sql',
);
const password = 'Rls-test-password-12345!';
const createdUserIds = new Set<string>();

const ownershipChecklist = [
  'IC-1: authenticated clients use real Supabase JWTs; service_role client bypass is verified without mocks',
  'IC-2: all 8 production tables have RLS enabled in the active schema',
  'IC-3: profile-owned rows resolve ownership through profiles.user_id = auth.uid()',
  'Blueprint 2.1 O-2: profiles are owner-updatable/deletable and publicly selectable only after handle+mode exist',
  'Blueprint 2.1 O-3: access_keys are owner-readable/insertable/deletable only',
  'Blueprint 2.1 O-4/O-5: sessions are owner-readable/insertable; daily_aggregates are read-only to clients',
  'Blueprint 2.1 O-9/O-10: badges/profile_badges are public-read and service_role-write for cron',
  'Blueprint 2.1 O-6/O-11: ingestion_runs are owner-readable/service_role-created; audit_events are service_role-readable only',
] as const;

type TestUser = {
  id: string;
  email: string;
  token: string;
  client: SupabaseClient;
  profileId: string;
  handle: string;
};

type SeededRows = {
  user1: TestUser;
  user2: TestUser;
  privateProfileId: string;
  accessKeyId: string;
  sessionId: string;
  ingestionRunId: string;
};

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[rls-test] Missing required environment variable: ${name}`);
  }

  return value;
}

function escapeLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function runPsql(sql: string): string {
  return execFileSync(
    'psql',
    [
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      `db.${readRequiredEnv('SUPABASE_PROJECT_ID')}.supabase.co`,
      '-p',
      '5432',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-X',
      '-q',
      '-A',
      '-t',
      '-F',
      '\t',
    ],
    {
      env: {
        ...process.env,
        PGPASSWORD: readRequiredEnv('SUPABASE_DB_PASSWORD'),
      },
      input: sql,
      encoding: 'utf8',
    },
  ).trim();
}

function applyRlsMigration(): void {
  runPsql(`
    SET tokensrank.target_schema = '${escapeLiteral(schema)}';
    \\i ${migrationPath}
    NOTIFY pgrst, 'reload schema';
  `);
}

function lines(sql: string): string[] {
  const output = runPsql(sql);
  return output ? output.split('\n') : [];
}

function schemaAdminClient() {
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

function authenticatedClient(token: string) {
  return createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_ANON_KEY'),
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
          Authorization: `Bearer ${token}`,
          'Accept-Profile': schema,
          'Content-Profile': schema,
        },
      },
    },
  );
}

async function waitForProfile(profileId: string): Promise<void> {
  const admin = schemaAdminClient();

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { data, error } = await admin
      .from('profiles')
      .select('id')
      .eq('id', profileId)
      .maybeSingle();

    if (!error && data) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const { error } = await admin
    .from('profiles')
    .upsert({
      id: profileId,
      user_id: profileId,
      handle: null,
      mode: null,
      verified: false,
    }, { onConflict: 'user_id' });

  if (error) {
    throw new Error(`[rls-test] Profile fallback insert failed: ${error.message}`);
  }
}

async function createTestUser(label: string, publicProfile = true): Promise<TestUser> {
  const admin = createServiceRoleClient();
  const safeSchema = schema.replace(/[^a-z0-9_]/g, '_');
  const email = `rls-${safeSchema}-${Date.now()}-${label}@example.com`;
  const handle = publicProfile ? `rls_${label}_${Date.now()}`.slice(0, 30) : null;

  const { data: createData, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      test_schema: schema,
    },
  });

  if (createError || !createData.user) {
    throw new Error(`[rls-test] createUser failed: ${createError?.message ?? 'no user'}`);
  }

  createdUserIds.add(createData.user.id);
  await waitForProfile(createData.user.id);

  const profileUpdate = {
    handle,
    mode: publicProfile ? 'script_verified' : null,
    verified: publicProfile,
  };
  const { error: profileError } = await schemaAdminClient()
    .from('profiles')
    .update(profileUpdate)
    .eq('id', createData.user.id);

  if (profileError) {
    throw new Error(`[rls-test] profile update failed: ${profileError.message}`);
  }

  const anon = createDisposableAnonClient(schema);
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !signInData.session) {
    throw new Error(`[rls-test] signIn failed: ${signInError?.message ?? 'no session'}`);
  }

  return {
    id: createData.user.id,
    email,
    token: signInData.session.access_token,
    client: authenticatedClient(signInData.session.access_token),
    profileId: createData.user.id,
    handle: handle ?? `private_${label}`,
  };
}

async function seedRows(): Promise<SeededRows> {
  const admin = schemaAdminClient();
  const user1 = await createTestUser('owner');
  const user2 = await createTestUser('other');
  const privateUser = await createTestUser('private', false);

  const { data: accessKey, error: accessKeyError } = await admin
    .from('access_keys')
    .insert({
      profile_id: user1.profileId,
      key_sha256: `sha-${Date.now()}`,
      key_prefix: 'tr_script_a',
      label: 'RLS owner key',
      scope: 'script',
    })
    .select('id')
    .single();

  if (accessKeyError || !accessKey) {
    throw new Error(`[rls-test] access key seed failed: ${accessKeyError?.message ?? 'no row'}`);
  }

  const { data: ingestionRun, error: runError } = await admin
    .from('ingestion_runs')
    .insert({
      profile_id: user1.profileId,
      status: 'processing',
      ingestion_mode: 'script_verified',
      session_count: 1,
    })
    .select('id')
    .single();

  if (runError || !ingestionRun) {
    throw new Error(`[rls-test] ingestion run seed failed: ${runError?.message ?? 'no row'}`);
  }

  const { data: session, error: sessionError } = await admin
    .from('sessions')
    .insert({
      profile_id: user1.profileId,
      source: 'claude',
      model: 'claude-test',
      session_id: `session-${Date.now()}`,
      file_sha256: `file-${Date.now()}`,
      first_event_at: new Date(Date.now() - 60_000).toISOString(),
      last_event_at: new Date().toISOString(),
      input_tokens: 10,
      output_tokens: 20,
      ingestion_mode: 'script_verified',
      ingestion_run_id: ingestionRun.id,
    })
    .select('id')
    .single();

  if (sessionError || !session) {
    throw new Error(`[rls-test] session seed failed: ${sessionError?.message ?? 'no row'}`);
  }

  const { error: aggregateError } = await admin
    .from('daily_aggregates')
    .upsert({
      profile_id: user1.profileId,
      date: new Date().toISOString().slice(0, 10),
      source: 'claude',
      model: 'claude-test',
      total_tokens: 30,
      total_sessions: 1,
    });

  if (aggregateError) {
    throw new Error(`[rls-test] aggregate seed failed: ${aggregateError.message}`);
  }

  const { error: badgeError } = await admin
    .from('badges')
    .upsert({
      slug: 'rls_test_badge',
      name: 'RLS Test Badge',
      description: 'Badge used by RLS tests.',
      icon_slug: 'test',
      criteria_json: { type: 'rls' },
      requires_verification: false,
      tier: 'standard',
    });

  if (badgeError) {
    throw new Error(`[rls-test] badge seed failed: ${badgeError.message}`);
  }

  const { error: profileBadgeError } = await admin
    .from('profile_badges')
    .upsert({
      profile_id: user1.profileId,
      badge_slug: 'rls_test_badge',
      evidence: { seeded: true },
    });

  if (profileBadgeError) {
    throw new Error(`[rls-test] profile badge seed failed: ${profileBadgeError.message}`);
  }

  const { error: auditError } = await admin
    .from('audit_events')
    .insert({
      profile_id: user1.profileId,
      event_type: 'rls.seeded',
      severity: 'info',
      payload: { seeded: true },
    });

  if (auditError) {
    throw new Error(`[rls-test] audit seed failed: ${auditError.message}`);
  }

  return {
    user1,
    user2,
    privateProfileId: privateUser.profileId,
    accessKeyId: accessKey.id as string,
    sessionId: session.id as string,
    ingestionRunId: ingestionRun.id as string,
  };
}

describe.sequential('Row-Level Security', () => {
  beforeEach(async () => {
    await setupTestSchema(schema);
    applyRlsMigration();
  });

  afterAll(async () => {
    const admin = createServiceRoleClient();

    for (const userId of createdUserIds) {
      await admin.auth.admin.deleteUser(userId);
    }
  });

  it('enables canonical policies on all 8 production tables', () => {
    expect(ownershipChecklist).toEqual([
      'IC-1: authenticated clients use real Supabase JWTs; service_role client bypass is verified without mocks',
      'IC-2: all 8 production tables have RLS enabled in the active schema',
      'IC-3: profile-owned rows resolve ownership through profiles.user_id = auth.uid()',
      'Blueprint 2.1 O-2: profiles are owner-updatable/deletable and publicly selectable only after handle+mode exist',
      'Blueprint 2.1 O-3: access_keys are owner-readable/insertable/deletable only',
      'Blueprint 2.1 O-4/O-5: sessions are owner-readable/insertable; daily_aggregates are read-only to clients',
      'Blueprint 2.1 O-9/O-10: badges/profile_badges are public-read and service_role-write for cron',
      'Blueprint 2.1 O-6/O-11: ingestion_runs are owner-readable/service_role-created; audit_events are service_role-readable only',
    ]);

    expect(lines(`
      SELECT relname || ':' || relrowsecurity::text
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${escapeLiteral(schema)}'
        AND c.relkind = 'r'
        AND c.relname IN (
          'profiles',
          'access_keys',
          'sessions',
          'daily_aggregates',
          'badges',
          'profile_badges',
          'ingestion_runs',
          'audit_events'
        )
      ORDER BY relname;
    `)).toEqual([
      'access_keys:true',
      'audit_events:true',
      'badges:true',
      'daily_aggregates:true',
      'ingestion_runs:true',
      'profile_badges:true',
      'profiles:true',
      'sessions:true',
    ]);

    expect(lines(`
      SELECT tablename || ':' || policyname || ':' || cmd
      FROM pg_policies
      WHERE schemaname = '${escapeLiteral(schema)}'
        AND tablename IN (
          'profiles',
          'access_keys',
          'sessions',
          'daily_aggregates',
          'badges',
          'profile_badges',
          'ingestion_runs',
          'audit_events'
        )
      ORDER BY tablename, policyname;
    `)).toEqual([
      'access_keys:access_keys_delete_own:DELETE',
      'access_keys:access_keys_insert_own:INSERT',
      'access_keys:access_keys_select_own:SELECT',
      'audit_events:audit_events_select_service_role:SELECT',
      'badges:badges_insert_service_role:INSERT',
      'badges:badges_public_read:SELECT',
      'badges:badges_update_service_role:UPDATE',
      'daily_aggregates:daily_aggregates_select_own_or_public:SELECT',
      'ingestion_runs:ingestion_runs_insert_service_role:INSERT',
      'ingestion_runs:ingestion_runs_select_own:SELECT',
      'profile_badges:profile_badges_insert_service_role:INSERT',
      'profile_badges:profile_badges_public_read:SELECT',
      'profile_badges:profile_badges_update_service_role:UPDATE',
      'profiles:profiles_delete_own:DELETE',
      'profiles:profiles_select_public:SELECT',
      'profiles:profiles_update_own:UPDATE',
      'sessions:sessions_insert_own:INSERT',
      'sessions:sessions_select_own:SELECT',
    ]);
  });

  it('allows owners to read and write only the tables with owner policies', async () => {
    const seeded = await seedRows();

    const { data: profileRows, error: profileError } = await seeded.user1.client
      .from('profiles')
      .select('id')
      .eq('id', seeded.user1.profileId);
    expect(profileError).toBeNull();
    expect(profileRows).toHaveLength(1);

    const { data: keyRows, error: keyError } = await seeded.user1.client
      .from('access_keys')
      .select('id')
      .eq('id', seeded.accessKeyId);
    expect(keyError).toBeNull();
    expect(keyRows).toHaveLength(1);

    const { data: insertedKey, error: insertKeyError } = await seeded.user1.client
      .from('access_keys')
      .insert({
        profile_id: seeded.user1.profileId,
        key_sha256: `owner-insert-${Date.now()}`,
        key_prefix: 'tr_script_b',
        label: 'owner inserted',
        scope: 'script',
      })
      .select('id');
    expect(insertKeyError).toBeNull();
    expect(insertedKey).toHaveLength(1);

    const { data: insertedSession, error: insertSessionError } = await seeded.user1.client
      .from('sessions')
      .insert({
        profile_id: seeded.user1.profileId,
        source: 'codex',
        model: 'codex-test',
        session_id: `owner-session-${Date.now()}`,
        file_sha256: `owner-file-${Date.now()}`,
        first_event_at: new Date(Date.now() - 60_000).toISOString(),
        last_event_at: new Date().toISOString(),
        input_tokens: 3,
        output_tokens: 4,
        ingestion_mode: 'script_verified',
      })
      .select('id');
    expect(insertSessionError).toBeNull();
    expect(insertedSession).toHaveLength(1);

    const { data: sessionRows, error: sessionError } = await seeded.user1.client
      .from('sessions')
      .select('id')
      .eq('id', seeded.sessionId);
    expect(sessionError).toBeNull();
    expect(sessionRows).toHaveLength(1);

    const { data: aggregateRows, error: aggregateError } = await seeded.user1.client
      .from('daily_aggregates')
      .select('profile_id')
      .eq('profile_id', seeded.user1.profileId);
    expect(aggregateError).toBeNull();
    expect(aggregateRows?.length).toBeGreaterThan(0);
  });

  it('blocks cross-user reads and deletes for owner-scoped resources', async () => {
    const seeded = await seedRows();

    const { data: privateProfiles, error: privateProfileError } = await seeded.user2.client
      .from('profiles')
      .select('id')
      .eq('id', seeded.privateProfileId);
    expect(privateProfileError).toBeNull();
    expect(privateProfiles).toHaveLength(0);

    const { data: keyRows, error: keyReadError } = await seeded.user2.client
      .from('access_keys')
      .select('id')
      .eq('id', seeded.accessKeyId);
    expect(keyReadError).toBeNull();
    expect(keyRows).toHaveLength(0);

    const { data: deletedKeys, error: keyDeleteError } = await seeded.user2.client
      .from('access_keys')
      .delete()
      .eq('id', seeded.accessKeyId)
      .select('id');
    expect(keyDeleteError).toBeNull();
    expect(deletedKeys).toHaveLength(0);

    const { data: sessionRows, error: sessionReadError } = await seeded.user2.client
      .from('sessions')
      .select('id')
      .eq('id', seeded.sessionId);
    expect(sessionReadError).toBeNull();
    expect(sessionRows).toHaveLength(0);

    const { data: deletedSessions, error: sessionDeleteError } = await seeded.user2.client
      .from('sessions')
      .delete()
      .eq('id', seeded.sessionId)
      .select('id');
    expect(sessionDeleteError).toBeNull();
    expect(deletedSessions).toHaveLength(0);

    const { data: runRows, error: runReadError } = await seeded.user2.client
      .from('ingestion_runs')
      .select('id')
      .eq('id', seeded.ingestionRunId);
    expect(runReadError).toBeNull();
    expect(runRows).toHaveLength(0);

    const { data: auditRows, error: auditReadError } = await seeded.user2.client
      .from('audit_events')
      .select('id')
      .eq('profile_id', seeded.user1.profileId);
    expect(auditReadError).toBeNull();
    expect(auditRows).toHaveLength(0);
  });

  it('allows service_role bypass and cron-owned writes', async () => {
    const seeded = await seedRows();
    const admin = schemaAdminClient();

    const { data: keyRows, error: keyError } = await admin
      .from('access_keys')
      .select('id')
      .eq('id', seeded.accessKeyId);
    expect(keyError).toBeNull();
    expect(keyRows).toHaveLength(1);

    const { data: sessionRows, error: sessionError } = await admin
      .from('sessions')
      .select('id')
      .eq('id', seeded.sessionId);
    expect(sessionError).toBeNull();
    expect(sessionRows).toHaveLength(1);

    const { data: auditRows, error: auditError } = await admin
      .from('audit_events')
      .select('id')
      .eq('profile_id', seeded.user1.profileId);
    expect(auditError).toBeNull();
    expect(auditRows?.length).toBeGreaterThan(0);

    const { data: insertedBadge, error: insertBadgeError } = await admin
      .from('badges')
      .insert({
        slug: 'rls_cron_badge',
        name: 'RLS Cron Badge',
        description: 'Badge inserted by service_role RLS test.',
        icon_slug: 'cron',
        criteria_json: { type: 'cron' },
        requires_verification: false,
        tier: 'standard',
      })
      .select('slug');
    expect(insertBadgeError).toBeNull();
    expect(insertedBadge).toHaveLength(1);

    const { data: insertedProfileBadge, error: insertProfileBadgeError } = await admin
      .from('profile_badges')
      .insert({
        profile_id: seeded.user1.profileId,
        badge_slug: 'rls_cron_badge',
        evidence: { cron: true },
      })
      .select('profile_id, badge_slug');
    expect(insertProfileBadgeError).toBeNull();
    expect(insertedProfileBadge).toHaveLength(1);

    const { data: insertedRun, error: insertRunError } = await admin
      .from('ingestion_runs')
      .insert({
        profile_id: seeded.user2.profileId,
        status: 'processing',
        ingestion_mode: 'script_verified',
      })
      .select('id');
    expect(insertRunError).toBeNull();
    expect(insertedRun).toHaveLength(1);
  });
});
