import Fastify from 'fastify';
import cron from 'node-cron';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  AGGREGATES_RECONCILE_CRON,
  CRON_TIMEZONE,
  LEADERBOARD_REFRESH_CRON,
  registerCronJobs,
} from '../../src/crons';
import { createSchemaServiceRoleClient } from './ingestion-test-helpers';
import {
  ensureLeaderboardMaterializedView,
  q,
  runSql,
  seedProfiles,
} from './db-test-helpers';
import { resolveTestSchema, setupTestSchema } from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();

type LogLine = {
  event?: string;
  [key: string]: unknown;
};

const logs: LogLine[] = [];

function captureLog(_message: unknown, args: unknown[]): void {
  const firstArg = args[0];

  if (firstArg && typeof firstArg === 'object') {
    logs.push(firstArg as LogLine);
  }
}

async function prepareCronData(): Promise<void> {
  const quotedSchema = q(schema);

  await seedProfiles(schema, 'cron_profile', 1);
  await runSql(`
    INSERT INTO ${quotedSchema}.daily_aggregates
      (profile_id, date, source, model, total_tokens, total_sessions, derived_cost_usd)
    SELECT id, CURRENT_DATE, 'claude', 'claude-3-5-sonnet', 100, 1, 0
    FROM ${quotedSchema}.profiles
    WHERE handle::text = 'cron_profile_1'
  `);
  await ensureLeaderboardMaterializedView(schema);
}

describe.sequential('registerCronJobs integration', () => {
  beforeEach(async () => {
    logs.length = 0;
    await setupTestSchema(schema);
    await prepareCronData();
  });

  it('registers both cron jobs with valid UTC expressions', async () => {
    const fastify = Fastify({
      logger: {
        level: 'info',
        stream: {
          write(message) {
            captureLog(message, [JSON.parse(message) as LogLine]);
          },
        },
      },
    });
    const jobs = registerCronJobs(fastify, createSchemaServiceRoleClient());

    try {
      expect(cron.validate(LEADERBOARD_REFRESH_CRON)).toBe(true);
      expect(cron.validate(AGGREGATES_RECONCILE_CRON)).toBe(true);
      expect(CRON_TIMEZONE).toBe('UTC');
      expect(jobs.leaderboardRefresh.getNextRun()).toBeInstanceOf(Date);
      expect(jobs.aggregatesReconcile.getNextRun()).toBeInstanceOf(Date);
      expect(logs.some((line) => line.event === 'crons.registered')).toBe(true);
    } finally {
      await fastify.close();
    }
  });

  it('executes jobs and logs refresh plus reconciliation completion events', async () => {
    const fastify = Fastify({
      logger: {
        level: 'info',
        stream: {
          write(message) {
            captureLog(message, [JSON.parse(message) as LogLine]);
          },
        },
      },
    });
    const jobs = registerCronJobs(fastify, createSchemaServiceRoleClient());

    try {
      await jobs.leaderboardRefresh.execute();
      await jobs.aggregatesReconcile.execute();

      expect(logs.some((line) => line.event === 'mv.refreshed')).toBe(true);
      expect(logs.some((line) => line.event === 'aggregates.reconcile_completed')).toBe(true);
    } finally {
      await fastify.close();
    }
  }, 30000);

  it('catches cron errors without crashing the server', async () => {
    const fastify = Fastify({
      logger: {
        level: 'info',
        stream: {
          write(message) {
            captureLog(message, [JSON.parse(message) as LogLine]);
          },
        },
      },
    });
    const jobs = registerCronJobs(fastify, createSchemaServiceRoleClient());
    const originalProjectId = process.env.SUPABASE_PROJECT_ID;
    const originalDbUrl = process.env.SUPABASE_DB_URL;

    try {
      delete process.env.SUPABASE_PROJECT_ID;
      delete process.env.SUPABASE_DB_URL;

      await expect(jobs.leaderboardRefresh.execute()).resolves.toBeUndefined();
      expect(logs.some((line) => line.event === 'mv.refresh_failed')).toBe(true);
    } finally {
      if (originalProjectId) {
        process.env.SUPABASE_PROJECT_ID = originalProjectId;
      }

      if (originalDbUrl) {
        process.env.SUPABASE_DB_URL = originalDbUrl;
      }

      await fastify.close();
    }
  }, 30000);
});
