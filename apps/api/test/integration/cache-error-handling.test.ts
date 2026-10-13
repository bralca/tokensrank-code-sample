import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';
import {
  buildLeaderboardCacheKey,
  buildProfileCacheKey,
  cache,
  resetCacheForTests,
  withCache,
} from '../../src/services/cache';

let app: Awaited<ReturnType<typeof buildServer>>;
let originalCacheTtlSeconds: string | undefined;

type CacheResource = 'leaderboard' | 'profile';

function cacheHeader(response: Awaited<ReturnType<typeof app.inject>>): string | undefined {
  const header = response.headers['x-tokensrank-cache'];

  return Array.isArray(header) ? header[0] : header?.toString();
}

function keyFor(resource: CacheResource): string {
  return resource === 'leaderboard'
    ? buildLeaderboardCacheKey('all', 'all', 50, 0)
    : buildProfileCacheKey('cache_error_profile', 'all');
}

async function expireSeededEntry(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
}

function seedExpiredEntry(resource: CacheResource, createdAt: number): void {
  cache.set(
    keyFor(resource),
    {
      value: {
        data: {
          resource,
          stale: true,
        },
      },
      createdAt,
    },
    {
      ttl: 1,
    },
  );
}

async function requestResource(resource: CacheResource) {
  return await app.inject({
    method: 'GET',
    url: `/__test/cache-error/${resource}`,
  });
}

beforeAll(async () => {
  originalCacheTtlSeconds = process.env.CACHE_TTL_SECONDS;
  process.env.CACHE_TTL_SECONDS = '5';

  app = await buildServer({ logger: false });

  app.get('/__test/cache-error/:resource', async (request, reply) => {
    const { resource } = request.params as { resource: CacheResource };
    const key = keyFor(resource);

    try {
      const data = await withCache(
        key,
        5,
        async () => {
          throw new Error('database unavailable');
        },
        {
          logger: request.log,
          reply,
          request,
        },
      );

      return reply.code(200).send(data);
    } catch {
      return reply
        .code(503)
        .header('X-TokensRank-Cache', reply.getHeader('X-TokensRank-Cache') ?? 'BYPASS')
        .header('Cache-Control', 'no-store')
        .send({
          error: {
            code: 'service_unavailable',
            message: 'Database temporarily unavailable',
          },
        });
    }
  });

  await app.ready();
});

beforeEach(() => {
  resetCacheForTests();
});

afterAll(async () => {
  resetCacheForTests();

  if (originalCacheTtlSeconds === undefined) {
    delete process.env.CACHE_TTL_SECONDS;
  } else {
    process.env.CACHE_TTL_SECONDS = originalCacheTtlSeconds;
  }

  await app?.close();
});

describe('cache error handling headers', () => {
  it('returns 503 BYPASS on fresh cache miss plus database error', async () => {
    const response = await requestResource('leaderboard');

    expect(response.statusCode).toBe(503);
    expect(cacheHeader(response)).toBe('BYPASS');
    expect(response.json()).toEqual({
      error: {
        code: 'service_unavailable',
        message: 'Database temporarily unavailable',
      },
    });
  });

  it('returns 200 HIT-DEGRADED on database error with stale data less than 1 hour old', async () => {
    seedExpiredEntry('leaderboard', Date.now() - 10_000);
    await expireSeededEntry();

    const response = await requestResource('leaderboard');

    expect(response.statusCode).toBe(200);
    expect(cacheHeader(response)).toBe('HIT-DEGRADED');
    expect(response.json()).toEqual({
      data: {
        resource: 'leaderboard',
        stale: true,
      },
    });
  });

  it('returns 503 BYPASS on database error with stale data older than 1 hour', async () => {
    seedExpiredEntry('leaderboard', Date.now() - 3_600_001);
    await expireSeededEntry();

    const response = await requestResource('leaderboard');

    expect(response.statusCode).toBe(503);
    expect(cacheHeader(response)).toBe('BYPASS');
  });

  it('applies the same BYPASS and HIT-DEGRADED behavior to profile cache entries', async () => {
    const bypass = await requestResource('profile');

    expect(bypass.statusCode).toBe(503);
    expect(cacheHeader(bypass)).toBe('BYPASS');

    seedExpiredEntry('profile', Date.now() - 10_000);
    await expireSeededEntry();

    const degraded = await requestResource('profile');

    expect(degraded.statusCode).toBe(200);
    expect(cacheHeader(degraded)).toBe('HIT-DEGRADED');
    expect(degraded.json()).toEqual({
      data: {
        resource: 'profile',
        stale: true,
      },
    });
  });
});
