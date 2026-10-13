import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveTestSchema, setupTestSchema } from './setup';

// Task ordering: 0010 wipes legacy badges, seeds the canonical catalog, and
// drops redundant policies so Task 6.0 can create authoritative RLS.

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const isPublicSchema = schema === 'public';
const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../supabase/migrations/0010_reconcile_to_spec.sql',
);

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[reconcile-test] Missing required environment variable: ${name}`);
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

function applyMigration(): void {
  runPsql(`
    SET tokensrank.target_schema = '${escapeLiteral(schema)}';
    \\i ${migrationPath}
  `);
}

function rows(sql: string): string[] {
  const output = runPsql(sql);
  return output ? output.split('\n') : [];
}

function cleanupPublicRows(): void {
  if (!isPublicSchema) {
    return;
  }

  runPsql(`
    DELETE FROM public.sessions
    WHERE profile_id::text LIKE '10000000-0000-0000-0000-0000000001%';

    DELETE FROM public.ingestion_runs
    WHERE profile_id::text LIKE '10000000-0000-0000-0000-0000000001%';

    DELETE FROM public.profile_badges
    WHERE profile_id::text LIKE '10000000-0000-0000-0000-0000000001%';

    DELETE FROM public.audit_events
    WHERE profile_id::text LIKE '10000000-0000-0000-0000-0000000001%'
       OR event_type IN ('legacy.error', 'new.error');

    DELETE FROM public.profiles
    WHERE id::text LIKE '10000000-0000-0000-0000-0000000001%';

    DELETE FROM auth.users
    WHERE id::text LIKE '10000000-0000-0000-0000-0000000001%';

    DELETE FROM public.badges
    WHERE slug = 'verified';
  `);
}

function seedPublicAuthUsers(): void {
  if (!isPublicSchema) {
    return;
  }

  runPsql(`
    INSERT INTO auth.users (
      id,
      aud,
      role,
      email,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at
    )
    VALUES
      ('10000000-0000-0000-0000-000000000101', 'authenticated', 'authenticated', 'reconcile-101@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
      ('10000000-0000-0000-0000-000000000102', 'authenticated', 'authenticated', 'reconcile-102@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
      ('10000000-0000-0000-0000-000000000103', 'authenticated', 'authenticated', 'reconcile-103@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
      ('10000000-0000-0000-0000-000000000104', 'authenticated', 'authenticated', 'reconcile-104@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
      ('10000000-0000-0000-0000-000000000105', 'authenticated', 'authenticated', 'reconcile-105@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
      ('10000000-0000-0000-0000-000000000106', 'authenticated', 'authenticated', 'reconcile-106@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
      ('10000000-0000-0000-0000-000000000107', 'authenticated', 'authenticated', 'reconcile-107@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
      ('10000000-0000-0000-0000-000000000108', 'authenticated', 'authenticated', 'reconcile-108@example.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
      ('10000000-0000-0000-0000-000000000109', 'authenticated', 'authenticated', 'reconcile-109@example.test', '{}'::jsonb, '{}'::jsonb, now(), now())
    ON CONFLICT (id) DO NOTHING;

    DELETE FROM public.profiles
    WHERE id::text LIKE '10000000-0000-0000-0000-0000000001%';
  `);
}

describe.sequential('0010_reconcile_to_spec migration', () => {
  beforeEach(async () => {
    if (isPublicSchema) {
      cleanupPublicRows();
      seedPublicAuthUsers();
      runPsql('ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_mode_check;');
      return;
    }

    await setupTestSchema(schema);
    runPsql(`ALTER TABLE ${schema}.profiles DROP CONSTRAINT IF EXISTS profiles_mode_check;`);
  });

  afterEach(() => {
    cleanupPublicRows();

    if (isPublicSchema) {
      applyMigration();
    }
  });

  it('coerces legacy profile modes to canonical values', () => {
    runPsql(`
      INSERT INTO ${schema}.profiles (id, user_id, handle, mode, verified)
      VALUES
        ('10000000-0000-0000-0000-000000000101', '10000000-0000-0000-0000-000000000101', 'modea', 'A', false),
        ('10000000-0000-0000-0000-000000000102', '10000000-0000-0000-0000-000000000102', 'modeb', 'B', false),
        ('10000000-0000-0000-0000-000000000103', '10000000-0000-0000-0000-000000000103', 'modenull', NULL, false);
    `);

    applyMigration();

    expect(rows(`
      SELECT COALESCE(mode, '<NULL>') || ':' || COUNT(*)
      FROM ${schema}.profiles
      WHERE id::text LIKE '10000000-0000-0000-0000-0000000001%'
      GROUP BY mode
      ORDER BY COALESCE(mode, '<NULL>');
    `)).toEqual(['<NULL>:1', 'script_verified:1', 'self_reported:1']);
  });

  it('rejects legacy profile mode values after migration', () => {
    applyMigration();

    expect(() => runPsql(`
      INSERT INTO ${schema}.profiles (id, user_id, handle, mode, verified)
      VALUES ('10000000-0000-0000-0000-000000000104', '10000000-0000-0000-0000-000000000104', 'modebad', 'A', false);
    `)).toThrow(/profiles_mode_check/);
  });

  it('allows partial ingestion run status after migration', () => {
    runPsql(`
      INSERT INTO ${schema}.profiles (id, user_id, handle, mode, verified)
      VALUES ('10000000-0000-0000-0000-000000000105', '10000000-0000-0000-0000-000000000105', 'partialrun', 'A', false);
    `);

    applyMigration();

    runPsql(`
      INSERT INTO ${schema}.ingestion_runs (profile_id, status, ingestion_mode)
      VALUES ('10000000-0000-0000-0000-000000000105', 'partial', 'script_verified');
    `);

    expect(rows(`SELECT status FROM ${schema}.ingestion_runs;`)).toEqual(['partial']);
  });

  it('coerces legacy audit severity error to critical and rejects new error values', () => {
    runPsql(`
      INSERT INTO ${schema}.profiles (id, user_id, handle, mode, verified)
      VALUES ('10000000-0000-0000-0000-000000000106', '10000000-0000-0000-0000-000000000106', 'audituser', 'B', false);
      ALTER TABLE ${schema}.audit_events DROP CONSTRAINT IF EXISTS audit_events_severity_check;
      INSERT INTO ${schema}.audit_events (profile_id, event_type, severity, payload)
      VALUES ('10000000-0000-0000-0000-000000000106', 'legacy.error', 'error', '{}'::jsonb);
    `);

    applyMigration();

    expect(rows(`SELECT severity FROM ${schema}.audit_events;`)).toEqual(['critical']);
    expect(() => runPsql(`
      INSERT INTO ${schema}.audit_events (profile_id, event_type, severity, payload)
      VALUES ('10000000-0000-0000-0000-000000000106', 'new.error', 'error', '{}'::jsonb);
    `)).toThrow(/audit_events_severity_check/);
  });

  it('keeps sessions.total_tokens as GENERATED ALWAYS and rejects explicit inserts', () => {
    runPsql(`
      INSERT INTO ${schema}.profiles (id, user_id, handle, mode, verified)
      VALUES ('10000000-0000-0000-0000-000000000107', '10000000-0000-0000-0000-000000000107', 'generated', 'A', false);
    `);

    applyMigration();

    expect(rows(`
      SELECT is_generated
      FROM information_schema.columns
      WHERE table_schema = '${escapeLiteral(schema)}'
        AND table_name = 'sessions'
        AND column_name = 'total_tokens';
    `)).toEqual(['ALWAYS']);

    expect(() => runPsql(`
      INSERT INTO ${schema}.sessions (
        profile_id, source, model, session_id, file_sha256, first_event_at,
        last_event_at, input_tokens, output_tokens, total_tokens, ingestion_mode
      )
      VALUES (
        '10000000-0000-0000-0000-000000000107', 'claude', 'claude-test',
        'generated-session', 'sha-generated-session', now(), now(), 1, 2, 3, 'script_verified'
      );
    `)).toThrow(/generated column/);
  });

  it('preserves session dedup uniqueness', () => {
    runPsql(`
      INSERT INTO ${schema}.profiles (id, user_id, handle, mode, verified)
      VALUES ('10000000-0000-0000-0000-000000000108', '10000000-0000-0000-0000-000000000108', 'dedupuser', 'A', false);
    `);

    applyMigration();

    runPsql(`
      INSERT INTO ${schema}.sessions (
        profile_id, source, model, session_id, file_sha256, first_event_at,
        last_event_at, input_tokens, output_tokens, ingestion_mode
      )
      VALUES (
        '10000000-0000-0000-0000-000000000108', 'claude', 'claude-test',
        'dedup-session', 'sha-dedup-session', now(), now(), 1, 2, 'script_verified'
      );
    `);

    expect(() => runPsql(`
      INSERT INTO ${schema}.sessions (
        profile_id, source, model, session_id, file_sha256, first_event_at,
        last_event_at, input_tokens, output_tokens, ingestion_mode
      )
      VALUES (
        '10000000-0000-0000-0000-000000000108', 'claude', 'claude-test',
        'dedup-session', 'sha-dedup-session', now(), now(), 1, 2, 'script_verified'
      );
    `)).toThrow(/duplicate key value/);
  });

  it('replaces legacy badge definitions and wipes legacy awards', () => {
    runPsql(`
      INSERT INTO ${schema}.profiles (id, user_id, handle, mode, verified)
      VALUES ('10000000-0000-0000-0000-000000000109', '10000000-0000-0000-0000-000000000109', 'badgeuser', 'A', false);
      INSERT INTO ${schema}.badges (slug, name, description, icon_slug, criteria_json, requires_verification, tier)
      VALUES ('verified', 'Verified', 'Legacy verified badge.', 'verified', '{}'::jsonb, false, 'standard')
      ON CONFLICT (slug) DO NOTHING;
      INSERT INTO ${schema}.profile_badges (profile_id, badge_slug, evidence)
      VALUES ('10000000-0000-0000-0000-000000000109', 'verified', '{}'::jsonb);
    `);

    applyMigration();

    expect(rows(`
      SELECT (SELECT COUNT(*) FROM ${schema}.badges)::text
      UNION ALL
      SELECT (SELECT COUNT(*) FROM ${schema}.profile_badges)::text
      UNION ALL
      SELECT (SELECT COUNT(*) FROM ${schema}.badges WHERE slug = 'verified')::text
      UNION ALL
      SELECT (SELECT COUNT(*) FROM ${schema}.badges WHERE slug = 'tier')::text;
    `)).toEqual(['16', '0', '0', '1']);
  });

  it('drops redundant policies for Task 6.0 to recreate authoritatively', () => {
    applyMigration();

    expect(rows(`
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = '${escapeLiteral(schema)}'
        AND policyname IN (
          'access_keys_select_own',
          'access_keys_update_own',
          'sessions_select_own',
          'daily_aggregates_select_own',
          'badges_select_public',
          'profile_badges_select_public',
          'ingestion_runs_select_own',
          'leaderboard_lifetime_select_public'
        )
      ORDER BY policyname;
    `)).toEqual([]);
  });

  it('is idempotent when run twice against the same schema', () => {
    applyMigration();
    applyMigration();

    expect(rows(`
      SELECT COUNT(*)::text
      FROM ${schema}.badges
      UNION ALL
      SELECT COUNT(*)::text
      FROM pg_constraint
      WHERE conrelid IN ('${schema}.profiles'::regclass, '${schema}.ingestion_runs'::regclass, '${schema}.audit_events'::regclass)
        AND conname IN ('profiles_mode_check', 'ingestion_runs_status_check', 'audit_events_severity_check');
    `)).toEqual(['16', '3']);
  });
});
