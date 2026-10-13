import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  GenerateAccessKeyResponseSchema,
  GenerateAccessKeySchema,
} from '@tokensrank/shared';

import { adminClient } from '../clients/supabase';
import { requireAuth, type AuthContext } from '../middleware/auth';
import { withPostgrestSchemaRetry } from '../lib/postgrest-schema-retry';
import { generateAccessKey } from '../services/access-keys';
import { writeAuditEvent } from '../services/audit';
import { listAccessKeysRoute } from './access-keys/list';

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

async function purgeAccessKeyCaches(fastify: FastifyInstance, auth: AuthContext): Promise<void> {
  fastify.cache.purgeKey(`me:v1:${auth.userId}`);
}

export async function accessKeysRoutes(fastify: FastifyInstance) {
  await fastify.register(listAccessKeysRoute);

  fastify.post<{ Body: unknown }>(
    '/api/access-keys/generate',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const auth = getAuthContext(request);
      const parsed = GenerateAccessKeySchema.safeParse(request.body);

      if (!parsed.success) {
        request.log.warn({
          event: 'access_keys.generate.validation_failed',
          profile_id: auth.profileId,
        }, '[access-keys] Generate access key validation failed');

        return reply
          .code(400)
          .send(errorEnvelope('invalid_scope', 'Scope must be script or self_reported'));
      }

      const generated = generateAccessKey(parsed.data.scope);

      try {
        const { data } = await withPostgrestSchemaRetry(async () => {
          const response = await adminClient
            .from('access_keys')
            .insert({
              profile_id: auth.profileId,
              key_sha256: generated.key_sha256,
              key_prefix: generated.key_prefix,
              scope: generated.scope,
              revoked_at: null,
            })
            .select('id,scope,key_prefix,created_at')
            .single();

          if (response.error || !response.data) {
            throw response.error ?? new Error('missing insert response');
          }

          return response;
        }, {
          context: 'access_keys.generate.insert',
          event: 'access_keys.generate.schema_retry',
          logger: request.log,
        });

        if (!data) {
          request.log.error({
            event: 'access_keys.generate.insert_failed',
            profile_id: auth.profileId,
            scope: generated.scope,
            error: 'missing insert response',
          }, '[access-keys] Failed to insert access key');

          return reply
            .code(500)
            .send(errorEnvelope('access_key_create_failed', 'Could not create access key'));
        }

        await writeAuditEvent({
          event_type: 'access_key.created',
          severity: 'info',
          profile_id: auth.profileId,
          payload: {
            key_id: data.id,
            key_prefix: data.key_prefix,
            scope: data.scope,
          },
          requestLog: request.log,
        });

        await purgeAccessKeyCaches(fastify, auth);

        const response = GenerateAccessKeyResponseSchema.parse({
          id: data.id,
          scope: data.scope,
          prefix: data.key_prefix,
          plaintext: generated.plaintext,
          created_at: toIsoTimestamp(data.created_at),
        });

        return reply
          .header('x-cache-tags', 'me')
          .code(200)
          .send({ data: response });
      } catch (error) {
        request.log.error({
          err: error,
          event: 'access_keys.generate.failed',
          profile_id: auth.profileId,
          scope: generated.scope,
        }, '[access-keys] Failed to generate access key');

        return reply
          .code(500)
          .send(errorEnvelope('access_key_create_failed', 'Could not create access key'));
      }
    },
  );
}
