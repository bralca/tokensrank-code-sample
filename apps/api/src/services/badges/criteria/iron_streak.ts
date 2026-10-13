import {
  getConsecutiveDays,
  getNumericCriteria,
  toUtcDateKey,
  type AggregateSnapshot,
  type BadgeCriteriaValidator,
} from '../types';

export const IRON_STREAK_MIN_CONSECUTIVE_DAYS = 30;

function buildSessionAggregates(
  sessions: Parameters<BadgeCriteriaValidator>[1],
): AggregateSnapshot[] {
  const sessionsByDate = new Map<string, number>();

  for (const session of sessions) {
    const dateKey = toUtcDateKey(session.first_event_at);
    if (!dateKey) {
      continue;
    }

    sessionsByDate.set(dateKey, (sessionsByDate.get(dateKey) ?? 0) + 1);
  }

  return Array.from(sessionsByDate, ([date, totalSessions]) => ({
    date,
    total_sessions: totalSessions,
  }));
}

/**
 * Evaluates the Iron Streak badge: at least one session on each day of a
 * 30-day UTC streak.
 */
export const evaluateIronStreak: BadgeCriteriaValidator = (_profile, sessions, aggregates, criteria) => {
  const minConsecutiveDays = getNumericCriteria(
    criteria,
    'min_consecutive_days',
    IRON_STREAK_MIN_CONSECUTIVE_DAYS,
  );
  const sourceAggregates = aggregates.length > 0 ? aggregates : buildSessionAggregates(sessions);
  const consecutiveDays = getConsecutiveDays(sourceAggregates);

  return {
    earned: consecutiveDays >= minConsecutiveDays,
    evidence: {
      consecutive_days: consecutiveDays,
      min_consecutive_days: minConsecutiveDays,
      active_days_evaluated: new Set(sourceAggregates.map((aggregate) => toUtcDateKey(aggregate.date))).size,
    },
  };
};
