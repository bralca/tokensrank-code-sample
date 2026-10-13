import type { FastifyInstance } from 'fastify';
import { UsageCatalogSchema, UsageDimensionSchema, UsageExplorerQuerySchema } from '@tokensrank/shared';
import { adminClient } from '../clients/supabase';
import { usageWindowStart } from '../services/leaderboard';

export async function explorerRoutes(app: FastifyInstance) {
  app.get<{ Params: { slug?: string } }>('/api/explore/:slug', async (request, reply) => respond(request, reply));
  app.get('/api/explore', async (request, reply) => respond(request, reply));
}

async function respond(request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) {
  const parsed = UsageExplorerQuerySchema.safeParse(request.query);
  const slug = (request.params as { slug?: string }).slug;
  if (!parsed.success || (slug && !/^[a-z0-9-]{1,320}$/.test(slug))) {
    return reply.code(400).send({ error: { code: 'invalid_explorer_query', message: 'Invalid usage category or period.' } });
  }
  try {
    const args = { p_kind: parsed.data.kind, p_start_date: usageWindowStart(parsed.data.period) };
    const result = slug
      ? await adminClient.rpc('query_usage_dimension', { ...args, p_slug: slug, p_limit: 50, p_offset: parsed.data.offset })
      : await adminClient.rpc('query_usage_catalog', args);
    if (result.error) throw result.error;
    const data = slug ? UsageDimensionSchema.parse(result.data) : UsageCatalogSchema.parse(result.data);
    if (slug && 'dimension' in data && !data.dimension) return reply.code(404).send({ error: { code: 'category_not_found', message: 'No published usage for this category.' } });
    return reply.header('Cache-Control', 'no-cache').send({ data });
  } catch (error) {
    request.log.error({ err: error }, 'Public usage explorer unavailable');
    return reply.code(503).send({ error: { code: 'explorer_unavailable', message: 'Usage rankings are temporarily unavailable.' } });
  }
}
