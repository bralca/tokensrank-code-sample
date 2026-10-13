import { createClient, type User } from '@supabase/supabase-js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { AuthSignUpSchema, isReservedHandle } from '@tokensrank/shared';

import { adminClient, createDisposableAnonClient } from '../../clients/supabase';
import { getRequestOrigin, isAllowedBrowserOrigin } from '../../lib/csrf';
import { redactLogMessage } from '../../lib/logger-privacy';
import { setCookies } from '../../plugins/cookies';
import { isPasswordBreached } from '../../services/password-breach';

type AuthSignUpBody = unknown;

type ErrorDetails = Record<string, unknown>;

type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    details?: ErrorDetails;
  };
};

const PROFILE_RETRY_DELAYS_MS = [100, 200, 400] as const;
const POSTGREST_SCHEMA_RETRY_DELAYS_MS = [150, 300, 600] as const;
type AuthSession = {
  access_token: string;
  refresh_token: string;
};

type SignUpAuthResult = {
  session: AuthSession;
  user: User;
};

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

function zodErrorToResponse(error: ZodError): {
  code: string;
  message: string;
  details: ErrorDetails;
} {
  const firstIssue = error.issues[0];
  const field = typeof firstIssue?.path[0] === 'string' ? firstIssue.path[0] : undefined;

  if (field === 'handle') {
    const isReserved = firstIssue?.message.toLowerCase().includes('reserved');

    return {
      code: 'invalid_handle',
      message: isReserved
        ? 'That handle\'s reserved'
        : 'Handle must be lowercase, 3-30 chars, letters/numbers/dash/underscore only',
      details: {
        field: 'handle',
        ...(isReserved ? { reason: 'reserved' } : { constraint: 'format' }),
      },
    };
  }

  return {
    code: 'schema_invalid',
    message: 'Request body failed validation',
    details: {
      issues: error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
        code: issue.code,
      })),
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function isEmailSendRateLimitError(error: { code?: string; message: string }): boolean {
  const normalizedMessage = error.message.toLowerCase();

  return error.code === 'over_email_send_rate_limit'
    || normalizedMessage.includes('email rate limit')
    || normalizedMessage.includes('security purposes');
}

function shouldUseAuthAdminFallback(): boolean {
  return process.env.NODE_ENV !== 'production';
}

function createTestAuthAdminClient() {
  return createClient(
    readRequiredEnv('SUPABASE_URL'),
    readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}

async function createConfirmedTestUserAndSession(input: {
  email: string;
  password: string;
}): Promise<SignUpAuthResult> {
  const authAdmin = createTestAuthAdminClient();
  const anon = createDisposableAnonClient();
  const { data: createdUser, error: createError } = await authAdmin.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    user_metadata: {
      test_schema: process.env.SUPABASE_SCHEMA,
    },
  });

  if (createError || !createdUser.user) {
    throw new Error(createError?.message ?? 'Supabase Auth Admin did not return a user');
  }

  const { data: sessionData, error: signInError } = await anon.auth.signInWithPassword({
    email: input.email,
    password: input.password,
  });

  if (signInError || !sessionData.user || !sessionData.session) {
    throw new Error(signInError?.message ?? 'Supabase Auth did not return a session');
  }

  return {
    session: sessionData.session,
    user: sessionData.user,
  };
}

async function confirmTestUserAndCreateSession(input: {
  email: string;
  password: string;
  userId: string;
}): Promise<SignUpAuthResult> {
  const authAdmin = createTestAuthAdminClient();
  const anon = createDisposableAnonClient();
  const { error: confirmError } = await authAdmin.auth.admin.updateUserById(input.userId, {
    email_confirm: true,
  });

  if (confirmError) {
    throw new Error(confirmError.message);
  }

  const { data: sessionData, error: signInError } = await anon.auth.signInWithPassword({
    email: input.email,
    password: input.password,
  });

  if (signInError || !sessionData.user || !sessionData.session) {
    throw new Error(signInError?.message ?? 'Supabase Auth did not return a session');
  }

  return {
    session: sessionData.session,
    user: sessionData.user,
  };
}

async function createAuthUserAndSession(input: {
  email: string;
  password: string;
  request: FastifyRequest;
}): Promise<SignUpAuthResult | { error: { code?: string; message: string } }> {
  const anon = createDisposableAnonClient();
  const { data: authData, error: authError } = await anon.auth.signUp({
    email: input.email,
    password: input.password,
    options: {
      data: {
        test_schema: process.env.SUPABASE_SCHEMA,
      },
    },
  });

  if (authError) {
    if (shouldUseAuthAdminFallback() && isEmailSendRateLimitError(authError)) {
      input.request.log.warn({
        event: 'auth.sign_up.dev_admin_fallback',
        error_code: authError.code,
      }, 'Using non-production Supabase Auth Admin fallback after email rate limit');

      try {
        return await createConfirmedTestUserAndSession({
          email: input.email,
          password: input.password,
        });
      } catch (error) {
        return {
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }

    return {
      error: {
        code: authError.code,
        message: authError.message,
      },
    };
  }

  if (authData.user && !authData.session) {
    input.request.log.warn({
      event: 'auth.sign_up.email_confirmation_required',
      user_id: authData.user.id,
    }, 'User created but email confirmation required; auto-confirming in dev mode');

    try {
      return await confirmTestUserAndCreateSession({
        email: input.email,
        password: input.password,
        userId: authData.user.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isSyntheticDuplicateUser = message.toLowerCase().includes('user not found');

      return {
        error: {
          ...(isSyntheticDuplicateUser ? { code: 'email_taken' } : {}),
          message: isSyntheticDuplicateUser ? 'User already exists' : message,
        },
      };
    }
  }

  if (!authData.user || !authData.session) {
    return {
      error: {
        message: 'Supabase Auth did not return a session',
      },
    };
  }

  return {
    session: authData.session,
    user: authData.user,
  };
}

async function waitForProfile(userId: string) {
  for (const delay of PROFILE_RETRY_DELAYS_MS) {
    const { data, error } = await adminClient
      .from('profiles')
      .select('id,user_id,handle')
      .eq('user_id', userId)
      .maybeSingle();

    if (!error && data) {
      return data;
    }

    await sleep(delay);
  }

  const { data, error } = await adminClient
    .from('profiles')
    .select('id,user_id,handle')
    .eq('user_id', userId)
    .maybeSingle();

  if (!error && data) {
    return data;
  }

  return null;
}

async function isHandleTaken(handle: string): Promise<boolean> {
  const { data, error } = await adminClient
    .from('profiles')
    .select('id')
    .ilike('handle', handle)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return Boolean(data);
}

function writeSignUpAuditEvent(input: {
  email: string;
  handle: string;
  ipAddress: string;
  profileId: string;
  request: FastifyRequest;
}): void {
  const atIndex = input.email.lastIndexOf('@');
  const emailDomain = atIndex === -1 ? null : input.email.slice(atIndex + 1).toLowerCase();

  input.request.log.debug({
    event: 'user.signed_up',
    profile_id: input.profileId,
    handle: input.handle,
    email_domain: emailDomain,
    ip_address: input.ipAddress,
  }, 'User signed up');
}

function isEmailTakenError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();

  return normalized.includes('already registered')
    || normalized.includes('already been registered')
    || normalized.includes('user already exists')
    || normalized.includes('already exists');
}

function isTransientPostgrestSchemaCacheError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();

  return normalized.includes('schema cache')
    || normalized.includes('could not find the table')
    || normalized.includes('pgrst205')
    || normalized.includes('pgrst106');
}

async function withPostgrestSchemaRetry<T>(
  operation: () => Promise<T>,
  request: FastifyRequest,
  context: string,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= POSTGREST_SCHEMA_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (!isTransientPostgrestSchemaCacheError(message) || attempt === POSTGREST_SCHEMA_RETRY_DELAYS_MS.length) {
        throw error;
      }

      lastError = error;
      request.log.warn({
        event: 'auth.sign_up.postgrest_schema_retry',
        context,
        attempt: attempt + 1,
        error: redactLogMessage(message),
      }, 'Retrying after transient PostgREST schema cache miss');

      const delay = POSTGREST_SCHEMA_RETRY_DELAYS_MS[attempt];

      if (delay === undefined) {
        throw error;
      }

      await sleep(delay);
    }
  }

  throw lastError;
}

export async function signUpHandler(
  request: FastifyRequest<{ Body: AuthSignUpBody }>,
  reply: FastifyReply,
) {
  try {
    if (!isAllowedBrowserOrigin(request)) {
      request.log.warn({
        event: 'auth.sign_up.csrf_rejected',
        origin: getRequestOrigin(request),
      }, 'Sign-up rejected by Origin whitelist');

      return sendError(reply, 403, 'csrf_violation', 'Origin not allowed');
    }

    const parsed = AuthSignUpSchema.parse(request.body);
    const email = parsed.email;
    const handle = parsed.handle.toLowerCase();

    if (isReservedHandle(handle)) {
      return sendError(reply, 400, 'invalid_handle', 'That handle\'s reserved', {
        field: 'handle',
        reason: 'reserved',
      });
    }

    if (await withPostgrestSchemaRetry(
      () => isHandleTaken(handle),
      request,
      'handle_availability',
    )) {
      request.log.warn({ event: 'auth.sign_up.handle_taken', handle }, 'Handle already taken');
      return sendError(reply, 409, 'handle_taken', 'That handle is taken', {
        field: 'handle',
      });
    }

    try {
      if (await isPasswordBreached(parsed.password)) {
        request.log.warn({ event: 'auth.sign_up.password_breached' }, 'Breached password rejected');
        return sendError(
          reply,
          400,
          'password_breached',
          'This password has been breached in a known data breach. Please choose another.',
          { field: 'password' },
        );
      }
    } catch (error) {
      request.log.warn({
        event: 'auth.sign_up.hibp_check_failed',
        error: redactLogMessage(error instanceof Error ? error.message : String(error)),
      }, 'HIBP password check failed open');
    }

    const authResult = await createAuthUserAndSession({
      email,
      password: parsed.password,
      request,
    });

    if ('error' in authResult) {
      const message = authResult.error.message || 'Sign-up failed';

      if (authResult.error.code === 'email_taken' || isEmailTakenError(message)) {
        request.log.warn({ event: 'auth.sign_up.email_taken' }, 'Email already taken');
        return sendError(reply, 409, 'email_taken', 'An account with this email already exists', {
          field: 'email',
        });
      }

      request.log.warn({
        event: 'auth.sign_up.supabase_failed',
        error_code: authResult.error.code,
        error: redactLogMessage(message),
      }, 'Supabase sign-up failed');
      return sendError(reply, 500, 'sign_up_failed', 'Could not create account');
    }

    const profile = await waitForProfile(authResult.user.id);

    if (!profile) {
      request.log.error({
        event: 'auth.sign_up.profile_creation_timeout',
        user_id: authResult.user.id,
      }, 'Profile shell was not created by trigger');
      return sendError(reply, 502, 'profile_creation_timeout', 'Profile creation is delayed. Please retry.');
    }

    const { data: updatedProfile, error: updateError } = await adminClient
      .from('profiles')
      .update({ handle })
      .eq('user_id', authResult.user.id)
      .select('id,user_id,handle')
      .single();

    if (updateError || !updatedProfile) {
      const message = updateError?.message ?? 'missing updated profile';

      if (message.toLowerCase().includes('duplicate')) {
        request.log.warn({ event: 'auth.sign_up.handle_taken_race', handle }, 'Handle taken during sign-up');
        return sendError(reply, 409, 'handle_taken', 'That handle is taken', {
          field: 'handle',
        });
      }

      request.log.error({
        event: 'auth.sign_up.profile_update_failed',
        user_id: authResult.user.id,
        error: redactLogMessage(message),
      }, 'Could not update profile handle');
      return sendError(reply, 500, 'profile_update_failed', 'Could not update profile');
    }

    writeSignUpAuditEvent({
      email,
      handle,
      ipAddress: request.ip,
      profileId: updatedProfile.id,
      request,
    });

    setCookies(reply, {
      accessToken: authResult.session.access_token,
      refreshToken: authResult.session.refresh_token,
    });
    reply.header('Location', '/onboarding');

    request.log.info({
      event: 'auth.sign_up.completed',
      user_id: authResult.user.id,
      profile_id: updatedProfile.id,
    }, 'Sign-up completed');

    return reply.code(302).send({
      data: {
        userId: authResult.user.id,
        email: authResult.user.email,
        handle,
        profileId: updatedProfile.id,
      },
    });
  } catch (error) {
    if (error instanceof ZodError) {
      const validation = zodErrorToResponse(error);
      request.log.warn({ event: 'auth.sign_up.validation_failed' }, 'Sign-up validation failed');

      return sendError(reply, 400, validation.code, validation.message, validation.details);
    }

    request.log.error({
      event: 'auth.sign_up.unhandled',
      error: redactLogMessage(error instanceof Error ? error.message : String(error)),
    }, 'Sign-up failed unexpectedly');

    return sendError(reply, 500, 'internal_error', 'An error occurred');
  }
}

export async function registerSignUpRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/auth/sign-up', signUpHandler);
}
