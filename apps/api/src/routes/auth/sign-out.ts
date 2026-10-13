import type { FastifyPluginAsync } from 'fastify';

import { requireAuth, type AuthContext } from '../../middleware/auth';
import { clearCookies } from '../../plugins/cookies';
import { writeAuditEvent } from '../../services/audit';

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: typeof requireAuth;
  }
}

export const authSignOutRoutes: FastifyPluginAsync = async (fastify) => {
  if (!fastify.hasDecorator('requireAuth')) {
    fastify.decorate('requireAuth', requireAuth);
  }

  fastify.post('/api/auth/sign-out', {
    preHandler: [fastify.requireAuth],
  }, async (request, reply) => {
    const auth = (request as typeof request & { auth?: AuthContext }).auth;

    await writeAuditEvent({
      event_type: 'auth.sign_out',
      severity: 'info',
      profile_id: auth?.profileId ?? null,
      payload: {
        user_id: auth?.userId ?? null,
      },
      requestLog: request.log,
    });

    clearCookies(reply);

    request.log.info({
      event: 'auth.sign_out',
      profile_id: auth?.profileId ?? null,
      user_id: auth?.userId ?? null,
    }, 'Sign-out completed');

    return reply.code(200).send({ ok: true });
  });
};
