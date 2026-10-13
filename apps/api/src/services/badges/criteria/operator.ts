import {
  getNumericCriteria,
  toCountNumber,
  toUtcDateKey,
  type BadgeCriteriaValidator,
} from '../types';

export const OPERATOR_MIN_SESSIONS_PER_DAY_AVG = 10;

/**
 * Evaluates the Operator badge: average sessions per active UTC day reaches the
 * power-user threshold.
 */
export const evaluateOperator: BadgeCriteriaValidator = (_profile, sessions, aggregates, criteria) => {
  const minSessionsPerDayAvg = getNumericCriteria(
    criteria,
    'min_sessions_per_day_avg',
    OPERATOR_MIN_SESSIONS_PER_DAY_AVG,
  );
  const sessionsByDate = new Map<string, number>();

  if (aggregates.length > 0) {
    for (const aggregate of aggregates) {
      const dateKey = toUtcDateKey(aggregate.date);
      if (!dateKey) {
        continue;
      }

      const sessionsCount = toCountNumber(aggregate.total_sessions ?? aggregate.sessions_count);
      sessionsByDate.set(dateKey, (sessionsByDate.get(dateKey) ?? 0) + sessionsCount);
    }
  } else {
    for (const session of sessions) {
      const dateKey = toUtcDateKey(session.first_event_at);
      if (!dateKey) {
        continue;
      }

      sessionsByDate.set(dateKey, (sessionsByDate.get(dateKey) ?? 0) + 1);
    }
  }

  const totalSessions = Array.from(sessionsByDate.values()).reduce((sum, count) => sum + count, 0);
  const activeDays = Array.from(sessionsByDate.values()).filter((count) => count > 0).length;
  const sessionsPerDayAvg = activeDays > 0 ? totalSessions / activeDays : 0;

  return {
    earned: sessionsPerDayAvg >= minSessionsPerDayAvg,
    evidence: {
      sessions_per_day_avg: sessionsPerDayAvg,
      min_sessions_per_day_avg: minSessionsPerDayAvg,
      total_sessions: totalSessions,
      active_days: activeDays,
    },
  };
};
