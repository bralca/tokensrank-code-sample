import {
  getNumericCriteria,
  type BadgeCriteriaValidator,
} from '../types';

export const MARATHONER_MIN_SESSION_HOURS = 6;
const millisecondsPerHour = 60 * 60 * 1000;

/**
 * Evaluates the Marathoner badge: a single session lasts at least the configured
 * number of hours.
 */
export const evaluateMarathoner: BadgeCriteriaValidator = (_profile, sessions, _aggregates, criteria) => {
  const minSessionHours = getNumericCriteria(criteria, 'min_session_hours', MARATHONER_MIN_SESSION_HOURS);
  let maxSessionHours = 0;
  let sessionId: string | null = null;

  for (const session of sessions) {
    const firstEventAt = new Date(session.first_event_at ?? '').getTime();
    const lastEventAt = new Date(session.last_event_at ?? '').getTime();
    if (Number.isNaN(firstEventAt) || Number.isNaN(lastEventAt) || lastEventAt < firstEventAt) {
      continue;
    }

    const durationHours = (lastEventAt - firstEventAt) / millisecondsPerHour;
    if (durationHours > maxSessionHours) {
      maxSessionHours = durationHours;
      sessionId = session.session_id ?? null;
    }
  }

  return {
    earned: maxSessionHours >= minSessionHours,
    evidence: {
      max_session_hours: maxSessionHours,
      min_session_hours: minSessionHours,
      session_id: sessionId,
      sessions_count: sessions.length,
    },
  };
};
