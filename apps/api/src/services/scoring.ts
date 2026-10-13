import { adminClient } from '../clients/supabase';
import { costForSession, pricingKey, type PricingMap } from '../lib/cost';

/**
 * Composite ranking score.
 *
 *   score = sqrt( log1p(tokens_decayed) · log1p(shipped_decayed) ) · consistency
 *
 * Geometric mean of the two sides means you need BOTH token usage and shipped
 * code — inflating one alone collapses the score toward zero. Per-day
 * exponential decay (except the lifetime 'all' window) keeps the board moving;
 * the consistency multiplier rewards steady activity over one-day spikes.
 *
 * Inputs are pre-aggregated daily series (tokens from daily_aggregates, shipped
 * LOC from contrib_daily), so the rebuild is linear in (profiles × ~90 days) —
 * not the old O(profiles × sessions) scan.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
// Chart series span the full activity history (first active day → today), with a
// 90-day floor so short histories still render a consistent frame and a 5-year
// ceiling so a pathological range can't bloat the metrics blob.
const MIN_SERIES_DAYS = 90;
const MAX_SERIES_DAYS = 1825;
export const SCORE_TAU_DAYS = 21;
export const CONSISTENCY_DENOM_CAP = 30;

export type ProfileWindow = '24h' | '7d' | '30d' | 'all';
export const WINDOWS: ProfileWindow[] = ['24h', '7d', '30d', 'all'];
export const WINDOW_DAYS: Record<ProfileWindow, number> = { '24h': 1, '7d': 7, '30d': 30, all: 3650 };

// v1 blended cost estimate (USD per token). Refined per-model later.

export type DaySeries = Map<string, number>;

export type ScoreResult = {
  score: number;
  tokensTotal: number;
  shippedTotal: number;
  commitTotal: number;
  sessionsTotal: number;
  daysActive: number;
};

function parseDayMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

export function computeScore(input: {
  window: ProfileWindow;
  nowMs: number;
  tokensByDay: DaySeries;
  shippedByDay: DaySeries;
  commitsByDay?: DaySeries;
  sessionsByDay?: DaySeries;
}): ScoreResult {
  const { window, nowMs, tokensByDay, shippedByDay, commitsByDay, sessionsByDay } = input;
  const windowDays = WINDOW_DAYS[window];
  const noDecay = window === 'all';
  const cutoffMs = noDecay ? Number.NEGATIVE_INFINITY : Math.floor(nowMs / DAY_MS) * DAY_MS - (windowDays - 1) * DAY_MS;
  const activeDays = new Set<string>();

  let tokensDecayed = 0;
  let shippedDecayed = 0;
  let tokensTotal = 0;
  let shippedTotal = 0;
  let commitTotal = 0;
  let sessionsTotal = 0;

  const inWindow = (day: string): { ok: boolean; weight: number } => {
    const dayMs = parseDayMs(day);
    if (!Number.isFinite(dayMs) || dayMs < cutoffMs) {
      return { ok: false, weight: 0 };
    }
    const ageDays = Math.max(0, (nowMs - dayMs) / DAY_MS);
    return { ok: true, weight: noDecay ? 1 : Math.exp(-ageDays / SCORE_TAU_DAYS) };
  };

  for (const [day, tokens] of tokensByDay) {
    const { ok, weight } = inWindow(day);
    if (!ok) continue;
    tokensDecayed += weight * tokens;
    tokensTotal += tokens;
    if (tokens > 0) activeDays.add(day);
  }

  for (const [day, shipped] of shippedByDay) {
    const { ok, weight } = inWindow(day);
    if (!ok) continue;
    shippedDecayed += weight * shipped;
    shippedTotal += shipped;
    if (shipped > 0) activeDays.add(day);
  }

  if (commitsByDay) {
    for (const [day, commits] of commitsByDay) {
      if (inWindow(day).ok) commitTotal += commits;
    }
  }

  if (sessionsByDay) {
    for (const [day, sessions] of sessionsByDay) {
      if (inWindow(day).ok) sessionsTotal += sessions;
    }
  }

  const denom = Math.min(windowDays, CONSISTENCY_DENOM_CAP);
  const consistency = 0.4 + 0.6 * Math.sqrt(Math.min(activeDays.size, denom) / denom);
  const score = Math.sqrt(Math.log1p(tokensDecayed) * Math.log1p(shippedDecayed)) * consistency;

  return { score, tokensTotal, shippedTotal, commitTotal, sessionsTotal, daysActive: activeDays.size };
}

/** Build a contiguous daily array of `spanDays` ending today (last element = today). */
function buildSeriesArray(series: DaySeries, nowMs: number, spanDays: number): number[] {
  const out = new Array<number>(spanDays).fill(0);
  const todayMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
  for (const [day, value] of series) {
    const dayMs = parseDayMs(day);
    if (!Number.isFinite(dayMs)) continue;
    const idx = spanDays - 1 - Math.round((todayMs - dayMs) / DAY_MS);
    if (idx >= 0 && idx < spanDays) out[idx] = value;
  }
  return out;
}

/**
 * Composite-score momentum per day over `spanDays` ending today: for each day,
 * the score over the trailing 30 days using the SAME formula as computeScore
 * (geomean of log1p(tokens)·log1p(shipped) × consistency). Single O(days) pass
 * with rolling 30-day sums + active-day count. Note: trailing-window, so it does
 * NOT apply the per-day τ-decay computeScore uses for the lifetime rank — it's a
 * recent-momentum view, deliberately cheap (no O(days²) per-day re-score).
 */
function buildScorePerDay(tokensByDay: DaySeries, shippedByDay: DaySeries, nowMs: number, spanDays: number): number[] {
  const tok = buildSeriesArray(tokensByDay, nowMs, spanDays);
  const ship = buildSeriesArray(shippedByDay, nowMs, spanDays);
  const W = CONSISTENCY_DENOM_CAP; // 30-day trailing window (matches consistency denom)
  const out = new Array<number>(spanDays).fill(0);
  let tSum = 0;
  let sSum = 0;
  let active = 0;
  const isActive = (i: number): number => ((tok[i] ?? 0) > 0 || (ship[i] ?? 0) > 0 ? 1 : 0);
  for (let i = 0; i < spanDays; i += 1) {
    tSum += tok[i] ?? 0;
    sSum += ship[i] ?? 0;
    active += isActive(i);
    if (i >= W) {
      tSum -= tok[i - W] ?? 0;
      sSum -= ship[i - W] ?? 0;
      active -= isActive(i - W);
    }
    const consistency = 0.4 + 0.6 * Math.sqrt(Math.min(active, W) / W);
    out[i] = Math.round(Math.sqrt(Math.log1p(tSum) * Math.log1p(sSum)) * consistency * 1000) / 1000;
  }
  return out;
}

/** Per-day dominant (most-tokens) model name over `spanDays` ending today; '' for idle days. */
function buildDominantModelArray(aggRows: DailyAggRow[], nowMs: number, spanDays: number): string[] {
  const todayMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const tokensByDayModel = new Map<number, Map<string, number>>();
  for (const row of aggRows) {
    const dayMs = parseDayMs(row.date);
    if (!Number.isFinite(dayMs)) continue;
    const idx = spanDays - 1 - Math.round((todayMs - dayMs) / DAY_MS);
    if (idx < 0 || idx >= spanDays) continue;
    let perModel = tokensByDayModel.get(idx);
    if (!perModel) { perModel = new Map(); tokensByDayModel.set(idx, perModel); }
    perModel.set(row.model, (perModel.get(row.model) ?? 0) + Number(row.total_tokens));
  }
  const out = new Array<string>(spanDays).fill('');
  for (const [idx, perModel] of tokensByDayModel) {
    let bestModel = '';
    let bestTokens = -1;
    for (const [model, tokens] of perModel) {
      if (tokens > bestTokens) { bestTokens = tokens; bestModel = model; }
    }
    out[idx] = bestModel;
  }
  return out;
}

type DailyAggRow = {
  profile_id: string;
  date: string;
  total_tokens: number | string;
  total_sessions: number;
  source: string;
  model: string;
  cost_usd_total?: number | string | null;
};
type ContribRow = { profile_id: string; day: string; shipped_loc: number | string; commit_count: number };

type SessionRow = {
  profile_id: string;
  first_event_at: string;
  last_event_at: string;
  total_tokens: number | string | null;
  active_seconds: number | null;
  longest_active_seconds: number | null;
  // For per-model cost (models.dev rates × source-aware token breakdown).
  source: string;
  model: string;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  cache_create_tokens: number | string | null;
  cached_tokens: number | string | null;
  reasoning_tokens: number | string | null;
  cost_usd_total?: number | string | null;
};

type ProfileSeries = {
  tokensByDay: DaySeries;
  sessionsByDay: DaySeries;
  shippedByDay: DaySeries;
  commitsByDay: DaySeries;
  aggRows: DailyAggRow[];
  sessions: SessionRow[];
  eventBacked: boolean;
};

function emptySeries(): ProfileSeries {
  return {
    tokensByDay: new Map(),
    sessionsByDay: new Map(),
    shippedByDay: new Map(),
    commitsByDay: new Map(),
    aggRows: [],
    sessions: [],
    eventBacked: false,
  };
}

// Preferred: the agent computes per-session active time (total + longest
// uninterrupted stretch) from event timestamps and stores them. For rows
// ingested before that existed, fall back to the first→last span capped at 8h
// (an uncapped span over-counts a session_id reused across days of idle gaps).
const MAX_SESSION_SECONDS = 8 * 60 * 60;

export type WindowSessionMetrics = {
  hourly: number[];
  dow: number[]; // sessions per weekday, Mon-indexed (0=Mon … 6=Sun)
  after_midnight: { count: number; pct: number };
  weekend_share: number;
  longest_session_seconds: number;
  longest_session_date: string | null;
  median_session_seconds: number;
  total_session_time_seconds: number;
  sessions_over_1h: number;
  largest_tokens_session_tokens: number;
  largest_tokens_session_date: string | null;
};

/** Hour-of-day histogram + session-duration stats from raw sessions (event timestamps). */
export function computeSessionMetrics(sessions: SessionRow[], window: ProfileWindow, nowMs: number): WindowSessionMetrics {
  const windowDays = WINDOW_DAYS[window];
  const cutoffMs = window === 'all' ? Number.NEGATIVE_INFINITY : Math.floor(nowMs / DAY_MS) * DAY_MS - (windowDays - 1) * DAY_MS;
  const hourly = new Array<number>(24).fill(0);
  const dow = new Array<number>(7).fill(0); // sessions per weekday, Mon-indexed
  const durations: number[] = [];
  let afterMidnight = 0;
  let weekend = 0;
  let total = 0;
  let totalDurSec = 0;
  let over1h = 0;
  let longestSec = 0;
  let longestDate: string | null = null;
  let largestTokens = 0;
  let largestTokensDate: string | null = null;

  for (const session of sessions) {
    const endMs = Date.parse(session.last_event_at);
    if (!Number.isFinite(endMs) || endMs < cutoffMs) continue;
    total += 1;
    const end = new Date(endMs);
    const hour = end.getUTCHours();
    hourly[hour] = (hourly[hour] ?? 0) + 1;
    if (hour < 6) afterMidnight += 1;
    const dowOfDay = end.getUTCDay(); // 0=Sun … 6=Sat
    if (dowOfDay === 0 || dowOfDay === 6) weekend += 1;
    const dowIdx = (dowOfDay + 6) % 7; // remap to Mon-indexed (0=Mon … 6=Sun)
    dow[dowIdx] = (dow[dowIdx] ?? 0) + 1;
    const startMs = Date.parse(session.first_event_at);
    const cappedSpanSec = Number.isFinite(startMs)
      ? Math.min(Math.max(0, (endMs - startMs) / 1000), MAX_SESSION_SECONDS)
      : 0;
    // Prefer the agent-computed active time; fall back to the capped span.
    const activeSec = session.active_seconds ?? cappedSpanSec;
    const longestStretchSec = session.longest_active_seconds ?? cappedSpanSec;
    durations.push(activeSec);
    totalDurSec += activeSec;
    if (longestStretchSec > longestSec) {
      longestSec = longestStretchSec;
      longestDate = end.toISOString();
    }
    if (activeSec > 3600) over1h += 1;
    const tokens = Number(session.total_tokens ?? 0);
    if (tokens > largestTokens) {
      largestTokens = tokens;
      largestTokensDate = end.toISOString();
    }
  }

  durations.sort((a, b) => a - b);
  const median = durations.length > 0 ? durations[Math.floor(durations.length / 2)] ?? 0 : 0;

  return {
    hourly,
    dow,
    after_midnight: { count: afterMidnight, pct: total > 0 ? afterMidnight / total : 0 },
    weekend_share: total > 0 ? weekend / total : 0,
    longest_session_seconds: Math.round(longestSec),
    longest_session_date: longestDate,
    median_session_seconds: Math.round(median),
    total_session_time_seconds: Math.round(totalDurSec),
    sessions_over_1h: over1h,
    largest_tokens_session_tokens: largestTokens,
    largest_tokens_session_date: largestTokensDate,
  };
}

/** Current/longest consecutive-active-day streaks over sorted 'YYYY-MM-DD' dates. */
export function computeStreaksFromDates(sortedDates: string[], nowMs: number): { current: number; longest: number } {
  if (sortedDates.length === 0) return { current: 0, longest: 0 };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < sortedDates.length; i += 1) {
    const gap = Math.round((parseDayMs(sortedDates[i]!) - parseDayMs(sortedDates[i - 1]!)) / DAY_MS);
    run = gap === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  const todayMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const lastMs = parseDayMs(sortedDates[sortedDates.length - 1]!);
  let current = 0;
  if (todayMs - lastMs <= DAY_MS) {
    current = 1;
    for (let i = sortedDates.length - 1; i > 0; i -= 1) {
      if (Math.round((parseDayMs(sortedDates[i]!) - parseDayMs(sortedDates[i - 1]!)) / DAY_MS) === 1) current += 1;
      else break;
    }
  }
  return { current, longest };
}

export type ModelMetric = {
  model: string;
  tokens: number;
  tokens14dCurr: number;
  tokens14dPrev: number;
};

export type WindowRichMetrics = {
  models: ModelMetric[];
  distinctModels: number;
  tools: { claude: number; codex: number };
  currentStreak: number;
  longestStreak: number;
  firstModel: { name: string; date: string } | null;
  latestModel: { name: string; date: string } | null;
};

type ModelStat = { tokens: number; first: string; last: string; curr14: number; prev14: number };

/** Model/source breakdown and streaks from daily_aggregates rows. (Day-of-week
 * session histogram lives in computeSessionMetrics so it matches the hourly one.) */
export function computeWindowRichMetrics(rows: DailyAggRow[], window: ProfileWindow, nowMs: number): WindowRichMetrics {
  const windowDays = WINDOW_DAYS[window];
  const cutoffMs = window === 'all' ? Number.NEGATIVE_INFINITY : Math.floor(nowMs / DAY_MS) * DAY_MS - (windowDays - 1) * DAY_MS;
  const curr14Ms = nowMs - 14 * DAY_MS;
  const prev14Ms = nowMs - 28 * DAY_MS;
  const modelStat = new Map<string, ModelStat>();
  const tools = { claude: 0, codex: 0, opencode: 0 };
  const activeDates = new Set<string>();

  for (const row of rows) {
    const dayMs = parseDayMs(row.date);
    if (dayMs < cutoffMs) continue;
    const tokens = Number(row.total_tokens);
    let stat = modelStat.get(row.model);
    if (!stat) {
      stat = { tokens: 0, first: row.date, last: row.date, curr14: 0, prev14: 0 };
      modelStat.set(row.model, stat);
    }
    stat.tokens += tokens;
    if (row.date < stat.first) stat.first = row.date;
    if (row.date > stat.last) stat.last = row.date;
    if (dayMs >= curr14Ms) stat.curr14 += tokens;
    else if (dayMs >= prev14Ms) stat.prev14 += tokens;
    if (row.source === 'claude' || row.source === 'codex' || row.source === 'opencode') tools[row.source] += tokens;
    activeDates.add(row.date);
  }

  const models: ModelMetric[] = Array.from(modelStat.entries())
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, 10)
    .map(([model, s]) => ({ model, tokens: s.tokens, tokens14dCurr: s.curr14, tokens14dPrev: s.prev14 }));

  // First/latest model = the model carrying the earliest / most-recent activity day in-window.
  let firstModel: { name: string; date: string } | null = null;
  let latestModel: { name: string; date: string } | null = null;
  for (const [model, s] of modelStat.entries()) {
    if (!firstModel || s.first < firstModel.date) firstModel = { name: model, date: s.first };
    if (!latestModel || s.last > latestModel.date) latestModel = { name: model, date: s.last };
  }

  const { current, longest } = computeStreaksFromDates(Array.from(activeDates).sort(), nowMs);

  return {
    models,
    distinctModels: modelStat.size,
    tools,
    currentStreak: current,
    longestStreak: longest,
    firstModel,
    latestModel,
  };
}

type SupabaseLike = Pick<typeof adminClient, 'from'>;

async function loadAll<T>(client: SupabaseLike, table: string, columns: string): Promise<T[]> {
  const rows: T[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client.from(table).select(columns).range(from, from + pageSize - 1).returns<T[]>();
    if (error) throw new Error(`[scoring] ${table} load failed: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < pageSize) return rows;
  }
}

/** Loads sessions whose last_event_at falls within the last `sinceDays` days (bounded scan). */
async function loadWindowedSessions(client: SupabaseLike, sinceIso: string): Promise<SessionRow[]> {
  const rows: SessionRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from('sessions')
      .select('profile_id,first_event_at,last_event_at,total_tokens,active_seconds,longest_active_seconds,source,model,input_tokens,output_tokens,cache_read_tokens,cache_create_tokens,cached_tokens,reasoning_tokens')
      .gte('last_event_at', sinceIso)
      .range(from, from + pageSize - 1)
      .returns<SessionRow[]>();
    if (error) throw new Error(`[scoring] sessions load failed: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < pageSize) return rows;
  }
}

async function loadUsageDailyAggregates(client: SupabaseLike): Promise<DailyAggRow[]> {
  return await loadAll<DailyAggRow>(
    client,
    'usage_daily_aggregates',
    'profile_id,date,total_tokens,total_sessions,source,model,cost_usd_total',
  );
}

async function loadWindowedUsageSessions(client: SupabaseLike, sinceIso: string): Promise<SessionRow[]> {
  const rows: SessionRow[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from('usage_session_rollups')
      .select('profile_id,first_event_at,last_event_at,total_tokens,source,model,input_tokens,output_tokens,cache_read_tokens,cache_create_tokens,cached_tokens,reasoning_tokens,cost_usd_total')
      .gte('last_event_at', sinceIso)
      .range(from, from + pageSize - 1)
      .returns<SessionRow[]>();

    if (error) {
      throw new Error(`[scoring] usage_session_rollups load failed: ${error.message}`);
    }

    rows.push(...(data ?? []));

    if ((data ?? []).length < pageSize) {
      return rows;
    }
  }
}

/** Load model_pricing into a Map for per-model cost. Small reference table. */
async function loadModelPricing(client: SupabaseLike): Promise<PricingMap> {
  const { data, error } = await client
    .from('model_pricing')
    .select('provider,model_id,input_per_mtok,output_per_mtok,cache_read_per_mtok,cache_write_per_mtok')
    .returns<Array<{
      provider: string; model_id: string;
      input_per_mtok: number | null; output_per_mtok: number | null;
      cache_read_per_mtok: number | null; cache_write_per_mtok: number | null;
    }>>();
  if (error) throw new Error(`[scoring] model_pricing load failed: ${error.message}`);
  const map: PricingMap = new Map();
  for (const r of data ?? []) {
    map.set(pricingKey(r.provider, r.model_id), {
      input: r.input_per_mtok,
      output: r.output_per_mtok,
      cache_read: r.cache_read_per_mtok,
      cache_write: r.cache_write_per_mtok,
    });
  }
  return map;
}

type WindowCost = { costUsd: number; mostExpensiveUsd: number; mostExpensiveDate: string | null };

/** Sum API-equivalent cost over sessions in the window, and track the single
 * most-expensive session (by real cost) for the headline stat. */
function computeWindowCost(
  sessions: SessionRow[],
  window: ProfileWindow,
  nowMs: number,
  pricing: PricingMap,
  unmatched: Set<string>,
): WindowCost {
  const windowDays = WINDOW_DAYS[window];
  const cutoffMs = window === 'all' ? Number.NEGATIVE_INFINITY : Math.floor(nowMs / DAY_MS) * DAY_MS - (windowDays - 1) * DAY_MS;
  let cost = 0;
  let mostExpensiveUsd = 0;
  let mostExpensiveDate: string | null = null;
  for (const s of sessions) {
    const endMs = Date.parse(s.last_event_at);
    if (!Number.isFinite(endMs) || endMs < cutoffMs) continue;
    const storedCost = s.cost_usd_total == null ? null : Number(s.cost_usd_total);
    const sessionCost = storedCost !== null && Number.isFinite(storedCost)
      ? Math.max(0, storedCost)
      : costForSession({
        source: s.source,
        model: s.model,
        input_tokens: Number(s.input_tokens ?? 0),
        output_tokens: Number(s.output_tokens ?? 0),
        cache_read_tokens: Number(s.cache_read_tokens ?? 0),
        cache_create_tokens: Number(s.cache_create_tokens ?? 0),
        cached_tokens: Number(s.cached_tokens ?? 0),
        reasoning_tokens: Number(s.reasoning_tokens ?? 0),
      }, pricing).costUsd;

    cost += sessionCost;
    if (sessionCost > mostExpensiveUsd) {
      mostExpensiveUsd = sessionCost;
      mostExpensiveDate = new Date(endMs).toISOString();
    }

    if (storedCost === null && s.model) {
      const result = costForSession({
        source: s.source,
        model: s.model,
        input_tokens: Number(s.input_tokens ?? 0),
        output_tokens: Number(s.output_tokens ?? 0),
        cache_read_tokens: Number(s.cache_read_tokens ?? 0),
        cache_create_tokens: Number(s.cache_create_tokens ?? 0),
        cached_tokens: Number(s.cached_tokens ?? 0),
        reasoning_tokens: Number(s.reasoning_tokens ?? 0),
      }, pricing);

      if (!result.matched) unmatched.add(`${s.source}:${s.model}`);
    }
  }
  return { costUsd: cost, mostExpensiveUsd, mostExpensiveDate };
}

export type RebuildResult = { profiles: number; rowsUpserted: number; unmatchedModels?: string[] };

/**
 * Recompute profile_summary for all active profiles across every window, then
 * rank by score within each window. Single linear pass over the two daily
 * series — bounded by profiles × days, all pre-aggregated.
 */
export async function rebuildProfileSummaries(options: {
  supabaseClient?: SupabaseLike;
  nowMs?: number;
} = {}): Promise<RebuildResult> {
  const client = options.supabaseClient ?? adminClient;
  const nowMs = options.nowMs ?? Date.now();

  // Load sessions across the full history (bounded to the 5-year series ceiling)
  // so the 'all' window's duration/total/cost stats are all-time, matching the
  // charts. NOTE: this scans the sessions table — the largest one — so before
  // prod scale this should move to a set-based SQL rollup (per-profile dirty queue).
  const sinceIso = new Date(nowMs - MAX_SERIES_DAYS * DAY_MS).toISOString();
  const [legacyAggRows, usageAggRows, contribRows, legacySessionRows, usageSessionRows, pricing, profiles] = await Promise.all([
    loadAll<DailyAggRow>(client, 'daily_aggregates', 'profile_id,date,total_tokens,total_sessions,source,model'),
    loadUsageDailyAggregates(client),
    loadAll<ContribRow>(client, 'contrib_daily', 'profile_id,day,shipped_loc,commit_count'),
    loadWindowedSessions(client, sinceIso),
    loadWindowedUsageSessions(client, sinceIso),
    loadModelPricing(client),
    loadAll<{ id: string }>(client, 'profiles', 'id'),
  ]);
  const eventBackedProfiles = new Set(usageAggRows.map((row) => row.profile_id));
  const aggRows = [
    ...usageAggRows,
    ...legacyAggRows.filter((row) => !eventBackedProfiles.has(row.profile_id)),
  ];
  const sessionRows = [
    ...usageSessionRows,
    ...legacySessionRows.filter((row) => !eventBackedProfiles.has(row.profile_id)),
  ];
  // Models seen in sessions with no models.dev rate contribute $0 cost and are
  // surfaced in the result. We do not fabricate blended fallback costs.
  const unmatchedModels = new Set<string>();

  const byProfile = new Map<string, ProfileSeries>();
  const ensure = (id: string): ProfileSeries => {
    let s = byProfile.get(id);
    if (!s) { s = emptySeries(); byProfile.set(id, s); }
    return s;
  };

  for (const row of aggRows) {
    const s = ensure(row.profile_id);
    s.eventBacked = eventBackedProfiles.has(row.profile_id);
    s.tokensByDay.set(row.date, (s.tokensByDay.get(row.date) ?? 0) + Number(row.total_tokens));
    s.sessionsByDay.set(row.date, (s.sessionsByDay.get(row.date) ?? 0) + row.total_sessions);
    s.aggRows.push(row);
  }
  for (const row of contribRows) {
    const s = ensure(row.profile_id);
    s.shippedByDay.set(row.day, (s.shippedByDay.get(row.day) ?? 0) + Number(row.shipped_loc));
    s.commitsByDay.set(row.day, (s.commitsByDay.get(row.day) ?? 0) + row.commit_count);
  }
  for (const row of sessionRows) {
    ensure(row.profile_id).sessions.push(row);
  }

  const computedAt = new Date(nowMs).toISOString();
  // An empty replacement must clear the previous summary as well.
  for (const profile of profiles) ensure(profile.id);
  const rows: Record<string, unknown>[] = [];
  // Collect per-window scores so we can rank after building every profile's row.
  const sessionCounts = await loadAll<{ profile_id: string; date: string; total_sessions: number }>(client, 'published_usage_session_counts', 'profile_id,date,total_sessions');
  const withSessionCounts = new Set(sessionCounts.map((row) => row.profile_id));
  for (const profileId of withSessionCounts) byProfile.get(profileId)?.sessionsByDay.clear();
  for (const row of sessionCounts) {
    const series = byProfile.get(row.profile_id);
    if (series) series.sessionsByDay.set(row.date, (series.sessionsByDay.get(row.date) ?? 0) + Number(row.total_sessions));
  }

  const scoresByWindow: Record<ProfileWindow, Array<{ profileId: string; score: number }>> = {
    '24h': [], '7d': [], '30d': [], all: [],
  };

  for (const [profileId, series] of byProfile) {
    // All-time activity range: aggRows span full history; sessions (90d window)
    // refine the most recent timestamp. ISO strings compare lexicographically.
    let firstSessionAt: string | null = null;
    let lastSessionAt: string | null = null;
    for (const aggRow of series.aggRows) {
      if (firstSessionAt === null || aggRow.date < firstSessionAt) firstSessionAt = aggRow.date;
      if (lastSessionAt === null || aggRow.date > lastSessionAt) lastSessionAt = aggRow.date;
    }
    for (const sessionRow of series.sessions) {
      if (firstSessionAt === null || sessionRow.first_event_at < firstSessionAt) firstSessionAt = sessionRow.first_event_at;
      if (lastSessionAt === null || sessionRow.last_event_at > lastSessionAt) lastSessionAt = sessionRow.last_event_at;
    }
    // Normalize to full ISO datetimes — daily_aggregates.date is date-only, but
    // the profile data_range schema requires z.string().datetime().
    firstSessionAt = firstSessionAt && !Number.isNaN(Date.parse(firstSessionAt)) ? new Date(firstSessionAt).toISOString() : null;
    lastSessionAt = lastSessionAt && !Number.isNaN(Date.parse(lastSessionAt)) ? new Date(lastSessionAt).toISOString() : null;

    // Chart series cover the full activity range (first active day → today), clamped
    // to [90, 1825] days. Same for every window since it's a presentation timeline.
    // Anchor to the earliest of ANY activity — tokens, shipped LOC, or commits —
    // so e.g. GitHub history older than the first token session still renders.
    const todayMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
    let earliestMs = firstSessionAt ? Date.parse(firstSessionAt) : Number.POSITIVE_INFINITY;
    for (const dayMap of [series.tokensByDay, series.shippedByDay, series.commitsByDay]) {
      for (const day of dayMap.keys()) {
        const ms = parseDayMs(day);
        if (Number.isFinite(ms) && ms < earliestMs) earliestMs = ms;
      }
    }
    const rawSpan = Number.isFinite(earliestMs)
      ? Math.round((todayMs - earliestMs) / DAY_MS) + 1
      : MIN_SERIES_DAYS;
    const spanDays = Math.min(MAX_SERIES_DAYS, Math.max(MIN_SERIES_DAYS, rawSpan));

    for (const window of WINDOWS) {
      const r = computeScore({
        window,
        nowMs,
        tokensByDay: series.tokensByDay,
        shippedByDay: series.shippedByDay,
        commitsByDay: series.commitsByDay,
        sessionsByDay: series.sessionsByDay,
      });

      scoresByWindow[window].push({ profileId, score: r.score });

      const rich = computeWindowRichMetrics(series.aggRows, window, nowMs);
      const sessionMetrics = computeSessionMetrics(series.sessions, window, nowMs);
      const windowCost = computeWindowCost(series.sessions, window, nowMs, pricing, unmatchedModels);
      if (series.sessions.length === 0 && series.eventBacked) {
        const cutoff = window === 'all' ? -Infinity : nowMs - WINDOW_DAYS[window] * DAY_MS;
        windowCost.costUsd = series.aggRows.reduce((sum, row) =>
          parseDayMs(row.date) >= cutoff ? sum + Number(row.cost_usd_total ?? 0) : sum, 0);
      }

      rows.push({
        profile_id: profileId,
        window,
        score: r.score,
        tokens_total: r.tokensTotal,
        cost_usd_total: Number(windowCost.costUsd.toFixed(4)),
        shipped_loc_total: r.shippedTotal,
        commit_count_total: r.commitTotal,
        sessions_count: r.sessionsTotal,
        days_active: r.daysActive,
        metrics: {
          daily_tokens_90d: buildSeriesArray(series.tokensByDay, nowMs, spanDays),
          daily_sessions_90d: buildSeriesArray(series.sessionsByDay, nowMs, spanDays),
          shipped_loc_per_day_90d: buildSeriesArray(series.shippedByDay, nowMs, spanDays),
          shipped_commit_per_day_90d: buildSeriesArray(series.commitsByDay, nowMs, spanDays),
          score_per_day_90d: buildScorePerDay(series.tokensByDay, series.shippedByDay, nowMs, spanDays),
          dominant_model_per_day_90d: buildDominantModelArray(series.aggRows, nowMs, spanDays),
          models: rich.models,
          distinct_models: rich.distinctModels,
          first_model: rich.firstModel,
          latest_model: rich.latestModel,
          tools: rich.tools,
          dow: sessionMetrics.dow,
          current_streak: rich.currentStreak,
          longest_streak: rich.longestStreak,
          hourly: sessionMetrics.hourly,
          after_midnight: sessionMetrics.after_midnight,
          weekend_share: sessionMetrics.weekend_share,
          longest_session_seconds: sessionMetrics.longest_session_seconds,
          longest_session_date: sessionMetrics.longest_session_date,
          median_session_seconds: sessionMetrics.median_session_seconds,
          total_session_time_seconds: sessionMetrics.total_session_time_seconds,
          sessions_over_1h: sessionMetrics.sessions_over_1h,
          largest_tokens_session_tokens: sessionMetrics.largest_tokens_session_tokens,
          largest_tokens_session_date: sessionMetrics.largest_tokens_session_date,
          // Real per-model cost: the genuinely most-expensive session (by USD), not
          // the most-tokens one — a small high-output session can outcost a big cached one.
          most_expensive_session_cost_usd: Number(windowCost.mostExpensiveUsd.toFixed(4)),
          most_expensive_session_date: windowCost.mostExpensiveDate,
          first_session_at: firstSessionAt,
          last_session_at: lastSessionAt,
        },
        computed_at: computedAt,
      });
    }
  }

  // Rank within each window by score desc; attach rank/percentile/total_ranked.
  const rankByKey = new Map<string, { rank: number; percentile: number; total: number }>();
  for (const window of WINDOWS) {
    const ranked = scoresByWindow[window]
      .filter((entry) => entry.score > 0)
      .sort((a, b) => (b.score - a.score) || a.profileId.localeCompare(b.profileId));
    const total = ranked.length;
    ranked.forEach((entry, index) => {
      const rank = index + 1;
      const percentile = total > 0 ? Math.round(((total - rank + 1) / total) * 1000) / 10 : null;
      rankByKey.set(`${entry.profileId}:${window}`, { rank, percentile: percentile ?? 0, total });
    });
  }

  for (const row of rows) {
    const key = `${row.profile_id as string}:${row.window as string}`;
    const ranked = rankByKey.get(key);
    row.rank = ranked?.rank ?? null;
    row.percentile = ranked?.percentile ?? null;
    row.total_ranked = ranked?.total ?? 0;
    row.rank_delta = null; // populated by leaderboard-rank against leaderboard_previous
  }

  // Upsert in batches.
  const batchSize = 500;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await client.from('profile_summary').upsert(batch, { onConflict: 'profile_id,window' });
    if (error) throw new Error(`[scoring] profile_summary upsert failed: ${error.message}`);
  }

  return {
    profiles: byProfile.size,
    rowsUpserted: rows.length,
    ...(unmatchedModels.size > 0 ? { unmatchedModels: Array.from(unmatchedModels) } : {}),
  };
}
