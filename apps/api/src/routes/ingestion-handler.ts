import { FastifyReply, FastifyRequest } from 'fastify';
import { INGEST_SESSIONS_MAX } from '@tokensrank/shared';

import { type AccessKeyContext } from '../middleware/auth';
import { IngestionService, type IngestionResult, type IngestionScope } from '../services/ingestion';
import { type IngestionMode } from '../services/mode';
import { scheduleSummaryRebuild } from '../services/summary-rebuild-scheduler';

function errorEnvelope(code: string, message: string, details?: Record<string, unknown>) {
  return {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}

function getAccessKeyContext(request: FastifyRequest): AccessKeyContext {
  return (request as FastifyRequest & { auth: AccessKeyContext }).auth;
}

function getRawSessionCount(body: unknown): number | null {
  if (typeof body !== 'object' || body === null || !('sessions' in body)) {
    return null;
  }

  const sessions = (body as { sessions?: unknown }).sessions;

  return Array.isArray(sessions) ? sessions.length : null;
}

function isBatchTooLarge(body: unknown): boolean {
  const sessionCount = getRawSessionCount(body);

  return sessionCount !== null && sessionCount > INGEST_SESSIONS_MAX;
}

function logCompletion(
  request: FastifyRequest,
  auth: AccessKeyContext,
  mode: IngestionMode,
  result: IngestionResult,
): void {
  request.log.info({
    event: 'ingestion.completed',
    ingestion_run_id: result.ingestion_run_id,
    profile_id: auth.profileId,
    mode,
    status: result.status,
    accepted_count: result.ok ? result.accepted : 0,
    rejected_count: result.ok ? result.rejected : 0,
    deduped_count: result.ok ? result.deduped : 0,
    latency_ms: result.run_duration_ms,
  });
}

function purgeAuthenticatedHydrationCaches(request: FastifyRequest, auth: AccessKeyContext): void {
  const userId = typeof auth.profile?.user_id === 'string' ? auth.profile.user_id : null;

  if (!userId) {
    request.log.warn({
      event: 'ingestion.auth_cache_purge_skipped',
      profile_id: auth.profileId,
    }, 'ingestion accepted but profile user id was unavailable for cache purge');
    return;
  }

  request.server.cache.purgeKey(`me:v1:${userId}`);
  request.server.cache.purgeKey(`onboarding:v1:${userId}`);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getErrorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

export async function handleIngest(
  request: FastifyRequest,
  reply: FastifyReply,
  expectedScope: IngestionScope,
  ingestionMode: IngestionMode,
  ingestionService: IngestionService,
) {
  let ingestionRunId: string | null = null;
  let startedAtMs = Date.now();
  let caughtError: unknown = null;

  try {
    const auth = getAccessKeyContext(request);
    startedAtMs = Date.now();
    ingestionRunId = await ingestionService.openIngestionRun(auth, request.body, ingestionMode, startedAtMs);

    (request as FastifyRequest & {
      ingestionRunId?: string;
      ingestionStartedAtMs?: number;
    }).ingestionRunId = ingestionRunId;
    (request as FastifyRequest & {
      ingestionRunId?: string;
      ingestionStartedAtMs?: number;
    }).ingestionStartedAtMs = startedAtMs;

    if (auth.scope !== expectedScope) {
      await ingestionService.closeIngestionRun({
        ingestionRunId,
        status: 'failed',
        acceptedCount: 0,
        dedupedCount: 0,
        rejectedCount: 1,
        rejectedDetails: [{
          session_id: '__batch__',
          reason_code: 'schema_invalid',
          details: {
            code: 'wrong_key_scope',
            expected_scope: expectedScope,
            actual_scope: auth.scope,
          },
        }],
        startedAtMs,
      });

      return reply
        .code(403)
        .send(errorEnvelope('wrong_key_scope', `Access key scope must be ${expectedScope}`));
    }

    if (isBatchTooLarge(request.body)) {
      const receivedSessions = getRawSessionCount(request.body) ?? 0;

      await ingestionService.closeIngestionRun({
        ingestionRunId,
        status: 'failed',
        acceptedCount: 0,
        dedupedCount: 0,
        rejectedCount: receivedSessions,
        rejectedDetails: [{
          session_id: '__batch__',
          reason_code: 'batch_too_large',
          details: {
            max_sessions: INGEST_SESSIONS_MAX,
            received_sessions: receivedSessions,
          },
        }],
        startedAtMs,
      });

      return reply
        .code(413)
        .send(errorEnvelope('batch_too_large', `Batch size exceeds ${INGEST_SESSIONS_MAX} sessions`));
    }

    const result = await ingestionService.ingestWithScope(
      auth,
      request.body,
      expectedScope,
      ingestionMode,
      request.log,
      { ingestionRunId, startedAtMs },
    );
    logCompletion(request, auth, ingestionMode, result);

    if (!result.ok) {
      if (result.reason_code === 'rate_limited') {
        reply.header('Retry-After', result.retry_after_sec);
      }

      return reply
        .code(result.status_code)
        .send(errorEnvelope(
          result.reason_code,
          result.message,
          result.reason_code === 'batch_too_large' ? undefined : result.details,
        ));
    }

    const responseData = {
      ingestion_run_id: result.ingestion_run_id,
      mode: ingestionMode,
      accepted: result.accepted,
      deduped: result.deduped,
      rejected: result.rejected,
      rejected_details: result.rejected_details,
      run_duration_ms: result.run_duration_ms,
    };

    if (result.accepted > 0) {
      purgeAuthenticatedHydrationCaches(request, auth);
      scheduleSummaryRebuild(request.log);
    }

    return reply.code(202).send({
      ...responseData,
      ingestionRunId: result.ingestion_run_id,
      counts: {
        accepted: result.accepted,
        deduped: result.deduped,
        rejected: result.rejected,
      },
      rejectedDetails: result.rejected_details,
      runDurationMs: result.run_duration_ms,
      signals: result.signals,
      data: responseData,
    });
  } catch (error) {
    caughtError = error;
    request.log.error({
      event: 'ingestion.failed',
      ingestion_run_id: ingestionRunId,
      error: getErrorMessage(error),
      stack: getErrorStack(error),
    }, 'ingestion failed');

    return reply
      .code(500)
      .send(errorEnvelope('ingestion_failed', 'Could not persist ingestion batch'));
  } finally {
    if (ingestionRunId && caughtError) {
      try {
        await ingestionService.failProcessingIngestionRunIfOpen({
          ingestionRunId,
          startedAtMs,
          errorMessage: getErrorMessage(caughtError),
        });
      } catch (finalizeError) {
        request.log.warn({
          event: 'ingestion.finalize_failed',
          ingestion_run_id: ingestionRunId,
          error: getErrorMessage(finalizeError),
        }, 'Failed to finalize failed ingestion run');
      }
    }
  }
}
