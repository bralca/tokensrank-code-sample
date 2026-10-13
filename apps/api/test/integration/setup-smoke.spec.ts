import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { setupTestSchema } from './setup';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const qcSchema = 'tokensrank_test_qc_verify';
const migrationPaths = [
  resolve(repoRoot, 'supabase/migrations/0010_reconcile_to_spec.sql'),
  resolve(repoRoot, 'supabase/migrations/0011_seed_design_canon_badges.sql'),
  resolve(repoRoot, 'supabase/migrations/0012_enable_rls.sql'),
];
const expectedApiSchemas = [
  'public',
  'tokensrank_test_w0',
  'tokensrank_test_w1',
  'tokensrank_test_w2',
  'tokensrank_test_w3',
  qcSchema,
];
const productionTables = [
  'access_keys',
  'audit_events',
  'badges',
  'daily_aggregates',
  'ingestion_runs',
  'profile_badges',
  'profiles',
  'sessions',
];

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[setup-smoke-test] Missing required environment variable: ${name}`);
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

function lines(sql: string): string[] {
  const output = runPsql(sql);
  return output ? output.split('\n') : [];
}

function applyInfrastructureMigrations(): void {
  const migrationCommands = migrationPaths
    .map((migrationPath) => `\\i ${migrationPath}`)
    .join('\n');

  runPsql(`
    SET tokensrank.target_schema = '${escapeLiteral(qcSchema)}';
    ${migrationCommands}
    NOTIFY pgrst, 'reload schema';
  `);
}

function parseTomlStringArray(config: string, key: string): string[] {
  const match = config.match(new RegExp(`${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`));

  if (!match?.[1]) {
    throw new Error(`[setup-smoke-test] Could not parse ${key} from supabase/config.toml`);
  }

  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

describe.sequential('setup and infrastructure smoke checks', () => {
  beforeAll(async () => {
    await setupTestSchema(qcSchema);
  });

  it('exposes all required Supabase API schemas and reaches the QC schema through PostgREST', async () => {
    const supabaseConfig = readFileSync(resolve(repoRoot, 'supabase/config.toml'), 'utf8');

    expect(parseTomlStringArray(supabaseConfig, 'schemas')).toEqual(expectedApiSchemas);
    expect(parseTomlStringArray(supabaseConfig, 'extra_search_path')).toEqual([
      'public',
      'extensions',
      'tokensrank_test_w0',
      'tokensrank_test_w1',
      'tokensrank_test_w2',
      'tokensrank_test_w3',
      qcSchema,
    ]);

    const qcClient = createClient(
      readRequiredEnv('SUPABASE_URL'),
      readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
      {
        db: {
          schema: qcSchema,
        },
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
        global: {
          headers: {
            'Accept-Profile': qcSchema,
            'Content-Profile': qcSchema,
          },
        },
      },
    );

    const { error } = await qcClient
      .from('profiles')
      .select('id')
      .limit(1);

    expect(error).toBeNull();
  });

  it('validates the production Caddy reverse-proxy configuration', () => {
    const output = execFileSync('caddy', ['validate', '--config', resolve(repoRoot, 'Caddyfile')], {
      encoding: 'utf8',
    });

    expect(output).toContain('Valid configuration');
  });

  it('replays migrations 0010 through 0012 idempotently against the QC schema', () => {
    expect(migrationPaths.map((migrationPath) => basename(migrationPath))).toEqual([
      '0010_reconcile_to_spec.sql',
      '0011_seed_design_canon_badges.sql',
      '0012_enable_rls.sql',
    ]);

    applyInfrastructureMigrations();
    applyInfrastructureMigrations();

    expect(lines(`
      SELECT relname || ':' || relrowsecurity::text
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${escapeLiteral(qcSchema)}'
        AND c.relkind = 'r'
        AND c.relname = ANY (ARRAY[${productionTables.map((table) => `'${table}'`).join(', ')}])
      ORDER BY relname;
    `)).toEqual(productionTables.map((table) => `${table}:true`));

    expect(lines(`
      SELECT COUNT(*)::text
      FROM ${qcSchema}.badges
      UNION ALL
      SELECT COUNT(*)::text
      FROM ${qcSchema}.badges
      WHERE requires_verification
      UNION ALL
      SELECT COUNT(*)::text
      FROM ${qcSchema}.badges
      WHERE slug IN (
        'tier',
        'iron_streak',
        'operator',
        'cache_whisperer',
        'night_owl',
        'multi_provider',
        'conductor',
        'outage_witness',
        'reasoning_junkie',
        'marathoner',
        'detonation',
        'long_context',
        'defection_arc',
        'two_tool',
        'drifter',
        'sniper'
      );
    `)).toEqual(['16', '5', '16']);

  });
});
