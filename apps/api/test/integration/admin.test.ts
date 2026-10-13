import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => {
  const adminToken = 'test-admin-token-32-characters-long';
  const originalAdminToken = process.env.ADMIN_PURGE_TOKEN;
  const originalMaxCacheItems = process.env.MAX_CACHE_ITEMS;

  process.env.ADMIN_PURGE_TOKEN = adminToken;
  process.env.MAX_CACHE_ITEMS = '20000';

  return {
    adminToken,
    originalAdminToken,
    originalMaxCacheItems,
  };
});

import { buildServer } from '../../src/server';
import {
  bumpCacheVersion,
  cache,
  getCacheVersion,
  resetCacheForTests,
  withCache,
} from '../../src/services/cache';

let app: Awaited<ReturnType<typeof buildServer>>;

async function purgeCache(payload: Record<string, unknown>, token = env.adminToken) {
  return app.inject({
    method: 'POST',
    url: '/api/admin/cache/purge',
    headers: token
      ? {
        origin: 'http://localhost:3000',
        authorization: `Bearer ${token}`,
      }
      : { origin: 'http://localhost:3000' },
    payload,
  });
}

async function seedCache(): Promise<void> {
  await withCache('profile:v0:alice:all', 3600, async () => ({ handle: 'alice' }));
  await withCache('profile:v0:bob:all', 3600, async () => ({ handle: 'bob' }));
  await withCache('lb:v0:7d:all:50:0', 3600, async () => ({ rows: [] }));
  await withCache('me:v0:user-1', 3600, async () => ({ id: 'user-1' }));
}

function restoreEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

beforeAll(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
});

beforeEach(async () => {
  resetCacheForTests();
  await seedCache();
});

afterAll(async () => {
  resetCacheForTests();
  restoreEnvValue('ADMIN_PURGE_TOKEN', env.originalAdminToken);
  restoreEnvValue('MAX_CACHE_ITEMS', env.originalMaxCacheItems);
  await app?.close();
});

describe('POST /api/admin/cache/purge', () => {
  it('purges exact keys and returns the deleted count', async () => {
    const response = await purgeCache({
      keys: ['profile:v0:alice:all', 'lb:v0:7d:all:50:0', 'missing-key'],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { purged_count: 2 } });
    expect(cache.has('profile:v0:alice:all')).toBe(false);
    expect(cache.has('lb:v0:7d:all:50:0')).toBe(false);
    expect(cache.has('profile:v0:bob:all')).toBe(true);
    expect(cache.has('me:v0:user-1')).toBe(true);
  });

  it('purges matching prefix keys only', async () => {
    const response = await purgeCache({ prefix: 'profile:v0:' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { purged_count: 2 } });
    expect(cache.has('profile:v0:alice:all')).toBe(false);
    expect(cache.has('profile:v0:bob:all')).toBe(false);
    expect(cache.has('lb:v0:7d:all:50:0')).toBe(true);
    expect(cache.has('me:v0:user-1')).toBe(true);
  });

  it('bumps cache version for all purge and leaves old entries to expire naturally', async () => {
    expect(getCacheVersion()).toBe(0);
    expect(cache.size).toBe(4);

    const response = await purgeCache({ all: true });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { purged_count: 4 } });
    expect(getCacheVersion()).toBe(1);
    expect(cache.has('profile:v0:alice:all')).toBe(true);
    expect(cache.has('lb:v0:7d:all:50:0')).toBe(true);
  });

  it('accepts the configured admin bearer token', async () => {
    const response = await purgeCache({ keys: ['me:v0:user-1'] });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { purged_count: 1 } });
  });

  it('rejects invalid and missing admin tokens with generic 401 responses', async () => {
    const invalid = await purgeCache({ all: true }, 'wrong-token');
    const missing = await purgeCache({ all: true }, '');

    for (const response of [invalid, missing]) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: {
          code: 'unauthorized',
          message: 'Unauthorized',
        },
      });
      expect(response.body).not.toContain(env.adminToken);
      expect(response.body).not.toContain('ADMIN_PURGE_TOKEN');
    }
  });

  it('rejects malformed requests with no mode, multiple modes, or invalid types', async () => {
    const malformedPayloads = [
      {},
      { keys: ['profile:v0:alice:all'], prefix: 'profile:v0:' },
      { all: false },
      { keys: 'profile:v0:alice:all' },
      { prefix: 42 },
      { all: true, extra: 'field' },
    ];

    for (const payload of malformedPayloads) {
      const response = await purgeCache(payload);
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain(env.adminToken);
    }
  });

  it('completes all purge with 10k resident keys in under 5 seconds', async () => {
    resetCacheForTests();

    for (let index = 0; index < 10_000; index += 1) {
      cache.set(`lb:v0:perf:${index}`, {
        value: { index },
        createdAt: Date.now(),
      });
    }

    expect(cache.size).toBe(10_000);
    const startedAt = performance.now();
    const response = await purgeCache({ all: true });
    const elapsedMs = performance.now() - startedAt;

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { purged_count: 10_000 } });
    expect(elapsedMs).toBeLessThan(5000);
    expect(getCacheVersion()).toBe(1);
  });

  it('does not leak auth behavior on wrong-length token comparisons', async () => {
    const response = await purgeCache({ all: true }, 'short');

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized',
      },
    });
  });

  it('uses version bump count from current cache size after prior version changes', async () => {
    expect(bumpCacheVersion()).toBe(1);
    await withCache('lb:v1:manual:all:50:0', 3600, async () => ({ rows: [] }));

    const response = await purgeCache({ all: true });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { purged_count: 5 } });
    expect(getCacheVersion()).toBe(2);
  });
});
