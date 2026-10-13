export {
  BADGE_EVALUATOR_LOCK_NAME,
  BADGE_EVALUATOR_TIMEOUT_WARN_MS,
  criteriaEvaluators,
  criteriaValidators,
  evaluateAllProfiles,
  evaluateBadge,
  hashAdvisoryLockKey,
} from './badge-evaluator';
export type {
  BadgeCatalogRow,
  BadgeDispatchResult,
  BadgeEvaluatorLogger,
  BadgeSnapshot,
  EvaluateAllProfilesOptions,
  EvaluateAllProfilesResult,
  ProfileRow,
} from './badge-evaluator';
export {
  AUDIT_EVENT_SEVERITIES,
  logPasswordResetRequested,
  writeAuditEvent,
} from './audit';
export {
  extractClientIp,
  IpRateLimiter,
  PASSWORD_RESET_RATE_LIMIT_MAX_REQUESTS,
  PASSWORD_RESET_RATE_LIMIT_WINDOW_MS,
  passwordResetLimiter,
} from './rate-limit';
export {
  formatPrometheusMetrics,
  getCacheKeyPrefix,
  getCacheStats,
  getStats,
  recordCacheHit,
  recordCacheMiss,
  resetCacheStatsForTests,
} from './cache-stats';
export type {
  CachePrefixStats,
  CacheStatsSnapshot,
  CacheStatus,
} from './cache-stats';
export {
  buildBadgesCacheKey,
  buildLeaderboardCacheKey,
  buildMeCacheKey,
  buildProfileCacheKey,
  buildVersionedCacheKey,
  bumpCacheVersion,
  cache,
  getCacheConfig,
  getCacheMetrics,
  getCacheVersion,
  purgeByPrefix,
  purgeIngestionCaches,
  purgeKeys,
  withCache,
} from './cache';
export {
  CacheService,
  cacheService,
} from './cache.service';
export {
  ProfileService,
  profileService,
} from './profile.service';
export {
  computeKeyHash,
  extractScopeFromKey,
  generateAccessKey,
  isValidKeyFormat,
  verifyAccessKey,
} from './access-keys';
export { safeCompareTokens } from './crypto';
export {
  buildDateFilter,
  buildSourceFilter,
  computeRankDeltas,
  enrichBadgesData,
  enrichProfileData,
  formatLeaderboardResponse,
  getLeaderboard,
  loadProfileCostsUsd,
  queryLeaderboardMv,
} from './leaderboard';

export type {
  AuditEventPayload,
  AuditEventSeverity,
  PasswordResetAuditReason,
  WriteAuditEventPayload,
} from './audit';
export type {
  AccessKeyScope,
  GeneratedAccessKey,
} from './access-keys';
export type {
  LeaderboardBadge,
  LeaderboardMode,
  LeaderboardProfileData,
  LeaderboardQueryParams,
  LeaderboardRow,
  RankedProfile,
  RankDeltaMap,
} from './leaderboard';
export type {
  ProfileHydrationAccessKey,
  ProfileHydrationIngestionRun,
  ProfileHydrationProfile,
} from './profile.service';
