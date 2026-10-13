/**
 * Nightly daily-aggregate reconciliation job.
 *
 * Purpose: compare trigger-owned `daily_aggregates` with grouped `sessions`
 * source data, log drift details, and replace affected aggregate
 * rows from source of truth. Caller: `registerCronJobs()` at 00:05 UTC.
 *
 * References: PRD NFR-27 and Blueprint §18.8.4. Limitation: v1 deploys one API
 * instance, but the advisory lock prevents duplicate work in future horizontal
 * deployments.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FastifyBaseLogger } from 'fastify';

import { adminClient } from '../clients/supabase';
import { createPostgresClient, getActiveDatabaseSchema, quoteIdentifier } from '../lib/postgres';

type AggregateDriftSample = {
  profile_id: string;
  date: string;
  source: string;
  model: string;
  expected_tokens: string;
  actual_tokens: string;
  expected_sessions: string;
  actual_sessions: string;
};

export type ReconcileResult = {
  reconciled: boolean;
  lockAcquired: boolean;
  driftedRows: number;
  affectedProfiles: number;
  correctedRows: number;
  durationMs: number;
  error?: string;
};

export type ReconcileAggregatesOptions = {
  logger?: Pick<FastifyBaseLogger, 'debug' | 'error' | 'info' | 'warn'>;
};

export type ReconcileSupabaseClient = Pick<SupabaseClient, 'from'>;

const advisoryLockName = 'tokensrank.daily_aggregates.reconcile';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function parseCount(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return Number.parseInt(value, 10);
  }

  return 0;
}

/**
 * Recomputes `daily_aggregates` from `sessions` and corrects trigger drift.
 *
 * Caller: the nightly 00:05 UTC API cron. The job compares the trigger-owned
 * `daily_aggregates` table with a fresh grouped projection of `sessions`.
 * When mismatches exist, it logs drift details and replaces aggregate
 * rows for affected profiles from the source-of-truth sessions table.
 *
 * Logging: emits `aggregates.reconcile_skipped`,
 * `aggregates.drift_detected`, `aggregates.reconcile_completed`, or
 * `aggregates.reconcile_failed`.
 *
 * References: PRD NFR-27; Blueprint scheduled jobs §18.8.4.
 */
export async function reconcileAggregates(
  db: ReconcileSupabaseClient = adminClient,
  options: ReconcileAggregatesOptions = {},
): Promise<ReconcileResult> {
  void db;

  const startedAt = Date.now();
  const schema = getActiveDatabaseSchema();
  const quotedSchema = quoteIdentifier(schema);
  const client = await createPostgresClient();
  let lockAcquired = false;

  try {
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [advisoryLockName],
    );
    lockAcquired = lockResult.rows[0]?.acquired === true;

    if (!lockAcquired) {
      const durationMs = Date.now() - startedAt;

      options.logger?.debug({
        event: 'aggregates.reconcile_skipped',
        duration_ms: durationMs,
      }, 'Aggregates reconciliation skipped because advisory lock is held');

      return {
        reconciled: false,
        lockAcquired: false,
        driftedRows: 0,
        affectedProfiles: 0,
        correctedRows: 0,
        durationMs,
      };
    }

    const diffSql = `
      WITH expected AS (
        SELECT
          profile_id,
          (last_event_at AT TIME ZONE 'UTC')::date AS date,
          source,
          COALESCE(model, 'unknown') AS model,
          SUM(total_tokens)::bigint AS total_tokens,
          COUNT(*)::integer AS total_sessions
        FROM ${quotedSchema}.sessions
        GROUP BY profile_id, (last_event_at AT TIME ZONE 'UTC')::date, source, COALESCE(model, 'unknown')
      ),
      actual AS (
        SELECT profile_id, date, source, model, total_tokens, total_sessions
        FROM ${quotedSchema}.daily_aggregates
      ),
      drift AS (
        SELECT
          COALESCE(expected.profile_id, actual.profile_id) AS profile_id,
          COALESCE(expected.date, actual.date) AS date,
          COALESCE(expected.source, actual.source) AS source,
          COALESCE(expected.model, actual.model) AS model,
          COALESCE(expected.total_tokens, 0)::bigint AS expected_tokens,
          COALESCE(actual.total_tokens, 0)::bigint AS actual_tokens,
          COALESCE(expected.total_sessions, 0)::integer AS expected_sessions,
          COALESCE(actual.total_sessions, 0)::integer AS actual_sessions
        FROM expected
        FULL OUTER JOIN actual
          ON actual.profile_id = expected.profile_id
         AND actual.date = expected.date
         AND actual.source = expected.source
         AND actual.model = expected.model
        WHERE COALESCE(expected.total_tokens, 0) <> COALESCE(actual.total_tokens, 0)
           OR COALESCE(expected.total_sessions, 0) <> COALESCE(actual.total_sessions, 0)
      )
      SELECT
        (SELECT COUNT(*)::integer FROM drift) AS drifted_rows,
        (SELECT COUNT(DISTINCT profile_id)::integer FROM drift) AS affected_profiles,
        COALESCE((
          SELECT jsonb_agg(to_jsonb(sample) ORDER BY profile_id, date, source, model)
          FROM (
            SELECT *
            FROM drift
            ORDER BY profile_id, date, source, model
            LIMIT 25
          ) sample
        ), '[]'::jsonb) AS sample
    `;
    const diffResult = await client.query<{
      affected_profiles: number | string;
      drifted_rows: number | string;
      sample: AggregateDriftSample[];
    }>(diffSql);
    const diffRow = diffResult.rows[0];
    const driftedRows = parseCount(diffRow?.drifted_rows);
    const affectedProfiles = parseCount(diffRow?.affected_profiles);
    const sample = diffRow?.sample ?? [];

    if (driftedRows > 0) {
      options.logger?.warn({
        event: 'aggregates.drift_detected',
        drifted_rows: driftedRows,
        affected_profiles: affectedProfiles,
      }, 'Daily aggregate drift detected');

      await client.query('BEGIN');
      await client.query(`
        CREATE TEMP TABLE tokensrank_reconcile_profiles ON COMMIT DROP AS
        WITH expected_profiles AS (
          SELECT DISTINCT profile_id FROM ${quotedSchema}.sessions
        ),
        actual_profiles AS (
          SELECT DISTINCT profile_id FROM ${quotedSchema}.daily_aggregates
        )
        SELECT profile_id FROM expected_profiles
        UNION
        SELECT profile_id FROM actual_profiles
      `);
      await client.query(`
        DELETE FROM ${quotedSchema}.daily_aggregates
        WHERE profile_id IN (SELECT profile_id FROM tokensrank_reconcile_profiles)
      `);
      const insertResult = await client.query(`
        INSERT INTO ${quotedSchema}.daily_aggregates
          (profile_id, date, source, model, total_tokens, total_sessions, derived_cost_usd, updated_at)
        SELECT
          profile_id,
          (last_event_at AT TIME ZONE 'UTC')::date AS date,
          source,
          COALESCE(model, 'unknown') AS model,
          SUM(total_tokens)::bigint AS total_tokens,
          COUNT(*)::integer AS total_sessions,
          0,
          now()
        FROM ${quotedSchema}.sessions
        WHERE profile_id IN (SELECT profile_id FROM tokensrank_reconcile_profiles)
        GROUP BY profile_id, (last_event_at AT TIME ZONE 'UTC')::date, source, COALESCE(model, 'unknown')
      `);
      await client.query('COMMIT');

      const durationMs = Date.now() - startedAt;
      const correctedRows = insertResult.rowCount ?? 0;

      options.logger?.info({
        event: 'aggregates.reconcile_completed',
        drifted_rows: driftedRows,
        affected_profiles: affectedProfiles,
        corrected_rows: correctedRows,
        duration_ms: durationMs,
      }, 'Aggregates reconciliation completed');

      return {
        reconciled: true,
        lockAcquired: true,
        driftedRows,
        affectedProfiles,
        correctedRows,
        durationMs,
      };
    }

    const durationMs = Date.now() - startedAt;

    options.logger?.info({
      event: 'aggregates.reconcile_completed',
      drifted_rows: 0,
      affected_profiles: 0,
      corrected_rows: 0,
      duration_ms: durationMs,
    }, 'Aggregates reconciliation completed');

    return {
      reconciled: true,
      lockAcquired: true,
      driftedRows: 0,
      affectedProfiles: 0,
      correctedRows: 0,
      durationMs,
    };
  } catch (error) {
    if (lockAcquired) {
      await client.query('ROLLBACK').catch(() => undefined);
    }

    const durationMs = Date.now() - startedAt;
    const message = getErrorMessage(error);

    options.logger?.error({
      event: 'aggregates.reconcile_failed',
      duration_ms: durationMs,
      error: message,
    }, 'Aggregates reconciliation failed');

    return {
      reconciled: false,
      lockAcquired,
      driftedRows: 0,
      affectedProfiles: 0,
      correctedRows: 0,
      durationMs,
      error: message,
    };
  } finally {
    if (lockAcquired) {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [advisoryLockName]);
    }

    await client.end();
  }
}
