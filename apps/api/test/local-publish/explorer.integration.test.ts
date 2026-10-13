import { Client } from 'pg';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, it, expect } from 'vitest';
import { explorerRoutes } from '../../src/routes/explorer';

const connectionString = process.env.TOKENSRANK_TEST_DB_URL!;
if (!connectionString || new URL(connectionString).hostname !== '127.0.0.1') throw new Error('Explorer tests require the disposable local database.');
const db = new Client({connectionString});
let app:FastifyInstance;
beforeAll(async()=>{await db.connect();app=Fastify();await app.register(explorerRoutes);await app.ready();});
afterAll(async()=>{await app.close();await db.end();});
beforeEach(async()=>{await db.query('TRUNCATE auth.users CASCADE');});
async function builder(handle:string){const id=randomUUID();await db.query('INSERT INTO auth.users(id) VALUES($1)',[id]);await db.query('UPDATE profiles SET handle=$2 WHERE id=$1',[id,handle]);return id;}
async function usage(id:string,model:string,tokens:number,source='codex',day=new Date().toISOString().slice(0,10)){
  await db.query(`INSERT INTO usage_daily_aggregates(profile_id,date,source,provider,model,total_tokens,input_tokens,output_tokens,cache_read_tokens,cache_create_tokens,cached_tokens,reasoning_tokens,total_sessions,event_count,cost_usd_total)
    VALUES($1,$2,$3,'openai',$4,$5::bigint,$5::bigint,0,0,0,0,0,1,1,$5::bigint/1000.0)`,[id,day,source,model,tokens]);
}
async function get(url:string){const r=await app.inject(url);expect(r.statusCode,r.body).toBe(200);return r.json().data;}
it('includes every model and every builder beyond the first leaderboard page',async()=>{
  for(let i=0;i<55;i++){const id=await builder(`builder-${i}`);await usage(id,'small-model',1);await usage(id,'large-model',10);}
  const catalog=await get('/api/explore');
  expect(catalog.find((r:any)=>r.key==='small-model')).toMatchObject({builders:55,tokens:55});
  const slug=catalog[0].slug;
  const detail=await get(`/api/explore/${slug}`);
  expect(detail).toMatchObject({builders:55,tokens:550,community_tokens:605});expect(detail.rows).toHaveLength(50);
  const page=await get(`/api/explore/${slug}?offset=50`);expect(page.rows).toHaveLength(5);expect(page.rows[0].rank).toBe(51);
  expect(detail.breakdown.find((r:any)=>r.kind==='tool')).toMatchObject({tokens:550,builders:55});
});
it('keeps exact model IDs distinct, counts one builder across tools and filters dates',async()=>{
  const id=await builder('multi-tool');await usage(id,'model-a',10);await usage(id,'model-a',20,'opencode');await usage(id,'model/a',40,'codex','2020-01-01');
  const catalog=await get('/api/explore');expect(new Set(catalog.map((r:any)=>r.slug)).size).toBe(2);
  expect(catalog.find((r:any)=>r.key==='model-a')).toMatchObject({tokens:30,builders:1,tools:['codex','opencode']});
  const recent=await get('/api/explore?period=7d');expect(recent).toHaveLength(1);expect(recent[0].tokens).toBe(30);
});
it('excludes hidden and future usage and applies the existing trust rule to rank',async()=>{
  const a=await builder('normal');const b=await builder('adjusted');const hidden=await builder('hidden');
  await usage(a,'model',100);await usage(b,'model',150);await usage(hidden,'secret-hidden-model',10000);await usage(a,'future-model',1000,'codex','2099-01-01');
  await db.query("INSERT INTO profile_verification_trust(profile_id,deboost_multiplier,rank_eligible) VALUES($1,0.5,true),($2,1,false)",[b,hidden]);
  const rows=await get('/api/explore');expect(rows).toHaveLength(1);expect(rows[0].tokens).toBe(250);
  const detail=await get(`/api/explore/${rows[0].slug}`);expect(detail.rows.map((r:any)=>r.handle)).toEqual(['normal','adjusted']);
  expect(JSON.stringify(detail)).not.toContain('session_id');expect(JSON.stringify(detail)).not.toContain('profile_id');
});
it('uses verified GitHub avatars and preserves custom photos',async()=>{
  const id=await builder('photo');await usage(id,'model',10);
  await db.query("INSERT INTO github_identities(profile_id,github_user_id,login) VALUES($1,42,'photo')",[id]);
  const [model]=await get('/api/explore');let detail=await get(`/api/explore/${model.slug}`);expect(detail.rows[0].avatar_url).toBe('https://avatars.githubusercontent.com/u/42?s=96');
  await db.query("UPDATE profiles SET avatar_url='https://example.com/custom.png' WHERE id=$1",[id]);
  detail=await get(`/api/explore/${model.slug}`);expect(detail.rows[0].avatar_url).toBe('https://example.com/custom.png');
});
it('returns empty periods separately from unknown categories and validates public queries',async()=>{
  const id=await builder('historical');await usage(id,'model',10,'codex','2020-01-01');
  const [model]=await get('/api/explore');expect(await get(`/api/explore/${model.slug}?period=24h`)).toMatchObject({builders:0,rows:[],tokens:0});
  expect((await app.inject('/api/explore/no-such-model')).statusCode).toBe(404);
  expect((await app.inject('/api/explore?kind=location')).statusCode).toBe(400);
  expect((await app.inject('/api/explore?offset=-1')).statusCode).toBe(400);
  expect((await db.query("SELECT has_function_privilege('anon','query_usage_dimension(text,text,date,integer,integer)','EXECUTE') allowed")).rows[0].allowed).toBe(false);
});
