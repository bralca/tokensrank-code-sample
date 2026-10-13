import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';
import { createPostgresClient } from '../../src/lib/postgres';
import { healthzRoutes } from '../../src/routes/healthz';

const healthAdvisoryLockName = process.env.HEALTH_ADVISORY_LOCK_NAME || 'tokensrank.healthz';

let app: Awaited<ReturnType<typeof buildServer>>;

function expectHealthyDependency(dependency: unknown): void {
  expect(dependency).toEqual({
    status: 'ok',
    latency_ms: expect.any(Number),
  });
}

function expectHealthResponseSchema(body: Record<string, unknown>): void {
  expect(body).toEqual({
    status: 'ok',
    service: 'api',
    version: expect.any(String),
    uptime_seconds: expect.any(Number),
    dependencies: {
      supabase: expect.any(Object),
      advisory_lock: expect.any(Object),
      cache: expect.any(Object),
    },
  });

  const dependencies = body.dependencies as Record<string, unknown>;
  expectHealthyDependency(dependencies.supabase);
  expectHealthyDependency(dependencies.advisory_lock);
  expectHealthyDependency(dependencies.cache);
}

beforeAll(async () => {
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('GET /healthz', () => {
  it('returns 200 with version, uptime, and dependency status when healthy', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-tokensrank-cache']).toBeUndefined();
    expectHealthResponseSchema(response.json());
  });

  it('checks real Supabase, advisory lock, and cache dependencies', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.dependencies.supabase.status).toBe('ok');
    expect(body.dependencies.advisory_lock.status).toBe('ok');
    expect(body.dependencies.cache.status).toBe('ok');
    expect(body.dependencies.supabase.latency_ms).toBeGreaterThanOrEqual(0);
    expect(body.dependencies.advisory_lock.latency_ms).toBeGreaterThanOrEqual(0);
    expect(body.dependencies.cache.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('does not require authentication', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: {
        origin: 'http://localhost:3000',
        authorization: 'Bearer invalid-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ok');
  });

  it('returns canonical 503 envelope when the advisory lock dependency is unavailable', async () => {
    const lockClient = await createPostgresClient();

    try {
      await lockClient.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [healthAdvisoryLockName]);

      const response = await app.inject({
        method: 'GET',
        url: '/healthz',
      });
      const body = response.json();

      expect(response.statusCode).toBe(503);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(body).toEqual({
        error: {
          code: 'service_unhealthy',
          message: 'Service health check failed',
          details: {
            service: 'api',
            dependencies: {
              supabase: {
                status: 'ok',
                latency_ms: expect.any(Number),
              },
              advisory_lock: {
                status: 'unhealthy',
                latency_ms: expect.any(Number),
                reason: 'advisory_lock_unavailable',
              },
              cache: {
                status: 'ok',
                latency_ms: expect.any(Number),
              },
            },
            duration_ms: expect.any(Number),
          },
        },
      });
    } finally {
      await lockClient
        .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [healthAdvisoryLockName])
        .catch(() => undefined);
      await lockClient.end().catch(() => undefined);
    }
  });

  it('returns canonical 503 envelope when cache is not initialized', async () => {
    const isolatedApp = Fastify({ logger: false });

    try {
      await isolatedApp.register(healthzRoutes);
      await isolatedApp.ready();

      const response = await isolatedApp.inject({
        method: 'GET',
        url: '/healthz',
      });
      const body = response.json();

      expect(response.statusCode).toBe(503);
      expect(body.error.code).toBe('service_unhealthy');
      expect(body.error.details.service).toBe('api');
      expect(body.error.details.dependencies.cache).toEqual({
        status: 'unhealthy',
        latency_ms: expect.any(Number),
        reason: 'cache_not_initialized',
      });
    } finally {
      await isolatedApp.close();
    }
  });
});
