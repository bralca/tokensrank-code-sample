import {
  type BadgeCriteriaValidator,
} from '../types';

function getRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function findErrorTag(value: unknown): string | null {
  const record = getRecord(value);
  if (!record) {
    return null;
  }

  const errorTag = record.error_tag;
  if (typeof errorTag === 'string' && errorTag.trim().length > 0) {
    return errorTag;
  }

  const signals = getRecord(record.fraud_signals_json);
  const nestedErrorTag = signals?.error_tag;
  if (typeof nestedErrorTag === 'string' && nestedErrorTag.trim().length > 0) {
    return nestedErrorTag;
  }

  return null;
}

/**
 * Evaluates the Outage Witness badge: at least one session contains an
 * `error_tag` in its fraud signal snapshot.
 */
export const evaluateOutageWitness: BadgeCriteriaValidator = (_profile, sessions) => {
  let matchedSessionId: string | null = null;
  let matchedErrorTag: string | null = null;

  for (const session of sessions) {
    const errorTag = findErrorTag(session.fraud_signals_json) ?? findErrorTag(session.fingerprint);
    if (errorTag) {
      matchedSessionId = session.session_id ?? null;
      matchedErrorTag = errorTag;
      break;
    }
  }

  return {
    earned: matchedErrorTag !== null,
    evidence: {
      has_error_tag: matchedErrorTag !== null,
      error_tag: matchedErrorTag,
      session_id: matchedSessionId,
      sessions_count: sessions.length,
    },
  };
};
