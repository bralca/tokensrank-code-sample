import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import './load-env.mjs';

const rootDir = resolve(new URL('..', import.meta.url).pathname);
const migrationsDir = resolve(rootDir, 'supabase/migrations');
const targetSchema = process.env.SUPABASE_SCHEMA ?? 'public';

function readRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[db:migrate] Missing required environment variable: ${name}`);
  }

  return value;
}

function escapeLiteral(value) {
  return value.replace(/'/g, "''");
}

if (!/^(public|tokensrank_test_w[0-9]+|tokensrank_test_qc_verify)$/.test(targetSchema)) {
  throw new Error(`[db:migrate] Refusing invalid SUPABASE_SCHEMA: ${targetSchema}`);
}

const migrationFiles = readdirSync(migrationsDir)
  .filter((file) => /^[0-9]+_.*\.sql$/.test(file))
  .sort();

const migrationFile = process.env.MIGRATION_FILE
  ? resolve(rootDir, process.env.MIGRATION_FILE)
  : resolve(migrationsDir, migrationFiles.at(-1) ?? '');

if (!migrationFile || !existsSync(migrationFile)) {
  throw new Error('[db:migrate] No migration file found to apply');
}

execFileSync(
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
  ],
  {
    env: {
      ...process.env,
      PGPASSWORD: readRequiredEnv('SUPABASE_DB_PASSWORD'),
    },
    input: `SET tokensrank.target_schema = '${escapeLiteral(targetSchema)}';\n\\i ${migrationFile}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  },
);

console.log(`[db:migrate] Applied ${migrationFile} to ${targetSchema}`);
