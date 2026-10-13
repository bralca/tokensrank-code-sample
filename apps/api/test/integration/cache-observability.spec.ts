import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';
import { resetCacheForTests, withCache } from '../../src/services/cache';

const adminToken = 'test-admin-token-32-characters-long';

let app: Awaited<ReturnType<typeof buildServer>>;
let originalAdminToken: string | undefined;
let loaderCalls = 0;

beforeAll(async () => {
  originalAdminToken = process.env.ADMIN_PURGE_TOKEN;
  process.env.ADMIN_PURGE_TOKEN = adminToken;

  app = await buildServer();

  app.get('/__test/cache-observability/:prefix', async (request, reply) => {
    const { prefix } = request.params as { prefix: string };

    const data = await withCache(
      `${prefix}:v0:test`,
      3600,
      async () => {
        loaderCalls += 1;
        return {
          loader_calls: loaderCalls,
          prefix,
        };
      },
      {
        logger: request.log,
        reply,
        request,
      },
    );

    return reply.code(200).send({ data });
  });

  app.get('/__test/cache-observability-error', async (request, reply) => {
    try {
      await withCache(
        'profile:v0:error',
        3600,
        async () => {
          throw new Error('database unavailable');
        },
        {
          logger: request.log,
          reply,
          request,
        },
      );
    } catch {
      return reply.code(503).send({
        error: {
          code: 'service_unavailable',
          message: 'Service temporarily unavailable. Please refresh.',
        },
      });
    }
  });

  await app.ready();
});

beforeEach(() => {
  loaderCalls = 0;
  resetCacheForTests();
});

afterAll(async () => {
  if (originalAdminToken === undefined) {
    delete process.env.ADMIN_PURGE_TOKEN;
  } else {
    process.env.ADMIN_PURGE_TOKEN = originalAdminToken;
  }

  await app?.close();
});

describe('cache observability integration', () => {
  it('emits MISS then HIT cache headers through the Fastify lifecycle', async () => {
    const missResponse = await app.inject({
      method: 'GET',
      url: '/__test/cache-observability/lb',
    });
    const hitResponse = await app.inject({
      method: 'GET',
      url: '/__test/cache-observability/lb',
    });

    expect(missResponse.statusCode).toBe(200);
    expect(missResponse.headers['x-tokensrank-cache']).toBe('MISS');
    expect(missResponse.json()).toEqual({
      data: {
        loader_calls: 1,
        prefix: 'lb',
      },
    });

    expect(hitResponse.statusCode).toBe(200);
    expect(hitResponse.headers['x-tokensrank-cache']).toBe('HIT');
    expect(hitResponse.json()).toEqual({
      data: {
        loader_calls: 1,
        prefix: 'lb',
      },
    });
  });

  it('exposes cache hit and miss counters in Prometheus format', async () => {
    await app.inject({
      method: 'GET',
      url: '/__test/cache-observability/lb',
    });
    await app.inject({
      method: 'GET',
      url: '/__test/cache-observability/lb',
    });
    await app.inject({
      method: 'GET',
      url: '/__test/cache-observability/profile',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/metrics',
      headers: {
        origin: 'http://localhost:3000',
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('# HELP tokensrank_cache_hits_total Cache hit count by key prefix');
    expect(response.body).toContain('# TYPE tokensrank_cache_hits_total counter');
    expect(response.body).toContain('tokensrank_cache_hits_total{key_prefix="lb"} 1');
    expect(response.body).toContain('tokensrank_cache_hits_total{key_prefix="profile"} 0');
    expect(response.body).toContain('# HELP tokensrank_cache_misses_total Cache miss count by key prefix');
    expect(response.body).toContain('# TYPE tokensrank_cache_misses_total counter');
    expect(response.body).toContain('tokensrank_cache_misses_total{key_prefix="lb"} 1');
    expect(response.body).toContain('tokensrank_cache_misses_total{key_prefix="profile"} 1');
  });

  it('protects the metrics endpoint with the admin bearer token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/metrics',
      headers: {
        origin: 'http://localhost:3000',
        authorization: 'Bearer wrong-token',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Unauthorized',
      },
    });
  });

  it('emits BYPASS when the cache loader fails without a valid cached value', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/__test/cache-observability-error',
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['x-tokensrank-cache']).toBe('BYPASS');
    expect(response.json()).toEqual({
      error: {
        code: 'service_unavailable',
        message: 'Service temporarily unavailable. Please refresh.',
      },
    });
  });
});
