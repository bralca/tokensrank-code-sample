import {
  getNumericCriteria,
  getSessionTotalTokens,
  toTokenNumber,
  toUtcDateKey,
  type BadgeCriteriaValidator,
} from '../types';

export const DETONATION_DAILY_TOKEN_THRESHOLD = 10_000_000;

/**
 * Evaluates the Detonation badge: at least one UTC day exceeds the burst token
 * threshold.
 */
export const evaluateDetonation: BadgeCriteriaValidator = (_profile, sessions, aggregates, criteria) => {
  const minDailyTokens = getNumericCriteria(criteria, 'min_daily_tokens', DETONATION_DAILY_TOKEN_THRESHOLD);
  const tokensByDate = new Map<string, number>();

  const aggregateRows = aggregates.filter((aggregate) => toUtcDateKey(aggregate.date) !== null);
  if (aggregateRows.length > 0) {
    for (const aggregate of aggregateRows) {
      const dateKey = toUtcDateKey(aggregate.date);
      if (!dateKey) {
        continue;
      }

      tokensByDate.set(dateKey, (tokensByDate.get(dateKey) ?? 0) + toTokenNumber(aggregate.total_tokens));
    }
  } else {
    for (const session of sessions) {
      const dateKey = toUtcDateKey(session.first_event_at);
      if (!dateKey) {
        continue;
      }

      tokensByDate.set(dateKey, (tokensByDate.get(dateKey) ?? 0) + getSessionTotalTokens(session));
    }
  }

  let peakDate: string | null = null;
  let peakDailyTokens = 0;

  for (const [date, tokens] of tokensByDate) {
    if (tokens > peakDailyTokens) {
      peakDate = date;
      peakDailyTokens = tokens;
    }
  }

  return {
    earned: peakDailyTokens >= minDailyTokens,
    evidence: {
      peak_date: peakDate,
      peak_daily_tokens: peakDailyTokens,
      min_daily_tokens: minDailyTokens,
      evaluated_days: tokensByDate.size,
    },
  };
};
