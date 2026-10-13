import { FastifyInstance } from 'fastify';

import { scriptSessionsRoutes } from './script-sessions';
import { selfReportedSessionsRoutes } from './self-reported/sessions';
import { usageImportRoutes } from './usage-import';

export async function ingestionRoutes(fastify: FastifyInstance) {
  await fastify.register(scriptSessionsRoutes);
  await fastify.register(selfReportedSessionsRoutes);
  await fastify.register(usageImportRoutes);
}
