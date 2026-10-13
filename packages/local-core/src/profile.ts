import type { ProfileResponse, ProfileWindow } from '@tokensrank/shared';
import { ProfileResponseSchema } from '@tokensrank/shared';

import type { LocalDatabase } from './db.js';
import { getGithubIdentity } from './github.js';
import { rebuildLocalProfileSummary, readLocalProfileSummary } from './scoring.js';
import { readUsageEvidence } from './usage-evidence.js';
import { buildUsageRecap } from './usage-recap.js';

type DailyUsageRow = {
  date: string;
  source: 'claude' | 'codex' | 'opencode';
  provider: 'anthropic' | 'openai' | 'unknown';
  model: string;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  total_sessions: number;
  event_count: number;
  cost_usd_total: number;
};

type SessionRow = {
  source: 'claude' | 'codex' | 'opencode';
  provider: 'anthropic' | 'openai' | 'unknown';
  session_id: string;
  model: string;
  first_event_at: string;
  last_event_at: string;
  total_tokens: number;
  turns: number;
  cost_usd_total: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS: Record<ProfileWindow, number | null> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  all: null,
};
const CADENCE_WINDOWS = ['24h', '7d', '30d', 'all'] as const satisfies ProfileWindow[];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

type CadenceWindowSummary = {
  busiest_day: string | null;
  busiest_hour: string | null;
  hourly: number[];
  daily: number[];
  after_midnight: { count: number; pct: number };
  weekend_share: number;
  sessions_count: number;
};

function dateOnly(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : date.toISOString().slice(0, 10);
}

function dateRange(days: number, nowMs = Date.now()): string[] {
  const today = new Date(nowMs);
  today.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(today);
    day.setUTCDate(today.getUTCDate() - (days - index - 1));
    return day.toISOString().slice(0, 10);
  });
}

function dateRangeFromFirstDay(firstDay: string | null, nowMs = Date.now()): string[] {
  if (!firstDay) return dateRange(90, nowMs);
  const today = new Date(nowMs);
  today.setUTCHours(0, 0, 0, 0);
  const start = new Date(`${firstDay}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || start.getTime() > today.getTime()) {
    return dateRange(90, nowMs);
  }
  const days = Math.max(1, Math.floor((today.getTime() - start.getTime()) / DAY_MS) + 1);
  return dateRange(days, nowMs);
}

function modelSourceKey(source: 'claude' | 'codex' | 'opencode', model: string): string {
  return JSON.stringify([source, model]);
}

function fmtMonth(value: string | null): string {
  if (!value) return 'Jun 2026';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Jun 2026';
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function fmtFullDate(value: string | null): string {
  if (!value) return 'Jun 4, 2026';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Jun 4, 2026';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDayLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dateOnly(date.toISOString()) === dateOnly(today.toISOString())) return 'Today';
  if (dateOnly(date.toISOString()) === dateOnly(yesterday.toISOString())) return 'Yesterday';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '00:00';
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

function formatMoney(value: number): string {
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}K`;
  return `$${Math.round(value)}`;
}

function loadDailyUsage(db: LocalDatabase): DailyUsageRow[] {
  return db.prepare(`
    SELECT date, source, provider, model, total_tokens, input_tokens, output_tokens,
      cache_read_tokens, cache_create_tokens, cached_tokens, reasoning_tokens,
      total_sessions, event_count, cost_usd_total
    FROM usage_daily_aggregates
    ORDER BY date ASC
  `).all() as DailyUsageRow[];
}

function loadSessions(db: LocalDatabase): SessionRow[] {
  return db.prepare(`
    SELECT rollups.source, rollups.provider, rollups.session_id, rollups.model,
      rollups.first_event_at, rollups.last_event_at, rollups.total_tokens,
      rollups.turns, rollups.cost_usd_total
    FROM usage_session_rollups rollups
    ORDER BY rollups.first_event_at ASC
  `).all() as SessionRow[];
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentileMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function trendFor(prev: number, curr: number): 'up' | 'down' | 'flat' {
  if (curr > prev) return 'up';
  if (curr < prev) return 'down';
  return 'flat';
}

function providerLabel(source: string): 'claude' | 'codex' | 'opencode' | 'other' {
  if (source === 'claude') return 'claude';
  if (source === 'codex') return 'codex';
  if (source === 'opencode') return 'opencode';
  return 'other';
}

function buildSeriesArray(series: Map<string, number>, nowMs: number, spanDays: number): number[] {
  const out = new Array<number>(spanDays).fill(0);
  const todayMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
  for (const [day, value] of series) {
    const dayMs = Date.parse(`${day}T00:00:00.000Z`);
    if (!Number.isFinite(dayMs)) continue;
    const idx = spanDays - 1 - Math.round((todayMs - dayMs) / DAY_MS);
    if (idx >= 0 && idx < spanDays) out[idx] = value;
  }
  return out;
}

function buildScorePerDay(tokensByDay: Map<string, number>, shippedByDay: Map<string, number>, nowMs: number, spanDays: number): number[] {
  const tokens = buildSeriesArray(tokensByDay, nowMs, spanDays);
  const shipped = buildSeriesArray(shippedByDay, nowMs, spanDays);
  const windowDays = 30;
  const out = new Array<number>(spanDays).fill(0);
  let tokenSum = 0;
  let shippedSum = 0;
  let activeDays = 0;
  const isActive = (index: number): number => ((tokens[index] ?? 0) > 0 || (shipped[index] ?? 0) > 0 ? 1 : 0);

  for (let index = 0; index < spanDays; index += 1) {
    tokenSum += tokens[index] ?? 0;
    shippedSum += shipped[index] ?? 0;
    activeDays += isActive(index);
    if (index >= windowDays) {
      tokenSum -= tokens[index - windowDays] ?? 0;
      shippedSum -= shipped[index - windowDays] ?? 0;
      activeDays -= isActive(index - windowDays);
    }

    const consistency = 0.4 + 0.6 * Math.sqrt(Math.min(activeDays, windowDays) / windowDays);
    out[index] = Math.round(Math.sqrt(Math.log1p(tokenSum) * Math.log1p(shippedSum)) * consistency * 1000) / 1000;
  }

  return out;
}

function dayInWindow(day: string, window: ProfileWindow, nowMs: number): boolean {
  const days = WINDOW_DAYS[window];
  if (days === null) return true;
  const dayMs = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(dayMs)) return false;
  const todayMs = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00.000Z`);
  return dayMs > todayMs - days * DAY_MS && dayMs <= todayMs;
}

function eventInWindow(value: string, window: ProfileWindow, nowMs: number): boolean {
  const days = WINDOW_DAYS[window];
  if (days === null) return true;
  const eventMs = Date.parse(value);
  if (!Number.isFinite(eventMs)) return false;
  return eventMs >= Math.floor(nowMs / DAY_MS) * DAY_MS - (days - 1) * DAY_MS && eventMs <= nowMs;
}

function buildCadenceWindowSummaries(
  sessions: SessionRow[],
  nowMs: number,
): Record<ProfileWindow, CadenceWindowSummary> {
  return Object.fromEntries(CADENCE_WINDOWS.map((window) => {
    const hourly = new Array(24).fill(0) as number[];
    const daily = new Array(7).fill(0) as number[];

    for (const session of sessions) {
      if (!eventInWindow(session.last_event_at, window, nowMs)) continue;
      const date = new Date(session.last_event_at);
      if (Number.isNaN(date.getTime())) continue;

      const hour = date.getUTCHours();
      const day = (date.getUTCDay() + 6) % 7;
      hourly[hour] = (hourly[hour] ?? 0) + 1;
      daily[day] = (daily[day] ?? 0) + 1;
    }

    const sessionsCount = hourly.reduce((total, value) => total + value, 0);
    const busiestHourIndex = hourly.reduce((best, value, index) => value > hourly[best]! ? index : best, 0);
    const busiestDayIndex = daily.reduce((best, value, index) => value > daily[best]! ? index : best, 0);
    const afterMidnightCount = hourly.slice(0, 5).reduce((total, value) => total + value, 0);
    const weekendCount = (daily[5] ?? 0) + (daily[6] ?? 0);

    return [window, {
      busiest_day: sessionsCount > 0 ? DAY_NAMES[busiestDayIndex] ?? null : null,
      busiest_hour: sessionsCount > 0 ? `${busiestHourIndex}:00` : null,
      hourly,
      daily,
      after_midnight: {
        count: afterMidnightCount,
        pct: sessionsCount > 0 ? afterMidnightCount / sessionsCount : 0,
      },
      weekend_share: sessionsCount > 0 ? weekendCount / sessionsCount : 0,
      sessions_count: sessionsCount,
    }];
  })) as Record<ProfileWindow, CadenceWindowSummary>;
}

export function buildLocalProfile(
  db: LocalDatabase,
  options: { window?: ProfileWindow; nowMs?: number } = {},
): ProfileResponse {
  const window = options.window ?? 'all';
  const nowMs = options.nowMs ?? Date.now();
	  const identity = getGithubIdentity(db);
	  const daily = loadDailyUsage(db);
	  const sessions = loadSessions(db);
	  const firstObservedDay = [
	    ...daily.map((row) => row.date),
	    ...sessions.map((session) => dateOnly(session.first_event_at)),
	  ].filter(Boolean).sort()[0] ?? null;
	  const days90 = dateRangeFromFirstDay(firstObservedDay, nowMs);
  const firstSessionAt = sessions[0]?.first_event_at ?? null;
  const lastSessionAt = sessions.at(-1)?.last_event_at ?? null;
  let summaryRows = readLocalProfileSummary(db);
  if (summaryRows.length === 0) {
    rebuildLocalProfileSummary(db, { nowMs });
    summaryRows = readLocalProfileSummary(db);
  }
  const selectedSummary = summaryRows.find((row) => row.window === window);
  const filteredDaily = daily.filter((row) => dayInWindow(row.date, window, nowMs));
  const filteredSessions = sessions.filter((session) => dayInWindow(dateOnly(session.last_event_at), window, nowMs));
  const rawWindowTokens = sum(filteredDaily.map((row) => row.total_tokens));
  const rawWindowCost = sum(filteredDaily.map((row) => row.cost_usd_total));
  const rawWindowSessions = filteredSessions.length;
  const rawWindowActiveDays = new Set(filteredDaily.filter((row) => row.total_tokens > 0).map((row) => row.date)).size;
  const totalTokens = rawWindowTokens;
  const totalCost = rawWindowCost;
  const totalSessions = rawWindowSessions;
  const summaryActiveDays = rawWindowActiveDays;

  const dailyByDate = new Map<string, { tokens: number; sessions: number; cost: number }>();
  for (const row of daily) {
    const existing = dailyByDate.get(row.date) ?? { tokens: 0, sessions: 0, cost: 0 };
    existing.tokens += row.total_tokens;
    existing.cost += row.cost_usd_total;
    dailyByDate.set(row.date, existing);
  }

  // Daily model rows can repeat a session that used several models.
  // Count each session once, on its latest activity date, matching usage rollups.
  for (const session of sessions) {
    const date = dateOnly(session.last_event_at);
    const existing = dailyByDate.get(date) ?? { tokens: 0, sessions: 0, cost: 0 };
    existing.sessions += 1;
    dailyByDate.set(date, existing);
  }

  const dailyTokens90d = days90.map((day) => dailyByDate.get(day)?.tokens ?? 0);
  const dailySessions90d = days90.map((day) => dailyByDate.get(day)?.sessions ?? 0);
  const tokensByDayForScore = new Map(Array.from(dailyByDate.entries()).map(([day, value]) => [day, value.tokens]));

  const modelTotals = new Map<string, { tokens: number; cost: number; sessions: number }>();
  const modelSourceTotals = new Map<string, { source: 'claude' | 'codex' | 'opencode'; model: string; tokens: number; cost: number }>();
  for (const row of filteredDaily) {
    const existing = modelTotals.get(row.model) ?? { tokens: 0, cost: 0, sessions: 0 };
    existing.tokens += row.total_tokens;
    existing.cost += row.cost_usd_total;
    existing.sessions += row.total_sessions;
    modelTotals.set(row.model, existing);

    const sourceModelKey = modelSourceKey(row.source, row.model);
    const existingSourceModel = modelSourceTotals.get(sourceModelKey) ?? {
      source: row.source,
      model: row.model,
      tokens: 0,
      cost: 0,
    };
    existingSourceModel.tokens += row.total_tokens;
    existingSourceModel.cost += row.cost_usd_total;
    modelSourceTotals.set(sourceModelKey, existingSourceModel);
  }
  const allModels = Array.from(modelTotals.entries())
    .sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens);
  const topModels = allModels.slice(0, 12);
  const topModelNames = topModels.map(([model]) => model);
  const topBySessionsModel = [...topModels].sort((a, b) => b[1].sessions - a[1].sessions)[0]?.[0] ?? null;

  const modelHistory = topModelNames.map((model) => {
    let tokenTotal = 0;
    let costTotal = 0;
    return {
      model,
      points: days90.map((date) => {
        const rows = daily.filter((row) => row.model === model && row.date === date);

        tokenTotal += sum(rows.map((row) => row.total_tokens));
        costTotal += sum(rows.map((row) => row.cost_usd_total));

        return { date, tokens: tokenTotal, cost: Math.round(costTotal * 100) / 100 };
      }),
    };
  });

  const providerSpendHistory = (['claude', 'codex', 'opencode'] as const).map((provider) => {
    let total = 0;
    return {
      provider,
      points: days90.map((date) => {
        total += sum(daily
          .filter((row) => providerLabel(row.source) === provider && row.date === date)
          .map((row) => row.cost_usd_total));
        return { date, cost: Math.round(total * 100) / 100 };
      }),
    };
  });

  const modelMetrics90d = topModels.map(([model, totals]) => {
    const prevDays = days90.slice(-28, -14);
    const currDays = days90.slice(-14);
    const prev = sum(daily.filter((row) => row.model === model && prevDays.includes(row.date)).map((row) => row.total_tokens));
    const curr = sum(daily.filter((row) => row.model === model && currDays.includes(row.date)).map((row) => row.total_tokens));
    return {
      model,
      tokens_total: totals.tokens,
      tokens_14d_prev: prev,
      tokens_14d_curr: curr,
      trend: trendFor(prev, curr),
    };
  });

  const cadenceWindows = buildCadenceWindowSummaries(sessions, nowMs);
  const allCadence = cadenceWindows.all;

	  const shippedRows = db.prepare(`
	    SELECT date,
	      SUM(github_shipped_loc) AS loc,
	      SUM(COALESCE(NULLIF(github_shipped_loc_score, 0), github_shipped_loc)) AS score_loc,
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
	  `).all() as Array<{ date: string; loc: number; score_loc: number; commits: number }>;
	  const shippedByDate = new Map(shippedRows.map((row) => [row.date, row]));
	  const shippedByDayForScore = new Map(shippedRows.map((row) => [row.date, Number(row.score_loc ?? row.loc ?? 0)]));
  const shippedLoc90d = days90.map((day) => shippedByDate.get(day)?.loc ?? 0);
  const shippedCommits90d = days90.map((day) => shippedByDate.get(day)?.commits ?? 0);
  const shippedLocTotal = sum(shippedRows.map((row) => row.loc));
  const shippedCommitTotal = sum(shippedRows.map((row) => row.commits));
	  const producedRows = db.prepare(`
	    SELECT date,
	      SUM(produced_loc) AS produced_loc,
	      SUM(COALESCE(NULLIF(produced_loc_score, 0), produced_loc)) AS produced_loc_score,
	      SUM(shipped_loc) AS shipped_loc,
	      SUM(COALESCE(NULLIF(shipped_loc_score, 0), shipped_loc)) AS shipped_loc_score,
	      SUM(ai_linked_commit_count) AS commits,
	      SUM(high_confidence_commit_count) AS high_confidence_commits,
	      AVG(median_link_confidence) AS median_link_confidence
    FROM code_daily_rollups
    GROUP BY date
  `).all() as Array<{
	    date: string;
	    produced_loc: number;
	    produced_loc_score: number;
	    shipped_loc: number;
	    shipped_loc_score: number;
	    commits: number;
    high_confidence_commits: number;
    median_link_confidence: number;
  }>;
  const linkedTokenRows = db.prepare(`
    SELECT substr(commits.committed_at, 1, 10) AS date,
      SUM(links.linked_tokens) AS linked_tokens
    FROM ai_commit_links links
    JOIN local_commits commits
      ON commits.repo_id = links.repo_id
      AND commits.sha = links.commit_sha
    GROUP BY substr(commits.committed_at, 1, 10)
  `).all() as Array<{ date: string; linked_tokens: number }>;
  const producedByDate = new Map(producedRows.map((row) => [row.date, row]));
  const linkedTokensByDate = new Map(linkedTokenRows.map((row) => [row.date, row.linked_tokens]));
  const producedLoc90d = days90.map((day) => producedByDate.get(day)?.produced_loc ?? 0);
  const producedShippedLoc90d = days90.map((day) => producedByDate.get(day)?.shipped_loc ?? 0);
  const producedCommits90d = days90.map((day) => producedByDate.get(day)?.commits ?? 0);
  const linkedTokens90d = days90.map((day) => linkedTokensByDate.get(day) ?? 0);
  const producedLocTotal = sum(producedRows.map((row) => row.produced_loc));
  const producedShippedLocTotal = sum(producedRows.map((row) => row.shipped_loc));
  const producedCommitTotal = sum(producedRows.map((row) => row.commits));
  const producedHighConfidenceCommitTotal = sum(producedRows.map((row) => row.high_confidence_commits));
  const producedMedianLinkConfidence = percentileMedian(
    producedRows
      .map((row) => row.median_link_confidence)
      .filter((value) => Number.isFinite(value) && value > 0)
  );
  const modelCodeRows = db.prepare(`
    SELECT date, source, provider, model,
      SUM(produced_loc) AS produced_loc,
      SUM(shipped_loc) AS shipped_loc
    FROM ai_code_model_daily
    GROUP BY date, source, provider, model
  `).all() as Array<{
    date: string;
    source: 'claude' | 'codex' | 'opencode';
    provider: 'anthropic' | 'openai' | 'unknown';
    model: string;
    produced_loc: number;
    shipped_loc: number;
  }>;
  const modelCodeTotals = new Map<string, {
    source: 'claude' | 'codex' | 'opencode';
    model: string;
    aiCodedLoc: number;
    shippedAiCodedLoc: number;
  }>();
  for (const row of modelCodeRows) {
    if (!dayInWindow(row.date, window, nowMs)) continue;
    const key = modelSourceKey(row.source, row.model);
    const existing = modelCodeTotals.get(key) ?? {
      source: row.source,
      model: row.model,
      aiCodedLoc: 0,
      shippedAiCodedLoc: 0,
    };
    existing.aiCodedLoc += row.produced_loc;
    existing.shippedAiCodedLoc += row.shipped_loc;
    modelCodeTotals.set(key, existing);
  }
  const modelCodeBreakdown = Array.from(new Set([
    ...modelSourceTotals.keys(),
    ...modelCodeTotals.keys(),
  ])).map((key) => {
    const usage = modelSourceTotals.get(key);
    const code = modelCodeTotals.get(key);
    return {
      model: usage?.model ?? code?.model ?? 'unknown',
      source: usage?.source ?? code?.source ?? 'opencode',
      tokens_total: usage?.tokens ?? 0,
      cost_usd_total: Math.round((usage?.cost ?? 0) * 100) / 100,
      ai_coded_loc: code?.aiCodedLoc ?? 0,
      shipped_ai_coded_loc: code?.shippedAiCodedLoc ?? 0,
    };
  }).sort((a, b) =>
    b.shipped_ai_coded_loc - a.shipped_ai_coded_loc
    || b.ai_coded_loc - a.ai_coded_loc
    || b.cost_usd_total - a.cost_usd_total
    || b.tokens_total - a.tokens_total
  ).slice(0, 20);

  const spendPerShippedAiLoc30d = days90.map((date, index) => {
    const windowDays = days90.slice(Math.max(0, index - 29), index + 1);
    const costUsd = sum(windowDays.map((day) => dailyByDate.get(day)?.cost ?? 0));
    const shippedAiCodedLoc = sum(windowDays.map((day) => producedByDate.get(day)?.shipped_loc ?? 0));
    const roundedCost = Math.round(costUsd * 100) / 100;
    if (costUsd <= 0 && shippedAiCodedLoc <= 0) {
      return { date, cost_usd: 0, shipped_ai_coded_loc: 0, value: null, status: 'no_activity' as const };
    }
    if (shippedAiCodedLoc <= 0) {
      return { date, cost_usd: roundedCost, shipped_ai_coded_loc: 0, value: null, status: 'no_shipped_code' as const };
    }
    if (costUsd <= 0) {
      return { date, cost_usd: 0, shipped_ai_coded_loc: shippedAiCodedLoc, value: 0, status: 'zero_cost' as const };
    }
    return {
      date,
      cost_usd: roundedCost,
      shipped_ai_coded_loc: shippedAiCodedLoc,
      value: Math.round((costUsd / shippedAiCodedLoc) * 10000) / 10000,
      status: 'ok' as const,
    };
  });

  const sessionDurations = sessions.map((session) =>
    Math.max(0, Date.parse(session.last_event_at) - Date.parse(session.first_event_at))
  );
  const longestSessionMs = Math.max(0, ...sessionDurations);
  const longestSession = sessions[sessionDurations.indexOf(longestSessionMs)] ?? sessions.at(-1);
  const mostExpensive = [...sessions].sort((a, b) => b.cost_usd_total - a.cost_usd_total)[0];
  const largestByTokens = [...sessions].sort((a, b) => b.total_tokens - a.total_tokens)[0];
  const totalSessionMs = sum(sessionDurations);
  const windowSessionDurations = filteredSessions.map((session) =>
    Math.max(0, Date.parse(session.last_event_at) - Date.parse(session.first_event_at))
  );

  const recentSessions = [...filteredSessions].sort((a,b)=>b.last_event_at.localeCompare(a.last_event_at)).slice(0, 10).map((session) => ({
    session_id: session.session_id,
    source: session.source,
    model: session.model,
    started_at: session.first_event_at,
    ended_at: session.last_event_at,
    tokens_total: session.total_tokens,
    cost_usd_total: session.cost_usd_total,
    turns: session.turns,
    project_name: 'Local import',
    day: fmtDayLabel(session.first_event_at),
    time: fmtTime(session.first_event_at),
  }));

  const handle = identity?.login ?? 'local';
  const avatarUrl = identity?.avatar_url ?? null;
  const joined = firstSessionAt ?? new Date().toISOString();

  const usageEvidence = readUsageEvidence(db, true);
  const response: ProfileResponse = {
    usage_recap: buildUsageRecap(daily, usageEvidence, nowMs),
    evidence: {
      github_login: identity?.login ?? null, published_at:null,
      output_tokens:sum(filteredDaily.map(row=>row.output_tokens)),
      usage: usageEvidence, contribution:null, standings:[],
    },
    token_mix: {
      input: sum(filteredDaily.map(row => row.input_tokens)),
      output: sum(filteredDaily.map(row => row.output_tokens)),
      cache_read: sum(filteredDaily.map(row => row.cache_read_tokens + row.cached_tokens)),
      cache_write: sum(filteredDaily.map(row => row.cache_create_tokens)),
      reasoning: sum(filteredDaily.map(row => row.reasoning_tokens)),
    },
    variant: 'owner_share_true',
    window,
    user_is_owner: true,
    identity: {
      handle,
      name: handle,
      display_name: handle,
      avatar_url: avatarUrl,
      bio: null,
      x_handle: handle,
      mode: 'self_reported',
      verified: Boolean(identity),
      share_projects: true,
      joined_at: joined,
      joined: fmtMonth(joined),
      joined_full: fmtFullDate(joined),
      os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux',
      archetype: null,
      last_sync: lastSessionAt,
      last_sync_status: lastSessionAt ? 'live' : 'stale',
      badges: [],
    },
    headline: {
      rank: null,
      rank_delta_30d: null,
      total_ranked: null,
      percentile: 'local',
      rank_percentile: null,
      tokens_total: totalTokens,
      cost_usd_total: Math.round(totalCost * 100) / 100,
    },
    at_glance: {
      tokens_total: totalTokens,
      cost_usd_total: Math.round(totalCost * 100) / 100,
      sessions_count: totalSessions,
      days_active: summaryActiveDays,
      avg_tokens_per_session: totalSessions > 0 ? totalTokens / totalSessions : 0,
      window_stats: {
        tokens: totalTokens,
        sessions: totalSessions,
        active_days: summaryActiveDays,
        median_session: formatDuration(percentileMedian(windowSessionDurations)),
        cache_hit_rate: 0,
      },
      project_breakdown: [],
    },
    models: {
      items: topModels.map(([label, value]) => ({
        label,
        tokens_total: value.tokens,
        sessions_count: value.sessions,
        percentage: totalTokens > 0 ? (value.tokens / totalTokens) * 100 : 0,
      })),
      models: allModels.map(([name, value]) => ({
        name,
        tokens: value.tokens,
        cost: Math.round(value.cost * 100) / 100,
        share: totalTokens > 0 ? value.tokens / totalTokens : 0,
        sessions: value.sessions,
      })),
      distinct: modelTotals.size,
      top_by_sessions: topBySessionsModel,
      first_model: sessions[0] ? { name: sessions[0].model, date: dateOnly(sessions[0].first_event_at) } : null,
      latest_model: sessions.at(-1) ? { name: sessions.at(-1)!.model, date: dateOnly(sessions.at(-1)!.last_event_at) } : null,
      model_metrics_90d: modelMetrics90d,
      model_usage_weeks: [],
      provider_spend_history: providerSpendHistory,
      model_usage_history: modelHistory,
      model_code_breakdown: modelCodeBreakdown,
    },
    tools: {
      items: (['claude', 'codex', 'opencode'] as const).map((source) => {
        const sourceRows = filteredDaily.filter((row) => row.source === source);
        const sourceTokens = sum(sourceRows.map((row) => row.total_tokens));
        return {
          label: source === 'claude' ? 'Claude' : source === 'codex' ? 'Codex' : 'OpenCode',
          source,
          project_name: null,
          tokens_total: sourceTokens,
          sessions_count: filteredSessions.filter(session=>session.source===source).length,
          percentage: totalTokens > 0 ? (sourceTokens / totalTokens) * 100 : 0,
        };
      }),
      claude_pct_tokens: totalTokens > 0 ? sum(filteredDaily.filter((row) => row.source === 'claude').map((row) => row.total_tokens)) / totalTokens : 0,
      codex_pct_tokens: totalTokens > 0 ? sum(filteredDaily.filter((row) => row.source === 'codex').map((row) => row.total_tokens)) / totalTokens : 0,
      both_days: days90.filter((day) =>
        dayInWindow(day, window, nowMs)
        && filteredDaily.some((row) => row.date === day && row.source === 'claude')
        && filteredDaily.some((row) => row.date === day && row.source === 'codex')
      ).length,
      days_observed: summaryActiveDays,
    },
    session_stats: {
      longest_session: {
        value: formatDuration(longestSessionMs),
        date: longestSession ? fmtDayLabel(longestSession.first_event_at) : '—',
      },
      largest_by_tokens: {
        value: largestByTokens ? `${largestByTokens.total_tokens.toLocaleString()} tokens` : '—',
        date: largestByTokens ? fmtDayLabel(largestByTokens.first_event_at) : '—',
      },
      most_expensive: {
        value: mostExpensive ? formatMoney(mostExpensive.cost_usd_total) : '—',
        date: mostExpensive ? fmtDayLabel(mostExpensive.first_event_at) : '—',
      },
      median_session: { value: formatDuration(percentileMedian(sessionDurations)) },
      sessions_over_1h: {
        value: String(sessionDurations.filter((value) => value >= 60 * 60 * 1000).length),
        sub: 'sessions',
      },
      total_time_in_sessions: { value: formatDuration(totalSessionMs) },
    },
    sessions: {
      items: recentSessions,
    },
    cadence: {
      days: days90.map((date, index) => ({
        date,
        tokens_total: dailyTokens90d[index] ?? 0,
        sessions_count: dailySessions90d[index] ?? 0,
      })),
      busiest_day: allCadence.busiest_day,
      busiest_hour: allCadence.busiest_hour,
      hourly: allCadence.hourly,
      daily: allCadence.daily,
      windows: cadenceWindows,
      current_streak: 0,
      longest_streak: 0,
      after_midnight: allCadence.after_midnight,
      weekend_share: allCadence.weekend_share,
      daily_tokens_90d: dailyTokens90d,
      daily_sessions_90d: dailySessions90d,
      score_per_day_90d: buildScorePerDay(tokensByDayForScore, shippedByDayForScore, nowMs, days90.length),
      streak_bands: [],
      dominant_model_per_day_90d: days90.map((date) => {
        const rows = daily.filter((row) => row.date === date).sort((a, b) => b.total_tokens - a.total_tokens);
        return rows[0]?.model ?? 'none';
      }),
    },
    parallelism: {
      buckets: [],
      peak_daily: [],
      peak_ever: 0,
      peak_ever_date: '—',
      peak_ever_time: '—',
      avg_concurrent: 0,
      days_parallel_3: 0,
      longest_sustained_3: '—',
      daily_peak_concurrent_90d: new Array(90).fill(0) as number[],
      tier_progression: {
        tier: 1,
        days_at_tier: 0,
        unlocked: [1],
        highest_unlocked: 1,
      },
    },
    shipped: {
      loc_per_day_90d: shippedLoc90d,
      commit_per_day_90d: shippedCommits90d,
      loc_total: shippedLocTotal,
      commit_total: shippedCommitTotal,
      produced_loc_per_day_90d: producedLoc90d,
      produced_shipped_loc_per_day_90d: producedShippedLoc90d,
      produced_commit_per_day_90d: producedCommits90d,
      linked_tokens_per_day_90d: linkedTokens90d,
      produced_loc_total: producedLocTotal,
      produced_shipped_loc_total: producedShippedLocTotal,
      produced_commit_total: producedCommitTotal,
      produced_high_confidence_commit_total: producedHighConfidenceCommitTotal,
      produced_median_link_confidence: producedMedianLinkConfidence,
      spend_per_shipped_ai_loc_30d: spendPerShippedAiLoc30d,
    },
    recent_activity: {
      items: [],
    },
    data_range: {
      first_session_at: firstSessionAt,
      last_session_at: lastSessionAt,
    },
    footer: {
      share_url: `http://localhost:3000/u/${handle}`,
      og_image_url: `http://localhost:3000/api/og/${handle}`,
      owner: {
        access_keys: [],
        last_sync_at: lastSessionAt,
        sync_status: lastSessionAt ? 'SYNCED' : 'STALE',
      },
    },
    access_keys: [],
    last_sync_at: lastSessionAt,
    sync_status: lastSessionAt ? 'SYNCED' : 'STALE',
  };

  return ProfileResponseSchema.parse(response);
}
