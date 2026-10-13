import type { LocalDatabase } from './db.js';
import { readSyncState } from './db.js';
import type { UsageEvidence } from '@tokensrank/shared';

/** Observed endpoints remain local evidence, never a claim about active work time. */
export function recoverSessionTimes(db: LocalDatabase): void {
  const rows = db.prepare(`SELECT source,session_id,min(event_at) first,max(event_at) last FROM (
      SELECT source,session_id,event_at FROM usage_events
      UNION ALL SELECT source,session_id,event_at FROM ai_tool_events
    ) WHERE event_at <= ? GROUP BY source,session_id`).all(new Date().toISOString()) as Array<{source:string;session_id:string;first:string;last:string}>;
  const session = db.prepare(`UPDATE usage_session_rollups SET first_event_at=min(first_event_at,?),last_event_at=max(last_event_at,?) WHERE source=? AND session_id=?`);
  db.transaction(()=>{for (const r of rows) {
    if (!Number.isFinite(Date.parse(r.first)) || !Number.isFinite(Date.parse(r.last))) continue;
    session.run(r.first,r.last,r.source,r.session_id);
  }})();
}

export function readUsageEvidence(db: LocalDatabase, includeCode = false): UsageEvidence {
  const sources = db.prepare(`SELECT DISTINCT d.source,coalesce(e.daily_basis,'session_dates') daily_basis,e.read_at
    FROM usage_daily_aggregates d LEFT JOIN usage_source_evidence e ON e.source=d.source
    WHERE d.total_tokens>0 ORDER BY d.source`).all() as UsageEvidence['sources'];
  const coverage = includeCode ? db.prepare(`SELECT
    (SELECT count(*) FROM usage_session_rollups) sessions,
    (SELECT count(*) FROM usage_session_rollups s WHERE EXISTS (
      SELECT 1 FROM ai_commit_links l WHERE l.source=s.source AND l.session_id=s.session_id AND l.link_reason='direct_commit_sha'
    )) linked_sessions`).get() as {sessions:number;linked_sessions:number} : null;
  return { version:1, sources:sources.map(s=>({...s,unpriced_models:readSyncState(db,`usage_unpriced_models_${s.source}`,[])})), attribution:coverage };
}
