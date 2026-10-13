import {
  type BadgeCriteriaValidator,
  type SessionSnapshot,
} from '../types';

function getSessionSource(session: SessionSnapshot): 'claude' | 'codex' | null {
  const source = session.source?.trim().toLowerCase();
  if (source === 'claude' || source === 'codex') {
    return source;
  }

  const model = session.model?.trim().toLowerCase();
  if (model?.includes('claude')) {
    return 'claude';
  }

  if (model?.includes('codex')) {
    return 'codex';
  }

  return null;
}

/**
 * Evaluates the Defection Arc badge: chronological activity shows Claude use
 * followed by later Codex use.
 */
export const evaluateDefectionArc: BadgeCriteriaValidator = (_profile, sessions, _aggregates, criteria) => {
  const fromModel = typeof criteria.from_model === 'string' ? criteria.from_model : 'claude';
  const toModel = typeof criteria.to_model === 'string' ? criteria.to_model : 'codex';
  const sortedSessions = [...sessions]
    .map((session) => ({
      session,
      source: getSessionSource(session),
      startedAt: new Date(session.first_event_at ?? '').getTime(),
    }))
    .filter((entry) => entry.source !== null && !Number.isNaN(entry.startedAt))
    .sort((a, b) => a.startedAt - b.startedAt);

  let firstFromAt: string | null = null;
  let firstToAfterFromAt: string | null = null;
  let fromSessionsBeforeTransition = 0;
  let toSessionsAfterTransition = 0;

  for (const entry of sortedSessions) {
    if (entry.source === fromModel && firstToAfterFromAt === null) {
      fromSessionsBeforeTransition += 1;
      firstFromAt ??= new Date(entry.startedAt).toISOString();
      continue;
    }

    if (entry.source === toModel && firstFromAt !== null) {
      toSessionsAfterTransition += 1;
      firstToAfterFromAt ??= new Date(entry.startedAt).toISOString();
    }
  }

  const transitioned = firstFromAt !== null && firstToAfterFromAt !== null;

  return {
    earned: transitioned,
    evidence: {
      transitioned,
      from_source: fromModel,
      to_source: toModel,
      first_from_at: firstFromAt,
      first_to_after_from_at: firstToAfterFromAt,
      from_sessions_before_transition: fromSessionsBeforeTransition,
      to_sessions_after_transition: toSessionsAfterTransition,
      evaluated_sessions: sortedSessions.length,
    },
  };
};
