import {
  getNumericCriteria,
  toTokenNumber,
  type BadgeCriteriaValidator,
} from '../types';

export const LONG_CONTEXT_TOKEN_THRESHOLD = 100_000;

/**
 * Evaluates the Long Context badge: a single session reaches the context-token
 * threshold using input plus cache token components.
 */
export const evaluateLongContext: BadgeCriteriaValidator = (_profile, sessions, _aggregates, criteria) => {
  const minContextTokens = getNumericCriteria(criteria, 'min_context_tokens', LONG_CONTEXT_TOKEN_THRESHOLD);
  let maxContextTokens = 0;
  let sessionId: string | null = null;

  for (const session of sessions) {
    const contextTokens = toTokenNumber(session.input_tokens)
      + toTokenNumber(session.cache_read_tokens)
      + toTokenNumber(session.cache_create_tokens)
      + toTokenNumber(session.cached_tokens);

    if (contextTokens > maxContextTokens) {
      maxContextTokens = contextTokens;
      sessionId = session.session_id ?? null;
    }
  }

  return {
    earned: maxContextTokens >= minContextTokens,
    evidence: {
      max_context_tokens: maxContextTokens,
      min_context_tokens: minContextTokens,
      session_id: sessionId,
      sessions_count: sessions.length,
    },
  };
};
