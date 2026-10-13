import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { adminClient } from '../clients/supabase';

const ACCESS_KEY_PATTERN = /^tr_(script|self_reported)_[A-Za-z0-9_-]{32}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export interface AccessKeyContext {
  profileId: string;
  accessKeyId: string;
  keySha256: string;
  scope: 'script' | 'self_reported';
  mode: 'script_verified' | 'self_reported' | null;
  profile: any;
}

type AccessKeyRow = {
  id: string;
  profile_id: string;
  key_sha256: string;
  key_prefix: string;
  scope: 'script' | 'self_reported';
  revoked_at: string | null;
};

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({
    error: {
      code: 'unauthorized',
      message: 'Unauthorized',
    },
  });
}

function keyRevoked(reply: FastifyReply) {
  return reply.code(401).send({
    error: {
      code: 'key_revoked',
      message: 'This access key has been revoked',
    },
  });
}

function wrongKeyScope(reply: FastifyReply, requiredScope: AccessKeyRow['scope']) {
  return reply.code(403).send({
    error: {
      code: 'wrong_key_scope',
      message: `Access key scope must be ${requiredScope}`,
    },
  });
}

function extractBearerToken(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) {
    return '';
  }

  return header.slice(7);
}

function isAccessKeyToken(token: string): boolean {
  return ACCESS_KEY_PATTERN.test(token);
}

function computeKeySha256(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function safeCompareSha256Hex(providedHash: string, storedHash: string): boolean {
  if (!SHA256_HEX_PATTERN.test(providedHash) || !SHA256_HEX_PATTERN.test(storedHash)) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(providedHash, 'hex'),
    Buffer.from(storedHash, 'hex'),
  );
}

function findMatchingAccessKey(rows: AccessKeyRow[], keyHash: string): AccessKeyRow | null {
  let matchingAccessKey: AccessKeyRow | null = null;

  for (const row of rows) {
    if (safeCompareSha256Hex(keyHash, row.key_sha256)) {
      matchingAccessKey = row;
    }
  }

  return matchingAccessKey;
}

function expectedScopeForRequest(req: FastifyRequest): AccessKeyRow['scope'] | null {
  const path = req.url.split('?', 1)[0];

  if (path === '/api/script/sessions') {
    return 'script';
  }

  if (path === '/api/self-reported/sessions') {
    return 'self_reported';
  }

  return null;
}

function attachAccessKeyContext(req: FastifyRequest, context: AccessKeyContext): void {
  req.accessKey = context;
  (req as FastifyRequest & { auth: AccessKeyContext }).auth = context;
}

export async function requireAccessKey(req: FastifyRequest, reply: FastifyReply) {
  const token = extractBearerToken(req.headers.authorization);

  if (!isAccessKeyToken(token)) {
    return unauthorized(reply);
  }

  const keySha256 = computeKeySha256(token);
  const keyPrefix = token.slice(0, 11);

  const { data: accessKeys, error } = await adminClient
    .from('access_keys')
    .select('id, profile_id, key_sha256, key_prefix, scope, revoked_at')
    .eq('key_prefix', keyPrefix);

  if (error || !accessKeys) {
    req.log.warn({
      event: 'bearer_auth.access_key_lookup_failed',
      error: error?.message,
    }, '[ce-auth] Access key lookup failed');

    return unauthorized(reply);
  }

  const accessKey = findMatchingAccessKey(accessKeys as AccessKeyRow[], keySha256);

  if (!accessKey) {
    return unauthorized(reply);
  }

  if (accessKey.revoked_at) {
    return keyRevoked(reply);
  }

  const expectedScope = expectedScopeForRequest(req);

  if (expectedScope && accessKey.scope !== expectedScope) {
    return wrongKeyScope(reply, expectedScope);
  }

  const { data: profile, error: profileError } = await adminClient
    .from('profiles')
    .select('*')
    .eq('id', accessKey.profile_id)
    .single();

  if (profileError || !profile) {
    req.log.warn({
      event: 'bearer_auth.profile_lookup_failed',
      profile_id: accessKey.profile_id,
      error: profileError?.message,
    }, '[ce-auth] Access key profile lookup failed');

    return reply.code(403).send({
      error: {
        code: 'no_profile',
        message: 'Profile was not found',
      },
    });
  }

  void adminClient
    .from('access_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', accessKey.id)
    .then(({ error: updateError }) => {
      if (updateError) {
        req.log.warn({
          event: 'bearer_auth.last_used_update_failed',
          access_key_id: accessKey.id,
          error: updateError.message,
        }, '[ce-auth] Access key last_used_at update failed');
      }
    });

  attachAccessKeyContext(req, {
    profileId: accessKey.profile_id,
    accessKeyId: accessKey.id,
    keySha256,
    scope: accessKey.scope,
    mode: profile.mode,
    profile,
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    accessKey?: AccessKeyContext;
  }

  interface FastifyInstance {
    requireAccessKey: typeof requireAccessKey;
  }
}

const bearerAuthPluginImpl: FastifyPluginAsync = async (fastify) => {
  if (!fastify.hasDecorator('requireAccessKey')) {
    fastify.decorate('requireAccessKey', requireAccessKey);
  }
};

export const bearerAuthPlugin = fp(bearerAuthPluginImpl, {
  name: 'tokensrank-bearer-auth',
});
