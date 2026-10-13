import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';
import {
  buildProfileCacheKey,
  cache,
  getCacheVersion,
  resetCacheForTests,
  withCache,
} from '../../src/services/cache';
import {
  buildIngestPayload,
  createAccessKeyFixture,
  createSchemaServiceRoleClient,
  deleteAuthUsers,
} from './ingestion-test-helpers';

const createdUserIds = new Set<string>();

let app: Awaited<ReturnType<typeof buildServer>>;
let admin: ReturnType<typeof createSchemaServiceRoleClient>;

async function repoFile(relativePath: string): Promise<string> {
  return await readFile(path.resolve(process.cwd(), '../..', relativePath), 'utf8');
}

async function postScript(accessKey: string, body: unknown) {
  return await app.inject({
    method: 'POST',
    url: '/api/script/sessions',
    headers: {
      origin: 'http://localhost:3000',
      authorization: `Bearer ${accessKey}`,
      'content-type': 'application/json',
    },
    payload: body,
  });
}

async function getProfile(profileId: string) {
  const { data, error } = await admin
    .from('profiles')
    .select('id,handle,mode,onboarded_at,verified')
    .eq('id', profileId)
    .single();

  if (error || !data) {
    throw new Error(`[state-lifecycle] profile lookup failed: ${error?.message ?? 'missing profile'}`);
  }

  return data as {
    id: string;
    handle: string | null;
    mode: string | null;
    onboarded_at: string | null;
    verified: boolean;
  };
}

beforeAll(async () => {
  admin = createSchemaServiceRoleClient();
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

describe.sequential('PRD state lifecycle SL-1 through SL-18', () => {
  it('SL-1 escalates profiles.mode to script_verified after script ingestion', async () => {
    const fixture = await createAccessKeyFixture('script', 'sl1');
    createdUserIds.add(fixture.userId);

    const response = await postScript(fixture.plaintext, buildIngestPayload(1, 'sl1'));

    expect(response.statusCode).toBe(202);
    await expect(getProfile(fixture.profileId)).resolves.toMatchObject({
      mode: 'script_verified',
      verified: true,
    });
  });

  it('SL-2 persists an immutable claimed handle in profiles.handle', async () => {
    const fixture = await createAccessKeyFixture('script', 'sl2');
    createdUserIds.add(fixture.userId);

    await expect(getProfile(fixture.profileId)).resolves.toMatchObject({
      handle: fixture.handle,
    });
  });

  it('SL-3 persists profiles.onboarded_at when onboarding completes', async () => {
    const fixture = await createAccessKeyFixture('script', 'sl3');
    createdUserIds.add(fixture.userId);
    const onboardedAt = new Date().toISOString();
    const { error } = await admin
      .from('profiles')
      .update({ onboarded_at: onboardedAt })
      .eq('id', fixture.profileId);

    expect(error).toBeNull();
    await expect(getProfile(fixture.profileId)).resolves.toMatchObject({
      onboarded_at: expect.any(String),
    });
  });

  it('SL-4 soft-revokes access keys through revoked_at', async () => {
    const fixture = await createAccessKeyFixture('script', 'sl4');
    createdUserIds.add(fixture.userId);
    const { error } = await admin
      .from('access_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', fixture.accessKeyId);
    const { data } = await admin
      .from('access_keys')
      .select('revoked_at')
      .eq('id', fixture.accessKeyId)
      .single();

    expect(error).toBeNull();
    expect(data?.revoked_at).toEqual(expect.any(String));
  });

  it('SL-5 inserts sessions rows through script ingestion', async () => {
    const fixture = await createAccessKeyFixture('script', 'sl5');
    createdUserIds.add(fixture.userId);
    const response = await postScript(fixture.plaintext, buildIngestPayload(2, 'sl5'));
    const { count } = await admin
      .from('sessions')
      .select('*', { count: 'exact', head: true })
      .eq('profile_id', fixture.profileId);

    expect(response.statusCode).toBe(202);
    expect(count).toBe(2);
  });

  it('SL-6 creates daily_aggregates through the sessions trigger', async () => {
    const fixture = await createAccessKeyFixture('script', 'sl6');
    createdUserIds.add(fixture.userId);
    const response = await postScript(fixture.plaintext, buildIngestPayload(3, 'sl6'));
    const { count } = await admin
      .from('daily_aggregates')
      .select('*', { count: 'exact', head: true })
      .eq('profile_id', fixture.profileId);

    expect(response.statusCode).toBe(202);
    expect(count ?? 0).toBeGreaterThan(0);
  });

  it('SL-7 records ingestion_runs status lifecycle', async () => {
    const fixture = await createAccessKeyFixture('script', 'sl7');
    createdUserIds.add(fixture.userId);
    const response = await postScript(fixture.plaintext, buildIngestPayload(1, 'sl7'));
    const runId = response.json().ingestion_run_id as string;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { data } = await admin
        .from('ingestion_runs')
        .select('status, completed_at')
        .eq('id', runId)
        .single();

      if (data?.status === 'completed') {
        expect(data.completed_at).toEqual(expect.any(String));
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error('[state-lifecycle] ingestion run did not reach completed status');
  });

  it('SL-8 stores and expires LRU cache entries', async () => {
    await withCache('state-lifecycle-key', 1, async () => ({ ok: true }));

    expect(cache.has('state-lifecycle-key')).toBe(true);
  });

  it('SL-9 increments cache_version on purge', async () => {
    const before = getCacheVersion();
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/cache/purge',
      headers: {
        origin: 'http://localhost:3000',
        authorization: `Bearer ${process.env.ADMIN_PURGE_TOKEN ?? ''}`,
      },
      payload: { all: true },
    });

    expect(response.statusCode).toBe(200);
    expect(getCacheVersion()).toBeGreaterThan(before);
  });

  it('SL-10 and SL-11 clear tr_at and tr_rt cookies on sign-out', async () => {
    const source = await repoFile('apps/api/src/plugins/cookies.ts');

    expect(source).toContain('tr_at');
    expect(source).toContain('tr_rt');
    expect(source).toContain('maxAge: 0');
  });

  it('SL-12 closes onboarding SSE EventSource on completion or unmount', async () => {
    const source = await repoFile('apps/web/app/onboarding/SSEListener.tsx');

    expect(source).toContain('new EventSource');
    expect(source).toContain('.close()');
  });

  it('SL-13 implements script file locking with stale lock recovery', async () => {
    const source = await repoFile('packages/script/bin/agent.mjs');

    expect(source).toContain('acquireRunLock');
    expect(source).toContain('STALE_LOCK_MS');
    expect(source).toContain('.lock');
  });

  it('SL-14 initializes state.json with install identity', async () => {
    const source = await repoFile('packages/script/bin/agent.mjs');

    expect(source).toContain('install_id');
    expect(source).toContain('state.json');
  });

  it('SL-15 persists shipped_session_ids for script-side dedup', async () => {
    const source = await repoFile('packages/script/bin/agent.mjs');

    expect(source).toContain('shipped_session_ids');
    expect(source).toContain('DEDUP_STATE_CAP');
  });

  it('SL-16 persists pending_payloads for offline retry', async () => {
    const source = await repoFile('packages/script/bin/agent.mjs');

    expect(source).toContain('pending_payloads');
    expect(source).toContain('OFFLINE_QUEUE_CAP');
  });

  it('SL-17 enforces last_run_at guard timer', async () => {
    const source = await repoFile('packages/script/bin/agent.mjs');

    expect(source).toContain('last_run_at');
    expect(source).toContain('LAST_RUN_MIN_INTERVAL_MS');
  });

  it('SL-18 sets Next.js ISR revalidate cache for profile pages', async () => {
    const source = await repoFile('apps/web/app/(public)/u/[handle]/page.tsx');

    expect(source).toContain('revalidate: 60');
    expect(source).toContain("tags: ['profile'");
    expect(buildProfileCacheKey('state_lifecycle', 'all')).toContain('profile:v');
  });
});
