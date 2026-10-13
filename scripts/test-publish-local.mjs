import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

// This runner creates and removes its own test database. It never reads .env
// or connects to an existing Supabase project or local application database.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const detected = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' }).stdout?.trim();
const pgBin = process.env.TOKENSRANK_POSTGRES_BIN || detected;
const restBin = process.env.TOKENSRANK_POSTGREST_BIN || 'postgrest';
if (!pgBin || !existsSync(join(pgBin, 'initdb'))) throw new Error('Install PostgreSQL or set TOKENSRANK_POSTGRES_BIN to its bin directory.');
if (spawnSync(restBin, ['--version'], { stdio: 'ignore' }).status !== 0) throw new Error('Install PostgREST or set TOKENSRANK_POSTGREST_BIN to its executable.');
const dir = mkdtempSync(join(tmpdir(), 'tokensrank-publish-test-'));
let rest;
let pgStarted = false;
function cleanup() {
  rest?.kill('SIGTERM');
  if (pgStarted) spawnSync(join(pgBin, 'pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', 'stop'], { stdio: 'ignore' });
  rmSync(dir, { recursive: true, force: true });
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });
function run(command, args, input) {
  const result = spawnSync(command, args, { input, encoding: 'utf8', cwd: root });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error?.message || result.stdout}`);
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
try {
  const dbPort = await freePort();
  const restPort = await freePort();
  run(join(pgBin, 'initdb'), ['-D', join(dir, 'data'), '-A', 'trust', '-U', 'postgres']);
  run(join(pgBin, 'pg_ctl'), ['-D', join(dir, 'data'), '-l', join(dir, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${dbPort} -k ${dir}`, 'start']);
  pgStarted = true;
  const psql = (sql) => run(join(pgBin, 'psql'), ['-h', '127.0.0.1', '-p', String(dbPort), '-U', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], sql);
  psql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE ROLE authenticator;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,raw_user_meta_data jsonb DEFAULT '{}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{"role":"service_role"}'::jsonb $$;`);
  const files = readdirSync(join(root, 'supabase/migrations')).filter((file) => /^\d+_.*\.sql$/.test(file)).sort();
  for (const file of files) psql(readFileSync(join(root, 'supabase/migrations', file), 'utf8'));
  // Supabase grants these by default; standalone PostgreSQL does not.
  psql(`GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;`);
  const dbUrl = `postgres://postgres@127.0.0.1:${dbPort}/postgres`;
  const restUrl = `http://127.0.0.1:${restPort}`;
  const config = join(dir, 'postgrest.conf');
  writeFileSync(config, `db-uri = "${dbUrl}"\ndb-schemas = "public"\ndb-anon-role = "anon"\nserver-host = "127.0.0.1"\nserver-port = ${restPort}\njwt-secret = "tokensrank-isolated-test-secret-at-least-32-characters"\n`);
  let restLog = '';
  rest = spawn(restBin, [config], { stdio: ['ignore', 'pipe', 'pipe'] });
  rest.stderr.on('data', (chunk) => { restLog += chunk; });
  rest.stdout.on('data', (chunk) => { restLog += chunk; });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (rest.exitCode !== null) throw new Error(restLog);
    try { ready = (await fetch(`${restUrl}/profiles?select=id&limit=0`, { signal: AbortSignal.timeout(2_000) })).ok; } catch { /* starting */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`PostgREST did not start: ${restLog}`);
  console.log(`Applied ${files.length} migrations to a disposable local database. Running publishing tests.`);
  const tests = spawn('pnpm', ['--filter', '@tokensrank/api', 'exec', 'vitest', 'run', '--config', 'vitest.local-publish.config.ts'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, TOKENSRANK_TEST_DB_URL: dbUrl, TOKENSRANK_TEST_REST_URL: restUrl },
  });
  process.exitCode = await new Promise((resolve) => tests.on('exit', (code) => resolve(code ?? 1)));
} finally { cleanup(); }
