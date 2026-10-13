import {
  getNumericCriteria,
  getSessionTotalTokens,
  toTokenNumber,
  type BadgeCriteriaValidator,
} from '../types';

export const TIER_THRESHOLD_TOKENS = 25_000_000;

/**
 * Evaluates the Tier badge: lifetime total token usage reaches the design-canon
 * top 1 percent threshold.
 */
export const evaluateTier: BadgeCriteriaValidator = (_profile, sessions, aggregates, criteria) => {
  const thresholdTokens = getNumericCriteria(criteria, 'threshold_tokens', TIER_THRESHOLD_TOKENS);
  const sessionTokens = sessions.reduce((sum, session) => sum + getSessionTotalTokens(session), 0);
  const aggregateTokens = aggregates.reduce((sum, aggregate) => sum + toTokenNumber(aggregate.total_tokens), 0);
  const tokensTotal = sessionTokens > 0 ? sessionTokens : aggregateTokens;

  return {
    earned: tokensTotal >= thresholdTokens,
    evidence: {
      tokens_total: tokensTotal,
      threshold_tokens: thresholdTokens,
      sessions_count: sessions.length,
      aggregates_count: aggregates.length,
    },
  };
};
