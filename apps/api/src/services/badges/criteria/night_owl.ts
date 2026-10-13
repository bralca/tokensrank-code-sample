import {
  getNumericCriteria,
  type BadgeCriteriaValidator,
} from '../types';

export const NIGHT_OWL_MIN_SESSION_RATIO = 0.5;
export const NIGHT_OWL_START_HOUR_UTC = 22;
export const NIGHT_OWL_END_HOUR_UTC = 6;

function isHourInWindow(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) {
    return true;
  }

  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }

  return hour >= startHour || hour < endHour;
}

/**
 * Evaluates the Night Owl badge using UTC session start hours.
 */
export const evaluateNightOwl: BadgeCriteriaValidator = (_profile, sessions, _aggregates, criteria) => {
  const minNightSessionsPct = getNumericCriteria(criteria, 'min_night_sessions_pct', NIGHT_OWL_MIN_SESSION_RATIO);
  const nightStartHour = getNumericCriteria(criteria, 'night_start_hour', NIGHT_OWL_START_HOUR_UTC);
  const nightEndHour = getNumericCriteria(criteria, 'night_end_hour', NIGHT_OWL_END_HOUR_UTC);
  let validSessions = 0;
  let nightSessions = 0;

  for (const session of sessions) {
    const startedAt = new Date(session.first_event_at ?? '');
    if (Number.isNaN(startedAt.getTime())) {
      continue;
    }

    validSessions += 1;
    if (isHourInWindow(startedAt.getUTCHours(), nightStartHour, nightEndHour)) {
      nightSessions += 1;
    }
  }

  const nightSessionRatio = validSessions > 0 ? nightSessions / validSessions : 0;

  return {
    earned: nightSessionRatio >= minNightSessionsPct && validSessions > 0,
    evidence: {
      night_session_ratio: nightSessionRatio,
      min_night_sessions_pct: minNightSessionsPct,
      night_sessions: nightSessions,
      valid_sessions: validSessions,
      night_start_hour_utc: nightStartHour,
      night_end_hour_utc: nightEndHour,
    },
  };
};
