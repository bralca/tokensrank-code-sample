import './load-env.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

// Dry run by default. Scope is deliberately an allowlist, never every database table.
const operational = new Set(['profiles','github_identities','access_keys','audit_events','commit_cache',
  'leaderboard_lifetime','connected_repos','contrib_daily','daily_aggregates','ingestion_runs','leaderboard_previous',
  'local_publish_jobs','local_publish_links','local_publish_runs','local_published_ai_linked_code_daily',
  'local_published_github_code_daily','local_published_model_code_daily','profile_badges','profile_summary',
  'profile_verification_trust','published_code_daily','sessions','usage_daily_aggregates','usage_events',
  'usage_session_rollups','usage_source_files','published_usage_session_counts']);
const reference = new Set(['badges','model_pricing']);
const project = process.env.SUPABASE_PROJECT_ID;
if (!project || !process.env.SUPABASE_DB_PASSWORD) throw new Error('Configure Supabase project and database password.');
const bin = process.env.TOKENSRANK_PG_BIN ?? '';
const exe = (name) => bin ? join(bin, name) : name;
const connection = ['-h',`db.${project}.supabase.co`,'-U','postgres','-d','postgres'];
const env = { ...process.env, PGPASSWORD: process.env.SUPABASE_DB_PASSWORD };
function sql(query) {
  return execFileSync(exe('psql'), [...connection,'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],
    { env, input: query, encoding: 'utf8', maxBuffer: 16*1024*1024 }).trim();
}
const ident = (v) => '"'+v.replaceAll('"','""')+'"';
const tables = JSON.parse(sql(`SELECT json_agg(x) FROM (SELECT schemaname,tablename FROM pg_tables
  WHERE schemaname='public' OR schemaname ~ '^tokensrank_test_(w[0-9]+|qc_verify)$') x`));
for (const t of tables) if (!operational.has(t.tablename) && !reference.has(t.tablename))
  throw new Error(`Unclassified table ${t.schemaname}.${t.tablename}; classify it before resetting.`);
const targets = tables.filter((t) => operational.has(t.tablename)).map((t) => `${ident(t.schemaname)}.${ident(t.tablename)}`);
const refTables = tables.filter((t) => reference.has(t.tablename));
const fingerprint = (t) => sql(`SELECT json_build_object('rows',count(*),'digest',md5(coalesce(string_agg(j::text,'' ORDER BY j::text),''))) FROM (SELECT to_jsonb(t) j FROM ${ident(t.schemaname)}.${ident(t.tablename)} t) q`);
const before = Object.fromEntries(refTables.map((t) => [`${t.schemaname}.${t.tablename}`,JSON.parse(fingerprint(t))]));
const inventory = targets.map((table) => ({table, rows:Number(sql(`SELECT count(*) FROM ${table}`))}));
const authUsers=Number(sql('SELECT count(*) FROM auth.users'));
console.log(JSON.stringify({project,authUsers,operational:inventory.filter((t)=>t.rows),preserved:before},null,2));
if (!process.argv.includes('--apply')) process.exit(0);
const expected = process.argv[process.argv.indexOf('--project')+1];
if (!process.argv.includes('--project') || expected!==project) throw new Error('Use --apply --project <configured project id> to explicitly select this database.');
const backup = resolve(process.env.TOKENSRANK_BACKUP_DIR ?? join(homedir(),'.tokensrank','backups'), `reset-${new Date().toISOString().replaceAll(':','-')}`);
mkdirSync(backup,{recursive:true,mode:0o700}); chmodSync(backup,0o700);
const dump=join(backup,'supabase.dump');
execFileSync(exe('pg_dump'), [...connection,'--format=custom','--no-owner','--schema=public','--schema=tokensrank_test_*','--schema=auth','--file',dump], {env,stdio:['ignore','ignore','pipe'],timeout:120000});
chmodSync(dump,0o600);
const listing=execFileSync(exe('pg_restore'),['--list',dump],{encoding:'utf8'});
if (!listing.includes('TABLE DATA auth users') || !listing.includes('model_pricing')) throw new Error('Backup validation failed. No reset performed.');
writeFileSync(join(backup,'manifest.json'),JSON.stringify({project,authUsers,inventory,reference:before},null,2),{mode:0o600});
// Preserve the reference catalog in the normal application schema before emptying
// fixtures. Never overwrite a price already present in public.
const priceSources = refTables.filter((t)=>t.tablename==='model_pricing' && t.schemaname!=='public');
const preservePrices=priceSources.map((t)=>`INSERT INTO public.model_pricing SELECT * FROM ${ident(t.schemaname)}.model_pricing ON CONFLICT(provider,model_id) DO NOTHING;`).join('\n');
sql(`BEGIN; SET LOCAL lock_timeout='10s'; ${preservePrices}
  TRUNCATE ${targets.join(',')},auth.users CASCADE;
  DELETE FROM auth.audit_log_entries;
  DELETE FROM auth.flow_state;
  COMMIT;`);
for (const table of targets) if (Number(sql(`SELECT count(*) FROM ${table}`))!==0) throw new Error(`Reset verification failed: ${table} is not empty.`);
for (const t of refTables) {
  if (t.schemaname==='public' && t.tablename==='model_pricing') continue;
  const after=JSON.parse(fingerprint(t)); const prior=before[`${t.schemaname}.${t.tablename}`];
  if(after.rows!==prior.rows || after.digest!==prior.digest) throw new Error(`Reference data changed: ${t.tablename}`);
}
console.log(JSON.stringify({reset:'complete',backup,authUsers:Number(sql('SELECT count(*) FROM auth.users')),pricingRows:Number(sql('SELECT count(*) FROM public.model_pricing'))}));
