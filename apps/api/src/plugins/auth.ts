import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { requireAccessKey, requireAuth } from '../middleware/auth';

const ADMIN_AUTH_FAILURE_DELAY_MS = 50;

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: typeof requireAuth;
    requireAccessKey: typeof requireAccessKey;
    requireAdmin: typeof requireAdmin;
  }
}

function extractBearerToken(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) {
    return '';
  }

  return header.slice(7);
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({
    error: {
      code: 'unauthorized',
      message: 'Unauthorized',
    },
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isAdminTokenValid(token: string, adminToken: string): boolean {
  if (!token || !adminToken) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      Buffer.from(token, 'utf8'),
      Buffer.from(adminToken, 'utf8'),
    );
  } catch {
    return false;
  }
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  const token = extractBearerToken(req.headers.authorization);
  const adminToken = process.env.ADMIN_PURGE_TOKEN ?? '';

  if (!isAdminTokenValid(token, adminToken)) {
    await wait(ADMIN_AUTH_FAILURE_DELAY_MS);
    return unauthorized(reply);
  }
}

const authPluginImpl: FastifyPluginAsync = async (fastify) => {
  if (!fastify.hasDecorator('requireAuth')) {
    fastify.decorate('requireAuth', requireAuth);
  }

  if (!fastify.hasDecorator('requireAccessKey')) {
    fastify.decorate('requireAccessKey', requireAccessKey);
  }

  if (!fastify.hasDecorator('requireAdmin')) {
    fastify.decorate('requireAdmin', requireAdmin);
  }
};

export const authPlugin = fp(authPluginImpl, {
  name: 'tokensrank-auth',
});
