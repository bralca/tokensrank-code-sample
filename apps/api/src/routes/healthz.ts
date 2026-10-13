import type { FastifyPluginAsync } from 'fastify';

import packageJson from '../../package.json';
import { adminClient } from '../clients/supabase';
import { createPostgresClient } from '../lib/postgres';
import { cache, getCacheConfig } from '../services/cache';

type DependencyStatus = 'ok' | 'unhealthy';

type HealthDependency = {
  status: DependencyStatus;
  latency_ms: number;
  reason?: string;
};

type HealthDependencies = {
  supabase: HealthDependency;
  advisory_lock: HealthDependency;
  cache: HealthDependency;
};

const HEALTH_CHECK_TIMEOUT_MS = Number.parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS || '3000', 10);
const HEALTH_ADVISORY_LOCK_NAME = process.env.HEALTH_ADVISORY_LOCK_NAME || 'tokensrank.healthz';

function errorEnvelope(code: string, message: string, details?: Record<string, unknown>) {
  return {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getHealthCheckTimeoutMs(): number {
  return Number.isFinite(HEALTH_CHECK_TIMEOUT_MS) && HEALTH_CHECK_TIMEOUT_MS > 0
    ? HEALTH_CHECK_TIMEOUT_MS
    : 3000;
}

async function withTimeout<T>(operation: PromiseLike<T>, dependency: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${dependency} health check timed out`));
    }, getHealthCheckTimeoutMs());
  });

  try {
    return await Promise.race([Promise.resolve(operation), timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function checkSupabase(): Promise<HealthDependency> {
  const startedAt = performance.now();

  try {
    const { error } = await withTimeout(
      adminClient
        .from('profiles')
        .select('id', { head: true, count: 'exact' })
        .limit(1),
      'supabase',
    );

    if (error) {
      return {
        status: 'unhealthy',
        latency_ms: Math.round(performance.now() - startedAt),
        reason: error.message,
      };
    }

    return {
      status: 'ok',
      latency_ms: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      latency_ms: Math.round(performance.now() - startedAt),
      reason: getErrorMessage(error),
    };
  }
}

async function checkAdvisoryLock(): Promise<HealthDependency> {
  const startedAt = performance.now();
  let client: Awaited<ReturnType<typeof createPostgresClient>> | null = null;
  let lockAcquired = false;

  try {
    client = await withTimeout(createPostgresClient(), 'postgres');
    const lockResult = await withTimeout(
      client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
        [HEALTH_ADVISORY_LOCK_NAME],
      ),
      'postgres_advisory_lock',
    );

    lockAcquired = lockResult.rows[0]?.acquired === true;

    if (!lockAcquired) {
      return {
        status: 'unhealthy',
        latency_ms: Math.round(performance.now() - startedAt),
        reason: 'advisory_lock_unavailable',
      };
    }

    return {
      status: 'ok',
      latency_ms: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      latency_ms: Math.round(performance.now() - startedAt),
      reason: getErrorMessage(error),
    };
  } finally {
    if (client) {
      if (lockAcquired) {
        await client
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [HEALTH_ADVISORY_LOCK_NAME])
          .catch(() => undefined);
      }

      await client.end().catch(() => undefined);
    }
  }
}

function checkCache(fastifyCache: unknown): HealthDependency {
  const startedAt = performance.now();

  try {
    const config = getCacheConfig();
    const cacheAvailable = typeof fastifyCache === 'object'
      && fastifyCache !== null
      && typeof (fastifyCache as { withCache?: unknown }).withCache === 'function'
      && typeof cache.size === 'number'
      && config.ttlSeconds > 0
      && config.maxItems > 0
      && config.maxSizeBytes > 0;

    if (!cacheAvailable) {
      return {
        status: 'unhealthy',
        latency_ms: Math.round(performance.now() - startedAt),
        reason: 'cache_not_initialized',
      };
    }

    return {
      status: 'ok',
      latency_ms: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      latency_ms: Math.round(performance.now() - startedAt),
      reason: getErrorMessage(error),
    };
  }
}

function allDependenciesHealthy(dependencies: HealthDependencies): boolean {
  return Object.values(dependencies).every((dependency) => dependency.status === 'ok');
}

export const healthzRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/healthz', async (request, reply) => {
    const startedAt = performance.now();
    const [supabase, advisoryLock] = await Promise.all([
      checkSupabase(),
      checkAdvisoryLock(),
    ]);
    const dependencies: HealthDependencies = {
      supabase,
      advisory_lock: advisoryLock,
      cache: checkCache(fastify.cache),
    };
    const durationMs = Math.round(performance.now() - startedAt);

    if (!allDependenciesHealthy(dependencies)) {
      request.log.warn({
        event: 'healthz.unhealthy',
        dependencies,
        duration_ms: durationMs,
      }, '[healthz] Dependency health check failed');

      return reply
        .code(503)
        .header('Cache-Control', 'no-store')
        .send(errorEnvelope('service_unhealthy', 'Service health check failed', {
          service: 'api',
          dependencies,
          duration_ms: durationMs,
        }));
    }

    return reply
      .code(200)
      .header('Cache-Control', 'no-store')
      .send({
        status: 'ok',
        service: 'api',
        version: packageJson.version,
        uptime_seconds: Math.floor(process.uptime()),
        dependencies,
      });
  });
};
