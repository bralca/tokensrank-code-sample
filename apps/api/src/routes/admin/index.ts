import type { FastifyPluginAsync } from 'fastify';

import { formatPrometheusMetrics } from '../../services/cache-stats';
import { cachePurgeRoutes } from './cache-purge.js';

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/admin/metrics', { preHandler: [fastify.requireAdmin] }, async (request, reply) => {
    request.log.debug({ event: 'admin.metrics' }, 'Admin metrics requested');

    return reply
      .code(200)
      .type('text/plain; charset=utf-8')
      .send(formatPrometheusMetrics());
  });

  await fastify.register(cachePurgeRoutes);
};
