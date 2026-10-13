import helmet from '@fastify/helmet';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Applies API-owned security headers. Caddy also sets transport-wide headers at
 * the edge, but Fastify emits HSTS as defense-in-depth for direct API responses.
 */
const securityHeadersPluginImpl: FastifyPluginAsync = async (fastify) => {
  await fastify.register(helmet, {
    xContentTypeOptions: true,
    xFrameOptions: {
      action: 'sameorigin',
    },
    referrerPolicy: {
      policy: 'strict-origin-when-cross-origin',
    },
    contentSecurityPolicy: false,
    hsts: {
      includeSubDomains: true,
      maxAge: 31_536_000,
      preload: true,
    },
  });
};

export const securityHeadersPlugin = fp(securityHeadersPluginImpl, {
  name: 'tokensrank-security-headers',
});
