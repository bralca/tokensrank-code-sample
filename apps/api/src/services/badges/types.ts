/**
 * Shared badge evaluator contracts and pure metric helpers.
 *
 * Badge criteria are evaluated from immutable snapshots so Task 26 can persist
 * the returned evidence without relying on mutable database state later.
 */

export type BadgeSlug =
  | 'tier'
  | 'iron_streak'
  | 'operator'
  | 'cache_whisperer'
  | 'night_owl'
  | 'multi_provider'
  | 'conductor'
  | 'outage_witness'
  | 'reasoning_junkie'
  | 'marathoner'
  | 'detonation'
  | 'long_context'
  | 'defection_arc'
  | 'two_tool'
  | 'drifter'
  | 'sniper';

export type ProfileMode = 'script_verified' | 'self_reported' | null;

export type BadgeCriteria = Record<string, unknown>;

export type BadgeEvidence = Record<string, unknown>;

/**
 * Minimal profile shape required by badge criteria. Validators do not mutate
 * profile data and intentionally avoid database clients.
 */
export interface ProfileSnapshot {
  id: string;
  mode?: ProfileMode;
  handle?: string | null;
}

/**
 * Session row shape consumed by criteria validators. It mirrors the current
 * `sessions` schema while keeping nullable/optional fields explicit for tests
 * and partial snapshots.
 */
export interface SessionSnapshot {
  id?: string;
  profile_id?: string;
  source?: 'claude' | 'codex' | string | null;
  session_id?: string | null;
  model?: string | null;
  first_event_at?: string | Date | null;
  last_event_at?: string | Date | null;
  input_tokens?: number | bigint | null;
  output_tokens?: number | bigint | null;
  cache_read_tokens?: number | bigint | null;
  cache_create_tokens?: number | bigint | null;
  cached_tokens?: number | bigint | null;
  reasoning_tokens?: number | bigint | null;
  total_tokens?: number | bigint | null;
  turns?: number | null;
  fraud_signals_json?: unknown;
  fingerprint?: unknown;
}

/**
 * Daily aggregate row shape consumed by activity and burst criteria. The
 * current schema stores per-source/model rows, so helpers sum duplicate dates.
 */
export interface AggregateSnapshot {
  profile_id?: string;
  date?: string | Date | null;
  source?: 'claude' | 'codex' | string | null;
  model?: string | null;
  total_tokens?: number | bigint | null;
  total_sessions?: number | null;
  sessions_count?: number | null;
}

/**
 * Result returned by every pure badge criteria validator.
 */
export interface BadgeEvaluationResult {
  earned: boolean;
  evidence: BadgeEvidence;
}

/**
 * Pure function contract used by each badge criteria module.
 */
export type BadgeCriteriaValidator = (
  profile: ProfileSnapshot,
  sessions: SessionSnapshot[],
  aggregates: AggregateSnapshot[],
  criteria: BadgeCriteria,
) => BadgeEvaluationResult;

export const millisecondsPerDay = 24 * 60 * 60 * 1000;

/**
 * Converts nullable token fields to a safe JavaScript number for aggregate
 * arithmetic. Badge thresholds are well below Number.MAX_SAFE_INTEGER.
 */
export function toTokenNumber(value: number | bigint | null | undefined): number {
  if (typeof value === 'bigint') {
    return Number(value);
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return value;
}

/**
 * Converts nullable count fields to a safe non-negative integer.
 */
export function toCountNumber(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.floor(value);
}

/**
 * Returns a session's effective total token count, using generated
 * `total_tokens` when present and otherwise summing token components.
 */
export function getSessionTotalTokens(session: SessionSnapshot): number {
  const explicitTotal = toTokenNumber(session.total_tokens);
  if (explicitTotal > 0) {
    return explicitTotal;
  }

  return toTokenNumber(session.input_tokens)
    + toTokenNumber(session.output_tokens)
    + toTokenNumber(session.cache_read_tokens)
    + toTokenNumber(session.cache_create_tokens)
    + toTokenNumber(session.cached_tokens)
    + toTokenNumber(session.reasoning_tokens);
}

/**
 * Reads a numeric criteria value with a fallback. This lets validators honor
 * criteria_json overrides while keeping production defaults centralized.
 */
export function getNumericCriteria(
  criteria: BadgeCriteria,
  key: string,
  fallback: number,
): number {
  const value = criteria[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Counts tokens by normalized model name. Empty or null models are ignored so
 * unknown rows do not inflate diversity or focus metrics.
 */
export function getModelCounts(sessions: SessionSnapshot[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const session of sessions) {
    const model = session.model?.trim().toLowerCase();
    if (!model) {
      continue;
    }

    counts.set(model, (counts.get(model) ?? 0) + getSessionTotalTokens(session));
  }

  return counts;
}

/**
 * Converts a timestamp to its UTC YYYY-MM-DD key, returning null for invalid
 * dates so callers can ignore malformed snapshot rows.
 */
export function toUtcDateKey(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

/**
 * Calculates the maximum consecutive-day streak from aggregate dates. Only
 * aggregate rows with at least one session count as active days.
 */
export function getConsecutiveDays(aggregates: AggregateSnapshot[]): number {
  const activeDates = new Set<string>();

  for (const aggregate of aggregates) {
    const sessionsCount = toCountNumber(aggregate.total_sessions ?? aggregate.sessions_count);
    const totalTokens = toTokenNumber(aggregate.total_tokens);
    if (sessionsCount <= 0 && totalTokens <= 0) {
      continue;
    }

    const dateKey = toUtcDateKey(aggregate.date);
    if (dateKey) {
      activeDates.add(dateKey);
    }
  }

  const sortedDates = Array.from(activeDates).sort();
  let longest = 0;
  let current = 0;
  let previousTime: number | null = null;

  for (const dateKey of sortedDates) {
    const currentTime = Date.parse(`${dateKey}T00:00:00.000Z`);
    if (previousTime === null || currentTime - previousTime === millisecondsPerDay) {
      current += 1;
    } else {
      current = 1;
    }

    longest = Math.max(longest, current);
    previousTime = currentTime;
  }

  return longest;
}

/**
 * Filters sessions to a UTC timestamp window using `first_event_at` as the
 * canonical session start. Invalid or missing timestamps are excluded.
 */
export function filterByDateRange(
  sessions: SessionSnapshot[],
  startInclusive?: Date,
  endExclusive?: Date,
): SessionSnapshot[] {
  const startTime = startInclusive?.getTime() ?? Number.NEGATIVE_INFINITY;
  const endTime = endExclusive?.getTime() ?? Number.POSITIVE_INFINITY;

  return sessions.filter((session) => {
    const startedAt = session.first_event_at instanceof Date
      ? session.first_event_at
      : new Date(session.first_event_at ?? '');
    const startedTime = startedAt.getTime();

    return !Number.isNaN(startedTime) && startedTime >= startTime && startedTime < endTime;
  });
}

/**
 * Calculates cache-read token share across sessions. The denominator is total
 * token usage, matching FR-57 cache whisperer semantics.
 */
export function getCacheReadRatio(sessions: SessionSnapshot[]): number {
  const totalTokens = sessions.reduce((sum, session) => sum + getSessionTotalTokens(session), 0);
  if (totalTokens <= 0) {
    return 0;
  }

  const cacheReadTokens = sessions.reduce(
    (sum, session) => sum + toTokenNumber(session.cache_read_tokens),
    0,
  );

  return cacheReadTokens / totalTokens;
}

/**
 * Calculates reasoning token share across sessions. The denominator is total
 * token usage so the result can be compared directly with FR-57 ratio criteria.
 */
export function getReasoningRatio(sessions: SessionSnapshot[]): number {
  const totalTokens = sessions.reduce((sum, session) => sum + getSessionTotalTokens(session), 0);
  if (totalTokens <= 0) {
    return 0;
  }

  const reasoningTokens = sessions.reduce(
    (sum, session) => sum + toTokenNumber(session.reasoning_tokens),
    0,
  );

  return reasoningTokens / totalTokens;
}
