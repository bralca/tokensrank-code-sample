import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type AccessKeyContext } from '../middleware/auth';

function getAccessKeyContext(request: FastifyRequest): AccessKeyContext {
  return (request as FastifyRequest & { auth: AccessKeyContext }).auth;
}

export async function installerCompletionRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/api/installer/complete',
    { preHandler: fastify.requireAccessKey },
    async (request, reply) => {
      const auth = getAccessKeyContext(request);

      try {
        // Purge caches to signal frontend polling/SSE to refresh. Actual ingestion
        // runs are created only when the script uploads sessions.
        const userId = auth.profile?.user_id;
        if (userId) {
          fastify.cache.purgeKey(`onboarding:v1:${userId}`);
          fastify.cache.purgeKey(`me:v1:${userId}`);
        }

        request.log.info({
          event: 'installer.completion_acknowledged',
          profile_id: auth.profileId,
        }, '[installer] Installation completion acknowledged');

        return reply.code(200).send({
          success: true,
          message: 'Installation completion acknowledged',
        });
      } catch (error) {
        request.log.error({
          err: error,
          event: 'installer.completion_failed',
          profile_id: auth.profileId,
        }, '[installer] Failed to acknowledge completion');

        return reply.code(500).send({
          error: {
            code: 'completion_failed',
            message: 'Could not acknowledge installation completion',
          },
        });
      }
    },
  );
}
