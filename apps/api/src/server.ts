import 'dotenv/config';
import Fastify, { type FastifyServerOptions, type RawServerDefault } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import cors from '@fastify/cors';

import { adminRoutes } from './routes/admin/index.js';
import { accessKeysRoutes } from './routes/access-keys';
import { accessKeysRevokeRoute } from './routes/access-keys/revoke';
import { authRoutes } from './routes/auth.routes';
import { authSignOutRoutes } from './routes/auth/sign-out';
import { githubReposRoutes } from './routes/github/repos';
import { healthzRoutes } from './routes/healthz';
import { homepageStatsRoutes } from './routes/homepage-stats';
import { ingestionRoutes } from './routes/ingestion.routes';
import { installerCompletionRoutes } from './routes/installer-completion';
import { installerRoutes } from './routes/installers';
import { leaderboardRoutes } from './routes/leaderboard';
import { explorerRoutes } from './routes/explorer';
import { localPublishRoutes } from './routes/local-publish';
import { ogProfileRoutes } from './routes/og/profile';
import { onboardingRoutes } from './routes/onboarding';
import { profileRoutes } from './routes/profile';
import { authPlugin } from './plugins/auth';
import { bearerAuthPlugin } from './plugins/bearer-auth';
import { cacheHeadersPlugin } from './plugins/cache-headers';
import { csrfPlugin } from './plugins/csrf';
import { errorHandlerPlugin } from './plugins/error-handler';
import { rateLimitPlugin } from './plugins/rate-limit';
import { requestIdPlugin } from './plugins/request-id';
import { securityHeadersPlugin } from './plugins/security-headers';
import { adminClient } from './clients/supabase';
import { initBadgeCron } from './cron/badge-evaluator.cron';
import { registerCronJobs } from './crons';
import { getAllowedOrigins } from './lib/csrf';
import { httpLogger, logger, loggerOptions } from './lib/logger';
import { cacheService } from './services/cache.service';

export { logger };

const PORT = Number.parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

type BuildServerOptions = {
  logger?: FastifyServerOptions<RawServerDefault>['logger'];
};

function shouldStartBadgeCron(): boolean {
  return process.env.NODE_ENV !== 'test' || process.env.START_FASTIFY === 'true';
}

export async function buildServer(options: BuildServerOptions = {}) {
  const fastify = Fastify({
    logger: options.logger ?? loggerOptions,
    disableRequestLogging: true,
  });

  fastify.decorate('cache', cacheService);

  await fastify.register(errorHandlerPlugin);
  await fastify.register(securityHeadersPlugin);

  await fastify.register(cors, {
    origin: [...getAllowedOrigins()],
    credentials: true,
  });

  await fastify.register(fastifyCookie, {
    secret: process.env.COOKIE_SECRET || 'dev-secret',
  });

  await fastify.register(csrfPlugin);
  await fastify.register(rateLimitPlugin);
  await fastify.register(httpLogger);
  await fastify.register(requestIdPlugin);
  await fastify.register(bearerAuthPlugin);
  await fastify.register(cacheHeadersPlugin);
  await fastify.register(authPlugin);
  await fastify.register(adminRoutes);
  await fastify.register(accessKeysRoutes);
  await fastify.register(accessKeysRevokeRoute);
  await fastify.register(authRoutes);
  await fastify.register(authSignOutRoutes);
  await fastify.register(githubReposRoutes);
  await fastify.register(homepageStatsRoutes);
  await fastify.register(ingestionRoutes);
  await fastify.register(installerCompletionRoutes);
  await fastify.register(installerRoutes);
  await fastify.register(leaderboardRoutes);
  await fastify.register(explorerRoutes);
  await fastify.register(localPublishRoutes);
  await fastify.register(ogProfileRoutes);
  await fastify.register(onboardingRoutes);
  await fastify.register(profileRoutes);

  fastify.get('/health', async (request) => {
    request.log.debug({ event: 'health.check' }, 'Health check');
    return { ok: true };
  });

  await fastify.register(healthzRoutes);

  let badgeCron: ReturnType<typeof initBadgeCron> | null = null;

  fastify.addHook('onClose', async () => {
    badgeCron?.stop();
  });

  fastify.addHook('onReady', async () => {
    if (!shouldStartBadgeCron()) {
      fastify.log.info({
        event: 'badge_cron.disabled',
        reason: 'test_environment',
      }, 'Badge evaluator cron disabled');
      return;
    }

    try {
      badgeCron = initBadgeCron({ logger: fastify.log });

      fastify.log.info({
        event: 'badge_cron.ready',
      }, 'Badge evaluator cron ready');
    } catch (error) {
      fastify.log.warn({
        event: 'badge_cron.initialization_failed',
        error: error instanceof Error ? error.message : String(error),
      }, 'Badge evaluator cron initialization failed');
    }
  });

  return fastify;
}

async function start() {
  const fastify = await buildServer();

  try {
    // Start database maintenance crons after routes are registered and before
    // the API begins accepting traffic.
    registerCronJobs(fastify, adminClient);

    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info({
      event: 'server.started',
      host: HOST,
      port: PORT,
    }, 'Server started');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

if (process.env.START_FASTIFY === 'true' || (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true')) {
  start();
}
