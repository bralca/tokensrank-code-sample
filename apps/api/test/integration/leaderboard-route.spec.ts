import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';
import { resetCacheForTests } from '../../src/services/cache';
import {
  createAccessKeyFixture,
  createSchemaServiceRoleClient,
  deleteAuthUsers,
} from './ingestion-test-helpers';

const createdUserIds = new Set<string>();
const adminToken = 'leaderboard-route-admin-token';

let app: Awaited<ReturnType<typeof buildServer>>;
let originalAdminToken: string | undefined;
let originalCacheTtlSeconds: string | undefined;

function fileHash(label: string): string {
  return crypto.createHash('sha256').update(label).digest('hex');
}

async function seedLeaderboardProfile(label: string, tokens: number): Promise<void> {
  const fixture = await createAccessKeyFixture('script', label);
  const admin = createSchemaServiceRoleClient();
  // Recent (relative to now) so the period=7d leaderboard query includes it — a
  // fixed date silently falls out of the 7-day window as real time passes.
  const timestamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

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
    throw new Error(`[leaderboard-route-test] profile seed failed: ${profileError.message}`);
  }

  const { error: sessionError } = await admin
    .from('sessions')
    .insert({
      profile_id: fixture.profileId,
      source: 'claude',
      model: 'claude-3-5-sonnet',
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
    throw new Error(`[leaderboard-route-test] session seed failed: ${sessionError.message}`);
  }
}

beforeAll(async () => {
  originalAdminToken = process.env.ADMIN_PURGE_TOKEN;
  originalCacheTtlSeconds = process.env.CACHE_TTL_SECONDS;
  process.env.ADMIN_PURGE_TOKEN = adminToken;

  app = await buildServer({ logger: false });
  await app.ready();
});

beforeEach(() => {
  process.env.CACHE_TTL_SECONDS = '3600';
  resetCacheForTests();
});

afterAll(async () => {
  resetCacheForTests();
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

describe('GET /api/leaderboard route', () => {
  it('rejects invalid FR-49 query parameters with the canonical error envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/leaderboard?period=lifetime&scope=all&limit=20&offset=0',
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['x-tokensrank-cache']).toBe('BYPASS');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      error: {
        code: 'invalid_leaderboard_query',
        message: 'Request query failed schema validation',
      },
    });
  });

  it('returns cached FR-50 leaderboard response shape for valid query parameters', async () => {
    await seedLeaderboardProfile('route_builder', 12_345);

    const response = await app.inject({
      method: 'GET',
      url: '/api/leaderboard?period=7d&scope=claude&limit=10&offset=0',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-tokensrank-cache']).toBe('MISS');
    expect(response.headers['cache-control']).toBe('public, max-age=3600');

    const body = response.json();

    expect(body).toMatchObject({
      data: [
        expect.objectContaining({
          rank: 1,
          rank_delta: 0,
          handle: 'route_builder',
          display_name: 'Builder route_builder',
          avatar_url: 'https://example.com/route_builder.png',
          mode: 'script_verified',
          tokens_total: 12_345,
          cost_usd_total: 0.04,
          badges: [],
        }),
      ],
      total: expect.any(Number),
    });
  });

  it('serves HIT on repeated reads, expires by TTL, and misses after admin purge', async () => {
    process.env.CACHE_TTL_SECONDS = '1';
    await seedLeaderboardProfile('cache_builder', 54_321);

    const url = '/api/leaderboard?period=7d&scope=claude&limit=10&offset=0';
    const first = await app.inject({
      method: 'GET',
      url,
    });
    const second = await app.inject({
      method: 'GET',
      url,
    });

    expect(first.statusCode).toBe(200);
    expect(first.headers['x-tokensrank-cache']).toBe('MISS');
    expect(first.headers['cache-control']).toBe('public, max-age=1');
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-tokensrank-cache']).toBe('HIT');
    expect(second.json()).toEqual(first.json());

    await new Promise((resolve) => {
      setTimeout(resolve, 1100);
    });

    const afterTtl = await app.inject({
      method: 'GET',
      url,
    });

    expect(afterTtl.statusCode).toBe(200);
    expect(afterTtl.headers['x-tokensrank-cache']).toBe('MISS');

    const purge = await app.inject({
      method: 'POST',
      url: '/api/admin/cache/purge',
      headers: {
        origin: 'http://localhost:3000',
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        all: true,
      },
    });

    expect(purge.statusCode).toBe(200);

    const afterPurge = await app.inject({
      method: 'GET',
      url,
    });

    expect(afterPurge.statusCode).toBe(200);
    expect(afterPurge.headers['x-tokensrank-cache']).toBe('MISS');
  });
});
