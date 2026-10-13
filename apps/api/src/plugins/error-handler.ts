import type { FastifyError, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import crypto from 'node:crypto';

import { adminClient } from '../clients/supabase';
import { redactLogMessage, redactStackTrace } from '../lib/logger-privacy';
import { writeAuditEvent } from '../services/audit';

type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

type ClientSafeError = FastifyError & {
  details?: Record<string, unknown>;
};

function extractBearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) {
    return null;
  }

  const token = header.slice(7).trim();

  return token.length > 0 ? token : null;
}

async function findProfileIdForBearerToken(token: string): Promise<string | null> {
  const keySha256 = crypto.createHash('sha256').update(token).digest('hex');
  const { data, error } = await adminClient
    .from('access_keys')
    .select('profile_id')
    .eq('key_sha256', keySha256)
    .is('revoked_at', null)
    .maybeSingle();

  if (error || !data?.profile_id) {
    return null;
  }

  return String(data.profile_id);
}

function getStatusCode(error: FastifyError): number {
  const statusCode = error.statusCode ?? 500;

  if (statusCode < 400 || statusCode > 599) {
    return 500;
  }

  return statusCode;
}

function getErrorCode(error: FastifyError, statusCode: number): string {
  if (statusCode >= 500) {
    return 'internal_error';
  }

  return error.code?.toLowerCase() ?? 'request_error';
}

function getClientMessage(error: FastifyError, statusCode: number): string {
  if (statusCode >= 500) {
    return 'An error occurred';
  }

  if (error.code === 'rate_limited') {
    return error.message;
  }

  return 'Request failed';
}

export function createErrorEnvelope(error: FastifyError): { statusCode: number; body: ErrorEnvelope } {
  const statusCode = getStatusCode(error);
  const clientSafeError = error as ClientSafeError;
  const details = error.code === 'rate_limited' ? clientSafeError.details : undefined;

  return {
    statusCode,
    body: {
      error: {
        code: getErrorCode(error, statusCode),
        message: getClientMessage(error, statusCode),
        ...(details ? { details } : {}),
      },
    },
  };
}

const errorHandlerPluginDefinition: FastifyPluginAsync = async (fastify) => {
  fastify.setErrorHandler(async (error, request, reply) => {
    const handledError = error as FastifyError;
    const { statusCode, body } = createErrorEnvelope(handledError);

    if (handledError.code === 'rate_limited') {
      const token = extractBearerToken(request.headers.authorization);
      const profileId = token ? await findProfileIdForBearerToken(token) : null;
      const retryAfterSeconds = body.error.details?.retry_after_seconds;

      await writeAuditEvent({
        event_type: 'request.rate_limited',
        severity: 'warn',
        profile_id: profileId,
        payload: {
          reason_code: 'rate_limited',
          path: request.url.split('?', 1)[0] ?? request.url,
          details: body.error.details ?? {},
        },
        requestLog: request.log,
      });

      request.log.warn({
        event: 'request.rate_limited',
        severity: 'warn',
        status_code: statusCode,
        profile_id: profileId,
      }, 'Request rate limited');

      if (typeof retryAfterSeconds === 'number') {
        reply.header('Retry-After', String(retryAfterSeconds));
      }

      return reply.code(statusCode).send(body);
    }

    request.log.error({
      event: 'error.unhandled',
      severity: 'critical',
      error_code: handledError.code ?? 'unknown',
      error_message: redactLogMessage(handledError.message),
      error_stack: redactStackTrace(handledError.stack),
      status_code: statusCode,
    }, 'Unhandled request error');

    return reply.code(statusCode).send(body);
  });
};

export const errorHandlerPlugin = fp(errorHandlerPluginDefinition, {
  name: 'tokensrank-error-handler',
});
