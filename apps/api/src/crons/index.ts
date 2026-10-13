import { purgeIngestionCaches } from '../services/cache';
/**
 * TokensRank API cron registration.
 *
 * Purpose: start database maintenance jobs with node-cron when the Fastify API
 * boots. Caller: `server.ts` after routes are registered and before `listen()`.
 * Each job catches/logs errors and relies on service-level advisory locks.
 *
 * References: PRD FR-51/NFR-26/NFR-27 and Blueprint §4.7/§18.8. Limitation:
 * v1 runs as a single API process; advisory locks preserve correctness if PM2
 * or a later deployment uses more than one process.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FastifyInstance } from 'fastify';
import type { ScheduledTask } from 'node-cron';
import cron from 'node-cron';

import { reconcileAggregates } from '../jobs/reconcile-aggregates';
import { syncAllConnectedProfiles } from '../services/github-pull';
import { syncModelPricing } from '../services/models-dev-sync';
import { rebuildProfileSummaries } from '../services/scoring';

export const AGGREGATES_RECONCILE_CRON = '5 0 * * *';
export const GITHUB_PULL_CRON = '0 3 * * *'; // Daily 03:00 UTC — pull shipped-code into contrib_daily
export const SUMMARY_REBUILD_CRON = '*/15 * * * *'; // Every 15 min — rebuild profile_summary + ranking
export const MODELS_DEV_SYNC_CRON = '0 6 * * *'; // Daily 06:00 UTC — refresh model_pricing from models.dev
export const CRON_TIMEZONE = 'UTC';

export type RegisteredCronJobs = {
  aggregatesReconcile: ScheduledTask;
  githubPull: ScheduledTask;
  summaryRebuild: ScheduledTask;
  modelDevSync: ScheduledTask;
};

/**
 * Registers TokensRank database maintenance cron jobs on API startup.
 *
 * Schedules:
 * - `5 0 * * *` UTC reconciles `daily_aggregates` from `sessions`.
 * - Daily GitHub pull into `contrib_daily`; profile-summary rebuild every 15m.
 *
 * Limitations: v1 runs a single API instance, but each job still uses a
 * Postgres advisory lock so future multi-instance deployments skip duplicate
 * work safely. Cron callbacks log and swallow errors to avoid crashing Fastify.
 *
 * References: PRD FR-51, NFR-26, NFR-27; Blueprint §4.7 and §18.8.
 */
export function registerCronJobs(
  fastify: FastifyInstance,
  supabaseClient: Pick<SupabaseClient, 'from'>,
): RegisteredCronJobs {
  const aggregatesReconcile = cron.schedule(
    AGGREGATES_RECONCILE_CRON,
    async () => {
      try {
        await reconcileAggregates(supabaseClient, { logger: fastify.log });
      } catch (error) {
        fastify.log.error({
          event: 'aggregates.reconcile_failed',
          error,
        }, 'Unhandled aggregates reconciliation cron error');
      }
    },
    {
      timezone: CRON_TIMEZONE,
    },
  );

  const githubPull = cron.schedule(
    GITHUB_PULL_CRON,
    async () => {
      try {
        const results = await syncAllConnectedProfiles();
        fastify.log.info({ event: 'github.pull_completed', profiles: results.length }, 'GitHub contribution pull completed');
      } catch (error) {
        fastify.log.error({
          event: 'github.pull_failed',
          error: error instanceof Error ? error.message : String(error),
        }, 'Unhandled GitHub pull cron error');
      }
    },
    {
      timezone: CRON_TIMEZONE,
    },
  );

  const summaryRebuild = cron.schedule(
    SUMMARY_REBUILD_CRON,
    async () => {
      try {
        const result = await rebuildProfileSummaries();
        purgeIngestionCaches();
        fastify.cache.purgeByPrefix('profile:');
        fastify.log.info({ event: 'summary.rebuild_completed', ...result }, 'Profile summary rebuild completed');
      } catch (error) {
        fastify.log.error({
          event: 'summary.rebuild_failed',
          error: error instanceof Error ? error.message : String(error),
        }, 'Unhandled profile summary rebuild cron error');
      }
    },
    {
      timezone: CRON_TIMEZONE,
    },
  );

  const modelDevSync = cron.schedule(
    MODELS_DEV_SYNC_CRON,
    async () => {
      try {
        const result = await syncModelPricing({ supabaseClient });
        fastify.log.info({ event: 'models_dev.sync_completed', ...result }, 'models.dev pricing sync completed');
      } catch (error) {
        fastify.log.error({
          event: 'models_dev.sync_failed',
          error: error instanceof Error ? error.message : String(error),
        }, 'Unhandled models.dev pricing sync cron error');
      }
    },
    {
      timezone: CRON_TIMEZONE,
    },
  );

  // Populate model_pricing on boot so cost is accurate before the first daily run
  // (mirrors the github-pull catch-up intent). Fire-and-forget; errors are logged.
  void syncModelPricing({ supabaseClient })
    .then((result) => fastify.log.info({ event: 'models_dev.sync_boot', ...result }, 'models.dev pricing sync (boot) completed'))
    .catch((error) => fastify.log.warn({
      event: 'models_dev.sync_boot_failed',
      error: error instanceof Error ? error.message : String(error),
    }, 'models.dev pricing sync (boot) failed'));

  fastify.addHook('onClose', async () => {
    aggregatesReconcile.stop();
    githubPull.stop();
    summaryRebuild.stop();
    modelDevSync.stop();
  });

  fastify.log.info({
    event: 'crons.registered',
    aggregates_reconcile: AGGREGATES_RECONCILE_CRON,
    github_pull: GITHUB_PULL_CRON,
    summary_rebuild: SUMMARY_REBUILD_CRON,
    models_dev_sync: MODELS_DEV_SYNC_CRON,
    timezone: CRON_TIMEZONE,
  }, 'Cron jobs registered');

  return {
    aggregatesReconcile,
    githubPull,
    summaryRebuild,
    modelDevSync,
  };
}
