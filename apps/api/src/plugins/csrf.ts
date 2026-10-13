import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { getAllowedOrigins, getRequestOrigin } from '../lib/csrf';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ACCESS_KEY_AUTH_PATHS = new Set([
  '/api/script/sessions',
  '/api/self-reported/sessions',
  '/api/installer/complete',
]);

// These routes authenticate a one-time code or a scoped publish token, never
// browser cookies. Local servers have no Origin; browser callers still must
// pass the origin check so a foreign page cannot use a user's browser session.
const PUBLISH_AUTH_PATHS = new Set([
  '/api/publish/link/exchange',
  '/api/publish/local',
  '/api/publish/token/revoke',
]);

function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

function isAllowedOrigin(origin: string): boolean {
  return getAllowedOrigins().has(origin);
}

function getRequestPath(request: FastifyRequest): string {
  return request.url.split('?', 1)[0] ?? request.url;
}

function isAccessKeyAuthPath(request: FastifyRequest): boolean {
  return request.method.toUpperCase() === 'POST'
    && ACCESS_KEY_AUTH_PATHS.has(getRequestPath(request));
}

function csrfViolation(request: FastifyRequest, reply: FastifyReply, origin: string | null) {
  request.log.warn({
    event: 'csrf.origin_rejected',
    severity: 'warn',
    origin,
  }, 'Request rejected by CSRF origin whitelist');

  return reply.code(403).send({
    error: {
      code: 'csrf_violation',
      message: 'Request origin not allowed',
    },
  });
}

const csrfPluginImpl: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    if (isSafeMethod(request.method)) {
      return;
    }

    if (isAccessKeyAuthPath(request)) {
      return;
    }

    const origin = getRequestOrigin(request);

    if (!origin && request.method === 'POST' && PUBLISH_AUTH_PATHS.has(getRequestPath(request))) {
      return;
    }

    if (!origin || !isAllowedOrigin(origin)) {
      return csrfViolation(request, reply, origin);
    }
  });
};

export const csrfPlugin = fp(csrfPluginImpl, {
  name: 'tokensrank-csrf',
});
