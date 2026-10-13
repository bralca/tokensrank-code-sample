export type CacheStatus = 'HIT' | 'MISS' | 'BYPASS' | 'HIT-DEGRADED';

export type CachePrefixStats = {
  hits: number;
  misses: number;
  hitRate: number;
};

export type CacheStatsSnapshot = {
  totals: CachePrefixStats;
  prefixes: Record<string, CachePrefixStats>;
};

type MutableCachePrefixStats = {
  hits: number;
  misses: number;
};

const cacheStats = new Map<string, MutableCachePrefixStats>();

function createEmptyStats(): MutableCachePrefixStats {
  return {
    hits: 0,
    misses: 0,
  };
}

function calculateHitRate(hits: number, misses: number): number {
  const total = hits + misses;

  if (total === 0) {
    return 0;
  }

  return hits / total;
}

function cloneStats(stats: MutableCachePrefixStats): CachePrefixStats {
  return {
    hits: stats.hits,
    misses: stats.misses,
    hitRate: calculateHitRate(stats.hits, stats.misses),
  };
}

function getMutableStats(prefix: string): MutableCachePrefixStats {
  const existingStats = cacheStats.get(prefix);

  if (existingStats) {
    return existingStats;
  }

  const nextStats = createEmptyStats();
  cacheStats.set(prefix, nextStats);
  return nextStats;
}

export function getCacheKeyPrefix(cacheKey: string): string {
  const [prefix] = cacheKey.split(':');
  const normalizedPrefix = prefix?.trim();

  if (!normalizedPrefix) {
    return 'unknown';
  }

  return normalizedPrefix;
}

export function recordCacheHit(cacheKey: string): CachePrefixStats {
  const stats = getMutableStats(getCacheKeyPrefix(cacheKey));
  stats.hits += 1;
  return cloneStats(stats);
}

export function recordCacheMiss(cacheKey: string): CachePrefixStats {
  const stats = getMutableStats(getCacheKeyPrefix(cacheKey));
  stats.misses += 1;
  return cloneStats(stats);
}

export function getStats(): CacheStatsSnapshot {
  const prefixes: Record<string, CachePrefixStats> = {};
  const totals = createEmptyStats();

  for (const [prefix, stats] of cacheStats.entries()) {
    prefixes[prefix] = cloneStats(stats);
    totals.hits += stats.hits;
    totals.misses += stats.misses;
  }

  return {
    totals: cloneStats(totals),
    prefixes,
  };
}

export function getCacheStats(): CacheStatsSnapshot {
  return getStats();
}

function escapePrometheusLabelValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

export function formatPrometheusMetrics(stats = getStats()): string {
  const lines = [
    '# HELP tokensrank_cache_hits_total Cache hit count by key prefix',
    '# TYPE tokensrank_cache_hits_total counter',
  ];

  for (const [prefix, prefixStats] of Object.entries(stats.prefixes)) {
    lines.push(
      `tokensrank_cache_hits_total{key_prefix="${escapePrometheusLabelValue(prefix)}"} ${prefixStats.hits}`,
    );
  }

  lines.push(
    '# HELP tokensrank_cache_misses_total Cache miss count by key prefix',
    '# TYPE tokensrank_cache_misses_total counter',
  );

  for (const [prefix, prefixStats] of Object.entries(stats.prefixes)) {
    lines.push(
      `tokensrank_cache_misses_total{key_prefix="${escapePrometheusLabelValue(prefix)}"} ${prefixStats.misses}`,
    );
  }

  return `${lines.join('\n')}\n`;
}

export function resetCacheStatsForTests(): void {
  cacheStats.clear();
}
