import type { FastifyPluginAsync } from 'fastify';
import {
  CachePurgeRequestSchema,
  CachePurgeResponseSchema,
  type CachePurgeRequest,
} from '@tokensrank/shared';

import { bumpCacheVersion, cache, purgeByPrefix, purgeKeys } from '../../services/cache';

function errorEnvelope(code: string, message: string) {
  return {
    error: {
      code,
      message,
    },
  };
}

function purgeCache(body: CachePurgeRequest): number {
  if ('keys' in body) {
    return purgeKeys(body.keys);
  }

  if ('prefix' in body) {
    return purgeByPrefix(body.prefix);
  }

  const purgedCount = cache.size;
  bumpCacheVersion();
  return purgedCount;
}

export const cachePurgeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/api/admin/cache/purge', {
    preHandler: [fastify.requireAdmin],
  }, async (request, reply) => {
    const parsed = CachePurgeRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      request.log.warn({
        event: 'admin.cache_purge.invalid_request',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
        })),
      }, 'Invalid cache purge request');

      return reply
        .code(400)
        .send(errorEnvelope('invalid_request', 'Request body failed schema validation'));
    }

    const purgedCount = purgeCache(parsed.data);
    const mode = 'keys' in parsed.data
      ? 'keys'
      : 'prefix' in parsed.data
        ? 'prefix'
        : 'all';

    request.log.info({
      event: 'cache.purged',
      mode,
      purged_count: purgedCount,
    }, 'Cache purge completed');

    return reply.code(200).send(CachePurgeResponseSchema.parse({
      data: {
        purged_count: purgedCount,
      },
    }));
  });
};
