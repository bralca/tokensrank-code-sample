import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { UsageImportFinalizeResponseSchema, UsageImportResponseSchema } from '@tokensrank/shared';

import type { AuthContext } from '../middleware/auth';
import { scheduleSummaryRebuild } from '../services/summary-rebuild-scheduler';
import { UsageImportService } from '../services/usage-import';

const DEFAULT_USAGE_IMPORT_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (rawValue === undefined || rawValue.trim() === '') {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const usageImportBodyLimitBytes = readPositiveIntegerEnv(
  'USAGE_IMPORT_BODY_LIMIT_BYTES',
  DEFAULT_USAGE_IMPORT_BODY_LIMIT_BYTES,
);

function errorEnvelope(code: string, message: string, details?: Record<string, unknown>) {
  return {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}

function isJsonContentType(contentType: string | undefined): boolean {
  return typeof contentType === 'string'
    && contentType.toLowerCase().split(';', 1)[0]?.trim() === 'application/json';
}

async function requireJsonContentType(request: FastifyRequest, reply: FastifyReply) {
  if (isJsonContentType(request.headers['content-type'])) {
    return;
  }

  request.log.warn({
    event: 'usage_import.unsupported_content_type',
    content_type: request.headers['content-type'] ?? null,
  }, 'Rejected usage import with unsupported content type');

  return reply.code(415).send(errorEnvelope(
    'unsupported_media_type',
    'Content-Type must be application/json',
  ));
}

function getAuthContext(request: FastifyRequest): AuthContext {
  const auth = (request as FastifyRequest & { auth?: AuthContext }).auth;

  if (!auth) {
    throw new Error('[usage-import] Missing auth context after requireAuth');
  }

  return auth;
}

function purgeAuthenticatedHydrationCaches(request: FastifyRequest, auth: AuthContext): void {
  request.server.cache.purgeKey(`me:v1:${auth.userId}`);
  request.server.cache.purgeKey(`onboarding:v1:${auth.userId}`);
}

export async function usageImportRoutes(fastify: FastifyInstance) {
  const usageImportService = new UsageImportService();

  fastify.post(
    '/api/me/usage/import/finalize',
    {
      bodyLimit: usageImportBodyLimitBytes,
      preValidation: requireJsonContentType,
      preHandler: fastify.requireAuth,
    },
    async (request, reply) => {
      const auth = getAuthContext(request);

      try {
        const result = await usageImportService.finalizeBrowserUsage(auth, request.body, request.log);

        if (!result.ok) {
          return reply
            .code(result.status_code)
            .send(errorEnvelope(result.reason_code, result.message, result.details));
        }

        if (result.projected) {
          purgeAuthenticatedHydrationCaches(request, auth);
          scheduleSummaryRebuild(request.log);
        }

        const response = UsageImportFinalizeResponseSchema.parse({
          data: {
            projected: result.projected,
          },
        });

        return reply
          .header('x-cache-tags', 'profile,leaderboard,me')
          .code(202)
          .send(response);
      } catch (error) {
        request.log.error({
          err: error,
          event: 'usage_import_finalize.failed',
          profile_id: auth.profileId,
        }, '[usage-import] Failed to finalize usage import');

        return reply
          .code(500)
          .send(errorEnvelope('usage_import_finalize_failed', 'Could not finalize usage import'));
      }
    },
  );

  fastify.post(
    '/api/me/usage/import',
    {
      bodyLimit: usageImportBodyLimitBytes,
      preValidation: requireJsonContentType,
      preHandler: fastify.requireAuth,
    },
    async (request, reply) => {
      const auth = getAuthContext(request);

      try {
        const result = await usageImportService.importBrowserUsage(auth, request.body, request.log);

        if (!result.ok) {
          return reply
            .code(result.status_code)
            .send(errorEnvelope(result.reason_code, result.message, result.details));
        }

        const response = UsageImportResponseSchema.parse({
          data: {
            ingestion_run_id: result.ingestion_run_id,
            accepted_count: result.accepted_count,
            deduped_count: result.deduped_count,
            rejected_count: result.rejected_count,
            rejected_details: result.rejected_details,
            projected: result.projected,
          },
        });

        return reply
          .header('x-cache-tags', 'profile,leaderboard,me')
          .code(202)
          .send(response);
      } catch (error) {
        request.log.error({
          err: error,
          event: 'usage_import.failed',
          profile_id: auth.profileId,
        }, '[usage-import] Failed to import usage events');

        return reply
          .code(500)
          .send(errorEnvelope('usage_import_failed', 'Could not persist usage import'));
      }
    },
  );
}
