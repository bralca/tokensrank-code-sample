import type { ProfileWindow } from '@tokensrank/shared';

import { adminClient } from '../clients/supabase';

// DEAD CODE: this module's cron is unregistered; only computeTierProgression is
// still imported (by profile.ts). Cost now comes from models.dev pricing in
// scoring.ts — the blended estimator is gone. This local stub keeps the dead
// paths compiling without a hardcoded rate; they do not run.
const computeProfileCostUsd = (_input: { tokensTotal: number }): number => 0;

type Source = 'claude' | 'codex';

type ProfileRow = {
  id: string;
};

type SessionRow = {
  profile_id: string;
  session_id: string;
  source: Source;
  model: string | null;
  file_sha256: string;
  first_event_at: string;
  last_event_at: string;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  cache_create_tokens: number | string | null;
  cached_tokens: number | string | null;
  reasoning_tokens: number | string | null;
  total_tokens: number | string | null;
  turns: number | string | null;
  fingerprint: Record<string, unknown> | null;
};

type ParallelismBucket = {
  label: string;
  sessions_count: number;
  percentage: number;
};

type WindowMetric = {
  profileId: string;
  window: ProfileWindow;
  rank: number | null;
  rank30dAgo: number | null;
  percentile: number | null;
  totalRanked: number;
  tokensTotal: number;
  sessionsCount: number;
  daysActive: number;
  currentStreak: number;
  longestStreak: number;
  afterMidnightCount: number;
  afterMidnightPct: number;
  weekendShare: number;
  avgConcurrent: number;
  daysParallel3: number;
  longestSustained3Seconds: number;
  peakDaily: number[];
  peakEver: number;
  peakEverDate: string;
  peakEverTime: string;
  parallelismBuckets: ParallelismBucket[];
  longestSessionSeconds: number;
  longestSessionDate: string;
  largestTokensSessionTokens: number;
  largestTokensSessionDate: string;
  mostExpensiveSessionCostUsd: number;
  mostExpensiveSessionDate: string;
  medianSessionSeconds: number;
  sessionsOver1h: number;
  totalSessionTimeSeconds: number;
  cacheHitRate: number;
  firstModelName: string | null;
  firstModelDate: string | null;
  latestModelName: string | null;
  latestModelDate: string | null;
  topModelBySessions: string | null;
  distinctModels: number;
  toolBothDays: number;
  toolDaysObserved: number;
  dailyTokens90d: number[];
  dailySessions90d: number[];
  dailyPeakConcurrent90d: number[];
  streakBands: Array<{ from_date: string; to_date: string; length: number }>;
  dominantModelPerDay90d: string[];
  modelMetrics90d: Array<{ model: string; tokens_total: number; tokens_14d_prev: number; tokens_14d_curr: number; trend: 'up' | 'down' | 'flat' }>;
  tierProgression: { tier: 1 | 2 | 3 | 4 | 5; days_at_tier: number; unlocked: number[]; highest_unlocked: 1 | 2 | 3 | 4 | 5 };
  firstSessionAt: string | null;
  lastSessionAt: string | null;
};

const windows = ['7d', '30d', 'all'] as const satisfies readonly ProfileWindow[];
const pageSize = 1000;
const upsertBatchSize = 500;
const hourMs = 60 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;

function parseNumeric(value: number | string | null | undefined): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function roundCurrency(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentages(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);

  if (total <= 0 || values.length === 0) {
    return values.map(() => 0);
  }

  const rounded = values.map((value) => roundPercent((value / total) * 100));
  const delta = roundPercent(100 - rounded.reduce((sum, value) => sum + value, 0));

  rounded[rounded.length - 1] = roundPercent((rounded[rounded.length - 1] ?? 0) + delta);

  return rounded;
}

function dateOnly(value: string | null | undefined): string {
  const date = new Date(value ?? '');

  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function startDateForWindow(window: ProfileWindow): Date | null {
  if (window === 'all') {
    return null;
  }

  return new Date(Date.now() - (window === '7d' ? 7 : 30) * dayMs);
}

function applySessionWindow(rows: SessionRow[], window: ProfileWindow): SessionRow[] {
  const startDate = startDateForWindow(window);

  if (!startDate) {
    return rows;
  }

  const startMs = startDate.getTime();

  return rows.filter((row) => {
    const eventMs = new Date(row.last_event_at).getTime();

    return !Number.isNaN(eventMs) && eventMs >= startMs;
  });
}

function sessionTokens(session: SessionRow): number {
  const generatedTotal = parseNumeric(session.total_tokens);

  if (generatedTotal > 0) {
    return generatedTotal;
  }

  return parseNumeric(session.input_tokens)
    + parseNumeric(session.output_tokens)
    + parseNumeric(session.cache_read_tokens)
    + parseNumeric(session.cache_create_tokens)
    + parseNumeric(session.cached_tokens)
    + parseNumeric(session.reasoning_tokens);
}

function projectNameForSession(session: SessionRow): string | null {
  const projectName = session.fingerprint?.project_name;

  return typeof projectName === 'string' && projectName.trim() !== ''
    ? projectName.trim()
    : null;
}

async function loadProfiles(): Promise<ProfileRow[]> {
  const rows: ProfileRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await adminClient
      .from('profiles')
      .select('id')
      .range(from, from + pageSize - 1)
      .returns<ProfileRow[]>();

    if (error) {
      throw new Error(`[metrics] Profile lookup failed: ${error.message}`);
    }

    rows.push(...(data ?? []));

    if ((data ?? []).length < pageSize) {
      return rows;
    }
  }
}

async function loadSessions(): Promise<SessionRow[]> {
  const rows: SessionRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await adminClient
      .from('sessions')
      .select([
        'profile_id',
        'session_id',
        'source',
        'model',
        'file_sha256',
        'first_event_at',
        'last_event_at',
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'cache_create_tokens',
        'cached_tokens',
        'reasoning_tokens',
        'total_tokens',
        'turns',
        'fingerprint',
      ].join(','))
      .order('last_event_at', { ascending: false })
      .range(from, from + pageSize - 1)
      .returns<SessionRow[]>();

    if (error) {
      throw new Error(`[metrics] Session lookup failed: ${error.message}`);
    }

    rows.push(...(data ?? []));

    if ((data ?? []).length < pageSize) {
      return rows;
    }
  }
}

function rankSessionRows(rows: SessionRow[], window: ProfileWindow): Array<{ profileId: string; tokens: number }> {
  const totals = new Map<string, number>();

  for (const row of applySessionWindow(rows, window)) {
    totals.set(row.profile_id, (totals.get(row.profile_id) ?? 0) + sessionTokens(row));
  }

  return Array.from(totals.entries())
    .filter(([, tokens]) => tokens > 0)
    .sort((left, right) => {
      const tokenDelta = right[1] - left[1];

      return tokenDelta === 0 ? left[0].localeCompare(right[0]) : tokenDelta;
    })
    .map(([profileId, tokens]) => ({ profileId, tokens }));
}

function computeStreaks(sessions: SessionRow[]): { currentStreak: number; longestStreak: number } {
  const dates = Array.from(new Set(sessions.map((session) => dateOnly(session.last_event_at)).filter(Boolean))).sort();

  if (dates.length === 0) {
    return { currentStreak: 0, longestStreak: 0 };
  }

  let longestStreak = 1;
  let currentRun = 1;

  for (let index = 1; index < dates.length; index += 1) {
    const previous = new Date(dates[index - 1]!);
    const current = new Date(dates[index]!);
    const dayDelta = Math.round((current.getTime() - previous.getTime()) / dayMs);

    if (dayDelta === 1) {
      currentRun += 1;
      longestStreak = Math.max(longestStreak, currentRun);
    } else {
      currentRun = 1;
    }
  }

  const activeDates = new Set(dates);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  let currentStreak = 0;
  for (let cursor = new Date(today); activeDates.has(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() - 1)) {
    currentStreak += 1;
  }

  return { currentStreak, longestStreak };
}

function concurrencyEvents(sessions: SessionRow[]): Array<{ timestamp: number; type: 'start' | 'end' }> {
  const events: Array<{ timestamp: number; type: 'start' | 'end' }> = [];

  for (const session of sessions) {
    const startMs = new Date(session.first_event_at).getTime();
    const endMs = new Date(session.last_event_at).getTime();

    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
      continue;
    }

    events.push({ timestamp: startMs, type: 'start' });
    events.push({ timestamp: endMs, type: 'end' });
  }

  return events.sort((left, right) => {
    if (left.timestamp !== right.timestamp) {
      return left.timestamp - right.timestamp;
    }

    return left.type === 'start' ? -1 : 1;
  });
}

function computeAvgConcurrent(sessions: SessionRow[]): number {
  const events = concurrencyEvents(sessions);

  if (events.length === 0) {
    return 0;
  }

  let weightedMs = 0;
  let current = 0;
  let lastTimestamp = events[0]!.timestamp;

  for (const event of events) {
    if (event.timestamp > lastTimestamp && current > 0) {
      weightedMs += (event.timestamp - lastTimestamp) * current;
    }

    current = event.type === 'start' ? current + 1 : Math.max(0, current - 1);
    lastTimestamp = event.timestamp;
  }

  const spanMs = events[events.length - 1]!.timestamp - events[0]!.timestamp;

  return spanMs > 0 ? roundPercent(weightedMs / spanMs) : current;
}

function computeLongestSustained3Seconds(sessions: SessionRow[]): number {
  const events = concurrencyEvents(sessions);
  let current = 0;
  let periodStart: number | null = null;
  let longestMs = 0;

  for (const event of events) {
    if (event.type === 'start') {
      if (current < 3 && current + 1 >= 3) {
        periodStart = event.timestamp;
      }
      current += 1;
    } else {
      if (current >= 3 && current - 1 < 3 && periodStart !== null) {
        longestMs = Math.max(longestMs, event.timestamp - periodStart);
        periodStart = null;
      }
      current = Math.max(0, current - 1);
    }
  }

  return Math.floor(longestMs / 1000);
}

function maxConcurrencyForRange(sessions: SessionRow[], rangeStartMs: number, rangeEndMs: number): {
  peak: number;
  peakAt: number | null;
} {
  const events: Array<{ timestamp: number; type: 'start' | 'end' }> = [];

  for (const session of sessions) {
    const startMs = new Date(session.first_event_at).getTime();
    const endMs = new Date(session.last_event_at).getTime();

    if (
      Number.isNaN(startMs)
      || Number.isNaN(endMs)
      || endMs < startMs
      || startMs >= rangeEndMs
      || endMs <= rangeStartMs
    ) {
      continue;
    }

    events.push({ timestamp: Math.max(startMs, rangeStartMs), type: 'start' });
    events.push({ timestamp: Math.min(endMs, rangeEndMs), type: 'end' });
  }

  events.sort((left, right) => {
    if (left.timestamp !== right.timestamp) {
      return left.timestamp - right.timestamp;
    }

    return left.type === 'start' ? -1 : 1;
  });

  let current = 0;
  let peak = 0;
  let peakAt: number | null = null;

  for (const event of events) {
    if (event.type === 'start') {
      current += 1;
      if (current > peak) {
        peak = current;
        peakAt = event.timestamp;
      }
    } else {
      current = Math.max(0, current - 1);
    }
  }

  return { peak, peakAt };
}

function maxConcurrencyForDay(sessions: SessionRow[], day: string): number {
  const dayStart = new Date(`${day}T00:00:00.000Z`).getTime();

  return maxConcurrencyForRange(sessions, dayStart, dayStart + dayMs).peak;
}

function computeDaysParallel3(sessions: SessionRow[]): number {
  const days = Array.from(new Set(sessions.map((session) => dateOnly(session.last_event_at)).filter(Boolean)));

  return days.filter((day) => maxConcurrencyForDay(sessions, day) >= 3).length;
}

function buildPeakDaily(sessions: SessionRow[], days = 90): {
  peakDaily: number[];
  peakEver: number;
  peakEverDate: string;
  peakEverTime: string;
} {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const firstDayMs = today.getTime() - (days - 1) * dayMs;
  const peakDaily: number[] = [];
  let peakEver = 0;
  let peakEverAt: number | null = null;

  for (let index = 0; index < days; index += 1) {
    const rangeStartMs = firstDayMs + index * dayMs;
    const { peak, peakAt } = maxConcurrencyForRange(sessions, rangeStartMs, rangeStartMs + dayMs);

    peakDaily.push(peak);

    if (peak > peakEver) {
      peakEver = peak;
      peakEverAt = peakAt;
    }
  }

  const peakDate = peakEverAt === null ? null : new Date(peakEverAt);

  return {
    peakDaily,
    peakEver,
    peakEverDate: peakDate
      ? peakDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
      : 'N/A',
    peakEverTime: peakDate
      ? peakDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })
      : '00:00',
  };
}

function buildDailyTokens90d(sessions: SessionRow[]): number[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const firstDayMs = today.getTime() - 89 * dayMs;
  const dailyTokens: number[] = [];

  for (let i = 0; i < 90; i += 1) {
    const rangeStartMs = firstDayMs + i * dayMs;
    const rangeEndMs = rangeStartMs + dayMs;
    const dayTokens = sessions
      .filter((s) => {
        const eventMs = new Date(s.last_event_at).getTime();
        return !Number.isNaN(eventMs) && eventMs >= rangeStartMs && eventMs < rangeEndMs;
      })
      .reduce((sum, s) => sum + sessionTokens(s), 0);
    dailyTokens.push(dayTokens);
  }

  return dailyTokens;
}

function buildDailySessionCounts90d(sessions: SessionRow[]): number[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const firstDayMs = today.getTime() - 89 * dayMs;
  const dailySessions: number[] = [];

  for (let i = 0; i < 90; i += 1) {
    const rangeStartMs = firstDayMs + i * dayMs;
    const rangeEndMs = rangeStartMs + dayMs;
    const dayCount = sessions.filter((s) => {
      const eventMs = new Date(s.last_event_at).getTime();
      return !Number.isNaN(eventMs) && eventMs >= rangeStartMs && eventMs < rangeEndMs;
    }).length;
    dailySessions.push(dayCount);
  }

  return dailySessions;
}

function buildDailyPeakConcurrent90d(sessions: SessionRow[]): number[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const firstDayMs = today.getTime() - 89 * dayMs;
  const dailyPeaks: number[] = [];

  for (let i = 0; i < 90; i += 1) {
    const rangeStartMs = firstDayMs + i * dayMs;
    const peak = maxConcurrencyForRange(sessions, rangeStartMs, rangeStartMs + dayMs).peak;
    dailyPeaks.push(peak);
  }

  return dailyPeaks;
}

function computeStreakBands(sessions: SessionRow[]): Array<{ from_date: string; to_date: string; length: number }> {
  const dates = Array.from(new Set(sessions.map((s) => dateOnly(s.last_event_at)).filter(Boolean))).sort();
  if (dates.length === 0) return [];

  const bands: Array<{ from_date: string; to_date: string; length: number }> = [];
  let streakStart = dates[0]!;
  let streakLength = 1;

  for (let i = 1; i < dates.length; i += 1) {
    const prev = new Date(dates[i - 1]!);
    const curr = new Date(dates[i]!);
    const dayDelta = Math.round((curr.getTime() - prev.getTime()) / dayMs);

    if (dayDelta === 1) {
      streakLength += 1;
    } else {
      if (streakLength >= 7) {
        bands.push({ from_date: streakStart, to_date: dates[i - 1]!, length: streakLength });
      }
      streakStart = dates[i]!;
      streakLength = 1;
    }
  }

  if (streakLength >= 7) {
    bands.push({ from_date: streakStart, to_date: dates[dates.length - 1]!, length: streakLength });
  }

  return bands;
}

function buildDominantModelPerDay90d(sessions: SessionRow[]): string[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const firstDayMs = today.getTime() - 89 * dayMs;
  const dailyModels: string[] = [];

  for (let i = 0; i < 90; i += 1) {
    const rangeStartMs = firstDayMs + i * dayMs;
    const rangeEndMs = rangeStartMs + dayMs;
    const daySessions = sessions.filter((s) => {
      const eventMs = new Date(s.last_event_at).getTime();
      return !Number.isNaN(eventMs) && eventMs >= rangeStartMs && eventMs < rangeEndMs;
    });

    const modelTokens = new Map<string, number>();
    for (const session of daySessions) {
      const model = session.model ?? 'unknown';
      modelTokens.set(model, (modelTokens.get(model) ?? 0) + sessionTokens(session));
    }

    const dominant = Array.from(modelTokens.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    dailyModels.push(dominant);
  }

  return dailyModels;
}

function buildPerModelMetrics90d(sessions: SessionRow[]): Array<{ model: string; tokens_total: number; tokens_14d_prev: number; tokens_14d_curr: number; trend: 'up' | 'down' | 'flat' }> {
  const models = new Set(sessions.map((s) => s.model ?? 'unknown'));
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  return Array.from(models).map((model) => {
    const modelSessions = sessions.filter((s) => (s.model ?? 'unknown') === model);
    const tokens_total = modelSessions.reduce((sum, s) => sum + sessionTokens(s), 0);

    const cutoff14d = today.getTime() - 14 * dayMs;
    const cutoff28d = today.getTime() - 28 * dayMs;

    const tokens_14d_prev = modelSessions
      .filter((s) => {
        const eventMs = new Date(s.last_event_at).getTime();
        return !Number.isNaN(eventMs) && eventMs >= cutoff28d && eventMs < cutoff14d;
      })
      .reduce((sum, s) => sum + sessionTokens(s), 0);

    const tokens_14d_curr = modelSessions
      .filter((s) => {
        const eventMs = new Date(s.last_event_at).getTime();
        return !Number.isNaN(eventMs) && eventMs >= cutoff14d;
      })
      .reduce((sum, s) => sum + sessionTokens(s), 0);

    const trend: 'up' | 'down' | 'flat' =
      tokens_14d_prev === 0 && tokens_14d_curr > 0
        ? 'up'
        : tokens_14d_curr > tokens_14d_prev
          ? 'up'
          : tokens_14d_curr < tokens_14d_prev
            ? 'down'
            : 'flat';

    return { model, tokens_total, tokens_14d_prev, tokens_14d_curr, trend };
  });
}

function computeTierProgression(peakDaily: number[]): { tier: 1 | 2 | 3 | 4 | 5; days_at_tier: number; unlocked: number[]; highest_unlocked: 1 | 2 | 3 | 4 | 5 } {
  const tiers = [
    { min: 1, max: 1, name: 'Solo' },
    { min: 2, max: 2, name: 'Pair' },
    { min: 3, max: 5, name: 'Trio' },
    { min: 6, max: 10, name: 'Squad' },
    { min: 11, max: Infinity, name: 'Swarm' },
  ];

  const max = Math.max(...peakDaily, 0);
  let currentTier: 1 | 2 | 3 | 4 | 5 = 1;

  for (let i = 0; i < tiers.length; i += 1) {
    if (max >= tiers[i]!.min) {
      currentTier = (i + 1) as 1 | 2 | 3 | 4 | 5;
    }
  }

  const daysAtTier = peakDaily.filter((p) => {
    const tier = tiers.findIndex((t) => p >= t.min && p <= t.max);
    return (tier + 1) === currentTier;
  }).length;

  const unlocked: number[] = [];
  for (let i = 0; i < tiers.length; i += 1) {
    if (max >= tiers[i]!.min) {
      unlocked.push(i + 1);
    }
  }

  const highest_unlocked = (unlocked[unlocked.length - 1] ?? 1) as 1 | 2 | 3 | 4 | 5;

  return { tier: currentTier, days_at_tier: daysAtTier, unlocked, highest_unlocked };
}

function buildParallelismBuckets(sessions: SessionRow[]): ParallelismBucket[] {
  const byDay = new Map<string, number>();

  for (const session of sessions) {
    const date = dateOnly(session.last_event_at);

    if (!date) {
      continue;
    }

    byDay.set(date, (byDay.get(date) ?? 0) + 1);
  }

  const buckets: ParallelismBucket[] = [
    { label: '1 at a time', sessions_count: 0, percentage: 0 },
    { label: '2 parallel', sessions_count: 0, percentage: 0 },
    { label: '3+ concurrent', sessions_count: 0, percentage: 0 },
  ];

  for (const count of byDay.values()) {
    if (count <= 1) {
      buckets[0]!.sessions_count += count;
    } else if (count === 2) {
      buckets[1]!.sessions_count += count;
    } else {
      buckets[2]!.sessions_count += count;
    }
  }

  const bucketPercentages = percentages(buckets.map((bucket) => bucket.sessions_count));

  return buckets.map((bucket, index) => ({
    ...bucket,
    percentage: bucketPercentages[index] ?? 0,
  }));
}

function sessionDurationSeconds(session: SessionRow): number | null {
  const startedAtMs = new Date(session.first_event_at).getTime();
  const endedAtMs = new Date(session.last_event_at).getTime();

  if (Number.isNaN(startedAtMs) || Number.isNaN(endedAtMs) || endedAtMs < startedAtMs) {
    return null;
  }

  return Math.floor((endedAtMs - startedAtMs) / 1000);
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);

  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function computeSessionStats(sessions: SessionRow[], tokensTotal: number) {
  const rows = sessions.flatMap((session) => {
    const durationSeconds = sessionDurationSeconds(session);

    if (durationSeconds === null) {
      return [];
    }

    const tokens = sessionTokens(session);

    return [{
      durationSeconds,
      tokens,
      cost: computeProfileCostUsd({ tokensTotal: tokens }),
      date: dateOnly(session.last_event_at),
    }];
  });
  const longestSession = rows.reduce<typeof rows[number] | null>(
    (best, row) => !best || row.durationSeconds > best.durationSeconds ? row : best,
    null,
  );
  const largestTokensSession = rows.reduce<typeof rows[number] | null>(
    (best, row) => !best || row.tokens > best.tokens ? row : best,
    null,
  );
  const mostExpensiveSession = rows.reduce<typeof rows[number] | null>(
    (best, row) => !best || row.cost > best.cost ? row : best,
    null,
  );
  const cacheReadTokens = sessions.reduce((sum, session) => sum + parseNumeric(session.cache_read_tokens), 0);

  return {
    longestSessionSeconds: longestSession?.durationSeconds ?? 0,
    longestSessionDate: longestSession?.date || 'N/A',
    largestTokensSessionTokens: largestTokensSession?.tokens ?? 0,
    largestTokensSessionDate: largestTokensSession?.date || 'N/A',
    mostExpensiveSessionCostUsd: roundCurrency(mostExpensiveSession?.cost ?? 0),
    mostExpensiveSessionDate: mostExpensiveSession?.date || 'N/A',
    medianSessionSeconds: median(rows.map((row) => row.durationSeconds)),
    sessionsOver1h: rows.filter((row) => row.durationSeconds > 3600).length,
    totalSessionTimeSeconds: rows.reduce((sum, row) => sum + row.durationSeconds, 0),
    cacheHitRate: tokensTotal > 0 ? cacheReadTokens / tokensTotal : 0,
  };
}

function computeModelSummary(sessions: SessionRow[]) {
  const groups = new Map<string, { tokens: number; sessions: number }>();

  for (const session of sessions) {
    const model = session.model ?? 'unknown';
    const group = groups.get(model) ?? { tokens: 0, sessions: 0 };

    group.tokens += sessionTokens(session);
    group.sessions += 1;
    groups.set(model, group);
  }

  const firstModel = [...sessions]
    .sort((left, right) => new Date(left.first_event_at).getTime() - new Date(right.first_event_at).getTime())[0];
  const latestModel = [...sessions]
    .sort((left, right) => new Date(right.last_event_at).getTime() - new Date(left.last_event_at).getTime())[0];
  const topModelBySessions = Array.from(groups.entries())
    .sort((left, right) => {
      const sessionDelta = right[1].sessions - left[1].sessions;

      return sessionDelta === 0 ? right[1].tokens - left[1].tokens : sessionDelta;
    })[0]?.[0] ?? null;

  return {
    distinctModels: groups.size,
    topModelBySessions,
    firstModelName: firstModel?.model ?? (firstModel ? 'unknown' : null),
    firstModelDate: firstModel ? dateOnly(firstModel.first_event_at) : null,
    latestModelName: latestModel?.model ?? (latestModel ? 'unknown' : null),
    latestModelDate: latestModel ? dateOnly(latestModel.last_event_at) : null,
  };
}

function computeToolSummary(sessions: SessionRow[]) {
  const activeDays = new Set(sessions.map((session) => dateOnly(session.last_event_at)).filter(Boolean));
  const claudeDays = new Set(
    sessions.filter((session) => session.source === 'claude').map((session) => dateOnly(session.last_event_at)).filter(Boolean),
  );
  const codexDays = new Set(
    sessions.filter((session) => session.source === 'codex').map((session) => dateOnly(session.last_event_at)).filter(Boolean),
  );

  return {
    toolBothDays: new Set([...claudeDays].filter((day) => codexDays.has(day))).size,
    toolDaysObserved: activeDays.size,
  };
}

function computeWindowMetric(
  profileId: string,
  window: ProfileWindow,
  sessions: SessionRow[],
  rankedByWindow: Map<ProfileWindow, Array<{ profileId: string; tokens: number }>>,
  rank30dAgoByProfile: Map<string, number>,
): WindowMetric {
  const windowSessions = applySessionWindow(sessions, window);
  const ranked = rankedByWindow.get(window) ?? [];
  const rankIndex = ranked.findIndex((row) => row.profileId === profileId);
  const rank = rankIndex >= 0 ? rankIndex + 1 : null;
  const totalRanked = ranked.length;
  const percentile = rank && totalRanked > 0 ? ((totalRanked - rank) / totalRanked) * 100 : null;
  const tokensTotal = windowSessions.reduce((sum, session) => sum + sessionTokens(session), 0);
  const sessionsCount = windowSessions.length;
  const daysActive = new Set(windowSessions.map((session) => dateOnly(session.last_event_at)).filter(Boolean)).size;
  const { currentStreak, longestStreak } = computeStreaks(windowSessions);
  const afterMidnightCount = windowSessions.filter((session) => {
    const date = new Date(session.first_event_at);

    return !Number.isNaN(date.getTime()) && date.getUTCHours() < 6;
  }).length;
  const weekendCount = windowSessions.filter((session) => {
    const date = new Date(session.first_event_at);

    return !Number.isNaN(date.getTime()) && (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  }).length;
  const { peakDaily, peakEver, peakEverDate, peakEverTime } = buildPeakDaily(sessions, 90);
  const sessionStats = computeSessionStats(windowSessions, tokensTotal);
  const modelSummary = computeModelSummary(windowSessions);
  const toolSummary = computeToolSummary(windowSessions);

  const dailyTokens90d = buildDailyTokens90d(sessions);
  const dailySessions90d = buildDailySessionCounts90d(sessions);
  const dailyPeakConcurrent90d = buildDailyPeakConcurrent90d(sessions);
  const streakBands = computeStreakBands(sessions);
  const dominantModelPerDay90d = buildDominantModelPerDay90d(sessions);
  const modelMetrics90d = buildPerModelMetrics90d(sessions);
  const tierProgression = computeTierProgression(peakDaily);

  let firstSessionMs = Number.POSITIVE_INFINITY;
  let lastSessionMs = Number.NEGATIVE_INFINITY;
  for (const session of sessions) {
    const firstMs = new Date(session.first_event_at).getTime();
    if (!Number.isNaN(firstMs) && firstMs < firstSessionMs) {
      firstSessionMs = firstMs;
    }
    const lastMs = new Date(session.last_event_at).getTime();
    if (!Number.isNaN(lastMs) && lastMs > lastSessionMs) {
      lastSessionMs = lastMs;
    }
  }
  const firstSessionAt = Number.isFinite(firstSessionMs) ? new Date(firstSessionMs).toISOString() : null;
  const lastSessionAt = Number.isFinite(lastSessionMs) ? new Date(lastSessionMs).toISOString() : null;

  return {
    profileId,
    window,
    rank,
    rank30dAgo: rank30dAgoByProfile.get(profileId) ?? null,
    percentile,
    totalRanked,
    tokensTotal,
    sessionsCount,
    daysActive,
    currentStreak,
    longestStreak,
    afterMidnightCount,
    afterMidnightPct: windowSessions.length > 0 ? roundPercent((afterMidnightCount / windowSessions.length) * 100) : 0,
    weekendShare: windowSessions.length > 0 ? roundPercent((weekendCount / windowSessions.length) * 100) : 0,
    avgConcurrent: computeAvgConcurrent(windowSessions),
    daysParallel3: computeDaysParallel3(windowSessions),
    longestSustained3Seconds: computeLongestSustained3Seconds(windowSessions),
    peakDaily,
    peakEver,
    peakEverDate,
    peakEverTime,
    parallelismBuckets: buildParallelismBuckets(windowSessions),
    ...sessionStats,
    ...modelSummary,
    ...toolSummary,
    dailyTokens90d,
    dailySessions90d,
    dailyPeakConcurrent90d,
    streakBands,
    dominantModelPerDay90d,
    modelMetrics90d,
    tierProgression,
    firstSessionAt,
    lastSessionAt,
  };
}

function buildModelsCache(profileId: string, window: ProfileWindow, sessions: SessionRow[]) {
  const totals = new Map<string, { tokens: number; sessions: number }>();
  const totalTokens = sessions.reduce((sum, session) => sum + sessionTokens(session), 0);

  for (const session of sessions) {
    const model = session.model ?? 'unknown';
    const current = totals.get(model) ?? { tokens: 0, sessions: 0 };

    current.tokens += sessionTokens(session);
    current.sessions += 1;
    totals.set(model, current);
  }

  return Array.from(totals.entries()).map(([model, values]) => ({
    profile_id: profileId,
    window,
    model,
    tokens_total: values.tokens,
    sessions_count: values.sessions,
    cost_usd: roundCurrency(computeProfileCostUsd({ tokensTotal: values.tokens })),
    cost_usd_total: roundCurrency(computeProfileCostUsd({ tokensTotal: values.tokens })),
    pct_of_total: totalTokens > 0 ? roundPercent((values.tokens / totalTokens) * 100) : 0,
    computed_at: new Date().toISOString(),
  }));
}

function buildToolsCache(profileId: string, window: ProfileWindow, sessions: SessionRow[]) {
  const claudeTokens = sessions
    .filter((session) => session.source === 'claude')
    .reduce((sum, session) => sum + sessionTokens(session), 0);
  const codexTokens = sessions
    .filter((session) => session.source === 'codex')
    .reduce((sum, session) => sum + sessionTokens(session), 0);
  const claudeSessions = sessions.filter((session) => session.source === 'claude').length;
  const codexSessions = sessions.filter((session) => session.source === 'codex').length;
  const total = claudeTokens + codexTokens;
  const claudeCost = roundCurrency(computeProfileCostUsd({ tokensTotal: claudeTokens }));
  const codexCost = roundCurrency(computeProfileCostUsd({ tokensTotal: codexTokens }));
  const totalCost = claudeCost + codexCost;
  const { toolBothDays, toolDaysObserved } = computeToolSummary(sessions);

  return {
    profile_id: profileId,
    window,
    claude_tokens: claudeTokens,
    codex_tokens: codexTokens,
    claude_pct: total > 0 ? roundPercent((claudeTokens / total) * 100) : 0,
    codex_pct: total > 0 ? roundPercent((codexTokens / total) * 100) : 0,
    cost_usd_claude: claudeCost,
    cost_usd_codex: codexCost,
    claude_cost_pct: totalCost > 0 ? roundPercent((claudeCost / totalCost) * 100) : 0,
    codex_cost_pct: totalCost > 0 ? roundPercent((codexCost / totalCost) * 100) : 0,
    claude_sessions: claudeSessions,
    codex_sessions: codexSessions,
    both_days: toolBothDays,
    days_observed: toolDaysObserved,
    computed_at: new Date().toISOString(),
  };
}

function buildSessionsCache(profileId: string, window: ProfileWindow, sessions: SessionRow[]) {
  return sessions.slice(0, 10).map((session, index) => ({
    profile_id: profileId,
    window,
    session_rank: index + 1,
    session_id: session.session_id,
    source: session.source,
    model: session.model,
    started_at: session.first_event_at,
    ended_at: session.last_event_at,
    tokens_total: sessionTokens(session),
    cost_usd_total: roundCurrency(computeProfileCostUsd({ tokensTotal: sessionTokens(session) })),
    turns: parseNumeric(session.turns),
    project_name: projectNameForSession(session),
    file_sha256: session.file_sha256,
    computed_at: new Date().toISOString(),
  }));
}

function buildCadenceCache(profileId: string, window: ProfileWindow, sessions: SessionRow[]) {
  const hourly = new Array<number>(24).fill(0);
  const daily = new Array<number>(7).fill(0);
  const start = new Date(Date.now() - 30 * dayMs);
  const byDate = new Map<string, { date: string; tokens_total: number; sessions_count: number }>();

  for (let day = 0; day < 30; day += 1) {
    const current = new Date(start.getTime() + day * dayMs);
    const date = current.toISOString().slice(0, 10);
    byDate.set(date, { date, tokens_total: 0, sessions_count: 0 });
  }

  const hourlyCounts = new Map<string, number>();

  for (const session of sessions) {
    const startedAt = new Date(session.first_event_at);

    if (!Number.isNaN(startedAt.getTime())) {
      hourly[startedAt.getUTCHours()]! += 1;
      daily[startedAt.getUTCDay()]! += 1;
    }

    const endedAt = new Date(session.last_event_at);

    if (Number.isNaN(endedAt.getTime()) || endedAt.getTime() < start.getTime()) {
      continue;
    }

    const date = endedAt.toISOString().slice(0, 10);
    const day = byDate.get(date);

    if (day) {
      day.tokens_total += sessionTokens(session);
      day.sessions_count += 1;
    }

    const hour = String(endedAt.getUTCHours()).padStart(2, '0');
    hourlyCounts.set(hour, (hourlyCounts.get(hour) ?? 0) + 1);
  }

  const days = Array.from(byDate.values());
  const busiestDay = days.reduce<typeof days[number] | null>(
    (best, day) => !best || day.tokens_total > best.tokens_total ? day : best,
    null,
  );
  const busiestHour = Array.from(hourlyCounts.entries())
    .sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;

  return {
    profile_id: profileId,
    window,
    hourly_pattern: hourly,
    daily_pattern: daily,
    days,
    busiest_day: busiestDay && busiestDay.tokens_total > 0 ? busiestDay.date : null,
    busiest_hour: busiestHour,
    busiest_hour_of_day: busiestHour,
    busiest_day_of_week: busiestDay && busiestDay.tokens_total > 0 ? busiestDay.date : null,
    computed_at: new Date().toISOString(),
  };
}

function buildProjectsCache(profileId: string, window: ProfileWindow, sessions: SessionRow[]) {
  const groups = new Map<string, { tokens: number; cost: number; sessions: number }>();
  const totalTokens = sessions.reduce((sum, session) => sum + sessionTokens(session), 0);

  for (const session of sessions) {
    const projectName = projectNameForSession(session) ?? `${session.source}-${session.file_sha256.slice(0, 8)}`;
    const tokens = sessionTokens(session);
    const current = groups.get(projectName) ?? { tokens: 0, cost: 0, sessions: 0 };

    current.tokens += tokens;
    current.cost = roundCurrency(current.cost + computeProfileCostUsd({ tokensTotal: tokens }));
    current.sessions += 1;
    groups.set(projectName, current);
  }

  return Array.from(groups.entries()).map(([projectName, values]) => ({
    profile_id: profileId,
    window,
    project_name: projectName,
    tokens_total: values.tokens,
    cost_usd_total: values.cost,
    sessions_count: values.sessions,
    percentage: totalTokens > 0 ? roundPercent((values.tokens / totalTokens) * 100) : 0,
    computed_at: new Date().toISOString(),
  }));
}

async function deleteExistingCacheRows(): Promise<void> {
  const tables = [
    'profile_models_breakdown_cache',
    'profile_tools_breakdown_cache',
    'profile_sessions_cache',
    'profile_cadence_cache',
    'profile_projects_breakdown_cache',
  ];

  for (const table of tables) {
    const { error } = await adminClient
      .from(table)
      .delete()
      .gte('computed_at', '1970-01-01T00:00:00.000Z');

    if (error) {
      throw new Error(`[metrics] Clearing ${table} failed: ${error.message}`);
    }
  }
}

async function upsertRows(table: string, rows: unknown[], onConflict?: string): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  for (let index = 0; index < rows.length; index += upsertBatchSize) {
    const batch = rows.slice(index, index + upsertBatchSize);
    const query = adminClient.from(table).upsert(batch, onConflict ? { onConflict } : undefined);
    const { error } = await query;

    if (error) {
      throw new Error(`[metrics] Upsert into ${table} failed: ${error.message}`);
    }
  }
}

function computeHomepageStats(sessions: SessionRow[]) {
  const cutoffMs = Date.now() - 24 * hourMs;
  const recentSessions = sessions.filter((session) => {
    const eventMs = new Date(session.last_event_at).getTime();

    return !Number.isNaN(eventMs) && eventMs >= cutoffMs;
  });
  const tokensTotal = recentSessions.reduce((sum, session) => sum + sessionTokens(session), 0);

  return {
    id: 1,
    connected_count: new Set(recentSessions.map((session) => session.profile_id)).size,
    tokens_24h: tokensTotal,
    cost_24h_usd: roundCurrency(computeProfileCostUsd({ tokensTotal })),
    records_today: recentSessions.length,
    computed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + hourMs).toISOString(),
  };
}

export async function computeHourlyMetrics(): Promise<void> {
  const startedAt = Date.now();
  const [profiles, sessions] = await Promise.all([
    loadProfiles(),
    loadSessions(),
  ]);
  const rankedByWindow = new Map<ProfileWindow, Array<{ profileId: string; tokens: number }>>(
    windows.map((window) => [window, rankSessionRows(sessions, window)]),
  );
  const thirtyDaysAgoMs = Date.now() - 30 * dayMs;
  const rankedThirtyDaysAgo = rankSessionRows(
    sessions.filter((session) => {
      const eventMs = new Date(session.last_event_at).getTime();

      return !Number.isNaN(eventMs) && eventMs < thirtyDaysAgoMs;
    }),
    'all',
  );
  const rank30dAgoByProfile = new Map(
    rankedThirtyDaysAgo.map((row, index) => [row.profileId, index + 1]),
  );
  const snapshotHour = new Date();
  snapshotHour.setMinutes(0, 0, 0);

  const metricsRows = [];
  const snapshotRows = [];
  const modelRows = [];
  const toolRows = [];
  const sessionRows = [];
  const cadenceRows = [];
  const projectRows = [];

  for (const profile of profiles) {
    const profileSessions = sessions.filter((session) => session.profile_id === profile.id);

    for (const window of windows) {
      const windowSessions = applySessionWindow(profileSessions, window);
      const metric = computeWindowMetric(profile.id, window, profileSessions, rankedByWindow, rank30dAgoByProfile);
      const now = new Date().toISOString();

      metricsRows.push({
        profile_id: profile.id,
        window,
        rank: metric.rank,
        rank_30d_ago: metric.rank30dAgo,
        percentile: metric.percentile === null ? null : roundPercent(metric.percentile),
        total_ranked: metric.totalRanked,
        tokens_total: metric.tokensTotal,
        cost_usd_total: roundCurrency(computeProfileCostUsd({ tokensTotal: metric.tokensTotal })),
        sessions_count: metric.sessionsCount,
        days_active: metric.daysActive,
        avg_tokens_per_session: metric.sessionsCount > 0 ? metric.tokensTotal / metric.sessionsCount : 0,
        current_streak: metric.currentStreak,
        longest_streak: metric.longestStreak,
        after_midnight_count: metric.afterMidnightCount,
        after_midnight_pct: metric.afterMidnightPct,
        weekend_share: metric.weekendShare,
        avg_concurrent: metric.avgConcurrent,
        days_parallel_3: metric.daysParallel3,
        longest_sustained_3_seconds: metric.longestSustained3Seconds,
        peak_ever: metric.peakEver,
        peak_ever_date: metric.peakEverDate,
        peak_ever_time: metric.peakEverTime,
        peak_daily: metric.peakDaily,
        parallelism_buckets: metric.parallelismBuckets,
        longest_session_seconds: metric.longestSessionSeconds,
        longest_session_date: metric.longestSessionDate,
        largest_tokens_session_tokens: metric.largestTokensSessionTokens,
        largest_tokens_session_date: metric.largestTokensSessionDate,
        most_expensive_session_cost_usd: metric.mostExpensiveSessionCostUsd,
        most_expensive_session_date: metric.mostExpensiveSessionDate,
        median_session_seconds: metric.medianSessionSeconds,
        sessions_over_1h: metric.sessionsOver1h,
        total_session_time_seconds: metric.totalSessionTimeSeconds,
        cache_hit_rate: metric.cacheHitRate,
        first_model_name: metric.firstModelName,
        first_model_date: metric.firstModelDate,
        latest_model_name: metric.latestModelName,
        latest_model_date: metric.latestModelDate,
        top_model_by_sessions: metric.topModelBySessions,
        distinct_models: metric.distinctModels,
        tool_both_days: metric.toolBothDays,
        tool_days_observed: metric.toolDaysObserved,
        daily_tokens_90d: metric.dailyTokens90d,
        daily_sessions_90d: metric.dailySessions90d,
        daily_peak_concurrent_90d: metric.dailyPeakConcurrent90d,
        streak_bands: metric.streakBands,
        dominant_model_per_day_90d: metric.dominantModelPerDay90d,
        model_metrics_90d: metric.modelMetrics90d,
        tier_progression: metric.tierProgression,
        first_session_at: metric.firstSessionAt,
        last_session_at: metric.lastSessionAt,
        computed_at: now,
        expires_at: new Date(Date.now() + hourMs).toISOString(),
      });

      snapshotRows.push({
        profile_id: profile.id,
        window,
        snapshot_hour: snapshotHour.toISOString(),
        rank: metric.rank,
        percentile: metric.percentile === null ? null : roundPercent(metric.percentile),
        total_ranked: metric.totalRanked,
        tokens_total: metric.tokensTotal,
        sessions_count: metric.sessionsCount,
        days_active: metric.daysActive,
        computed_at: now,
      });

      modelRows.push(...buildModelsCache(profile.id, window, windowSessions));
      toolRows.push(buildToolsCache(profile.id, window, windowSessions));
      sessionRows.push(...buildSessionsCache(profile.id, window, windowSessions));
      cadenceRows.push(buildCadenceCache(profile.id, window, windowSessions));
      projectRows.push(...buildProjectsCache(profile.id, window, windowSessions));
    }
  }

  await deleteExistingCacheRows();
  await upsertRows('profile_metrics_cache', metricsRows, 'profile_id,window');
  await upsertRows('hourly_metrics_snapshots', snapshotRows, 'profile_id,window,snapshot_hour');
  await upsertRows('profile_models_breakdown_cache', modelRows, 'profile_id,window,model');
  await upsertRows('profile_tools_breakdown_cache', toolRows, 'profile_id,window');
  await upsertRows('profile_sessions_cache', sessionRows, 'profile_id,window,session_rank');
  await upsertRows('profile_cadence_cache', cadenceRows, 'profile_id,window');
  await upsertRows('profile_projects_breakdown_cache', projectRows, 'profile_id,window,project_name');
  await upsertRows('homepage_stats_cache', [computeHomepageStats(sessions)], 'id');

  console.log(`[metrics] Hourly metrics computed for ${profiles.length} profiles in ${Date.now() - startedAt}ms`);
}

// Exported helpers for focused tests and shared derived metric validation.
export {
  buildDailyTokens90d,
  buildDailySessionCounts90d,
  buildDailyPeakConcurrent90d,
  buildDominantModelPerDay90d,
  buildPerModelMetrics90d,
  computeTierProgression,
  computeStreakBands,
};
