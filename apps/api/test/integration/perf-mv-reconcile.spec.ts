import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reconcileAggregates } from '../../src/jobs/reconcile-aggregates';
import { createSchemaServiceRoleClient } from './ingestion-test-helpers';
import {
  ensureLeaderboardMaterializedView,
  q,
  runSql,
  seedProfiles,
} from './db-test-helpers';
import { resolveTestSchema, setupTestSchema } from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const reconcileBudgetMs = 60000;
const heapBudgetBytes = 100 * 1024 * 1024;

function bytesToMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

function warnIfBudgetExceeded(metric: string, value: number, budget: number, unit: string): void {
  if (value <= budget) {
    return;
  }

  console.warn(`[perf-mv-reconcile] WARN ${metric}=${value}${unit} exceeded budget=${budget}${unit}`);
}

async function cleanupPerfUsers(): Promise<void> {
  await runSql(`
    DELETE FROM auth.users
    WHERE email LIKE 'perf_mv_reconcile_%@example.com'
  `);
}

async function seedPerformanceDataset(): Promise<void> {
  const quotedSchema = q(schema);

  await seedProfiles(schema, 'perf_mv_reconcile', 1000);
  await runSql(`
    INSERT INTO ${quotedSchema}.daily_aggregates
      (profile_id, date, source, model, total_tokens, total_sessions, derived_cost_usd)
    SELECT
      profiles.id,
      DATE '2026-03-01' + aggregate_day.day,
      CASE WHEN aggregate_day.day % 2 = 0 THEN 'claude' ELSE 'codex' END,
      'perf-model',
      10,
      1,
      0
    FROM ${quotedSchema}.profiles profiles
    CROSS JOIN generate_series(0, 29) AS aggregate_day(day)
    WHERE profiles.handle::text LIKE 'perf_mv_reconcile_%'
  `);
  await runSql(`
    INSERT INTO ${quotedSchema}.sessions (
      profile_id,
      source,
      model,
      session_id,
      file_sha256,
      first_event_at,
      last_event_at,
      input_tokens,
      output_tokens,
      turns,
      ingestion_mode
    )
    SELECT
      profiles.id,
      'claude',
      'perf-model',
      'perf_session_' || session_index || '_' || profiles.id::text,
      encode(sha256((profiles.id::text || session_index)::bytea), 'hex'),
      TIMESTAMPTZ '2026-04-27T10:00:00Z',
      TIMESTAMPTZ '2026-04-27T10:05:00Z',
      5,
      5,
      1,
      'script_verified'
    FROM ${quotedSchema}.profiles profiles
    CROSS JOIN generate_series(1, 10) AS session_index
    WHERE profiles.handle::text LIKE 'perf_mv_reconcile_%'
  `);
  await ensureLeaderboardMaterializedView(schema);
}

describe.sequential('MV refresh and aggregate reconciliation performance', () => {
  beforeEach(async () => {
    await setupTestSchema(schema);
    await seedPerformanceDataset();
  }, 90000);

  afterEach(async () => {
    await cleanupPerfUsers();
  });

  it('logs performance metrics for reconciliation without hard-failing budgets', async () => {
    const heapBefore = process.memoryUsage().heapUsed;
    const reconcileResult = await reconcileAggregates(createSchemaServiceRoleClient());
    const heapAfter = process.memoryUsage().heapUsed;
    const heapDelta = Math.max(0, heapAfter - heapBefore);

    console.info('[perf-mv-reconcile] metrics', {
      reconcile_duration_ms: reconcileResult.durationMs,
      heap_delta_mb: bytesToMb(heapDelta),
      reconcile_drifted_rows: reconcileResult.driftedRows,
      reconcile_corrected_rows: reconcileResult.correctedRows,
    });

    warnIfBudgetExceeded('reconcile_duration_ms', reconcileResult.durationMs, reconcileBudgetMs, 'ms');
    warnIfBudgetExceeded('heap_delta_mb', bytesToMb(heapDelta), bytesToMb(heapBudgetBytes), 'MB');

    expect(reconcileResult.error).toBeUndefined();
    expect(reconcileResult.reconciled).toBe(true);
  }, 180000);
});
