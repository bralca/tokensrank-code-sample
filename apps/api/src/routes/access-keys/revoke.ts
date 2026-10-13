import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  RevokeAccessKeyParamsSchema,
  RevokeAccessKeyResponseSchema,
} from '@tokensrank/shared';

import { adminClient } from '../../clients/supabase';
import { requireAuth, type AuthContext } from '../../middleware/auth';
import { writeAuditEvent } from '../../services/audit';

function errorEnvelope(code: string, message: string) {
  return {
    error: {
      code,
      message,
    },
  };
}

function getAuthContext(request: FastifyRequest): AuthContext {
  const auth = (request as typeof request & { auth?: AuthContext }).auth;

  if (!auth) {
    throw new Error('[access-keys] Missing auth context after requireAuth');
  }

  return auth;
}

function purgeAccessKeyCaches(fastify: FastifyInstance, auth: AuthContext): void {
  fastify.cache.purgeKey(`me:v1:${auth.userId}`);
}

type RevokeAccessKeyRouteParams = {
  key_id: string;
};

type RevokedAccessKeyRow = {
  id: string;
  key_prefix: string;
  scope: 'script' | 'self_reported';
  revoked_at: string;
};

export async function accessKeysRevokeRoute(fastify: FastifyInstance) {
  fastify.delete<{ Params: RevokeAccessKeyRouteParams }>(
    '/api/access-keys/:key_id',
    { preHandler: requireAuth },
    async (
      request: FastifyRequest<{ Params: RevokeAccessKeyRouteParams }>,
      reply: FastifyReply,
    ) => {
      const auth = getAuthContext(request);
      const parsedParams = RevokeAccessKeyParamsSchema.safeParse(request.params);

      if (!parsedParams.success) {
        request.log.warn({
          event: 'access_keys.revoke.validation_failed',
          profile_id: auth.profileId,
        }, '[access-keys] Revoke access key validation failed');

        return reply
          .code(400)
          .send(errorEnvelope('schema_invalid', 'Route parameters failed validation'));
      }

      const revokedAt = new Date().toISOString();

      try {
        const { data, error } = await adminClient
          .from('access_keys')
          .update({ revoked_at: revokedAt })
          .eq('id', parsedParams.data.key_id)
          .eq('profile_id', auth.profileId)
          .is('revoked_at', null)
          .select('id,key_prefix,scope,revoked_at')
          .maybeSingle();

        if (error) {
          request.log.error({
            event: 'access_keys.revoke.update_failed',
            profile_id: auth.profileId,
            key_id: parsedParams.data.key_id,
            error: error.message,
          }, '[access-keys] Failed to revoke access key');

          return reply
            .code(500)
            .send(errorEnvelope('access_key_revoke_failed', 'Could not revoke access key'));
        }

        if (!data) {
          request.log.warn({
            event: 'access_keys.revoke.not_found',
            profile_id: auth.profileId,
            key_id: parsedParams.data.key_id,
          }, '[access-keys] Access key revoke target not found');

          return reply
            .code(404)
            .send(errorEnvelope('key_not_found', 'Access key was not found'));
        }

        const revokedKey = data as RevokedAccessKeyRow;

        await writeAuditEvent({
          event_type: 'access_key.revoked',
          severity: 'warn',
          profile_id: auth.profileId,
          payload: {
            key_id: revokedKey.id,
            key_prefix: revokedKey.key_prefix,
            scope: revokedKey.scope,
            revoked_at: revokedKey.revoked_at,
          },
          requestLog: request.log,
        });

        purgeAccessKeyCaches(fastify, auth);

        return reply
          .header('x-cache-tags', 'me')
          .code(200)
          .send(RevokeAccessKeyResponseSchema.parse({ ok: true }));
      } catch (error) {
        request.log.error({
          err: error,
          event: 'access_keys.revoke.failed',
          profile_id: auth.profileId,
          key_id: parsedParams.data.key_id,
        }, '[access-keys] Failed to revoke access key');

        return reply
          .code(500)
          .send(errorEnvelope('access_key_revoke_failed', 'Could not revoke access key'));
      }
    },
  );
}
