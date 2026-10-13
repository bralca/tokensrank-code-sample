import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ListAccessKeysResponseSchema } from '@tokensrank/shared';

import { adminClient } from '../../clients/supabase';
import { requireAuth, type AuthContext } from '../../middleware/auth';
import { withPostgrestSchemaRetry } from '../../lib/postgrest-schema-retry';

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

function toIsoTimestamp(value: string): string {
  return new Date(value).toISOString();
}

type AccessKeyRow = {
  id: string;
  key_prefix: string;
  scope: 'script' | 'self_reported';
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
};

export const listAccessKeysRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/api/access-keys',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuthContext(request);

      try {
        const { data } = await withPostgrestSchemaRetry(async () => {
          const response = await adminClient
            .from('access_keys')
            .select('id,key_prefix,scope,created_at,revoked_at,last_used_at')
            .eq('profile_id', auth.profileId)
            .order('created_at', { ascending: false })
            .returns<AccessKeyRow[]>();

          if (response.error) {
            throw response.error;
          }

          return response;
        }, {
          context: 'access_keys.list.query',
          event: 'access_keys.list.schema_retry',
          logger: request.log,
        });

        const response = ListAccessKeysResponseSchema.parse((data ?? []).map((key) => ({
          keyId: key.id,
          keyPrefix: key.key_prefix,
          scope: key.scope,
          createdAt: toIsoTimestamp(key.created_at),
          revokedAt: key.revoked_at ? toIsoTimestamp(key.revoked_at) : null,
          lastUsedAt: key.last_used_at ? toIsoTimestamp(key.last_used_at) : null,
        })));

        return reply.code(200).send({ data: response });
      } catch (error) {
        request.log.error({
          err: error,
          event: 'access_keys.list.failed',
          profile_id: auth.profileId,
        }, '[access-keys] Failed to list access keys');

        return reply
          .code(500)
          .send(errorEnvelope('access_key_list_failed', 'Could not list access keys'));
      }
    },
  );
};
