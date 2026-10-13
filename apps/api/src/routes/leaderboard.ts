import type { FastifyInstance } from 'fastify';
import {
  LeaderboardQuerySchema,
  LeaderboardResponseSchema,
  type LeaderboardQuery,
} from '@tokensrank/shared';

import { adminClient } from '../clients/supabase';
import {
  buildLeaderboardCacheKey,
  getCacheConfig,
  withCache,
} from '../services/cache';
import {
  getLeaderboard,
  countLeaderboardProfiles,
  type LeaderboardRow,
} from '../services/leaderboard';

const CACHE_STATUS_HEADER = 'X-TokensRank-Cache';

function errorEnvelope(code: string, message: string) {
  return {
    error: {
      code,
      message,
    },
  };
}

type LeaderboardPageData = {
  rows: LeaderboardRow[];
  total: number;
};

async function loadLeaderboardData(query: LeaderboardQuery): Promise<LeaderboardPageData> {
  const [rows, total] = await Promise.all([
    getLeaderboard(adminClient, query),
    countLeaderboardProfiles(adminClient, query),
  ]);

  return {
    rows,
    total,
  };
}

export async function leaderboardRoutes(fastify: FastifyInstance) {
  fastify.get('/api/leaderboard', async (request, reply) => {
    const parsedQuery = LeaderboardQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      request.log.warn({
        event: 'leaderboard.query.validation_failed',
        issues: parsedQuery.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
        })),
      }, '[leaderboard] Query validation failed');

      return reply
        .code(400)
        .header(CACHE_STATUS_HEADER, 'BYPASS')
        .header('Cache-Control', 'no-store')
        .send(errorEnvelope('invalid_leaderboard_query', 'Request query failed schema validation'));
    }

    const query = parsedQuery.data;
    const ttlSeconds = Math.min(60, getCacheConfig().ttlSeconds);
    const cacheKey = buildLeaderboardCacheKey(
      query.period,
      query.scope,
      query.limit,
      query.offset,
      query.sort,
      query.order,
    );

    try {
      const leaderboard = await withCache(
        cacheKey,
        ttlSeconds,
        async () => await loadLeaderboardData(query),
        {
          logger: request.log,
          reply,
          request,
        },
      );

      return reply
        .code(200)
        .header('Cache-Control', 'no-cache')
        .send({
          data: LeaderboardResponseSchema.parse(leaderboard.rows),
          total: leaderboard.total,
        });
    } catch (error) {
      request.log.error({
        err: error,
        event: 'leaderboard.load_failed',
        cache_key: cacheKey,
        period: query.period,
        scope: query.scope,
        limit: query.limit,
        offset: query.offset,
      }, '[leaderboard] Failed to load leaderboard');

      return reply
        .code(503)
        .header(CACHE_STATUS_HEADER, reply.getHeader(CACHE_STATUS_HEADER) ?? 'BYPASS')
        .header('Cache-Control', 'no-store')
        .send(errorEnvelope('leaderboard_unavailable', 'Could not load leaderboard'));
    }
  });
}
