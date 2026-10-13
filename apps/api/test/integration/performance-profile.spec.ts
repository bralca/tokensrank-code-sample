import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';
import { resetCacheForTests } from '../../src/services/cache';
import {
  createAccessKeyFixture,
  createSchemaServiceRoleClient,
  deleteAuthUsers,
} from './ingestion-test-helpers';

const PROFILE_P95_BUDGET_MS = Number.parseInt(process.env.PERF_PROFILE_API_P95_MS ?? '200', 10);
const SAMPLE_COUNT = Number.parseInt(process.env.PERF_PROFILE_API_SAMPLES ?? '25', 10);

const createdUserIds = new Set<string>();

let app: Awaited<ReturnType<typeof buildServer>>;
let originalCacheTtlSeconds: string | undefined;
let seededProfile: { handle: string; profileId: string; userId: string };

function percentile(values: number[], percentileValue: number): number {
  const sortedValues = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil((percentileValue / 100) * sortedValues.length) - 1,
  );

  return sortedValues[index] ?? 0;
}

function cacheHeader(response: Awaited<ReturnType<typeof app.inject>>): string | undefined {
  const header = response.headers['x-tokensrank-cache'];

  return Array.isArray(header) ? header[0] : header?.toString();
}

function sha(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isoDaysAgo(daysAgo: number): string {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  date.setUTCHours(12, 0, 0, 0);

  return date.toISOString();
}

async function seedSession(profileId: string, index: number): Promise<void> {
  const admin = createSchemaServiceRoleClient();
  const lastEventAt = isoDaysAgo((index % 30) + 1);
  const firstEventAt = new Date(new Date(lastEventAt).getTime() - 15 * 60_000).toISOString();
  const source = index % 2 === 0 ? 'claude' : 'codex';
  const model = source === 'claude' ? 'claude-3-5-sonnet' : 'gpt-5-codex';
  const sessionId = `perf_profile_session_${index}_${crypto.randomUUID()}`;
  const tokens = 1_000 + index * 25;

  const { error: sessionError } = await admin
    .from('sessions')
    .insert({
      profile_id: profileId,
      source,
      model,
      session_id: sessionId,
      file_sha256: sha(sessionId),
      first_event_at: firstEventAt,
      last_event_at: lastEventAt,
      input_tokens: tokens,
      output_tokens: 250,
      cache_read_tokens: 0,
      cache_create_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      turns: 2,
      ingestion_mode: 'script_verified',
      fingerprint: {
        project_name: `perf-profile-${index % 5}`,
      },
    });

  if (sessionError) {
    throw new Error(`[performance-profile] session seed failed: ${sessionError.message}`);
  }

  const { error: aggregateError } = await admin
    .from('daily_aggregates')
    .upsert({
      profile_id: profileId,
      date: lastEventAt.slice(0, 10),
      source,
      model,
      total_tokens: tokens + 250,
      total_sessions: 1,
      derived_cost_usd: (tokens + 250) * 0.00001,
    });

  if (aggregateError) {
    throw new Error(`[performance-profile] aggregate seed failed: ${aggregateError.message}`);
  }
}

async function seedProfileWithUsage(): Promise<typeof seededProfile> {
  const fixture = await createAccessKeyFixture('script', 'perfprofile');
  const admin = createSchemaServiceRoleClient();
  const handle = `perfprofile_${crypto.randomUUID().slice(0, 8)}`;

  createdUserIds.add(fixture.userId);

  const { error: profileError } = await admin
    .from('profiles')
    .update({
      handle,
      display_name: 'Performance Profile Builder',
      avatar_url: null,
      bio: 'Profile payload used for endpoint performance acceptance.',
      x_handle: handle,
      mode: 'script_verified',
      verified: true,
      share_projects: true,
    })
    .eq('id', fixture.profileId);

  if (profileError) {
    throw new Error(`[performance-profile] profile seed failed: ${profileError.message}`);
  }

  await Promise.all(Array.from({ length: 20 }, async (_value, index) => {
    await seedSession(fixture.profileId, index);
  }));

  return {
    handle,
    profileId: fixture.profileId,
    userId: fixture.userId,
  };
}

async function getProfile(handle: string) {
  return await app.inject({
    method: 'GET',
    url: `/api/profile/${handle}?window=all`,
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

describe('GET /api/profile/:handle performance', () => {
  it('serves cached public profile payloads under the p95 budget', async () => {
    const warm = await getProfile(seededProfile.handle);

    expect(warm.statusCode).toBe(200);
    expect(cacheHeader(warm)).toBe('MISS');

    const latenciesMs: number[] = [];
    const responses = [];

    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const startedAt = performance.now();
      const response = await getProfile(seededProfile.handle);
      latenciesMs.push(performance.now() - startedAt);
      responses.push(response);
    }

    const p95Ms = percentile(latenciesMs, 95);

    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(responses.every((response) => cacheHeader(response) === 'HIT')).toBe(true);
    expect(p95Ms, `profile cached p95 ${p95Ms.toFixed(2)}ms exceeded ${PROFILE_P95_BUDGET_MS}ms`).toBeLessThan(PROFILE_P95_BUDGET_MS);
  });
});
