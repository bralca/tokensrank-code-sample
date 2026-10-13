import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { PasswordResetRequestSchema } from '@tokensrank/shared';

import { createDisposableAnonClient } from '../../clients/supabase';
import { getRequestOrigin, isAllowedBrowserOrigin } from '../../lib/csrf';
import { redactLogMessage } from '../../lib/logger-privacy';
import { extractClientIp, passwordResetLimiter } from '../../services/rate-limit';
import { logPasswordResetRequested } from '../../services/audit';

const PASSWORD_RESET_MIN_RESPONSE_MS = 100;
const DEFAULT_SITE_URL = 'http://localhost:3000';
const PASSWORD_RESET_CONFIRM_PATH = '/auth/password-reset/confirm';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getRetryAfterSeconds(resetAt: Date): number {
  return Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
}

function buildPasswordResetRedirectUrl(): string {
  const configuredUrl = process.env.SUPABASE_AUTH_REDIRECT_URL || DEFAULT_SITE_URL;

  return new URL(PASSWORD_RESET_CONFIRM_PATH, configuredUrl).toString();
}

function dispatchPasswordResetEmail(email: string, request: FastifyRequest): void {
  const anon = createDisposableAnonClient();

  void anon.auth.resetPasswordForEmail(email, {
    redirectTo: buildPasswordResetRedirectUrl(),
  }).then(({ error }) => {
    if (!error) {
      request.log.info({
        event: 'auth.password_reset.dispatch_started',
      }, 'Password reset dispatch started');
      return;
    }

    request.log.warn({
      event: 'auth.password_reset.dispatch_failed',
      error: redactLogMessage(error.message),
      error_code: error.code,
    }, 'Password reset dispatch failed');
  }).catch((error) => {
    request.log.warn({
      event: 'auth.password_reset.dispatch_failed',
      error: redactLogMessage(error instanceof Error ? error.message : String(error)),
    }, 'Password reset dispatch failed');
  });
}

async function sendGenericPasswordResetResponse(reply: FastifyReply, startedAt: number) {
  const elapsedMs = Date.now() - startedAt;
  const remainingDelayMs = Math.max(0, PASSWORD_RESET_MIN_RESPONSE_MS - elapsedMs);

  if (remainingDelayMs > 0) {
    await sleep(remainingDelayMs);
  }

  return reply.code(200).send({ ok: true });
}

export async function registerPasswordResetRequestRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: unknown }>('/api/auth/password-reset/request', async (request, reply) => {
    const startedAt = Date.now();
    const clientIp = extractClientIp(request);
    const rateLimit = passwordResetLimiter.check(clientIp);

    if (!rateLimit.allowed) {
      await logPasswordResetRequested(request, false, 'rate_limited');

      request.log.warn({
        event: 'auth.password_reset.rate_limited',
        client_ip: clientIp,
        reset_at: rateLimit.resetAt.toISOString(),
      }, 'Password reset request rate limited');

      return reply
        .header('Retry-After', String(getRetryAfterSeconds(rateLimit.resetAt)))
        .code(429)
        .send({
          error: {
            code: 'rate_limited',
            message: 'Too many password reset requests. Please try again later.',
            details: {
              reset_at: rateLimit.resetAt.toISOString(),
            },
          },
        });
    }

    if (!isAllowedBrowserOrigin(request)) {
      await logPasswordResetRequested(request, false, 'validation_failed');

      request.log.warn({
        event: 'auth.password_reset.csrf_rejected',
        origin: getRequestOrigin(request),
      }, 'Password reset request rejected by Origin whitelist');

      return sendGenericPasswordResetResponse(reply, startedAt);
    }

    const parsed = PasswordResetRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      await logPasswordResetRequested(request, false, 'validation_failed');

      request.log.warn({
        event: 'auth.password_reset.validation_failed',
      }, 'Password reset request validation failed');

      return sendGenericPasswordResetResponse(reply, startedAt);
    }

    dispatchPasswordResetEmail(parsed.data.email, request);

    await logPasswordResetRequested(request, true, 'requested');

    request.log.info({
      event: 'auth.password_reset.requested',
    }, 'Password reset requested');

    return sendGenericPasswordResetResponse(reply, startedAt);
  });
}
