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

let app: Awaited<ReturnType<typeof buildServer>>;
let originalCacheTtlSeconds: string | undefined;

function cacheHeader(response: Awaited<ReturnType<typeof app.inject>>): string | undefined {
  const header = response.headers['x-tokensrank-cache'];

  return Array.isArray(header) ? header[0] : header?.toString();
}

function fileHash(label: string): string {
  return crypto.createHash('sha256').update(label).digest('hex');
}

async function seedLeaderboardProfile(label: string, tokens: number): Promise<void> {
  const fixture = await createAccessKeyFixture('script', label);
  const admin = createSchemaServiceRoleClient();
  const timestamp = new Date().toISOString();

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
    throw new Error(`[leaderboard-cache-test] profile seed failed: ${profileError.message}`);
  }

  const { error: sessionError } = await admin
    .from('sessions')
    .insert({
      profile_id: fixture.profileId,
      source: 'claude',
      model: 'leaderboard-cache-model',
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
    throw new Error(`[leaderboard-cache-test] session seed failed: ${sessionError.message}`);
  }

  const { error: aggregateError } = await admin
    .from('daily_aggregates')
    .upsert({
      profile_id: fixture.profileId,
      date: timestamp.slice(0, 10),
      source: 'claude',
      model: 'leaderboard-cache-model',
      total_tokens: tokens,
      total_sessions: 1,
      derived_cost_usd: tokens * 0.00001,
    });

  if (aggregateError) {
    throw new Error(`[leaderboard-cache-test] aggregate seed failed: ${aggregateError.message}`);
  }
}

async function getLeaderboard(query = 'period=all&scope=all&limit=10&offset=0') {
  return await app.inject({
    method: 'GET',
    url: `/api/leaderboard?${query}`,
  });
}

beforeAll(async () => {
  originalCacheTtlSeconds = process.env.CACHE_TTL_SECONDS;
  app = await buildServer({ logger: false });
  await app.ready();
});

beforeEach(async () => {
  process.env.CACHE_TTL_SECONDS = '3600';
  resetCacheForTests();
  await seedLeaderboardProfile(`lbcache_${crypto.randomUUID().slice(0, 8)}`, 50_000);
});

afterAll(async () => {
  resetCacheForTests();
  await deleteAuthUsers(createdUserIds);
  createdUserIds.clear();

  if (originalCacheTtlSeconds === undefined) {
    delete process.env.CACHE_TTL_SECONDS;
  } else {
    process.env.CACHE_TTL_SECONDS = originalCacheTtlSeconds;
  }

  await app?.close();
});

describe('GET /api/leaderboard cache headers', () => {
  it('returns MISS on the first request', async () => {
    const response = await getLeaderboard();

    expect(response.statusCode).toBe(200);
    expect(cacheHeader(response)).toBe('MISS');
  });

  it('returns HIT on the second request for the same params', async () => {
    await getLeaderboard();
    const response = await getLeaderboard();

    expect(response.statusCode).toBe(200);
    expect(cacheHeader(response)).toBe('HIT');
  });

  it('returns MISS for different leaderboard params', async () => {
    await getLeaderboard('period=all&scope=all&limit=10&offset=0');
    const response = await getLeaderboard('period=7d&scope=claude&limit=10&offset=0');

    expect(response.statusCode).toBe(200);
    expect(cacheHeader(response)).toBe('MISS');
  });

  it('serves more than 95 percent hits under repeated load after warm-up', async () => {
    await getLeaderboard();

    const responses = await Promise.all(
      Array.from({ length: 100 }, async () => await getLeaderboard()),
    );
    const hitCount = responses.filter((response) => cacheHeader(response) === 'HIT').length;

    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(hitCount / responses.length).toBeGreaterThan(0.95);
  });

  it('returns MISS again after TTL expiry', async () => {
    process.env.CACHE_TTL_SECONDS = '1';

    const first = await getLeaderboard();
    const second = await getLeaderboard();

    expect(cacheHeader(first)).toBe('MISS');
    expect(cacheHeader(second)).toBe('HIT');

    await new Promise((resolve) => {
      setTimeout(resolve, 1100);
    });

    const afterTtl = await getLeaderboard();

    expect(afterTtl.statusCode).toBe(200);
    expect(cacheHeader(afterTtl)).toBe('MISS');
  });
});
