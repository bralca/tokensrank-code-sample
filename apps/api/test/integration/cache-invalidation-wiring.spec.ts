import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';
import { resetCacheForTests } from '../../src/services/cache';
import {
  buildIngestPayload,
  createAccessKeyFixture,
  deleteAuthUsers,
} from './ingestion-test-helpers';

const createdUserIds = new Set<string>();

let app: Awaited<ReturnType<typeof buildServer>>;

function cacheHeader(response: Awaited<ReturnType<typeof app.inject>>): string | undefined {
  const header = response.headers['x-tokensrank-cache'];

  return Array.isArray(header) ? header[0] : header?.toString();
}

async function getLeaderboard() {
  return await app.inject({
    method: 'GET',
    url: '/api/leaderboard?period=all&scope=all&limit=10&offset=0',
  });
}

async function createTrackedScriptFixture(label: string) {
  const fixture = await createAccessKeyFixture('script', label);
  createdUserIds.add(fixture.userId);
  return fixture;
}

async function ingestScriptSession(label: string) {
  const fixture = await createTrackedScriptFixture(label);

  return await app.inject({
    method: 'POST',
    url: '/api/script/sessions',
    headers: {
      authorization: `Bearer ${fixture.plaintext}`,
      origin: 'http://localhost:3000',
    },
    payload: buildIngestPayload(1, `qc6-cache-${label}-${crypto.randomUUID().slice(0, 8)}`),
  });
}

async function purgeAllCache() {
  return await app.inject({
    method: 'POST',
    url: '/api/admin/cache/purge',
    headers: {
      authorization: `Bearer ${process.env.ADMIN_PURGE_TOKEN ?? ''}`,
      origin: 'http://localhost:3000',
    },
    payload: {
      all: true,
    },
  });
}

beforeAll(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
});

beforeEach(() => {
  resetCacheForTests();
});

afterAll(async () => {
  resetCacheForTests();
  await app?.close();
  await deleteAuthUsers(createdUserIds);
});

describe('QC-6 cache invalidation wiring', () => {
  it('serves leaderboard MISS then HIT for identical reads', async () => {
    const first = await getLeaderboard();
    const second = await getLeaderboard();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(cacheHeader(first)).toBe('MISS');
    expect(cacheHeader(second)).toBe('HIT');
  });

  it('purges leaderboard cache after successful ingestion', async () => {
    await getLeaderboard();

    const warm = await getLeaderboard();
    expect(cacheHeader(warm)).toBe('HIT');

    const ingest = await ingestScriptSession('ingestion-purge');
    expect(ingest.statusCode).toBe(202);
    expect(ingest.json()).toMatchObject({
      accepted: 1,
      rejected: 0,
    });

    const afterIngestion = await getLeaderboard();
    expect(afterIngestion.statusCode).toBe(200);
    expect(cacheHeader(afterIngestion)).toBe('MISS');
  });

  it('admin purge invalidates warm leaderboard cache', async () => {
    await getLeaderboard();

    const warm = await getLeaderboard();
    expect(cacheHeader(warm)).toBe('HIT');

    const purge = await purgeAllCache();
    expect(purge.statusCode).toBe(200);
    expect(purge.json()).toMatchObject({
      data: {
        purged_count: expect.any(Number),
      },
    });

    const afterPurge = await getLeaderboard();
    expect(afterPurge.statusCode).toBe(200);
    expect(cacheHeader(afterPurge)).toBe('MISS');
  });
});
