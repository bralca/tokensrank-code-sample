import type { FastifyInstance } from 'fastify';
import { adminClient } from '../clients/supabase';
import { usageWindowStart } from '../services/leaderboard';

// Daily aggregates have UTC dates, so this reports today, not a rolling 24 hours.
export async function homepageStatsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/homepage/stats', async (request, reply) => {
    const { data, error } = await adminClient.rpc('public_usage_stats', {
      p_start_date: usageWindowStart('24h'),
    }).returns<Array<{ connected: number; tokens: number; sessions: number; cost: number }>>();
    if (error) {
      request.log.error({ err: error }, 'Public usage totals unavailable');
      return reply.code(503).send({ error: { code: 'stats_unavailable', message: 'Community totals are temporarily unavailable.' } });
    }
    const row = Array.isArray(data) ? data[0] : undefined;
    return reply.header('Cache-Control', 'public, max-age=60').send({
      connected: Number(row?.connected ?? 0), tokens24h: Number(row?.tokens ?? 0),
      cost24h: Math.round(Number(row?.cost ?? 0) * 100) / 100,
      recordsToday: Number(row?.sessions ?? 0), computedAt: new Date().toISOString(),
    });
  });
}
