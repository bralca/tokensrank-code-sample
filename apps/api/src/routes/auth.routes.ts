import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import {
  AuthSignInSchema,
  PasswordResetConfirmSchema,
} from '@tokensrank/shared';

import { adminClient, createDisposableAnonClient } from '../clients/supabase';
import { getRequestOrigin, isAllowedBrowserOrigin } from '../lib/csrf';
import { redactLogMessage } from '../lib/logger-privacy';
import { clearCookies, REFRESH_TOKEN_COOKIE_NAME, setCookies } from '../plugins/cookies';
import { writeAuditEvent } from '../services/audit';
import { isPasswordBreached } from '../services/password-breach';
import { registerSignUpRoute } from './auth/sign-up';
import { registerGithubOAuthRoutes } from './auth/github';
import { registerPasswordResetRequestRoute } from './auth/password-reset-request';

const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

type ErrorDetails = Record<string, unknown>;

type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    details?: ErrorDetails;
  };
};

function getLogErrorMessage(error: unknown): string {
  return redactLogMessage(error instanceof Error ? error.message : String(error)) ?? 'unknown error';
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: ErrorDetails,
) {
  const body: ErrorEnvelope = {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };

  return reply.code(statusCode).send(body);
}

function zodErrorDetails(error: ZodError): ErrorDetails {
  return {
    issues: error.issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
      code: issue.code,
    })),
  };
}

function extractCookieValue(cookieHeader: string | undefined, name: string): string {
  if (!cookieHeader) {
    return '';
  }

  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');

    if (rawKey === name) {
      return decodeURIComponent(rawValue.join('='));
    }
  }

  return '';
}

function getRequestCookie(req: FastifyRequest, name: string): string {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies;

  return cookies?.[name] ?? extractCookieValue(req.headers.cookie, name);
}

async function writeSignInAuditEvent(input: {
  email: string;
  eventType: 'auth.signin_success' | 'auth.signin_failed';
  ipAddress: string;
  profileId?: string | null;
  request: FastifyRequest;
  userId?: string | null;
}): Promise<void> {
  await writeAuditEvent({
    event_type: input.eventType,
    severity: input.eventType === 'auth.signin_success' ? 'info' : 'warn',
    profile_id: input.profileId ?? null,
    payload: {
      email: input.email,
      ip_address: input.ipAddress,
      user_id: input.userId ?? null,
    },
    requestLog: input.request.log,
  });
}

async function getProfileIdForUser(userId: string): Promise<string | null> {
  const { data, error } = await adminClient
    .from('profiles')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return data.id;
}

async function writePasswordResetConfirmAuditEvent(input: {
  eventType: 'auth.password_reset_confirmed' | 'auth.password_reset_confirm_failed';
  profileId?: string | null;
  reason: string;
  request: FastifyRequest;
  userId?: string | null;
}): Promise<void> {
  await writeAuditEvent({
    event_type: input.eventType,
    severity: input.eventType === 'auth.password_reset_confirmed' ? 'info' : 'warn',
    profile_id: input.profileId ?? null,
    payload: {
      reason: input.reason,
      reason_code: input.reason,
      user_id: input.userId ?? null,
    },
    requestLog: input.request.log,
  });
}

export async function authRoutes(fastify: FastifyInstance) {
  await registerSignUpRoute(fastify);
  await registerGithubOAuthRoutes(fastify);
  await registerPasswordResetRequestRoute(fastify);

  // POST /api/auth/sign-in
  fastify.post<{ Body: unknown }>('/api/auth/sign-in', async (req, reply) => {
    try {
      if (!isAllowedBrowserOrigin(req)) {
        req.log.warn({
          event: 'auth.signin.csrf_rejected',
          origin: getRequestOrigin(req),
        }, 'Sign-in rejected by Origin whitelist');

        return sendError(reply, 403, 'csrf_violation', 'Origin not allowed');
      }

      const body = AuthSignInSchema.parse(req.body);
      const { email, password } = body;

      const anon = createDisposableAnonClient();
      const { data: authData, error: authError } = await anon.auth.signInWithPassword({
        email,
        password,
      });

      if (authError || !authData.user || !authData.session) {
        await writeSignInAuditEvent({
          email,
          eventType: 'auth.signin_failed',
          ipAddress: req.ip,
          request: req,
        });

        req.log.warn({
          event: 'auth.signin_failed',
          error_code: authError?.code,
        }, 'Invalid sign-in credentials');

        return sendError(reply, 401, 'invalid_credentials', INVALID_CREDENTIALS_MESSAGE);
      }

      const { data: profile, error: profileError } = await adminClient
        .from('profiles')
        .select('*')
        .eq('user_id', authData.user.id)
        .single();

      if (profileError || !profile) {
        await writeSignInAuditEvent({
          email,
          eventType: 'auth.signin_failed',
          ipAddress: req.ip,
          request: req,
          userId: authData.user.id,
        });

        req.log.warn({
          event: 'auth.signin.no_profile',
          user_id: authData.user.id,
          error: redactLogMessage(profileError?.message ?? 'missing profile'),
        }, 'Sign-in profile not found');

        return sendError(reply, 403, 'profile_missing', 'Profile not found');
      }

      await writeSignInAuditEvent({
        email,
        eventType: 'auth.signin_success',
        ipAddress: req.ip,
        profileId: profile.id,
        request: req,
        userId: authData.user.id,
      });

      setCookies(reply, {
        accessToken: authData.session.access_token,
        refreshToken: authData.session.refresh_token,
      });

      req.log.info({
        event: 'auth.signin_success',
        user_id: authData.user.id,
        profile_id: profile.id,
      }, 'Sign-in completed');

      return reply.code(200).send({
        data: {
          session: authData.session,
          user: authData.user,
          profile,
          user_id: authData.user.id,
          handle: profile.handle,
          profile_id: profile.id,
        },
      });
    } catch (error) {
      if (error instanceof ZodError) {
        req.log.warn({ event: 'auth.signin.validation_failed' }, 'Sign-in validation failed');

        return sendError(reply, 400, 'schema_invalid', 'Request body failed validation', zodErrorDetails(error));
      }

      req.log.error({
        event: 'auth.signin.unhandled',
        error_message: getLogErrorMessage(error),
      }, 'Sign-in failed unexpectedly');

      return sendError(reply, 500, 'internal_error', 'An error occurred');
    }
  });

  // POST /api/auth/refresh
  fastify.post('/api/auth/refresh', async (req, reply) => {
    try {
      if (!isAllowedBrowserOrigin(req)) {
        req.log.warn({
          event: 'auth.refresh.csrf_rejected',
          origin: getRequestOrigin(req),
        }, 'Session refresh rejected by Origin whitelist');

        return sendError(reply, 403, 'csrf_violation', 'Origin not allowed');
      }

      const refreshToken = getRequestCookie(req, REFRESH_TOKEN_COOKIE_NAME);

      if (!refreshToken) {
        req.log.warn({ event: 'auth.refresh.missing_cookie' }, 'Refresh token cookie missing');

        return sendError(reply, 401, 'missing_refresh_token', 'Refresh token cookie is required');
      }

      const anon = createDisposableAnonClient();
      const { data, error } = await anon.auth.refreshSession({
        refresh_token: refreshToken,
      });

      if (error || !data.session || !data.user) {
        req.log.warn({
          event: 'auth.refresh.failed',
          error_code: error?.code,
          error: redactLogMessage(error?.message ?? 'missing refreshed session'),
        }, 'Session refresh failed');

        clearCookies(reply);

        return sendError(reply, 401, 'invalid_refresh_token', 'Refresh token is invalid or expired');
      }

      setCookies(reply, {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
      });

      req.log.info({
        event: 'auth.refresh.completed',
        user_id: data.user.id,
      }, 'Session refreshed');

      return reply.code(200).send({
        data: {
          session: data.session,
          user_id: data.user.id,
        },
      });
    } catch (error) {
      req.log.error({
        event: 'auth.refresh.unhandled',
        error_message: getLogErrorMessage(error),
      }, 'Session refresh failed unexpectedly');

      return sendError(reply, 500, 'internal_error', 'An error occurred');
    }
  });

  // POST /api/auth/password-reset/confirm
  fastify.post<{ Body: unknown }>('/api/auth/password-reset/confirm', async (req, reply) => {
    try {
      if (!isAllowedBrowserOrigin(req)) {
        req.log.warn({
          event: 'auth.password_reset_confirm.csrf_rejected',
          origin: getRequestOrigin(req),
        }, 'Password reset confirmation rejected by Origin whitelist');

        return sendError(reply, 403, 'csrf_violation', 'Origin not allowed');
      }

      const body = PasswordResetConfirmSchema.parse(req.body);
      const { token, new_password: newPassword } = body;

      try {
        if (await isPasswordBreached(newPassword)) {
          req.log.warn({
            event: 'auth.password_reset_confirm.password_breached',
          }, 'Breached password rejected during password reset confirmation');

          await writePasswordResetConfirmAuditEvent({
            eventType: 'auth.password_reset_confirm_failed',
            reason: 'password_breached',
            request: req,
          });

          return sendError(
            reply,
            400,
            'password_breached',
            'This password has been breached in a known data breach. Please choose another.',
            { field: 'new_password' },
          );
        }
      } catch (error) {
        req.log.warn({
          event: 'auth.password_reset_confirm.hibp_check_failed',
          error: redactLogMessage(error instanceof Error ? error.message : String(error)),
        }, 'HIBP password check failed open');
      }

      const anon = createDisposableAnonClient();

      const { data: verifiedData, error: verifyError } = await anon.auth.verifyOtp({
        token_hash: token,
        type: 'recovery',
      });

      if (verifyError || !verifiedData.user || !verifiedData.session) {
        await writePasswordResetConfirmAuditEvent({
          eventType: 'auth.password_reset_confirm_failed',
          reason: 'invalid_token',
          request: req,
        });

        req.log.warn({
          event: 'auth.password_reset_confirm.invalid_token',
          error_code: verifyError?.code,
        }, 'Password reset token verification failed');

        return sendError(reply, 401, 'invalid_token', 'Password reset token is invalid or expired');
      }

      const { data: updatedData, error: updateError } = await anon.auth.updateUser({
        password: newPassword,
      });

      if (updateError || !updatedData.user) {
        const profileId = await getProfileIdForUser(verifiedData.user.id);

        await writePasswordResetConfirmAuditEvent({
          eventType: 'auth.password_reset_confirm_failed',
          profileId,
          reason: 'password_update_failed',
          request: req,
          userId: verifiedData.user.id,
        });

        req.log.error({
          event: 'auth.password_reset_confirm.update_failed',
          user_id: verifiedData.user.id,
          error_code: updateError?.code,
          error: redactLogMessage(updateError?.message ?? 'missing updated user'),
        }, 'Password update failed during reset confirmation');

        return sendError(reply, 500, 'password_reset_failed', 'Could not update password');
      }

      const { error: revokeError } = await adminClient.auth.admin.signOut(
        verifiedData.session.access_token,
        'global',
      );

      if (revokeError) {
        const profileId = await getProfileIdForUser(updatedData.user.id);

        await writePasswordResetConfirmAuditEvent({
          eventType: 'auth.password_reset_confirm_failed',
          profileId,
          reason: 'refresh_token_revocation_failed',
          request: req,
          userId: updatedData.user.id,
        });

        req.log.error({
          event: 'auth.password_reset_confirm.revoke_failed',
          user_id: updatedData.user.id,
          error_code: revokeError.code,
          error: redactLogMessage(revokeError.message),
        }, 'Refresh token revocation failed during password reset confirmation');

        return sendError(reply, 500, 'password_reset_failed', 'Could not revoke existing sessions');
      }

      const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({
        email: updatedData.user.email ?? verifiedData.user.email ?? '',
        password: newPassword,
      });

      if (signInError || !signInData.user || !signInData.session) {
        const profileId = await getProfileIdForUser(updatedData.user.id);

        await writePasswordResetConfirmAuditEvent({
          eventType: 'auth.password_reset_confirm_failed',
          profileId,
          reason: 'session_issue_failed',
          request: req,
          userId: updatedData.user.id,
        });

        req.log.error({
          event: 'auth.password_reset_confirm.signin_failed',
          user_id: updatedData.user.id,
          error_code: signInError?.code,
          error: redactLogMessage(signInError?.message ?? 'missing replacement session'),
        }, 'Fresh session issuance failed after password reset confirmation');

        return sendError(reply, 500, 'password_reset_failed', 'Could not issue a fresh session');
      }

      const profileId = await getProfileIdForUser(signInData.user.id);

      await writePasswordResetConfirmAuditEvent({
        eventType: 'auth.password_reset_confirmed',
        profileId,
        reason: 'confirmed',
        request: req,
        userId: signInData.user.id,
      });

      setCookies(reply, {
        accessToken: signInData.session.access_token,
        refreshToken: signInData.session.refresh_token,
      });

      req.log.info({
        event: 'auth.password_reset_confirm.confirmed',
        user_id: signInData.user.id,
        profile_id: profileId,
      }, 'Password reset confirmed');

      return reply.code(200).send({
        data: {
          message: 'Password updated. Please sign in.',
        },
      });
    } catch (error) {
      if (error instanceof ZodError) {
        req.log.warn({
          event: 'auth.password_reset_confirm.validation_failed',
        }, 'Password reset confirm validation failed');

        return sendError(reply, 400, 'schema_invalid', 'Request body failed validation', zodErrorDetails(error));
      }

      req.log.error({
        event: 'auth.password_reset_confirm.unhandled',
        error_message: getLogErrorMessage(error),
      }, 'Password reset confirm failed unexpectedly');

      return sendError(reply, 500, 'internal_error', 'An error occurred');
    }
  });
}
