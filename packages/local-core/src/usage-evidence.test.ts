import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe,it,expect } from 'vitest';
import { openLocalStore } from './db.js';
import { dailyRowsFromPayload,readCcusageUsage,writeCcusageRollups,type CcusageRunner } from './ccusage.js';
import { rebuildUsageRollups } from './ingest.js';
import { buildLocalProfile } from './profile.js';
import { buildPublishPayload } from './publish.js';
import { recoverSessionTimes } from './usage-evidence.js';

const now='2026-06-02T12:00:00.000Z';
const runner:CcusageRunner=async(source,args)=>source!=='codex'?{sessions:[],daily:[]}:
  args[0]==='session'?{sessions:[{sessionId:'private-session',lastActivity:'2026-06-02',inputTokens:40,outputTokens:10,cachedInputTokens:50,totalTokens:100,totalCost:2,modelsUsed:['model']}]}:
    {daily:[
      {date:'2026-06-01',inputTokens:10,outputTokens:5,cachedInputTokens:20,totalTokens:35,costUSD:.5,models:{model:{inputTokens:10,outputTokens:5,cachedInputTokens:20,reasoningOutputTokens:3,totalTokens:35,cost:.5}}},
      {date:'2026-06-02',inputTokens:30,outputTokens:5,cachedInputTokens:30,totalTokens:65,costUSD:1.5,models:{model:{inputTokens:30,outputTokens:5,cachedInputTokens:30,totalTokens:65,cost:1.5}}},
    ]};

describe('recorded usage evidence',()=>{
  it('keeps multi-day usage on event dates across refreshes and restarts, and publishes only aggregates',async()=>{
    const dataDir=await mkdtemp(path.join(os.tmpdir(),'tokensrank-days-'));const store=openLocalStore({dataDir});
    try {
      for(let i=0;i<2;i++)writeCcusageRollups(store.db,await readCcusageUsage({runner,homeDir:dataDir}));
      rebuildUsageRollups(store.db);
      const profile=buildLocalProfile(store.db,{nowMs:Date.parse(now)});
      expect(profile.cadence.days.filter(d=>d.tokens_total>0)).toEqual([
        {date:'2026-06-01',tokens_total:35,sessions_count:0},{date:'2026-06-02',tokens_total:65,sessions_count:1},
      ]);
      const receipt=buildPublishPayload(store.db,{githubUserId:42});
      expect(receipt.summary).toMatchObject({total_tokens:100,total_cost_usd:2,sessions_count:1});
      expect(receipt.usage_evidence).toMatchObject({sources:[{source:'codex',daily_basis:'event_dates'}],attribution:null});
      expect(JSON.stringify(receipt)).not.toContain('private-session');
      expect(receipt.usage_session_rollups).toEqual([]);
      expect(profile.token_mix).toMatchObject({input:40,output:10,cache_read:50});
    }finally{store.close();}
  });
  it('preserves the previous whole-source snapshot if the daily read fails',async()=>{
    const dataDir=await mkdtemp(path.join(os.tmpdir(),'tokensrank-days-failed-'));const store=openLocalStore({dataDir});
    try{
      writeCcusageRollups(store.db,await readCcusageUsage({runner,homeDir:dataDir}));
      const failed:CcusageRunner=async(s,a)=>{if(s==='codex'&&a[0]==='daily')throw Error('unreadable file');return runner(s,a);};
      writeCcusageRollups(store.db,await readCcusageUsage({runner:failed,homeDir:dataDir}));
      expect(buildPublishPayload(store.db,{githubUserId:42}).summary.total_tokens).toBe(100);
      expect(store.db.prepare('SELECT count(*) n FROM usage_daily_aggregates').get()).toEqual({n:2});
    }finally{store.close();}
  });
  it('uses exact recorded components and exact prices without allocating a combined cost or borrowing model prices',()=>{
    const rows=dailyRowsFromPayload('codex',{daily:[{date:'2026-06-01',totalTokens:120,costUSD:999,models:{
      known:{inputTokens:10,outputTokens:10,cachedInputTokens:80,reasoningOutputTokens:5},
      'known-20260101':{inputTokens:10,outputTokens:10},
    }}]},{pricing:new Map([['openai:known',{input:1,output:2,cache_read:.1,cache_write:1}]])})!;
    expect(rows.map(r=>r.total_tokens)).toEqual([100,20]);
    expect(rows[0]!.cost_usd_total).toBeCloseTo(.000038);
    expect(rows[1]).toMatchObject({cost_usd_total:0,missing_price:true});
    expect(dailyRowsFromPayload('codex',{daily:[{date:'2026-06-01',totalTokens:10,inputTokens:10,outputTokens:0,modelsUsed:['unpriced']}]})).toEqual([
      expect.objectContaining({model:'unpriced',cost_usd_total:0,missing_price:true}),
    ]);
    expect(()=>dailyRowsFromPayload('codex',{daily:[{date:'2026-02-30',totalTokens:10}]})).toThrow(/invalid UTC date/);
    expect(()=>dailyRowsFromPayload('codex',{daily:[{date:'2026-06-01',totalTokens:10}]})).toThrow(/output counter/);
    expect(()=>dailyRowsFromPayload('codex',{daily:[{date:'2026-06-01',totalTokens:121,models:{known:{totalTokens:100}}}]})).toThrow(/reconcile/);
  });
  it('recovers observed endpoints without exporting individual timestamps or inventing active duration',async()=>{
    const dataDir=await mkdtemp(path.join(os.tmpdir(),'tokensrank-times-'));const store=openLocalStore({dataDir});
    try{
      writeCcusageRollups(store.db,await readCcusageUsage({runner,homeDir:dataDir}));
      for(const [id,time] of [['a','2026-06-01T23:59:00.000Z'],['b','2026-06-02T00:01:00.000Z'],['future','2099-01-01T00:00:00.000Z']]){
        store.db.prepare(`INSERT INTO usage_events(event_id,source,provider,event_kind,session_id,event_at,model_source,source_file_hash,parser_version,created_at)
          VALUES(?,'codex','openai','token_usage','private-session',?,'record','private-file','test',?)`).run(id,time,now);
      }
      recoverSessionTimes(store.db);
      expect(store.db.prepare('SELECT first_event_at,last_event_at FROM usage_session_rollups').get()).toEqual({first_event_at:'2026-06-01T23:59:00.000Z',last_event_at:'2026-06-02T00:01:00.000Z'});
      // Session-wide endpoints cannot establish when each individual model ran.
      expect(store.db.prepare('SELECT first_event_at FROM usage_session_model_rollups LIMIT 1').get()).not.toEqual({first_event_at:'2026-06-01T23:59:00.000Z'});
      expect(JSON.stringify(buildPublishPayload(store.db,{githubUserId:42}))).not.toContain('23:59');
    }finally{store.close();}
  });
});
