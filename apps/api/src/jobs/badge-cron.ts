import type { SupabaseClient } from '@supabase/supabase-js';
import type { FastifyBaseLogger } from 'fastify';
import type { ScheduledTask } from 'node-cron';
import cron from 'node-cron';

import {
  evaluateAllProfiles,
  type EvaluateAllProfilesResult,
} from '../services/badge-evaluator';

export const BADGE_EVALUATOR_CRON = '*/15 * * * *';
export const BADGE_EVALUATOR_CRON_TIMEZONE = 'UTC';

export type StartBadgeEvaluatorCronOptions = {
  logger?: Pick<FastifyBaseLogger, 'error' | 'info' | 'warn' | 'debug'>;
};

export function startBadgeEvaluatorCron(
  supabaseClient: Pick<SupabaseClient, 'from'>,
  options: StartBadgeEvaluatorCronOptions = {},
): ScheduledTask {
  const task = cron.schedule(
    BADGE_EVALUATOR_CRON,
    async () => {
      try {
        const result: EvaluateAllProfilesResult = await evaluateAllProfiles(supabaseClient, {
          logger: options.logger,
          acquireLock: true,
        });

        if (!result.lockAcquired) {
          return;
        }

        options.logger?.info?.({
          event: 'badge_cron.completed',
          evaluated: result.evaluated,
          badges_evaluated: result.badgesEvaluated,
          awarded: result.awarded,
          skipped: result.skipped,
          errors: result.errors.length,
          duration_ms: result.durationMs,
        }, 'Badge evaluator cron completed');
      } catch (error) {
        options.logger?.error?.({
          event: 'badge_cron.failed',
          error: error instanceof Error ? error.message : String(error),
        }, 'Badge evaluator cron failed');
      }
    },
    {
      timezone: BADGE_EVALUATOR_CRON_TIMEZONE,
    },
  );

  options.logger?.info?.({
    event: 'badge_cron.registered',
    schedule: BADGE_EVALUATOR_CRON,
    timezone: BADGE_EVALUATOR_CRON_TIMEZONE,
  }, 'Badge evaluator cron registered');

  return task;
}
