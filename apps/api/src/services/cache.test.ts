import { afterEach, describe, expect, it, vi } from 'vitest';

import {
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
  resetCacheForTests,
  withCache,
} from './cache';

const originalCacheTtlSeconds = process.env.CACHE_TTL_SECONDS;
const originalMaxCacheItems = process.env.MAX_CACHE_ITEMS;
const originalMaxCacheSizeBytes = process.env.MAX_CACHE_SIZE_BYTES;

afterEach(() => {
  resetCacheForTests();
  vi.useRealTimers();

  if (originalCacheTtlSeconds === undefined) {
    delete process.env.CACHE_TTL_SECONDS;
  } else {
    process.env.CACHE_TTL_SECONDS = originalCacheTtlSeconds;
  }

  if (originalMaxCacheItems === undefined) {
    delete process.env.MAX_CACHE_ITEMS;
  } else {
    process.env.MAX_CACHE_ITEMS = originalMaxCacheItems;
  }

  if (originalMaxCacheSizeBytes === undefined) {
    delete process.env.MAX_CACHE_SIZE_BYTES;
  } else {
    process.env.MAX_CACHE_SIZE_BYTES = originalMaxCacheSizeBytes;
  }
});

describe('getCacheConfig', () => {
  it('uses production defaults when env overrides are absent', () => {
    delete process.env.CACHE_TTL_SECONDS;
    delete process.env.MAX_CACHE_ITEMS;
    delete process.env.MAX_CACHE_SIZE_BYTES;

    expect(getCacheConfig()).toEqual({
      ttlSeconds: 3600,
      maxItems: 5000,
      maxSizeBytes: 52_428_800,
    });
  });

  it('uses positive integer env overrides', () => {
    process.env.CACHE_TTL_SECONDS = '5';
    process.env.MAX_CACHE_ITEMS = '25';
    process.env.MAX_CACHE_SIZE_BYTES = '2048';

    expect(getCacheConfig()).toEqual({
      ttlSeconds: 5,
      maxItems: 25,
      maxSizeBytes: 2048,
    });
  });

  it('falls back for invalid env overrides', () => {
    process.env.CACHE_TTL_SECONDS = '0';
    process.env.MAX_CACHE_ITEMS = '-10';
    process.env.MAX_CACHE_SIZE_BYTES = 'not-a-number';

    expect(getCacheConfig()).toEqual({
      ttlSeconds: 3600,
      maxItems: 5000,
      maxSizeBytes: 52_428_800,
    });
  });
});

describe('withCache', () => {
  it('loads once and returns cached values on repeated calls', async () => {
    const loader = vi.fn(async () => ({ rank: 1 }));

    await expect(withCache('lb:v0:all:all:50:0:cost:desc', 3600, loader)).resolves.toEqual({ rank: 1 });
    await expect(withCache('lb:v0:all:all:50:0:cost:desc', 3600, loader)).resolves.toEqual({ rank: 1 });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(getCacheMetrics()).toEqual({
      hits: 1,
      misses: 1,
    });
  });

  it('uses CACHE_TTL_SECONDS when no explicit TTL is provided', async () => {
    process.env.CACHE_TTL_SECONDS = '1';
    let loadCount = 0;
    const loader = vi.fn(async () => {
      loadCount += 1;
      return { value: loadCount };
    });

    await expect(withCache('profile:v0:alex:all', loader)).resolves.toEqual({ value: 1 });
    await new Promise((resolve) => {
      setTimeout(resolve, 1100);
    });
    await expect(withCache('profile:v0:alex:all', loader)).resolves.toEqual({ value: 2 });

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('uses a single in-flight loader for concurrent misses on the same key', async () => {
    let resolveLoader: (value: { rows: number }) => void = () => undefined;
    const loader = vi.fn(
      () => new Promise<{ rows: number }>((resolve) => {
        resolveLoader = resolve;
      }),
    );

    const first = withCache('lb:v0:7d:all:50:0:cost:desc', 3600, loader);
    const second = withCache('lb:v0:7d:all:50:0:cost:desc', 3600, loader);
    const third = withCache('lb:v0:7d:all:50:0:cost:desc', 3600, loader);

    resolveLoader({ rows: 50 });

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      { rows: 50 },
      { rows: 50 },
      { rows: 50 },
    ]);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(getCacheMetrics()).toEqual({
      hits: 0,
      misses: 3,
    });
  });

  it('does not cache loader failures and clears the in-flight guard', async () => {
    const loader = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce('fresh');

    await expect(withCache('profile:v0:alex:7d', 3600, loader)).rejects.toThrow('database unavailable');
    await expect(withCache('profile:v0:alex:7d', 3600, loader)).resolves.toBe('fresh');

    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('cache key versioning and purge helpers', () => {
  it('builds versioned keys for cacheable resources', () => {
    expect(buildVersionedCacheKey('custom', 'a', 1, true)).toBe('custom:v0:a:1:true');
    expect(buildLeaderboardCacheKey('7d', 'all', 50, 0)).toBe('lb:v0:7d:all:50:0:cost:desc');
    expect(buildProfileCacheKey('alex', '30d')).toBe('profile:v0:alex:30d');
    expect(buildMeCacheKey('profile-id')).toBe('me:v0:profile-id');
    expect(buildBadgesCacheKey('alex')).toBe('badges:v0:alex');
  });

  it('bumps the version without deleting old keys', async () => {
    const oldKey = buildLeaderboardCacheKey('all', 'all', 50, 0);
    await withCache(oldKey, 3600, async () => 'old-value');

    expect(bumpCacheVersion()).toBe(1);
    const newKey = buildLeaderboardCacheKey('all', 'all', 50, 0);

    expect(oldKey).toBe('lb:v0:all:all:50:0:cost:desc');
    expect(newKey).toBe('lb:v1:all:all:50:0:cost:desc');
    expect(cache.has(oldKey)).toBe(true);
    expect(cache.has(newKey)).toBe(false);
  });

  it('keeps the existing ingestion invalidation helper as a version bump alias', () => {
    expect(getCacheVersion()).toBe(0);
    expect(purgeIngestionCaches()).toBe(1);
    expect(getCacheVersion()).toBe(1);
  });

  it('purges exact keys', async () => {
    await withCache('profile:v0:alex:all', 3600, async () => 'alex');
    await withCache('profile:v0:sam:all', 3600, async () => 'sam');

    expect(purgeKeys(['profile:v0:alex:all', 'missing-key'])).toBe(1);
    expect(cache.has('profile:v0:alex:all')).toBe(false);
    expect(cache.has('profile:v0:sam:all')).toBe(true);
  });

  it('purges keys by string prefix', async () => {
    await withCache('profile:v0:alex:all', 3600, async () => 'alex');
    await withCache('profile:v0:alex:7d', 3600, async () => 'alex-7d');
    await withCache('lb:v0:all:all:50:0:cost:desc', 3600, async () => 'leaderboard');

    expect(purgeByPrefix('profile:v0:alex')).toBe(2);
    expect(cache.has('profile:v0:alex:all')).toBe(false);
    expect(cache.has('profile:v0:alex:7d')).toBe(false);
    expect(cache.has('lb:v0:all:all:50:0:cost:desc')).toBe(true);
  });
});
