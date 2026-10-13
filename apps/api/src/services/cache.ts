import { LRUCache } from 'lru-cache';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  getCacheStats,
  recordCacheHit,
  recordCacheMiss,
  resetCacheStatsForTests,
  type CacheStatus,
} from './cache-stats';
import {
  setCacheStatusHeader,
  setRequestCacheStatus,
} from '../plugins/cache-headers';

const DEFAULT_CACHE_TTL_SECONDS = 3600;
const DEFAULT_MAX_CACHE_ITEMS = 5000;
const DEFAULT_MAX_CACHE_SIZE_BYTES = 52_428_800;
const SERIALIZATION_FALLBACK_BYTES = 1024;

type CacheMetrics = {
  hits: number;
  misses: number;
};

type CacheConfig = {
  ttlSeconds: number;
  maxItems: number;
  maxSizeBytes: number;
};

type CacheEntry = {
  value: unknown;
  createdAt: number;
};

type CacheLoadOutcome<T> = {
  value: T;
  status: CacheStatus;
};

type CacheLogger = {
  debug?: (bindings: Record<string, unknown>, message?: string) => void;
  warn?: (bindings: Record<string, unknown>, message?: string) => void;
};

type CacheContext = {
  logger?: CacheLogger;
  reply?: FastifyReply;
  request?: FastifyRequest;
};

const inFlightLoads = new Map<string, Promise<CacheLoadOutcome<unknown>>>();
let cacheVersion = 0;

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallback;
  }

  return parsedValue;
}

export function getCacheConfig(): CacheConfig {
  return {
    ttlSeconds: readPositiveIntegerEnv('CACHE_TTL_SECONDS', DEFAULT_CACHE_TTL_SECONDS),
    maxItems: readPositiveIntegerEnv('MAX_CACHE_ITEMS', DEFAULT_MAX_CACHE_ITEMS),
    maxSizeBytes: readPositiveIntegerEnv('MAX_CACHE_SIZE_BYTES', DEFAULT_MAX_CACHE_SIZE_BYTES),
  };
}

function calculateEntrySize(entry: CacheEntry): number {
  try {
    const serializedValue = JSON.stringify(entry.value);

    if (!serializedValue) {
      return SERIALIZATION_FALLBACK_BYTES;
    }

    return Math.max(1, Buffer.byteLength(serializedValue, 'utf8'));
  } catch {
    return SERIALIZATION_FALLBACK_BYTES;
  }
}

export const cache = new LRUCache<string, CacheEntry>({
  max: getCacheConfig().maxItems,
  maxSize: getCacheConfig().maxSizeBytes,
  sizeCalculation: calculateEntrySize,
  ttl: getCacheConfig().ttlSeconds * 1000,
  allowStale: false,
  noDeleteOnStaleGet: true,
});

function markCacheStatus(status: CacheStatus, context?: CacheContext): void {
  setRequestCacheStatus(context?.request, status);
  setCacheStatusHeader(context?.reply, status);
}

function resolveTtlMs(ttlSeconds?: number): number {
  const effectiveTtlSeconds = ttlSeconds && ttlSeconds > 0
    ? ttlSeconds
    : getCacheConfig().ttlSeconds;

  return effectiveTtlSeconds * 1000;
}

export async function withCache<T>(
  key: string,
  loader: () => Promise<T>,
  context?: CacheContext,
): Promise<T>;
export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
  context?: CacheContext,
): Promise<T>;
export async function withCache<T>(
  key: string,
  ttlSecondsOrLoader: number | (() => Promise<T>),
  maybeLoaderOrContext?: (() => Promise<T>) | CacheContext,
  maybeContext?: CacheContext,
): Promise<T> {
  const ttlSeconds = typeof ttlSecondsOrLoader === 'number' ? ttlSecondsOrLoader : undefined;
  const loader = typeof ttlSecondsOrLoader === 'function'
    ? ttlSecondsOrLoader
    : maybeLoaderOrContext;
  const context = typeof ttlSecondsOrLoader === 'function'
    ? maybeLoaderOrContext as CacheContext | undefined
    : maybeContext;

  if (typeof loader !== 'function') {
    throw new Error('withCache requires a loader function');
  }

  const cachedEntry = cache.get(key, { noDeleteOnStaleGet: true });

  if (cachedEntry !== undefined) {
    recordCacheHit(key);
    markCacheStatus('HIT', context);
    context?.logger?.debug?.({
      event: 'cache.hit',
      key,
      age_ms: Date.now() - cachedEntry.createdAt,
      status: 'HIT',
    });
    return cachedEntry.value as T;
  }

  recordCacheMiss(key);

  const inFlightLoad = inFlightLoads.get(key);

  if (inFlightLoad) {
    try {
      const outcome = await inFlightLoad as CacheLoadOutcome<T>;
      markCacheStatus(outcome.status, context);
      return outcome.value;
    } catch (error) {
      markCacheStatus('BYPASS', context);
      throw error;
    }
  }

  const loadPromise = (async () => {
    try {
      const loadStartedAt = Date.now();
      const value = await loader();
      cache.set(key, { value, createdAt: Date.now() }, { ttl: resolveTtlMs(ttlSeconds) });
      context?.logger?.debug?.({
        event: 'cache.miss',
        key,
        load_ms: Date.now() - loadStartedAt,
        status: 'MISS',
      });
      return {
        value,
        status: 'MISS',
      } satisfies CacheLoadOutcome<T>;
    } catch (error) {
      const staleEntry = cache.get(key, {
        allowStale: true,
        noDeleteOnStaleGet: true,
      });

      if (staleEntry) {
        const ageMs = Date.now() - staleEntry.createdAt;
        const maxStaleMs = DEFAULT_CACHE_TTL_SECONDS * 1000;

        if (ageMs <= maxStaleMs) {
          context?.logger?.warn?.({
            event: 'cache.served_stale',
            key,
            age_ms: ageMs,
            error: error instanceof Error ? error.message : String(error),
            status: 'HIT-DEGRADED',
          });
          return {
            value: staleEntry.value as T,
            status: 'HIT-DEGRADED',
          } satisfies CacheLoadOutcome<T>;
        }
      }

      context?.logger?.warn?.({
        event: 'cache.bypass',
        key,
        error: error instanceof Error ? error.message : String(error),
        status: 'BYPASS',
      });
      throw error;
    } finally {
      inFlightLoads.delete(key);
    }
  })();

  inFlightLoads.set(key, loadPromise);

  try {
    const outcome = await loadPromise as CacheLoadOutcome<T>;
    markCacheStatus(outcome.status, context);
    return outcome.value;
  } catch (error) {
    markCacheStatus('BYPASS', context);
    throw error;
  }
}

export function getCacheVersion(): number {
  return cacheVersion;
}

export function buildVersionedCacheKey(prefix: string, ...params: Array<string | number | boolean>): string {
  return `${prefix}:v${cacheVersion}:${params.map(String).join(':')}`;
}

export function buildLeaderboardCacheKey(
  period: string,
  scope: string,
  limit: number,
  offset: number,
  sort = 'cost',
  order = 'desc',
): string {
  return buildVersionedCacheKey('lb', period, scope, limit, offset, sort, order);
}

export function buildProfileCacheKey(handle: string, window = 'all'): string {
  return buildVersionedCacheKey('profile', handle, window);
}

export function buildMeCacheKey(userId: string): string {
  return buildVersionedCacheKey('me', userId);
}

export function buildBadgesCacheKey(handle: string): string {
  return buildVersionedCacheKey('badges', handle);
}

export function purgeKeys(keys: string[]): number {
  let purgedCount = 0;

  for (const key of keys) {
    if (!key.includes('*')) {
      if (cache.delete(key)) {
        purgedCount += 1;
      }

      continue;
    }

    const pattern = new RegExp(`^${key
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}(?::.*)?$`);

    for (const existingKey of cache.keys()) {
      if (pattern.test(existingKey)) {
        cache.delete(existingKey);
        purgedCount += 1;
      }
    }
  }

  return purgedCount;
}

export function purgeByPrefix(prefix: string): number {
  let purgedCount = 0;

  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
      purgedCount += 1;
    }
  }

  return purgedCount;
}

export function bumpCacheVersion(): number {
  cacheVersion += 1;
  return cacheVersion;
}

export function purgeIngestionCaches(): number {
  return bumpCacheVersion();
}

export function getCacheMetrics(): CacheMetrics {
  const { totals } = getCacheStats();

  return {
    hits: totals.hits,
    misses: totals.misses,
  };
}

export function resetCacheForTests(): void {
  cache.clear();
  inFlightLoads.clear();
  cacheVersion = 0;
  resetCacheStatsForTests();
}
