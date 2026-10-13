import type { SupabaseClient } from '@supabase/supabase-js';
import type { FastifyBaseLogger } from 'fastify';
import type { ScheduledTask } from 'node-cron';
import cron from 'node-cron';

import { adminClient } from '../clients/supabase';
import {
  evaluateAllProfiles,
  type EvaluateAllProfilesResult,
} from '../services/badge-evaluator';

export const BADGE_EVALUATOR_CRON_SCHEDULE = '*/15 * * * *';
export const BADGE_EVALUATOR_CRON_TIMEZONE = 'UTC';

export type BadgeCronLogger = Pick<FastifyBaseLogger, 'debug' | 'error' | 'info' | 'warn'>;

export type InitBadgeCronOptions = {
  logger?: BadgeCronLogger;
  supabaseClient?: Pick<SupabaseClient, 'from'>;
};

export async function runBadgeEvaluationCycle(
  options: InitBadgeCronOptions = {},
): Promise<EvaluateAllProfilesResult> {
  const result = await evaluateAllProfiles(options.supabaseClient ?? adminClient, {
    logger: options.logger,
    acquireLock: true,
  });

  if (!result.lockAcquired) {
    options.logger?.info({
      event: 'badge_cron.skipped',
      reason: 'advisory_lock_held',
      duration_ms: result.durationMs,
    }, 'Badge evaluator cron skipped because advisory lock is held');
    return result;
  }

  options.logger?.info({
    event: 'badge_cron.completed',
    evaluated: result.evaluated,
    badges_evaluated: result.badgesEvaluated,
    awarded: result.awarded,
    skipped: result.skipped,
    errors: result.errors.length,
    duration_ms: result.durationMs,
  }, 'Badge evaluator cron completed');

  return result;
}

export function initBadgeCron(options: InitBadgeCronOptions = {}): ScheduledTask {
  const task = cron.schedule(
    BADGE_EVALUATOR_CRON_SCHEDULE,
    async () => {
      try {
        await runBadgeEvaluationCycle(options);
      } catch (error) {
        options.logger?.warn({
          event: 'badge_cron.failed',
          error: error instanceof Error ? error.message : String(error),
        }, 'Badge evaluator cron failed');
      }
    },
    {
      timezone: BADGE_EVALUATOR_CRON_TIMEZONE,
    },
  );

  options.logger?.info({
    event: 'badge_cron.initialized',
    schedule: BADGE_EVALUATOR_CRON_SCHEDULE,
    timezone: BADGE_EVALUATOR_CRON_TIMEZONE,
  }, 'Badge evaluator cron initialized');

  return task;
}
