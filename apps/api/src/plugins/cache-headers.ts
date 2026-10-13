import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { CacheStatus } from '../services/cache-stats';

export const CACHE_STATUS_HEADER = 'X-TokensRank-Cache';

declare module 'fastify' {
  interface FastifyRequest {
    cacheStatus?: CacheStatus;
  }
}

export function setRequestCacheStatus(request: FastifyRequest | undefined, status: CacheStatus): void {
  if (!request) {
    return;
  }

  request.cacheStatus = status;
}

export function setCacheStatusHeader(reply: FastifyReply | undefined, status: CacheStatus): void {
  if (!reply) {
    return;
  }

  reply.header(CACHE_STATUS_HEADER, status);
}

export async function cacheHeadersPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onSend', async (request, reply, payload) => {
    if (request.cacheStatus && !reply.hasHeader(CACHE_STATUS_HEADER)) {
      reply.header(CACHE_STATUS_HEADER, request.cacheStatus);
    }

    return payload;
  });
}
