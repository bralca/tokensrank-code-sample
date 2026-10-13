import {
  getNumericCriteria,
  getReasoningRatio,
  toTokenNumber,
  type BadgeCriteriaValidator,
} from '../types';

export const REASONING_JUNKIE_MIN_REASONING_TOKENS = 1;
export const REASONING_JUNKIE_MIN_REASONING_RATIO = 0.1;

/**
 * Evaluates the Reasoning Junkie badge: reasoning output exists and reaches the
 * configured share of total token usage.
 */
export const evaluateReasoningJunkie: BadgeCriteriaValidator = (_profile, sessions, _aggregates, criteria) => {
  const minReasoningTokens = getNumericCriteria(
    criteria,
    'min_reasoning_tokens',
    REASONING_JUNKIE_MIN_REASONING_TOKENS,
  );
  const minReasoningRatio = getNumericCriteria(
    criteria,
    'min_reasoning_ratio',
    REASONING_JUNKIE_MIN_REASONING_RATIO,
  );
  const reasoningRatio = getReasoningRatio(sessions);
  const reasoningTokens = sessions.reduce((sum, session) => sum + toTokenNumber(session.reasoning_tokens), 0);

  return {
    earned: reasoningTokens >= minReasoningTokens && reasoningRatio >= minReasoningRatio,
    evidence: {
      reasoning_ratio: reasoningRatio,
      min_reasoning_ratio: minReasoningRatio,
      reasoning_tokens: reasoningTokens,
      min_reasoning_tokens: minReasoningTokens,
      sessions_count: sessions.length,
    },
  };
};
