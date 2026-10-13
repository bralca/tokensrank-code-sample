import { afterEach, describe, expect, it } from 'vitest';

import {
  formatPrometheusMetrics,
  getCacheKeyPrefix,
  getStats,
  recordCacheHit,
  recordCacheMiss,
  resetCacheStatsForTests,
} from './cache-stats';

afterEach(() => {
  resetCacheStatsForTests();
});

describe('cache stats tracking', () => {
  it('extracts the key prefix from versioned cache keys', () => {
    expect(getCacheKeyPrefix('lb:v0:all:all:50:0')).toBe('lb');
    expect(getCacheKeyPrefix('profile:v3:alex:30d')).toBe('profile');
    expect(getCacheKeyPrefix(':malformed')).toBe('unknown');
    expect(getCacheKeyPrefix('')).toBe('unknown');
  });

  it('tracks hits and misses per key prefix', () => {
    recordCacheHit('lb:v0:all:all:50:0');
    recordCacheHit('lb:v0:all:all:50:0');
    recordCacheMiss('lb:v0:7d:all:50:0');
    recordCacheMiss('profile:v0:alex:all');

    expect(getStats()).toEqual({
      totals: {
        hits: 2,
        misses: 2,
        hitRate: 0.5,
      },
      prefixes: {
        lb: {
          hits: 2,
          misses: 1,
          hitRate: 2 / 3,
        },
        profile: {
          hits: 0,
          misses: 1,
          hitRate: 0,
        },
      },
    });
  });

  it('returns immutable snapshots', () => {
    recordCacheHit('lb:v0:all:all:50:0');

    const snapshot = getStats();
    const lbStats = snapshot.prefixes.lb;

    expect(lbStats).toBeDefined();

    lbStats!.hits = 100;
    snapshot.totals.hits = 100;

    expect(getStats()).toEqual({
      totals: {
        hits: 1,
        misses: 0,
        hitRate: 1,
      },
      prefixes: {
        lb: {
          hits: 1,
          misses: 0,
          hitRate: 1,
        },
      },
    });
  });

  it('resets counters for isolated tests', () => {
    recordCacheHit('lb:v0:all:all:50:0');
    recordCacheMiss('profile:v0:alex:all');

    resetCacheStatsForTests();

    expect(getStats()).toEqual({
      totals: {
        hits: 0,
        misses: 0,
        hitRate: 0,
      },
      prefixes: {},
    });
  });

  it('formats counters in Prometheus text format', () => {
    recordCacheHit('lb:v0:all:all:50:0');
    recordCacheMiss('lb:v0:7d:all:50:0');
    recordCacheMiss('profile:v0:alex:all');

    expect(formatPrometheusMetrics()).toBe([
      '# HELP tokensrank_cache_hits_total Cache hit count by key prefix',
      '# TYPE tokensrank_cache_hits_total counter',
      'tokensrank_cache_hits_total{key_prefix="lb"} 1',
      'tokensrank_cache_hits_total{key_prefix="profile"} 0',
      '# HELP tokensrank_cache_misses_total Cache miss count by key prefix',
      '# TYPE tokensrank_cache_misses_total counter',
      'tokensrank_cache_misses_total{key_prefix="lb"} 1',
      'tokensrank_cache_misses_total{key_prefix="profile"} 1',
      '',
    ].join('\n'));
  });
});
