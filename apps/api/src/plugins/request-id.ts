import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { ulid } from 'ulid';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

function bindRequestLogger(request: { log: FastifyBaseLogger }, requestId: string): void {
  if (typeof request.log.child !== 'function') {
    return;
  }

  Object.defineProperty(request, 'log', {
    value: request.log.child({ request_id: requestId }),
    configurable: true,
  });
}

const requestIdPluginDefinition: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('requestId', '');

  fastify.addHook('onRequest', async (request, reply) => {
    const requestId = ulid();
    request.requestId = requestId;
    bindRequestLogger(request, requestId);
    reply.header('X-Request-ID', requestId);
  });

  fastify.addHook('onSend', async (request, reply) => {
    reply.header('X-Request-ID', request.requestId);
  });
};

export const requestIdPlugin = fp(requestIdPluginDefinition, {
  name: 'tokensrank-request-id',
});
