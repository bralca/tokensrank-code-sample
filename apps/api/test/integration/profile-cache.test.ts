import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';
import {
  buildProfileCacheKey,
  cache,
  resetCacheForTests,
} from '../../src/services/cache';
import {
  createAccessKeyFixture,
  createSchemaServiceRoleClient,
  deleteAuthUsers,
} from './ingestion-test-helpers';

const createdUserIds = new Set<string>();

let app: Awaited<ReturnType<typeof buildServer>>;
let originalCacheTtlSeconds: string | undefined;
let seededProfile: { handle: string; profileId: string; userId: string };

function cacheHeader(response: Awaited<ReturnType<typeof app.inject>>): string | undefined {
  const header = response.headers['x-tokensrank-cache'];

  return Array.isArray(header) ? header[0] : header?.toString();
}

function fileHash(label: string): string {
  return crypto.createHash('sha256').update(label).digest('hex');
}

function isoDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

async function seedSession(profileId: string, label: string, daysAgo: number, tokens: number): Promise<void> {
  const admin = createSchemaServiceRoleClient();
  const lastEventAt = isoDaysAgo(daysAgo);
  const firstEventAt = new Date(new Date(lastEventAt).getTime() - 60_000).toISOString();

  const { error: sessionError } = await admin
    .from('sessions')
    .insert({
      profile_id: profileId,
      source: 'claude',
      model: 'profile-cache-model',
      session_id: `${label}_${daysAgo}_${crypto.randomUUID()}`,
      file_sha256: fileHash(`${profileId}_${label}_${daysAgo}`),
      first_event_at: firstEventAt,
      last_event_at: lastEventAt,
      input_tokens: tokens,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_create_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      turns: 1,
      ingestion_mode: 'script_verified',
      fingerprint: {
        project_name: label,
      },
    });

  if (sessionError) {
    throw new Error(`[profile-cache-test] session seed failed: ${sessionError.message}`);
  }

  const { error: aggregateError } = await admin
    .from('daily_aggregates')
    .upsert({
      profile_id: profileId,
      date: lastEventAt.slice(0, 10),
      source: 'claude',
      model: 'profile-cache-model',
      total_tokens: tokens,
      total_sessions: 1,
      derived_cost_usd: tokens * 0.00001,
    });

  if (aggregateError) {
    throw new Error(`[profile-cache-test] aggregate seed failed: ${aggregateError.message}`);
  }
}

async function seedProfileWithUsage(): Promise<typeof seededProfile> {
  const fixture = await createAccessKeyFixture('script', 'pfcache');
  const admin = createSchemaServiceRoleClient();
  const handle = `pfcache_${crypto.randomUUID().slice(0, 8)}`;

  createdUserIds.add(fixture.userId);

  const { error: profileError } = await admin
    .from('profiles')
    .update({
      handle,
      display_name: 'Profile Cache Builder',
      mode: 'script_verified',
      verified: true,
      share_projects: false,
    })
    .eq('id', fixture.profileId);

  if (profileError) {
    throw new Error(`[profile-cache-test] profile seed failed: ${profileError.message}`);
  }

  await seedSession(fixture.profileId, 'recent', 1, 100);
  await seedSession(fixture.profileId, 'month', 20, 200);
  await seedSession(fixture.profileId, 'quarter', 80, 300);

  return {
    handle,
    profileId: fixture.profileId,
    userId: fixture.userId,
  };
}

async function getProfile(handle: string, query = '') {
  return await app.inject({
    method: 'GET',
    url: `/api/profile/${handle}${query}`,
  });
}

beforeAll(async () => {
  originalCacheTtlSeconds = process.env.CACHE_TTL_SECONDS;
  process.env.CACHE_TTL_SECONDS = '3600';
  app = await buildServer({ logger: false });
  await app.ready();
  seededProfile = await seedProfileWithUsage();
});

beforeEach(() => {
  resetCacheForTests();
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

describe('GET /api/profile/:handle cache windows', () => {
  it('returns MISS on the first request with default all window', async () => {
    const response = await getProfile(seededProfile.handle);

    expect(response.statusCode).toBe(200);
    expect(cacheHeader(response)).toBe('MISS');
    expect(response.json().window).toBe('all');
  });

  it('returns HIT for a repeated request with the same window', async () => {
    await getProfile(seededProfile.handle);
    const response = await getProfile(seededProfile.handle);

    expect(response.statusCode).toBe(200);
    expect(cacheHeader(response)).toBe('HIT');
  });

  it('returns MISS when switching to window=7d because window is part of the cache key', async () => {
    await getProfile(seededProfile.handle);
    const response = await getProfile(seededProfile.handle, '?window=7d');

    expect(response.statusCode).toBe(200);
    expect(cacheHeader(response)).toBe('MISS');
    expect(response.json().window).toBe('7d');
  });

  it('returns HIT for a repeated window=7d request', async () => {
    await getProfile(seededProfile.handle, '?window=7d');
    const response = await getProfile(seededProfile.handle, '?window=7d');

    expect(response.statusCode).toBe(200);
    expect(cacheHeader(response)).toBe('HIT');
  });

  it('stores separate cache entries for all, 7d, and 30d windows', async () => {
    await getProfile(seededProfile.handle);
    await getProfile(seededProfile.handle, '?window=7d');
    await getProfile(seededProfile.handle, '?window=30d');

    expect(cache.has(buildProfileCacheKey(seededProfile.handle, 'all'))).toBe(true);
    expect(cache.has(buildProfileCacheKey(seededProfile.handle, '7d'))).toBe(true);
    expect(cache.has(buildProfileCacheKey(seededProfile.handle, '30d'))).toBe(true);
  });

  it('returns 404 for a nonexistent handle', async () => {
    const response = await getProfile(`missing_${crypto.randomUUID().slice(0, 8)}`);

    expect(response.statusCode).toBe(404);
    expect(cacheHeader(response)).toBe('MISS');
    expect(response.json()).toMatchObject({
      error: {
        code: 'profile_not_found',
      },
    });
  });
});
