import { leaderboardRoutes } from '../../src/routes/leaderboard';
import { homepageStatsRoutes } from '../../src/routes/homepage-stats';
import { resetCacheForTests } from '../../src/services/cache';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalPublishPayloadSchema, LOCAL_PUBLISH_BODY_LIMIT_BYTES } from '@tokensrank/shared';

const github = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/github-pull', () => ({ calculateProfileContribDaily: github }));
import { localPublishRoutes, processPublishVerification } from '../../src/routes/local-publish';
import { registerPublishWorker } from '../../src/services/publish-jobs';
import { csrfPlugin } from '../../src/plugins/csrf';
import { cacheService } from '../../src/services/cache.service';
import { registerGetProfileRoute } from '../../src/routes/profile/get';
import { adminClient } from '../../src/clients/supabase';

const profileId = '11111111-1111-4111-8111-111111111111';
const origin = 'http://localhost:3200';
const dbUrl = process.env.TOKENSRANK_TEST_DB_URL ?? 'postgres://postgres@127.0.0.1:55439/postgres';
if (new URL(dbUrl).hostname !== '127.0.0.1') throw new Error('Use an isolated local database.');
const db = new Client({ connectionString: dbUrl });
const day = new Date().toISOString().slice(0, 10);
const timestamp = `${day}T12:00:00.000Z`;
const usage = { date: day, source: 'opencode', provider: 'unknown', model: 'test-model', total_tokens: 100,
  input_tokens: 80, output_tokens: 20, cache_read_tokens: 0, cache_create_tokens: 0, cached_tokens: 0,
  reasoning_tokens: 0, total_sessions: 1, event_count: 1, cost_usd_total: 0.01 };
const payload = LocalPublishPayloadSchema.parse({ schema_version: 1, client_version: 'test', generated_at: timestamp,
  github_user_id: 123, selected_repos: [{ repo_id: 456, full_name: 'fixture/repo', prod_branch: 'main' }],
  usage_daily: [usage], model_daily: [usage], pricing_snapshot: [],
  produced_code_daily: [{ date: day, produced_loc: 20, produced_loc_score: 15, shipped_loc: 3, shipped_loc_score: 2, ai_linked_commit_count: 1, high_confidence_commit_count: 1, median_link_confidence: 1 }],
  github_code_daily: [{ date: day, repo_id: 456, full_name: 'fixture/repo', prod_branch: 'main', github_shipped_loc: 10, github_shipped_loc_score: 8, github_commit_count: 1, verified_at: timestamp, verification_source: 'github_remote_prod' }],
  ai_linked_code_daily: [{ date: day, repo_id: 456, full_name: 'fixture/repo', linked_shipped_loc: 3, linked_shipped_loc_score: 2, linked_commit_count: 1, linked_tokens: 100, linked_cost_usd: 0.01, high_confidence_commit_count: 1, median_link_confidence: 1 }],
  model_code_daily: [{ date: day, source: 'opencode', provider: 'unknown', model: 'test-model', produced_loc: 20, produced_loc_score: 15, shipped_loc: 3, shipped_loc_score: 2, linked_commit_count: 1, linked_tokens: 100, linked_cost_usd: 0.01 }],
  summary: { total_tokens: 100, total_cost_usd: 0.01, sessions_count: 1, produced_loc_total: 20,
    github_shipped_loc_total: 10, ai_linked_shipped_loc_total: 3 },
  privacy_report: { prompts_sent: 0, raw_commands_sent: 0, file_contents_sent: 0, absolute_paths_sent: 0, raw_transcripts_sent: 0 },
});
let server: FastifyInstance;
let worker: ReturnType<typeof registerPublishWorker>;
async function startServer() {
  server = Fastify({ logger: false });
  server.decorate('cache', cacheService);
  server.decorate('requireAuth', async (request) => { (request as any).auth = { profileId, userId: profileId }; });
  await server.register(csrfPlugin);
  await server.register(localPublishRoutes);
  registerGetProfileRoute(server);
  await server.register(leaderboardRoutes);
  await server.register(homepageStatsRoutes);
  worker = registerPublishWorker(server, processPublishVerification);
  await server.ready();
}
async function link() {
  const start = await server.inject({ method: 'POST', url: '/api/publish/link/start', headers: { origin } });
  expect(start.statusCode, start.body).toBe(201);
  const code = start.json().data.code;
  const exchange = await server.inject({ method: 'POST', url: '/api/publish/link/exchange', payload: { code, github_user_id: 123 } });
  expect(exchange.statusCode, exchange.body).toBe(201);
  expect(exchange.json().data.public_profile_url).toBe(`${origin}/u/publish-fixture`);
  return { code, token: exchange.json().data.publish_token as string };
}
async function send(token: string, body = payload) {
  const response = await server.inject({ method: 'POST', url: '/api/publish/local', headers: { authorization: `Bearer ${token}` }, payload: body });
  expect(response.statusCode, response.body).toBe(202);
  return response.json().data.publish_run_id as string;
}
async function status(token: string, runId: string) {
  const response = await server.inject({ method: 'GET', url: `/api/publish/local/runs/${runId}`, headers: { authorization: `Bearer ${token}` } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().data;
}
beforeAll(async () => { await db.connect(); await startServer(); });
afterAll(async () => { await server.close(); await db.end(); });
beforeEach(async () => {
  resetCacheForTests();
  await db.query('TRUNCATE auth.users CASCADE');
  await db.query('INSERT INTO auth.users(id) VALUES($1)', [profileId]);
  await db.query("UPDATE profiles SET handle='publish-fixture',mode='self_reported',verified=false WHERE id=$1", [profileId]);
  await db.query("INSERT INTO github_identities(profile_id,github_user_id,login,provider_token,verified_emails) VALUES($1,123,'fixture','test-only',ARRAY[]::text[])", [profileId]);
  github.mockReset().mockResolvedValue({ rows: [{ profile_id: profileId, day, shipped_loc: 10, commit_count: 1 }], shippedLocTotal: 10, verificationRows: [{ profile_id: profileId, day, shipped_loc: 10, commit_count: 1 }], rawShippedLocTotal: 10 });
  cacheService.purgeByPrefix('profile:');
});

describe('local-to-public publishing with real PostgreSQL and HTTP', () => {
  it.skipIf(!process.env.TOKENSRANK_TEST_PAYLOAD)('stores an existing aggregate export in the disposable database', async () => {
    const real = LocalPublishPayloadSchema.parse(JSON.parse(readFileSync(process.env.TOKENSRANK_TEST_PAYLOAD!, 'utf8')));
    real.github_user_id = 123;
    const byDay = new Map<string, { profile_id: string; day: string; shipped_loc: number; commit_count: number }>();
    for (const row of real.github_code_daily) {
      const total = byDay.get(row.date) ?? { profile_id: profileId, day: row.date, shipped_loc: 0, commit_count: 0 };
      total.shipped_loc += row.github_shipped_loc; total.commit_count += row.github_commit_count;
      byDay.set(row.date, total);
    }
    const rows = [...byDay.values()];
    // GitHub is a deterministic fixture here; this check validates the real
    // export's storage shape without transmitting user data outside localhost.
    github.mockResolvedValue({ rows, verificationRows: rows, shippedLocTotal: rows.reduce((sum, row) => sum + row.shipped_loc, 0), rawShippedLocTotal: rows.reduce((sum, row) => sum + row.shipped_loc, 0) });
    const { token } = await link(); const runId = await send(token, real);
    for (let attempt = 0; attempt < 5; attempt++) {
      await worker.processNext();
      await db.query('UPDATE local_publish_jobs SET available_at=now()');
    }
    const result = await status(token, runId);
    expect(result.publish_run.publication_ready, result.publish_run.error).toBe(true);
    expect(Number((await db.query('SELECT count(*) FROM usage_session_rollups')).rows[0].count)).toBe(real.usage_session_rollups.length);
    const profileResponse = await server.inject({method:'GET',url:'/api/profile/publish-fixture?window=all'});
    expect(profileResponse.statusCode,profileResponse.body).toBe(200);
    const profile = profileResponse.json();
    expect(profile.models.models).toHaveLength(new Set(real.model_daily.map(row=>row.model)).size);
    expect(profile.models.models.reduce((sum:number,model:{tokens:number})=>sum+model.tokens,0)).toBe(real.summary.total_tokens);
    expect(profile.evidence.usage).toEqual(real.usage_evidence);
  });
  it('verifies actual code additions while preserving the capped ranking score', async () => {
    const body = structuredClone(payload);
    body.github_code_daily[0]!.github_shipped_loc = 3434;
    body.github_code_daily[0]!.github_shipped_loc_score = 2000;
    body.summary.github_shipped_loc_total = 3434;
    body.summary.github_shipped_loc_score_total = 2000;
    const row = { profile_id: profileId, day, shipped_loc: 2000, weighted_shipped: 2000, commit_count: 1 };
    github.mockResolvedValue({ rows: [row], shippedLocTotal: 2000,
      verificationRows: [{ ...row, shipped_loc: 3434 }], rawShippedLocTotal: 3434 });
    const { token } = await link(); const runId = await send(token, body);
    await worker.processNext();
    const result = await status(token, runId);
    expect(result.publish_run.verification_status).toBe('passed');
    expect(result.publish_run.remote_github_shipped_loc_total).toBe(3434);
    expect(result.trust.failed_publish_count).toBe(0);
    expect(Number((await db.query('SELECT shipped_loc FROM contrib_daily')).rows[0].shipped_loc)).toBe(2000);
  });
  it('publishes aggregate-only usage without session records or GitHub code requests', async () => {
    const body = structuredClone(payload);
    body.schema_version = 2;
    body.usage_session_rollups = [];
    body.selected_repos = [];
    body.produced_code_daily = []; body.github_code_daily = []; body.ai_linked_code_daily = []; body.model_code_daily = [];
    body.summary = { ...body.summary, produced_loc_total: 0, produced_loc_score_total: 0, github_shipped_loc_total: 0, github_shipped_loc_score_total: 0, ai_linked_shipped_loc_total: 0, ai_linked_shipped_loc_score_total: 0 };
    body.session_counts_daily = [{ date: day, source: 'opencode', total_sessions: 1 }];
    // Two models in the same session must still count as a single session.
    body.model_daily = [{ ...usage, input_tokens:40, output_tokens:20, total_tokens: 60, cost_usd_total: 0.006 }, { ...usage, model: 'second-model', input_tokens:30, output_tokens:10, total_tokens: 40, cost_usd_total: 0.004 }];
    body.usage_daily=body.model_daily;
    body.usage_evidence={version:1,sources:[{source:'opencode',daily_basis:'event_dates',read_at:timestamp,unpriced_models:[]}],attribution:null};
    const before = await server.inject({ url: '/api/leaderboard?period=all&scope=all' });
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().data).toHaveLength(0);
    await db.query('UPDATE github_identities SET provider_token=NULL');
    const { token } = await link(); const runId = await send(token, body);
    await worker.processNext();
    expect(github).not.toHaveBeenCalled();
    const result = await status(token, runId);
    expect(result.publish_run.publication_ready).toBe(true);
    expect(Number((await db.query('SELECT count(*) FROM usage_session_rollups')).rows[0].count)).toBe(0);
    const summary = (await db.query("SELECT tokens_total,cost_usd_total FROM profile_summary WHERE \"window\"='all'")).rows[0];
    expect(Number(summary.tokens_total)).toBe(100);
    expect(Number(summary.cost_usd_total)).toBe(0.01);
    const publicProfile = await server.inject({ method: 'GET', url: '/api/profile/publish-fixture?window=all' });
    expect(publicProfile.statusCode).toBe(200);
    expect(publicProfile.json().headline.tokens_total).toBe(100);
    expect(publicProfile.json().headline.cost_usd_total).toBe(0.01);
    expect(publicProfile.json().headline.rank).toBe(1);
    expect(publicProfile.json().evidence).toMatchObject({github_login:'fixture',usage:body.usage_evidence,contribution:null,output_tokens:30});
    expect(publicProfile.json().evidence.standings).toContainEqual({kind:'tool',key:'opencode',slug:'opencode',rank:1,builders:1});
    expect(JSON.stringify(publicProfile.json().evidence)).not.toContain('profile_id');
    expect((await db.query("SELECT has_table_privilege('anon','published_profile_evidence','SELECT') allowed")).rows[0].allowed).toBe(false);
    expect(publicProfile.json().at_glance.sessions_count).toBe(1);
    expect(publicProfile.json().cadence.days.at(-1)).toMatchObject({ date: day, tokens_total: 100, sessions_count: 1 });
    for (const scope of ['all', 'opencode']) {
      for (const period of ['all', '7d', '24h']) {
        const board = await server.inject({ url: `/api/leaderboard?period=${period}&scope=${scope}` });
        expect(board.statusCode, board.body).toBe(200);
        expect(board.json().data).toHaveLength(1);
        expect(board.json().data[0]).toMatchObject({ handle: 'publish-fixture', rank: 1, tokens_total: 100, cost_usd_total: 0.01, top_model: 'test-model' });
      }
    }
    const scoped = await server.inject({ url: '/api/leaderboard?period=all&scope=claude' });
    expect(scoped.json().data).toHaveLength(0);
    const stats = await server.inject({ url: '/api/homepage/stats' });
    expect(stats.json()).toMatchObject({ connected: 1, tokens24h: 100, recordsToday: 1, cost24h: 0.01 });
  });
  it('ranks beyond a PostgREST page, excludes hidden profiles, and never double counts legacy data', async () => {
    const second = '22222222-2222-4222-8222-222222222222';
    const hidden = '33333333-3333-4333-8333-333333333333';
    await db.query('INSERT INTO auth.users(id) VALUES($1),($2)', [second, hidden]);
    await db.query("UPDATE profiles SET handle=CASE id WHEN $1 THEN 'second-builder' ELSE 'hidden-builder' END WHERE id IN ($1,$2)", [second, hidden]);
    await db.query("INSERT INTO usage_daily_aggregates(profile_id,date,source,provider,model,total_tokens,total_sessions,cost_usd_total) SELECT $1,current_date,'opencode','unknown','model-'||n,1,1,0.01 FROM generate_series(1,1005) n", [profileId]);
    await db.query("INSERT INTO usage_daily_aggregates(profile_id,date,source,provider,model,total_tokens,total_sessions,cost_usd_total) VALUES($1,current_date,'claude','anthropic','sonnet',300,1,1),($2,current_date,'claude','anthropic','sonnet',9999,1,1)", [second,hidden]);
    await db.query("INSERT INTO daily_aggregates(profile_id,date,source,model,total_tokens,total_sessions) VALUES($1,current_date,'claude','legacy',9000,5)", [profileId]);
    await db.query("INSERT INTO profile_verification_trust(profile_id,rank_eligible,deboost_multiplier,leaderboard_hidden_at) VALUES($1,true,0.5,NULL),($2,false,0,now())", [second,hidden]);
    const board = await server.inject({ url: '/api/leaderboard?period=all&limit=1&offset=0' });
    expect(board.statusCode,board.body).toBe(200);
    expect(board.json().total).toBe(2);
    expect(board.json().data[0]).toMatchObject({ rank: 1,tokens_total: 1005 });
    const next = await server.inject({ url: '/api/leaderboard?period=all&limit=1&offset=1' });
    expect(next.json().data[0]).toMatchObject({ rank: 2,tokens_total: 300 });
    const empty = await server.inject({ url: '/api/leaderboard?period=all&limit=1&offset=2' });
    expect(empty.json()).toMatchObject({ data: [], total: 2 });
    const stats = await server.inject({ url: '/api/homepage/stats' });
    expect(stats.json()).toMatchObject({ connected: 2,tokens24h: 1305 });
  });

  it('keeps publishing available after resetting an isolated test schema', async () => {
    await db.query("SELECT public.reset_test_schema('tokensrank_test_w9')");
    expect((await db.query("SELECT to_regprocedure('tokensrank_test_w9.claim_local_publish()')::text AS fn")).rows[0].fn).toBeTruthy();
    expect((await db.query("SELECT * FROM tokensrank_test_w9.claim_local_publish()")).rows).toEqual([]);
    expect((await db.query("SELECT has_table_privilege('anon','tokensrank_test_w9.local_publish_jobs','SELECT') AS allowed")).rows[0].allowed).toBe(false);
    expect((await db.query("SELECT tokensrank_test_w9.count_usage_leaderboard(NULL,NULL) AS n")).rows[0].n).toBe('0');
    expect((await db.query("SELECT * FROM tokensrank_test_w9.query_usage_leaderboard_sorted(NULL,NULL,50,0,NULL,'sessions','asc')")).rows).toEqual([]);
  });
  it('connects, publishes OpenCode, rebuilds the public profile, and revokes the connection', async () => {
    const { token } = await link();
    const runId = await send(token);
    expect((await status(token, runId)).publish_run.publication_ready).toBe(false);
    await worker.processNext();
    const result = await status(token, runId);
    expect(result.publish_run).toMatchObject({ verification_status: 'passed', publication_ready: true });
    expect(result.trust.rank_eligible).toBe(true);
    expect((await db.query('SELECT mode,verified FROM profiles WHERE id=$1', [profileId])).rows[0]).toEqual({ mode: 'script_verified', verified: true });
    expect((await db.query('SELECT source,total_tokens FROM usage_daily_aggregates')).rows).toEqual([{ source: 'opencode', total_tokens: '100' }]);
    expect(Number((await db.query('SELECT linked_cost_usd FROM local_published_ai_linked_code_daily')).rows[0].linked_cost_usd)).toBe(0.01);
    expect((await db.query('SELECT source,produced_loc,shipped_loc FROM local_published_model_code_daily')).rows).toEqual([{ source: 'opencode', produced_loc: '20', shipped_loc: '3' }]);
    const profile = await server.inject({ url: '/api/profile/publish-fixture?window=all' });
    expect(profile.statusCode, profile.body).toBe(200);
    expect(JSON.stringify(profile.json())).toContain('test-model');
    const revoked = await server.inject({ method: 'POST', url: '/api/publish/token/revoke', headers: { authorization: `Bearer ${token}` } });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((await server.inject({ url: '/api/publish/token/status', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
  });

  it('rejects foreign origins, wrong identities, expired tokens, and concurrent code reuse', async () => {
    expect((await server.inject({ method: 'POST', url: '/api/publish/link/start' })).statusCode).toBe(403);
    for (const url of ['/api/publish/local', '/api/publish/link/exchange', '/api/publish/token/revoke']) {
      expect((await server.inject({ method: 'POST', url, headers: { origin: 'https://foreign.example' }, payload: {} })).statusCode).toBe(403);
    }
    const start = await server.inject({ method: 'POST', url: '/api/publish/link/start', headers: { origin } });
    const code = start.json().data.code;
    const exchanges = await Promise.all([1, 2].map(() => server.inject({ method: 'POST', url: '/api/publish/link/exchange', payload: { code, github_user_id: 123 } })));
    expect(exchanges.filter((r) => r.statusCode === 201)).toHaveLength(1);
    const token = exchanges.find((r) => r.statusCode === 201)!.json().data.publish_token;
    expect((await server.inject({ method: 'POST', url: '/api/publish/local', headers: { authorization: `Bearer ${token}` }, payload: { ...payload, github_user_id: 999 } })).statusCode).toBe(403);
    await db.query("UPDATE local_publish_links SET expires_at=now()-interval '1 minute'");
    expect((await server.inject({ method: 'POST', url: '/api/publish/local', headers: { authorization: `Bearer ${token}` }, payload })).statusCode).toBe(401);
  });

  it('accepts a multi-megabyte history and rejects exports above the bounded limit', async () => {
    const { token } = await link();
    const session = { source: 'opencode' as const, provider: 'unknown' as const, model: 'test-model', first_event_at: timestamp, last_event_at: timestamp,
      input_tokens: 80, output_tokens: 20, cache_read_tokens: 0, cache_create_tokens: 0, cached_tokens: 0, reasoning_tokens: 0,
      total_tokens: 100, turns: 1, cost_usd_total: 0.01, source_file_hashes: [] };
    const large = { ...payload, usage_session_rollups: Array.from({ length: 5000 }, (_, i) => ({ ...session, session_id: `session-${i}-${'x'.repeat(90)}` })) };
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(2_000_000);
    const runId = await send(token, large);
    await worker.processNext();
    expect((await status(token, runId)).publish_run.publication_ready).toBe(true);
    expect((await db.query('SELECT count(*) FROM usage_session_rollups')).rows[0].count).toBe('5000');
    const oversized = await server.inject({ method: 'POST', url: '/api/publish/local', headers: { 'content-type': 'application/json' }, payload: ' '.repeat(LOCAL_PUBLISH_BODY_LIMIT_BYTES + 1) });
    expect(oversized.statusCode).toBe(413);
  });

  it('preserves previous data when an aggregate insert fails, and resumes after restart', async () => {
    const { token } = await link();
    const firstId=await send(token); await worker.processNext();
    const duplicate = { ...payload, model_daily: [payload.model_daily[0], payload.model_daily[0]] };
    const runId = await send(token, duplicate);
    await worker.processNext();
    expect((await db.query('SELECT total_tokens FROM usage_daily_aggregates')).rows).toEqual([{ total_tokens: '100' }]);
    expect((await db.query('SELECT shipped_loc FROM contrib_daily')).rows).toEqual([{ shipped_loc: '10' }]);
    expect((await db.query('SELECT publish_run_id FROM published_profile_evidence')).rows).toEqual([{publish_run_id:firstId}]);
    expect((await status(token, runId)).publish_run.verification_status).toBe('processing');
    // Repair the simulated bad input and make its durable retry immediately available.
    await db.query('UPDATE local_publish_jobs SET payload=$1,available_at=now() WHERE run_id=$2', [payload, runId]);
    await server.close(); await startServer();
    await worker.processNext();
    expect((await status(token, runId)).publish_run.publication_ready).toBe(true);
    expect((await db.query('SELECT publish_run_id FROM published_profile_evidence')).rows).toEqual([{publish_run_id:runId}]);
  });

  it('recovers an expired lease and resumes a completed verification without repeating it', async () => {
    const { token } = await link(); const runId = await send(token);
    const first = (await adminClient.rpc('claim_local_publish')).data![0];
    expect((await adminClient.rpc('claim_local_publish')).data).toHaveLength(0);
    await db.query("UPDATE local_publish_jobs SET lease_until=now()-interval '1 second'");
    const second = (await adminClient.rpc('claim_local_publish')).data![0];
    expect(second.lease_token).not.toBe(first.lease_token);
    await expect(processPublishVerification(first)).rejects.toThrow('Publish lease lost');
    await processPublishVerification(second);
    const calls = github.mock.calls.length;
    expect((await status(token, runId)).publish_run.publication_ready).toBe(false);
    await db.query("UPDATE local_publish_jobs SET lease_until=now()-interval '1 second'");
    await server.close(); await startServer();
    await worker.processNext();
    expect(github).toHaveBeenCalledTimes(calls);
    expect((await status(token, runId)).publish_run.publication_ready).toBe(true);
  });

  it('does not penalize transient GitHub errors and applies a failed claim only once', async () => {
    const { token } = await link(); const runId = await send(token);
    github.mockRejectedValue(new Error('GitHub temporarily unavailable'));
    await worker.processNext();
    expect((await db.query('SELECT * FROM profile_verification_trust')).rows).toHaveLength(0);
    await db.query('UPDATE local_publish_jobs SET attempts=4,available_at=now()');
    await worker.processNext();
    expect((await status(token, runId)).trust).toMatchObject({ failed_publish_count: 0, rank_eligible: false });
    github.mockResolvedValue({ rows: [], shippedLocTotal: 0, verificationRows: [], rawShippedLocTotal: 0 });
    const badRun = await send(token, { ...payload, summary: { ...payload.summary, github_shipped_loc_total: 100 } });
    await worker.processNext(); await worker.processNext();
    expect((await status(token, badRun)).trust).toMatchObject({ failed_publish_count: 1, rank_eligible: false });
  });

  it('clears old public totals when an empty replacement is published', async () => {
    const { token } = await link(); await send(token); await worker.processNext();
    github.mockResolvedValue({ rows: [], shippedLocTotal: 0, verificationRows: [], rawShippedLocTotal: 0 });
    const runId = await send(token, { ...payload, usage_daily: [], model_daily: [], selected_repos: [], produced_code_daily: [], github_code_daily: [], ai_linked_code_daily: [], model_code_daily: [], summary: { ...payload.summary, github_shipped_loc_total: 0, ai_linked_shipped_loc_total: 0 } });
    await worker.processNext();
    expect((await status(token, runId)).publish_run.publication_ready).toBe(true);
    const rows = (await db.query('SELECT tokens_total FROM profile_summary')).rows;
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => Number(row.tokens_total) === 0)).toBe(true);
  });
});
