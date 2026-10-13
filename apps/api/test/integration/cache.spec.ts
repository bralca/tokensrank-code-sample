import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createAccessKeyFixture,
  createSchemaServiceRoleClient,
  deleteAuthUsers,
} from './ingestion-test-helpers';

const adminToken = 'task-90-admin-token-32-characters';
const leaderboardUrl = '/api/leaderboard?period=7d&scope=claude&limit=10&offset=0';
const allowedOrigin = 'http://localhost:3000';

type CacheModule = typeof import('../../src/services/cache');
type SeededProfile = {
  label: string;
  profileId: string;
};

let app: FastifyInstance;
let cacheModule: CacheModule;
let originalAdminToken: string | undefined;
let originalCacheTtlSeconds: string | undefined;
let seedCounter = 0;
const createdUserIds = new Set<string>();

function cacheHeader(response: LightMyRequestResponse): string | undefined {
  const header = response.headers['x-tokensrank-cache'];

  return Array.isArray(header) ? header[0] : header?.toString();
}

function fileHash(label: string): string {
  return crypto.createHash('sha256').update(label).digest('hex');
}

function authPluginSource(): string {
  return readFileSync(new URL('../../src/plugins/auth.ts', import.meta.url), 'utf8');
}

function seedCacheEntry(key: string): void {
  cacheModule.cache.set(key, {
    value: {
      key,
    },
    createdAt: Date.now(),
  }, { ttl: 2000 });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function seedLeaderboardProfile(purpose: string): Promise<SeededProfile> {
  seedCounter += 1;

  const label = `cache90_${purpose}_${seedCounter}`.replace(/[^a-z0-9_]/g, '_').slice(0, 30);
  const fixture = await createAccessKeyFixture('script', label);
  const admin = createSchemaServiceRoleClient();
  const timestamp = new Date().toISOString();
  const tokens = 90_000 + seedCounter;

  createdUserIds.add(fixture.userId);

  const { error: profileError } = await admin
    .from('profiles')
    .update({
      handle: label,
      display_name: `Builder ${label}`,
      avatar_url: `https://example.com/${label}.png`,
      mode: 'script_verified',
      verified: true,
    })
    .eq('id', fixture.profileId);

  if (profileError) {
    throw new Error(`[cache-test] profile seed failed: ${profileError.message}`);
  }

  const { error: sessionError } = await admin
    .from('sessions')
    .insert({
      profile_id: fixture.profileId,
      source: 'claude',
      model: 'cache-task-90-model',
      session_id: `${label}_session`,
      file_sha256: fileHash(`${label}_session`),
      first_event_at: timestamp,
      last_event_at: timestamp,
      input_tokens: tokens,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_create_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      turns: 1,
      ingestion_mode: 'script_verified',
    });

  if (sessionError) {
    throw new Error(`[cache-test] session seed failed: ${sessionError.message}`);
  }

  const { error: aggregateError } = await admin
    .from('daily_aggregates')
    .upsert({
      profile_id: fixture.profileId,
      date: timestamp.slice(0, 10),
      source: 'claude',
      model: 'cache-task-90-model',
      total_tokens: tokens,
      total_sessions: 1,
      derived_cost_usd: tokens * 0.00001,
    });

  if (aggregateError) {
    throw new Error(`[cache-test] aggregate seed failed: ${aggregateError.message}`);
  }

  return {
    label,
    profileId: fixture.profileId,
  };
}

async function getLeaderboard(): Promise<LightMyRequestResponse> {
  return await app.inject({
    method: 'GET',
    url: leaderboardUrl,
  });
}

async function purgeCache(
  payload: Record<string, unknown>,
  token = adminToken,
): Promise<LightMyRequestResponse> {
  return await app.inject({
    method: 'POST',
    url: '/api/admin/cache/purge',
    headers: {
      origin: allowedOrigin,
      authorization: `Bearer ${token}`,
    },
    payload,
  });
}

async function purgeCacheWithoutAuthorization(
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return await app.inject({
    method: 'POST',
    url: '/api/admin/cache/purge',
    headers: {
      origin: allowedOrigin,
    },
    payload,
  });
}

async function measure<T>(operation: () => Promise<T>): Promise<{ durationMs: number; result: T }> {
  const startedAt = performance.now();
  const result = await operation();

  return {
    durationMs: performance.now() - startedAt,
    result,
  };
}

beforeAll(async () => {
  originalAdminToken = process.env.ADMIN_PURGE_TOKEN;
  originalCacheTtlSeconds = process.env.CACHE_TTL_SECONDS;

  process.env.CACHE_TTL_SECONDS = '2';
  process.env.ADMIN_PURGE_TOKEN = adminToken;

  const [{ buildServer }, importedCacheModule] = await Promise.all([
    import('../../src/server'),
    import('../../src/services/cache'),
  ]);

  cacheModule = importedCacheModule;

  if (cacheModule.getCacheConfig().ttlSeconds !== 2) {
    throw new Error('[cache-test] CACHE_TTL_SECONDS must be read before app initialization');
  }

  app = await buildServer({ logger: false });
  await app.ready();
});

beforeEach(() => {
  process.env.CACHE_TTL_SECONDS = '2';
  cacheModule.resetCacheForTests();
});

afterAll(async () => {
  cacheModule?.resetCacheForTests();
  await deleteAuthUsers(createdUserIds);
  createdUserIds.clear();

  if (originalAdminToken === undefined) {
    delete process.env.ADMIN_PURGE_TOKEN;
  } else {
    process.env.ADMIN_PURGE_TOKEN = originalAdminToken;
  }

  if (originalCacheTtlSeconds === undefined) {
    delete process.env.CACHE_TTL_SECONDS;
  } else {
    process.env.CACHE_TTL_SECONDS = originalCacheTtlSeconds;
  }

  await app?.close();
});

describe('Task 90 cache TTL override and admin purge integration', () => {
  it('initializes the Fastify integration harness with CACHE_TTL_SECONDS=2 and real Supabase fixtures', async () => {
    const seededProfile = await seedLeaderboardProfile('setup');
    const response = await getLeaderboard();

    expect(response.statusCode).toBe(200);
    expect(cacheHeader(response)).toBe('MISS');
    expect(cacheModule.getCacheConfig().ttlSeconds).toBe(2);
    expect(response.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          handle: seededProfile.label,
          mode: 'script_verified',
        }),
      ]),
    );
  });

  it('expires cached GET /api/leaderboard responses after the CACHE_TTL_SECONDS override', async () => {
    await seedLeaderboardProfile('ttl');

    const first = await getLeaderboard();
    const second = await getLeaderboard();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(cacheHeader(first)).toBe('MISS');
    expect(cacheHeader(second)).toBe('HIT');
    expect(second.json()).toEqual(first.json());

    await sleep(3000);

    const third = await getLeaderboard();

    expect(third.statusCode).toBe(200);
    expect(cacheHeader(third)).toBe('MISS');
    expect(third.json()).toEqual(first.json());
  });

  it('purges cached leaderboard entries through the admin endpoint with a valid bearer token', async () => {
    await seedLeaderboardProfile('purge');

    const first = await getLeaderboard();
    const second = await getLeaderboard();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(cacheHeader(first)).toBe('MISS');
    expect(cacheHeader(second)).toBe('HIT');
    expect(second.json()).toEqual(first.json());

    const purge = await purgeCache({ all: true });

    expect(purge.statusCode).toBe(200);
    expect(cacheHeader(purge)).toBeUndefined();
    expect(purge.json()).toEqual({
      data: {
        purged_count: expect.any(Number),
      },
    });
    expect(purge.json().data.purged_count).toBeGreaterThanOrEqual(1);

    const afterPurge = await getLeaderboard();

    expect(afterPurge.statusCode).toBe(200);
    expect(cacheHeader(afterPurge)).toBe('MISS');
    expect(afterPurge.json()).toEqual(first.json());
  });

  it('rejects admin cache purge requests with an invalid bearer token', async () => {
    const { durationMs, result } = await measure(async () => await purgeCache({ all: true }, 'wrong-admin-token'));

    expect(result.statusCode).toBe(401);
    expect(durationMs).toBeGreaterThanOrEqual(40);
    expect(cacheHeader(result)).toBeUndefined();
    expect(result.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized',
      },
    });
  });

  it('rejects admin cache purge requests without Authorization using the same timing-safe failure path', async () => {
    const wrongToken = await measure(async () => await purgeCache({ all: true }, 'wrong-admin-token'));
    const missingToken = await measure(async () => await purgeCacheWithoutAuthorization({ all: true }));

    expect(wrongToken.result.statusCode).toBe(401);
    expect(missingToken.result.statusCode).toBe(401);
    expect(missingToken.durationMs).toBeGreaterThanOrEqual(40);
    expect(Math.abs(wrongToken.durationMs - missingToken.durationMs)).toBeLessThan(100);
    expect(missingToken.result.json()).toEqual(wrongToken.result.json());
    expect(missingToken.result.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized',
      },
    });
  });

  it('emits X-TokensRank-Cache only on cached GET endpoints across miss, hit, and purge transitions', async () => {
    await seedLeaderboardProfile('headers');

    const miss = await getLeaderboard();
    const hit = await getLeaderboard();
    const purge = await purgeCache({ all: true });
    const afterPurge = await getLeaderboard();

    expect(miss.statusCode).toBe(200);
    expect(hit.statusCode).toBe(200);
    expect(purge.statusCode).toBe(200);
    expect(afterPurge.statusCode).toBe(200);
    expect(cacheHeader(miss)).toBe('MISS');
    expect(cacheHeader(hit)).toBe('HIT');
    expect(cacheHeader(purge)).toBeUndefined();
    expect(cacheHeader(afterPurge)).toBe('MISS');
    expect(afterPurge.json()).toEqual(miss.json());
  });

  it('satisfies the Task 90 cache wiring contracts for keys, purge payloads, auth, schemas, and TTL', async () => {
    // Contract findings:
    // - Cache keys are centralized in cache.ts and use {prefix}:v{version}:{params}.
    // - The leaderboard route emits X-TokensRank-Cache through withCache() on GET responses.
    // - Admin purge accepts all three FR-66 modes: all, keys, and prefix.
    // - Admin bearer validation uses crypto.timingSafeEqual plus a fixed failure delay.
    // - This spec runs inside the per-worker tokensrank_test_w* schema from per-worker-setup.ts.
    // - CACHE_TTL_SECONDS=2 is read before the Fastify app initializes in beforeAll.
    expect(cacheModule.buildLeaderboardCacheKey('7d', 'claude', 10, 0)).toBe('lb:v0:7d:claude:10:0:cost:desc');
    expect(cacheModule.buildProfileCacheKey('alice', '30d')).toBe('profile:v0:alice:30d');
    expect(process.env.SUPABASE_SCHEMA).toMatch(/^tokensrank_test_w[0-3]$/);
    expect(cacheModule.getCacheConfig().ttlSeconds).toBe(2);
    expect(authPluginSource()).toContain('crypto.timingSafeEqual');

    seedCacheEntry('lb:v0:exact-contract');
    const emptyKeys = await purgeCache({ keys: [] });
    expect(emptyKeys.statusCode).toBe(200);
    expect(emptyKeys.json()).toEqual({ data: { purged_count: 0 } });
    expect(cacheModule.cache.has('lb:v0:exact-contract')).toBe(true);

    const exactKeys = await purgeCache({ keys: ['lb:v0:exact-contract'] });
    expect(exactKeys.statusCode).toBe(200);
    expect(exactKeys.json()).toEqual({ data: { purged_count: 1 } });
    expect(cacheModule.cache.has('lb:v0:exact-contract')).toBe(false);

    seedCacheEntry('lb:v0:empty-prefix-a');
    seedCacheEntry('profile:v0:empty-prefix-b');
    const emptyPrefix = await purgeCache({ prefix: '' });
    expect(emptyPrefix.statusCode).toBe(200);
    expect(emptyPrefix.json().data.purged_count).toBeGreaterThanOrEqual(2);
    expect(cacheModule.cache.has('lb:v0:empty-prefix-a')).toBe(false);
    expect(cacheModule.cache.has('profile:v0:empty-prefix-b')).toBe(false);

    seedCacheEntry('lb:v0:all-contract');
    const all = await purgeCache({ all: true });
    expect(all.statusCode).toBe(200);
    expect(all.json().data.purged_count).toBeGreaterThanOrEqual(1);
    expect(cacheModule.buildLeaderboardCacheKey('7d', 'claude', 10, 0)).toBe('lb:v1:7d:claude:10:0:cost:desc');
  });
});
