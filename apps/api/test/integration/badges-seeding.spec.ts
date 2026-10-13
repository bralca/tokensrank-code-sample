import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { BadgeSchema } from '@tokensrank/shared';
import { resolveTestSchema, setupTestSchema } from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../supabase/migrations/0010_reconcile_to_spec.sql',
);

const expectedSlugs = [
  'cache_whisperer',
  'conductor',
  'defection_arc',
  'detonation',
  'drifter',
  'iron_streak',
  'long_context',
  'marathoner',
  'multi_provider',
  'night_owl',
  'operator',
  'outage_witness',
  'reasoning_junkie',
  'sniper',
  'tier',
  'two_tool',
];

const verificationGatedSlugs = [
  'cache_whisperer',
  'iron_streak',
  'operator',
  'reasoning_junkie',
  'tier',
];

const expectedCriteria: Record<string, Record<string, unknown>> = {
  tier: { threshold_tokens: 25000000 },
  iron_streak: { min_consecutive_days: 30 },
  operator: { min_sessions_per_day_avg: 10 },
  cache_whisperer: { min_cache_read_ratio: 0.3 },
  night_owl: { min_night_sessions_pct: 0.5, night_start_hour: 22, night_end_hour: 6 },
  multi_provider: { requires_claude: true, requires_codex: true },
  conductor: { min_models_used: 5 },
  outage_witness: { requires_error_tag: true },
  reasoning_junkie: { min_reasoning_tokens: 1, min_reasoning_ratio: 0.1 },
  marathoner: { min_session_hours: 6 },
  detonation: { min_daily_tokens: 10000000 },
  long_context: { min_context_tokens: 100000 },
  defection_arc: { from_model: 'claude', to_model: 'codex' },
  two_tool: { requires_both_models: true },
  drifter: { min_models_used: 8 },
  sniper: { require_singular_focus: true, focus_ratio_threshold: 0.9 },
};

type BadgeRow = {
  slug: string;
  name: string;
  description: string;
  icon_slug: string;
  criteria_json: Record<string, unknown>;
  requires_verification: boolean;
  tier: string;
};

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[badges-seeding-test] Missing required environment variable: ${name}`);
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

function lines(sql: string): string[] {
  const output = runPsql(sql);
  return output ? output.split('\n') : [];
}

function badgeRows(): BadgeRow[] {
  return lines(`
    SELECT jsonb_build_object(
      'slug', slug,
      'name', name,
      'description', description,
      'icon_slug', icon_slug,
      'criteria_json', criteria_json,
      'requires_verification', requires_verification,
      'tier', tier
    )::text
    FROM ${schema}.badges
    ORDER BY slug;
  `).map((row) => JSON.parse(row) as BadgeRow);
}

describe.sequential('badge seeding migration', () => {
  beforeEach(async () => {
    if (schema !== 'public') {
      await setupTestSchema(schema);
    }
  });

  it('runs the reconciliation migration without errors', () => {
    expect(() => applyMigration()).not.toThrow();
  });

  it('seeds exactly the 16 design-canon badges', () => {
    applyMigration();

    expect(lines(`SELECT slug FROM ${schema}.badges ORDER BY slug;`)).toEqual(expectedSlugs);
  });

  it('marks 5 badges as verification-gated and 11 as mode-agnostic', () => {
    applyMigration();

    expect(lines(`
      SELECT requires_verification::text || ':' || COUNT(*)::text
      FROM ${schema}.badges
      GROUP BY requires_verification
      ORDER BY requires_verification DESC;
    `)).toEqual(['true:5', 'false:11']);

    expect(lines(`
      SELECT slug
      FROM ${schema}.badges
      WHERE requires_verification
      ORDER BY slug;
    `)).toEqual(verificationGatedSlugs);
  });

  it('populates required catalog metadata for every badge', () => {
    applyMigration();

    for (const badge of badgeRows()) {
      expect(badge.slug, 'slug').toMatch(/^[a-z0-9_]+$/);
      expect(badge.name, `${badge.slug} name`).toMatch(/\S/);
      expect(badge.description, `${badge.slug} description`).toMatch(/\S/);
      expect(badge.icon_slug, `${badge.slug} icon_slug`).toMatch(/\S/);
      expect(['standard', 'rare', 'legendary'], `${badge.slug} tier`).toContain(badge.tier);
      expect(badge.criteria_json, `${badge.slug} criteria_json`).toBeTruthy();
      expect(Object.keys(badge.criteria_json).length, `${badge.slug} criteria_json keys`).toBeGreaterThan(0);
    }
  });

  it('stores validator-compatible criteria_json for each badge type', () => {
    applyMigration();

    const criteriaBySlug = Object.fromEntries(
      badgeRows().map((badge) => [badge.slug, badge.criteria_json]),
    );

    expect(criteriaBySlug).toEqual(expectedCriteria);
  });

  it('parses every seeded badge through the shared badge schema', () => {
    applyMigration();

    for (const badge of badgeRows()) {
      expect(() => BadgeSchema.parse({
        ...badge,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })).not.toThrow();
    }
  });

  it('leaves profile_badges empty after seeding', () => {
    applyMigration();

    expect(lines(`SELECT COUNT(*)::text FROM ${schema}.profile_badges;`)).toEqual(['0']);
  });

  it('preserves profile_badges foreign-key integrity', () => {
    applyMigration();

    runPsql(`
      INSERT INTO ${schema}.profiles (id, user_id, handle, mode, verified)
      VALUES (
        '20000000-0000-0000-0000-000000000501',
        '20000000-0000-0000-0000-000000000501',
        'badgefk',
        'script_verified',
        true
      );

      INSERT INTO ${schema}.profile_badges (profile_id, badge_slug, evidence)
      VALUES (
        '20000000-0000-0000-0000-000000000501',
        'tier',
        '{"tokens_total":25000000}'::jsonb
      );
    `);

    expect(lines(`SELECT COUNT(*)::text FROM ${schema}.profile_badges WHERE badge_slug = 'tier';`)).toEqual(['1']);

    expect(lines(`
      SELECT COUNT(*)::text
      FROM pg_constraint
      WHERE conrelid = 'public.profile_badges'::regclass
        AND contype = 'f'
        AND pg_get_constraintdef(oid) LIKE '%REFERENCES badges(slug)%';
    `)).toEqual(['1']);
  });

  it('keeps badge RLS public-read and client-write protected', () => {
    applyMigration();

    expect(lines(`
      SELECT policyname || ':' || cmd || ':' || roles::text
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'badges'
      ORDER BY policyname;
    `)).toEqual([
      'badges_insert_service_role:INSERT:{service_role}',
      'badges_public_read:SELECT:{anon,authenticated}',
      'badges_update_service_role:UPDATE:{service_role}',
    ]);

    expect(lines(`
      SELECT relrowsecurity::text
      FROM pg_class
      WHERE oid = 'public.badges'::regclass;
    `)).toEqual(['true']);

    expect(lines(`
      SELECT COUNT(*)::text
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'badges'
        AND cmd IN ('INSERT', 'UPDATE')
        AND roles::text[] = ARRAY['service_role'];
    `)).toEqual(['2']);
  });

  it('does not interfere with session triggers that maintain daily aggregates', () => {
    applyMigration();

    runPsql(`
      INSERT INTO ${schema}.profiles (id, user_id, handle, mode, verified)
      VALUES (
        '20000000-0000-0000-0000-000000000502',
        '20000000-0000-0000-0000-000000000502',
        'triggerok',
        'script_verified',
        true
      );

      INSERT INTO ${schema}.sessions (
        profile_id,
        source,
        model,
        session_id,
        file_sha256,
        first_event_at,
        last_event_at,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_create_tokens,
        cached_tokens,
        ingestion_mode
      )
      VALUES (
        '20000000-0000-0000-0000-000000000502',
        'claude',
        'claude-test',
        'trigger-session',
        'sha-trigger-session',
        '2026-04-27T00:00:00Z',
        '2026-04-27T00:30:00Z',
        100,
        50,
        25,
        10,
        5,
        'script_verified'
      );
    `);

    expect(lines(`
      SELECT total_tokens::text || ':' || total_sessions::text
      FROM ${schema}.daily_aggregates
      WHERE profile_id = '20000000-0000-0000-0000-000000000502';
    `)).toEqual(['190:1']);
  });

  it('is idempotent when the migration is replayed', () => {
    applyMigration();
    const firstSnapshot = lines(`
      SELECT slug || ':' || requires_verification::text || ':' || criteria_json::text
      FROM ${schema}.badges
      ORDER BY slug;
    `);

    applyMigration();
    const secondSnapshot = lines(`
      SELECT slug || ':' || requires_verification::text || ':' || criteria_json::text
      FROM ${schema}.badges
      ORDER BY slug;
    `);

    expect(secondSnapshot).toEqual(firstSnapshot);
    expect(lines(`SELECT COUNT(*)::text FROM ${schema}.badges;`)).toEqual(['16']);
    expect(lines(`SELECT COUNT(*)::text FROM ${schema}.profile_badges;`)).toEqual(['0']);
  });
});
