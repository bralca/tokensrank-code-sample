import {
  getCacheReadRatio,
  getNumericCriteria,
  toTokenNumber,
  type BadgeCriteriaValidator,
} from '../types';

export const CACHE_WHISPERER_MIN_CACHE_READ_RATIO = 0.3;

/**
 * Evaluates the Cache Whisperer badge: cache-read tokens make up at least the
 * configured share of total token usage.
 */
export const evaluateCacheWhisperer: BadgeCriteriaValidator = (_profile, sessions, _aggregates, criteria) => {
  const minCacheReadRatio = getNumericCriteria(
    criteria,
    'min_cache_read_ratio',
    CACHE_WHISPERER_MIN_CACHE_READ_RATIO,
  );
  const cacheReadRatio = getCacheReadRatio(sessions);
  const cacheReadTokens = sessions.reduce((sum, session) => sum + toTokenNumber(session.cache_read_tokens), 0);

  return {
    earned: cacheReadRatio >= minCacheReadRatio && cacheReadTokens > 0,
    evidence: {
      cache_read_ratio: cacheReadRatio,
      min_cache_read_ratio: minCacheReadRatio,
      cache_read_tokens: cacheReadTokens,
      sessions_count: sessions.length,
    },
  };
};
