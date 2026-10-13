import { Client } from 'pg';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, it, expect } from 'vitest';
import { leaderboardRoutes } from '../../src/routes/leaderboard';
import { resetCacheForTests } from '../../src/services/cache';

const connectionString = process.env.TOKENSRANK_TEST_DB_URL!;
if (!connectionString || new URL(connectionString).hostname !== '127.0.0.1') throw new Error('Leaderboard tests require the disposable local database.');
const db = new Client({ connectionString });
let app: FastifyInstance;
beforeAll(async () => { await db.connect(); app = Fastify(); await app.register(leaderboardRoutes); await app.ready(); });
afterAll(async () => { await app.close(); await db.end(); });
beforeEach(async () => { resetCacheForTests(); await db.query('TRUNCATE auth.users CASCADE'); });

async function builder(handle: string) {
  const id = randomUUID();
  await db.query('INSERT INTO auth.users(id) VALUES($1)', [id]);
  await db.query('UPDATE profiles SET handle=$2 WHERE id=$1', [id, handle]);
  return id;
}
async function usage(id: string, tokens: number, cost: number, daysAgo = 0, source = 'codex', model = 'model') {
  await db.query(`INSERT INTO usage_daily_aggregates(profile_id,date,source,provider,model,total_tokens,total_sessions,cost_usd_total)
    VALUES($1,(now() AT TIME ZONE 'UTC')::date-$4::integer,$5,'openai',$6,$2,10,$3)`, [id, tokens, cost, daysAgo, source, model]);
}
async function counts(id: string, sessions: number, daysAgo = 0, source = 'codex') {
  await db.query(`INSERT INTO published_usage_session_counts(profile_id,date,source,total_sessions)
    VALUES($1,(now() AT TIME ZONE 'UTC')::date-$3::integer,$4,$2)`, [id, sessions, daysAgo, source]);
}
async function board(query = '') {
  const response = await app.inject(`/api/leaderboard${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { total: number; data: Array<{ handle: string; rank: number; tokens_total: number; cost_usd_total: number; sessions_count: number; active_days: number }> };
}

it('defaults to API value and sorts the complete population before applying pagination', async () => {
  const costly = await builder('cost-leader'); const busy = await builder('token-leader'); const free = await builder('zero-value');
  await usage(costly, 100, 20); await counts(costly, 2);
  await usage(busy, 9000, 1); await counts(busy, 7);
  await usage(free, 10, 0); await counts(free, 1);
  expect((await board()).data.map(r => r.handle)).toEqual(['cost-leader', 'token-leader', 'zero-value']);
  expect((await board('?limit=1&offset=1')).data[0]).toMatchObject({ handle: 'token-leader', rank: 2 });
  expect((await board('?sort=tokens&limit=1')).data[0]).toMatchObject({ handle: 'token-leader', rank: 1 });
  expect((await board('?sort=cost&order=asc&limit=1')).data[0]).toMatchObject({ handle: 'zero-value', rank: 3 });
  // Sorting has its own cache entry; a prior request must not poison another order.
  expect((await board('?sort=cost&order=desc&limit=1')).data[0].handle).toBe('cost-leader');
  expect((await board()).total).toBe(3);
  const own = await db.query('SELECT * FROM query_usage_leaderboard(NULL,NULL,1,0,$1)', [busy]);
  expect(Number(own.rows[0].rank)).toBe(2);
});

it('returns scoped session counts and distinct active days without multiplying multi-model sessions', async () => {
  const active = await builder('active-builder'); const sessions = await builder('session-builder');
  await usage(active, 100, 10, 0, 'codex', 'model-a'); await usage(active, 200, 20, 0, 'codex', 'model-b');
  await usage(active, 50, 1, 2); await usage(active, 60, 1, 40);
  await usage(active, 500, 50, 0, 'claude');
  await counts(active, 3); await counts(active, 2, 2); await counts(active, 1, 40); await counts(active, 4, 0, 'claude');
  await usage(sessions, 10, 1); await counts(sessions, 20);
  const scoped = await board('?period=7d&scope=codex&sort=active_days');
  expect(scoped.data[0]).toMatchObject({ handle: 'active-builder', tokens_total: 350, cost_usd_total: 31, sessions_count: 5, active_days: 2 });
  expect((await board('?period=24h&scope=codex')).data.find(r => r.handle === 'active-builder')).toMatchObject({ tokens_total: 300, sessions_count: 3, active_days: 1 });
  expect((await board('?period=7d&sort=sessions')).data[0].handle).toBe('session-builder');
  expect((await board('?period=7d&sort=sessions&order=asc')).data[0]).toMatchObject({ handle: 'active-builder', sessions_count: 9, active_days: 2 });
});

it('preserves eligibility and trust, excludes future records, and uses a stable tie break', async () => {
  const a = await builder('eligible-one'); const b = await builder('eligible-two'); const hidden = await builder('hidden-user'); const adjusted = await builder('adjusted-user');
  await usage(a, 100, 10); await usage(b, 100, 10); await usage(hidden, 9999, 9999); await usage(adjusted, 120, 12);
  await usage(a, 99999, 99999, -1);
  await db.query('INSERT INTO profile_verification_trust(profile_id,deboost_multiplier,rank_eligible) VALUES($1,0.5,true),($2,1,false)', [adjusted, hidden]);
  const data = await board();
  expect(data.total).toBe(3);
  expect(data.data.slice(0, 2).map(r => r.handle)).toEqual(a < b ? ['eligible-one', 'eligible-two'] : ['eligible-two', 'eligible-one']);
  expect(data.data[2]).toMatchObject({ handle: 'adjusted-user', cost_usd_total: 12, rank: 3 });
  expect(data.data[0].tokens_total).toBe(100);
  expect((await db.query("SELECT has_function_privilege('anon','query_usage_leaderboard_sorted(date,text,integer,integer,uuid,text,text)','EXECUTE') allowed")).rows[0].allowed).toBe(false);
});

it('rejects unsupported sorting and returns a genuine empty period', async () => {
  for (const query of ['sort=made_up', 'order=random', 'sort=cost&offset=-1']) {
    expect((await app.inject(`/api/leaderboard?${query}`)).statusCode).toBe(400);
  }
  const id = await builder('old-builder'); await usage(id, 100, 10, 90);
  expect(await board('?period=7d&sort=sessions')).toEqual({ data: [], total: 0 });
});
