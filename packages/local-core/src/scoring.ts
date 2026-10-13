import type { LocalDatabase } from './db.js';
import { nowIso } from './db.js';

export type LocalProfileWindow = '24h' | '7d' | '30d' | 'all';

const DAY_MS = 24 * 60 * 60 * 1000;
const SCORE_TAU_DAYS = 21;
const CONSISTENCY_DENOM_CAP = 30;
const WINDOWS: LocalProfileWindow[] = ['24h', '7d', '30d', 'all'];
const WINDOW_DAYS: Record<LocalProfileWindow, number> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  all: 3650,
};

type DaySeries = Map<string, number>;

type LocalScoreResult = {
  score: number;
  tokensTotal: number;
  shippedTotal: number;
  commitTotal: number;
  sessionsTotal: number;
  daysActive: number;
};

type UsageDayRow = {
  date: string;
  tokens: number;
  sessions: number;
  cost: number;
};

type GithubDayRow = {
  date: string;
  shipped_loc: number;
  shipped_loc_score: number;
  commits: number;
};

type AiLinkedDayRow = {
  date: string;
  linked_loc: number;
  linked_loc_score: number;
  linked_commits: number;
};

export type LocalProfileSummaryRow = {
  window: LocalProfileWindow;
  score: number;
  tokens_total: number;
  cost_usd_total: number;
  github_shipped_loc_total: number;
  ai_linked_loc_total: number;
  sessions_count: number;
  days_active: number;
  metrics_json: string;
  computed_at: string;
};

function parseDayMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function inWindow(day: string, window: LocalProfileWindow, nowMs: number): { ok: boolean; weight: number } {
  const noDecay = window === 'all';
  const cutoffMs = noDecay ? Number.NEGATIVE_INFINITY : nowMs - WINDOW_DAYS[window] * DAY_MS;
  const dayMs = parseDayMs(day);
  if (!Number.isFinite(dayMs) || dayMs < cutoffMs) {
    return { ok: false, weight: 0 };
  }

  const ageDays = Math.max(0, (nowMs - dayMs) / DAY_MS);
  return {
    ok: true,
    weight: noDecay ? 1 : Math.exp(-ageDays / SCORE_TAU_DAYS),
  };
}

export function computeLocalScore(input: {
  window: LocalProfileWindow;
  nowMs: number;
  tokensByDay: DaySeries;
  shippedByDay: DaySeries;
  commitsByDay?: DaySeries;
  sessionsByDay?: DaySeries;
}): LocalScoreResult {
  const { window, nowMs, tokensByDay, shippedByDay, commitsByDay, sessionsByDay } = input;
  const activeDays = new Set<string>();
  let tokensDecayed = 0;
  let shippedDecayed = 0;
  let tokensTotal = 0;
  let shippedTotal = 0;
  let commitTotal = 0;
  let sessionsTotal = 0;

  for (const [day, tokens] of tokensByDay) {
    const { ok, weight } = inWindow(day, window, nowMs);
    if (!ok) continue;
    tokensDecayed += tokens * weight;
    tokensTotal += tokens;
    if (tokens > 0) activeDays.add(day);
  }

  for (const [day, shipped] of shippedByDay) {
    const { ok, weight } = inWindow(day, window, nowMs);
    if (!ok) continue;
    shippedDecayed += shipped * weight;
    shippedTotal += shipped;
    if (shipped > 0) activeDays.add(day);
  }

  if (commitsByDay) {
    for (const [day, commits] of commitsByDay) {
      if (inWindow(day, window, nowMs).ok) commitTotal += commits;
    }
  }

  if (sessionsByDay) {
    for (const [day, sessions] of sessionsByDay) {
      if (inWindow(day, window, nowMs).ok) sessionsTotal += sessions;
    }
  }

  const denom = Math.min(WINDOW_DAYS[window], CONSISTENCY_DENOM_CAP);
  const consistency = 0.4 + 0.6 * Math.sqrt(Math.min(activeDays.size, denom) / denom);
  const score = Math.sqrt(Math.log1p(tokensDecayed) * Math.log1p(shippedDecayed)) * consistency;

  return {
    score,
    tokensTotal,
    shippedTotal,
    commitTotal,
    sessionsTotal,
    daysActive: activeDays.size,
  };
}

function addToSeries(series: DaySeries, day: string, value: number): void {
  series.set(day, (series.get(day) ?? 0) + value);
}

function sumWindowRows<T extends { date: string }>(
  rows: T[],
  window: LocalProfileWindow,
  nowMs: number,
  selector: (row: T) => number,
): number {
  return rows.reduce((total, row) => (
    inWindow(row.date, window, nowMs).ok ? total + selector(row) : total
  ), 0);
}

export function rebuildLocalProfileSummary(db: LocalDatabase, options: { nowMs?: number } = {}): number {
  const nowMs = options.nowMs ?? Date.now();
  const computedAt = new Date(nowMs).toISOString();
  const usageRows = db.prepare(`
    SELECT substr(rollups.last_event_at, 1, 10) AS date,
      SUM(rollups.total_tokens) AS tokens,
      COUNT(*) AS sessions,
      SUM(rollups.cost_usd_total) AS cost
    FROM usage_session_rollups rollups
    JOIN ai_threads threads
      ON threads.source = rollups.source
      AND threads.session_id = rollups.session_id
    JOIN local_repos repos
      ON repos.id = threads.repo_id
    WHERE repos.selected = 1
      AND repos.local_root NOT LIKE '%/.worktrees/%'
      AND repos.local_root NOT LIKE '%\\.worktrees\\%'
    GROUP BY date
  `).all() as UsageDayRow[];
	  const githubRows = db.prepare(`
	    SELECT date,
	      SUM(github_shipped_loc) AS shipped_loc,
	      SUM(COALESCE(NULLIF(github_shipped_loc_score, 0), github_shipped_loc)) AS shipped_loc_score,
	      SUM(github_commit_count) AS commits
	    FROM github_code_daily
	    WHERE EXISTS (
	      SELECT 1
	      FROM local_repos repos
	      WHERE repos.github_repo_id = github_code_daily.repo_id
	        AND repos.selected = 1
	        AND repos.local_root NOT LIKE '%/.worktrees/%'
	        AND repos.local_root NOT LIKE '%\\.worktrees\\%'
	    )
	    GROUP BY date
  `).all() as GithubDayRow[];
	  const aiLinkedRows = db.prepare(`
	    SELECT date,
	      SUM(linked_shipped_loc) AS linked_loc,
	      SUM(COALESCE(NULLIF(linked_shipped_loc_score, 0), linked_shipped_loc)) AS linked_loc_score,
	      SUM(linked_commit_count) AS linked_commits
	    FROM ai_linked_code_daily
	    WHERE EXISTS (
	      SELECT 1
	      FROM local_repos repos
	      WHERE repos.github_repo_id = ai_linked_code_daily.repo_id
	        AND repos.selected = 1
	        AND repos.local_root NOT LIKE '%/.worktrees/%'
	        AND repos.local_root NOT LIKE '%\\.worktrees\\%'
	    )
    GROUP BY date
  `).all() as AiLinkedDayRow[];

  const tokensByDay: DaySeries = new Map();
  const sessionsByDay: DaySeries = new Map();
  const shippedByDay: DaySeries = new Map();
  const commitsByDay: DaySeries = new Map();

  for (const row of usageRows) {
    addToSeries(tokensByDay, row.date, Number(row.tokens ?? 0));
    addToSeries(sessionsByDay, row.date, Number(row.sessions ?? 0));
  }

	  for (const row of githubRows) {
	    addToSeries(shippedByDay, row.date, Number(row.shipped_loc_score ?? row.shipped_loc ?? 0));
	    addToSeries(commitsByDay, row.date, Number(row.commits ?? 0));
	  }

  const stmt = db.prepare(`
    INSERT INTO profile_summary_local (
      window, score, tokens_total, cost_usd_total, github_shipped_loc_total,
      ai_linked_loc_total, sessions_count, days_active, metrics_json, computed_at
    )
    VALUES (
      @window, @score, @tokens_total, @cost_usd_total, @github_shipped_loc_total,
      @ai_linked_loc_total, @sessions_count, @days_active, @metrics_json, @computed_at
    )
    ON CONFLICT(window) DO UPDATE SET
      score = excluded.score,
      tokens_total = excluded.tokens_total,
      cost_usd_total = excluded.cost_usd_total,
      github_shipped_loc_total = excluded.github_shipped_loc_total,
      ai_linked_loc_total = excluded.ai_linked_loc_total,
      sessions_count = excluded.sessions_count,
      days_active = excluded.days_active,
      metrics_json = excluded.metrics_json,
      computed_at = excluded.computed_at
  `);

  db.transaction(() => {
    for (const window of WINDOWS) {
      const score = computeLocalScore({
        window,
        nowMs,
        tokensByDay,
        shippedByDay,
        commitsByDay,
        sessionsByDay,
      });
	      const costTotal = sumWindowRows(usageRows, window, nowMs, (row) => Number(row.cost ?? 0));
	      const aiLinkedLocTotal = sumWindowRows(aiLinkedRows, window, nowMs, (row) => Number(row.linked_loc ?? 0));
	      const aiLinkedCommitTotal = sumWindowRows(aiLinkedRows, window, nowMs, (row) => Number(row.linked_commits ?? 0));
	      const githubShippedLocTotal = sumWindowRows(githubRows, window, nowMs, (row) => Number(row.shipped_loc ?? 0));

      stmt.run({
        window,
        score: score.score,
        tokens_total: score.tokensTotal,
	        cost_usd_total: Number(costTotal.toFixed(4)),
	        github_shipped_loc_total: githubShippedLocTotal,
        ai_linked_loc_total: aiLinkedLocTotal,
        sessions_count: score.sessionsTotal,
        days_active: score.daysActive,
        metrics_json: JSON.stringify({
          github_commit_count_total: score.commitTotal,
          ai_linked_commit_count_total: aiLinkedCommitTotal,
          score_formula: 'sqrt(log1p(tokens_decayed) * log1p(shipped_decayed)) * consistency',
          source: 'local',
        }),
        computed_at: computedAt,
      });
    }
  })();

  return WINDOWS.length;
}

export function readLocalProfileSummary(db: LocalDatabase): LocalProfileSummaryRow[] {
  return db.prepare(`
    SELECT window, score, tokens_total, cost_usd_total, github_shipped_loc_total,
      ai_linked_loc_total, sessions_count, days_active, metrics_json, computed_at
    FROM profile_summary_local
    ORDER BY CASE window
      WHEN '24h' THEN 1
      WHEN '7d' THEN 2
      WHEN '30d' THEN 3
      ELSE 4
    END
  `).all() as LocalProfileSummaryRow[];
}
