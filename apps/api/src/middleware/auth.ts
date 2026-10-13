import { FastifyReply, FastifyRequest } from 'fastify';

import { adminClient, createDisposableAnonClient } from '../clients/supabase';
import { withPostgrestSchemaRetry } from '../lib/postgrest-schema-retry';
import { safeCompareTokens } from '../services/crypto';
export { requireAccessKey, type AccessKeyContext } from './require-access-key';

export interface AuthContext {
  userId: string;
  email: string | null;
  profileId: string;
  profile: any;
}

const ADMIN_AUTH_FAILURE_DELAY_MS = 50;
const PROFILE_RETRY_DELAYS_MS = [100, 200, 400] as const;

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({
    error: {
      code: 'unauthorized',
      message: 'Unauthorized',
    },
  });
}

function authError(reply: FastifyReply, statusCode: number, code: string, message: string) {
  return reply.code(statusCode).send({
    error: {
      code,
      message,
    },
  });
}

function extractBearerToken(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) {
    return '';
  }

  return header.slice(7);
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

function extractSessionToken(req: FastifyRequest): string {
  return extractBearerToken(req.headers.authorization)
    || extractCookieValue(req.headers.cookie, 'tr_at');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Extract user ID from bearer token (Supabase session token)
async function getUserIdFromBearer(token: string): Promise<string | null> {
  try {
    const anon = createDisposableAnonClient();
    const { data, error } = await anon.auth.getUser(token);
    if (error || !data.user) return null;
    return data.user.id;
  } catch {
    return null;
  }
}

// Extract user ID from bearer token (Supabase session token) with the token
async function verifySessionToken(token: string): Promise<{ user_id: string; email: string | null; expires_at?: number } | null> {
  try {
    const anon = createDisposableAnonClient();
    const { data, error } = await anon.auth.getUser(token);
    if (error || !data.user) return null;
    return { user_id: data.user.id, email: data.user.email ?? null };
  } catch {
    return null;
  }
}

async function loadAuthProfile(req: FastifyRequest, userId: string): Promise<any | null> {
  for (let attempt = 0; attempt <= PROFILE_RETRY_DELAYS_MS.length; attempt += 1) {
    const { data, error } = await withPostgrestSchemaRetry(async () => {
      const response = await adminClient
        .from('profiles')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

      if (response.error) {
        throw response.error;
      }

      return response;
    }, {
      context: 'auth.profile_lookup',
      event: 'auth.profile_lookup.schema_retry',
      logger: req.log,
    });

    if (data) {
      return data;
    }

    const delay = PROFILE_RETRY_DELAYS_MS[attempt];

    if (delay === undefined) {
      req.log.warn({
        event: 'auth.profile_lookup_missing',
        user_id: userId,
      }, '[ce-auth] Profile was not found for authenticated user');
      return null;
    }

    await wait(delay);
  }

  return null;
}

// Require authenticated user (session token)
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const token = extractSessionToken(req);

  if (!token) {
    return authError(reply, 401, 'unauthorized', 'Unauthorized');
  }

  const session = await verifySessionToken(token);
  if (!session) {
    return authError(reply, 401, 'unauthorized', 'Unauthorized');
  }

  const profile = await loadAuthProfile(req, session.user_id);

  if (!profile) {
    return authError(reply, 403, 'no_profile', 'Profile was not found');
  }

  // Attach auth context to request
  (req as any).auth = {
    userId: session.user_id,
    email: session.email,
    profileId: profile.id,
    profile,
  } as AuthContext;
}

// Require admin token
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  const token = extractBearerToken(req.headers.authorization);
  const adminToken = process.env.ADMIN_PURGE_TOKEN ?? '';
  const isValid = adminToken.length > 0 && safeCompareTokens(token, adminToken);

  if (!isValid) {
    await wait(ADMIN_AUTH_FAILURE_DELAY_MS);
    return unauthorized(reply);
  }
}

export { getUserIdFromBearer, verifySessionToken };
