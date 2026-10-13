import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildBadgesCacheKey,
  buildMeCacheKey,
  cache,
  getCacheConfig,
  getCacheMetrics,
  purgeKeys,
  resetCacheForTests,
  withCache,
} from '../../src/services/cache';
import {
  BADGE_EVALUATOR_LOCK_NAME,
  evaluateAllProfiles,
  evaluateBadge,
  hashAdvisoryLockKey,
  type BadgeCatalogRow,
  type ProfileRow,
} from '../../src/services/badge-evaluator';
import type { SessionPayload } from '@tokensrank/shared';

type QueryResult = {
  data?: unknown;
  error?: { message: string; code?: string } | null;
};

type FakeSupabasePlan = Record<string, QueryResult>;

function createFakeSupabase(plan: FakeSupabasePlan) {
  return {
    from(table: string) {
      const resolveResult = (): QueryResult => plan[table] ?? { data: [], error: null };
      const builder = {
        eq: () => builder,
        gte: () => builder,
        in: () => builder,
        insert: async () => ({ data: null, error: null }),
        limit: () => builder,
        maybeSingle: async () => {
          const result = resolveResult();
          const data = Array.isArray(result.data) ? result.data[0] ?? null : result.data ?? null;

          return { data, error: result.error ?? null };
        },
        order: () => builder,
        select: () => builder,
        single: async () => resolveResult(),
        then: (resolve: (value: QueryResult) => unknown, reject: (reason?: unknown) => unknown) => (
          Promise.resolve(resolveResult()).then(resolve, reject)
        ),
      };

      return builder;
    },
  };
}

function createSession(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    source: 'claude',
    session_id: 'service-coverage-session',
    model: 'claude-3-5-sonnet',
    first_event_at: '2026-04-27T10:00:00.000Z',
    last_event_at: '2026-04-27T10:05:00.000Z',
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0,
    turns: 2,
    file_sha256: '4'.repeat(64),
    ...overrides,
  };
}

function createIngestBody(sessions: SessionPayload[]) {
  return {
    client: {
      version: '1.0.0',
      install_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      platform: 'darwin',
      arch: 'arm64',
    },
    run: {
      run_id: `service-coverage-${sessions.length}`,
      started_at: '2026-04-27T10:00:00.000Z',
      finished_at: '2026-04-27T10:10:00.000Z',
    },
    sessions,
  };
}

function createLoggerCollector() {
  const entries: Array<{ level: string; payload: Record<string, unknown> }> = [];

  return {
    entries,
    logger: {
      debug: (payload: Record<string, unknown>) => entries.push({ level: 'debug', payload }),
      error: (payload: Record<string, unknown>) => entries.push({ level: 'error', payload }),
      info: (payload: Record<string, unknown>) => entries.push({ level: 'info', payload }),
      warn: (payload: Record<string, unknown>) => entries.push({ level: 'warn', payload }),
    },
  };
}

describe.sequential('QC-3 backend service branch coherence', () => {
  afterEach(() => {
    vi.doUnmock('../../src/lib/postgres');
    vi.restoreAllMocks();
    resetCacheForTests();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('covers cache configuration, stale degradation, bypass, exact purge, and key builders', async () => {
    vi.stubEnv('CACHE_TTL_SECONDS', 'invalid');
    vi.stubEnv('MAX_CACHE_ITEMS', '7');
    vi.stubEnv('MAX_CACHE_SIZE_BYTES', '');
    expect(getCacheConfig()).toEqual({
      ttlSeconds: 3600,
      maxItems: 7,
      maxSizeBytes: 52_428_800,
    });

    await expect(withCache('qc3:no-loader', 30, undefined as never)).rejects.toThrow('withCache requires a loader function');

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    cache.set('qc3:circular', { value: circular, createdAt: Date.now() });
    expect(cache.has('qc3:circular')).toBe(true);

    const cacheGet = cache.get.bind(cache);
    vi.spyOn(cache, 'get').mockImplementation((key, options) => {
      if (key === 'qc3:stale' && options?.allowStale === true) {
        return {
          value: { status: 'old' },
          createdAt: Date.now() - 5,
        };
      }

      if (key === 'qc3:stale') {
        return undefined;
      }

      return cacheGet(key, options);
    });

    const staleLogs = createLoggerCollector();
    await expect(withCache('qc3:stale', 1, async () => {
      throw new Error('origin unavailable');
    }, { logger: staleLogs.logger })).resolves.toEqual({ status: 'old' });
    expect(staleLogs.entries.some((entry) => entry.payload.event === 'cache.served_stale')).toBe(true);

    const bypassLogs = createLoggerCollector();
    await expect(withCache('qc3:bypass', async () => {
      throw 'plain failure';
    }, { logger: bypassLogs.logger })).rejects.toBe('plain failure');
    expect(bypassLogs.entries.some((entry) => entry.payload.status === 'BYPASS')).toBe(true);

    cache.set('me:v0:user-1', { value: true, createdAt: Date.now() });
    expect(purgeKeys([buildMeCacheKey('user-1')])).toBe(1);
    expect(buildBadgesCacheKey('alice')).toBe('badges:v0:alice');
    expect(getCacheMetrics().misses).toBeGreaterThan(0);
  });

  it('covers badge evaluator fetch, skipped, per-badge, and per-profile error paths', async () => {
    const logger = createLoggerCollector();

    await expect(evaluateAllProfiles(createFakeSupabase({
      profiles: { data: [], error: null },
      badges: { data: null, error: { message: 'catalog offline' } },
    }) as never, {
      acquireLock: false,
      logger: logger.logger,
    })).rejects.toThrow('Failed to fetch badges: catalog offline');
    await expect(evaluateAllProfiles(createFakeSupabase({
      profiles: { data: null, error: { message: 'profiles offline' } },
      badges: { data: [], error: null },
    }) as never, {
      acquireLock: false,
      logger: logger.logger,
    })).rejects.toThrow('Failed to fetch profiles: profiles offline');

    const missingValidator = await evaluateAllProfiles(createFakeSupabase({
      profiles: {
        data: [{
          id: '10000000-0000-0000-0000-000000000001',
          user_id: '10000000-0000-0000-0000-000000000001',
          handle: 'missing_validator',
          mode: 'script_verified',
        } satisfies ProfileRow],
        error: null,
      },
      badges: {
        data: [{
          slug: 'not_canonical',
          requires_verification: false,
          criteria_json: {},
        } satisfies BadgeCatalogRow],
        error: null,
      },
      daily_aggregates: { data: [], error: null },
      sessions: { data: [], error: null },
    }) as never, {
      acquireLock: false,
      logger: logger.logger,
    });
    expect(missingValidator).toMatchObject({ evaluated: 1, skipped: 1, badgesEvaluated: 1 });
    expect(logger.entries.some((entry) => entry.payload.event === 'badge.validator_missing')).toBe(true);

    const invalidCriteria = await evaluateAllProfiles(createFakeSupabase({
      profiles: {
        data: [{
          id: '10000000-0000-0000-0000-000000000011',
          user_id: '10000000-0000-0000-0000-000000000011',
          handle: 'invalid_criteria',
          mode: 'script_verified',
        } satisfies ProfileRow],
        error: null,
      },
      badges: {
        data: [{
          slug: 'tier',
          requires_verification: false,
          criteria_json: { threshold_tokens: -1 },
        } satisfies BadgeCatalogRow],
        error: null,
      },
      daily_aggregates: { data: [], error: null },
      sessions: { data: [], error: null },
    }) as never, {
      acquireLock: false,
      logger: logger.logger,
    });
    expect(invalidCriteria).toMatchObject({ evaluated: 1, skipped: 1, badgesEvaluated: 1 });
    expect(logger.entries.some((entry) => entry.payload.event === 'badge.criteria_invalid')).toBe(true);

    const profileFailure = await evaluateAllProfiles(createFakeSupabase({
      profiles: {
        data: [{
          id: '10000000-0000-0000-0000-000000000002',
          user_id: '10000000-0000-0000-0000-000000000002',
          handle: 'profile_failure',
          mode: 'script_verified',
        } satisfies ProfileRow],
        error: null,
      },
      badges: { data: [], error: null },
      sessions: { data: null, error: { message: 'sessions unavailable' } },
    }) as never, {
      acquireLock: false,
      logger: logger.logger,
    });
    expect(profileFailure.errors[0]).toMatchObject({
      profile_id: '10000000-0000-0000-0000-000000000002',
      error: 'Failed to fetch sessions for profile 10000000-0000-0000-0000-000000000002: sessions unavailable',
    });
    expect(logger.entries.some((entry) => entry.payload.event === 'badge.profile_failed')).toBe(true);

    const aggregateFailure = await evaluateAllProfiles(createFakeSupabase({
      profiles: {
        data: [{
          id: '10000000-0000-0000-0000-000000000012',
          user_id: '10000000-0000-0000-0000-000000000012',
          handle: 'aggregate_failure',
          mode: 'script_verified',
        } satisfies ProfileRow],
        error: null,
      },
      badges: { data: [], error: null },
      daily_aggregates: { data: null, error: { message: 'aggregates unavailable' } },
      sessions: { data: [], error: null },
    }) as never, {
      acquireLock: false,
      logger: logger.logger,
    });
    expect(aggregateFailure.errors[0]).toMatchObject({
      profile_id: '10000000-0000-0000-0000-000000000012',
      error: 'Failed to fetch aggregates for profile 10000000-0000-0000-0000-000000000012: aggregates unavailable',
    });

    const perBadgeFailure = await evaluateAllProfiles(createFakeSupabase({
      profiles: {
        data: [{
          id: 'not-a-uuid',
          user_id: '10000000-0000-0000-0000-000000000003',
          handle: 'badge_failure',
          mode: 'script_verified',
        } satisfies ProfileRow],
        error: null,
      },
      badges: {
        data: [{
          slug: 'tier',
          requires_verification: false,
          criteria_json: { threshold_tokens: 1 },
        } satisfies BadgeCatalogRow],
        error: null,
      },
      daily_aggregates: { data: [], error: null },
      sessions: {
        data: [{
          ...createSession(),
          total_tokens: 10,
        }],
        error: null,
      },
    }) as never, {
      acquireLock: false,
      logger: logger.logger,
    });
    expect(perBadgeFailure.errors[0]).toMatchObject({
      profile_id: 'not-a-uuid',
      badge_slug: 'tier',
    });
    expect(logger.entries.some((entry) => entry.payload.event === 'badge.evaluation_failed')).toBe(true);

    expect(hashAdvisoryLockKey(BADGE_EVALUATOR_LOCK_NAME)).toBeTypeOf('number');
    expect(evaluateBadge(
      { id: 'profile', mode: 'script_verified', handle: 'profile' },
      [],
      [],
      { slug: 'tier', requires_verification: false, criteria_json: { threshold_tokens: -1 } },
    )).toMatchObject({ awarded: false, reason: 'criteria_invalid' });

    const slowRun = await evaluateAllProfiles(createFakeSupabase({
      profiles: { data: [], error: null },
      badges: { data: [], error: null },
    }) as never, {
      acquireLock: false,
      logger: logger.logger,
      timeoutWarnMs: -1,
    });
    expect(slowRun.lockAcquired).toBe(true);
    expect(logger.entries.some((entry) => entry.payload.event === 'badge_cron.slow')).toBe(true);
  });

  it('covers badge evaluator lock skip and award side effects with a mocked postgres client', async () => {
    vi.resetModules();

    const queries: string[] = [];
    vi.doMock('../../src/lib/postgres', () => ({
      createPostgresClient: async () => ({
        end: async () => undefined,
        query: async (sql: string) => {
          queries.push(sql);

          if (sql.includes('pg_try_advisory_lock')) {
            return {
              rows: [{ acquired: false }],
              rowCount: 1,
            };
          }

          return {
            rows: [],
            rowCount: 1,
          };
        },
      }),
      getActiveDatabaseSchema: () => 'tokensrank_test_service_coverage',
      quoteIdentifier: (value: string) => `"${value.replaceAll('"', '""')}"`,
    }));

    const { evaluateAllProfiles: evaluateWithMockedPostgres } = await import('../../src/services/badge-evaluator');
    const lockedLogger = createLoggerCollector();
    const locked = await evaluateWithMockedPostgres(createFakeSupabase({
      profiles: { data: [], error: null },
      badges: { data: [], error: null },
    }) as never, {
      logger: lockedLogger.logger,
    });
    expect(locked).toMatchObject({ lockAcquired: false, evaluated: 0 });
    expect(lockedLogger.entries.some((entry) => entry.payload.event === 'badge_cron.skipped')).toBe(true);
    expect(queries.some((query) => query.includes('pg_advisory_unlock'))).toBe(true);

    const awardLogger = createLoggerCollector();
    const awarded = await evaluateWithMockedPostgres(createFakeSupabase({
      profiles: {
        data: [{
          id: '10000000-0000-0000-0000-000000000013',
          user_id: '10000000-0000-0000-0000-000000000013',
          handle: 'award_path',
          mode: 'script_verified',
        } satisfies ProfileRow],
        error: null,
      },
      badges: {
        data: [{
          slug: 'tier',
          requires_verification: false,
          criteria_json: { threshold_tokens: 1 },
        } satisfies BadgeCatalogRow],
        error: null,
      },
      daily_aggregates: { data: [], error: null },
      sessions: {
        data: [{
          id: 'award-session',
          profile_id: '10000000-0000-0000-0000-000000000013',
          source: 'claude',
          session_id: 'award-session',
          model: 'claude-3-5-sonnet',
          first_event_at: '2026-04-27T10:00:00.000Z',
          last_event_at: '2026-04-27T10:05:00.000Z',
          input_tokens: 10,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_create_tokens: 0,
          cached_tokens: 0,
          reasoning_tokens: 0,
          total_tokens: 10,
          turns: 1,
          fingerprint: {},
        }],
        error: null,
      },
    }) as never, {
      acquireLock: false,
      logger: awardLogger.logger,
    });
    expect(awarded).toMatchObject({ evaluated: 1, awarded: 1, badgesEvaluated: 1 });
    expect(awardLogger.entries.some((entry) => entry.payload.event === 'audit.recorded')).toBe(true);
    expect(awardLogger.entries.some((entry) => entry.payload.event === 'badge.cache_purged')).toBe(true);
  });

  it('covers non-test pretty logger configuration', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOG_LEVEL', 'debug');

    const loggerModule = await import('../../src/lib/logger');

    expect(loggerModule.loggerOptions.transport).toMatchObject({
      target: 'pino-pretty',
      options: {
        colorize: true,
        ignore: 'pid,hostname',
        singleLine: true,
      },
    });
  });
});
