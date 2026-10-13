import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reconcileAggregates } from '../../src/jobs/reconcile-aggregates';
import { createSchemaServiceRoleClient } from './ingestion-test-helpers';
import { q, runSql, seedProfiles } from './db-test-helpers';
import { resolveTestSchema, setupTestSchema } from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();

type AggregateRow = {
  total_sessions: number;
  total_tokens: string;
};

function fileHash(label: string): string {
  return crypto.createHash('sha256').update(label).digest('hex');
}

async function seedProfileSessions(label: string, count = 2): Promise<string> {
  const quotedSchema = q(schema);

  await seedProfiles(schema, label, 1);
  const profileRows = await runSql<{ id: string }>(`
    SELECT id
    FROM ${quotedSchema}.profiles
    WHERE handle::text = $1
    LIMIT 1
  `, [`${label}_1`]);
  const profileId = profileRows[0]?.id;

  if (!profileId) {
    throw new Error(`[reconcile-test] missing profile for ${label}`);
  }

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
      cache_read_tokens,
      cache_create_tokens,
      cached_tokens,
      reasoning_tokens,
      turns,
      ingestion_mode
    )
    SELECT
      $1::uuid,
      'claude',
      'claude-3-5-sonnet',
      $2 || '_' || session_index,
      $3 || session_index,
      TIMESTAMPTZ '2026-04-27T10:00:00Z',
      TIMESTAMPTZ '2026-04-27T10:05:00Z',
      1000 + session_index,
      100,
      0,
      0,
      0,
      0,
      1,
      'script_verified'
    FROM generate_series(1, $4::integer) session_index
  `, [profileId, label, fileHash(label), count]);

  return profileId;
}

async function readAggregate(profileId: string): Promise<AggregateRow> {
  const rows = await runSql<AggregateRow>(`
    SELECT total_tokens::text, total_sessions
    FROM ${q(schema)}.daily_aggregates
    WHERE profile_id = $1
      AND date = DATE '2026-04-27'
      AND source = 'claude'
      AND model = 'claude-3-5-sonnet'
  `, [profileId]);

  const row = rows[0];

  if (!row) {
    throw new Error('[reconcile-test] expected aggregate row');
  }

  return row;
}

async function corruptAggregate(profileId: string): Promise<void> {
  await runSql(`
    UPDATE ${q(schema)}.daily_aggregates
    SET total_tokens = 42,
        total_sessions = 99
    WHERE profile_id = $1
  `, [profileId]);
}

async function cleanupPerfUsers(): Promise<void> {
  await runSql(`
    DELETE FROM auth.users
    WHERE email LIKE 'perf_reconcile_%@example.com'
  `);
}

describe.sequential('reconcileAggregates integration', () => {
  beforeEach(async () => {
    await setupTestSchema(schema);
  });

  afterEach(async () => {
    await cleanupPerfUsers();
  });

  it('detects token mismatch and logs a critical audit event', async () => {
    const profileId = await seedProfileSessions('reconcile_mismatch');
    await corruptAggregate(profileId);

    const result = await reconcileAggregates(createSchemaServiceRoleClient());

    expect(result.error).toBeUndefined();
    expect(result.driftedRows).toBe(1);
    expect(result.affectedProfiles).toBe(1);

    const auditRows = await runSql<{ event_type: string; severity: string }>(`
      SELECT event_type, severity
      FROM ${q(schema)}.audit_events
      WHERE event_type = 'aggregates.drift_detected'
      ORDER BY id DESC
      LIMIT 1
    `);

    expect(auditRows[0]).toEqual({
      event_type: 'aggregates.drift_detected',
      severity: 'critical',
    });
  }, 30000);

  it('corrects drifted daily aggregate rows from sessions', async () => {
    const profileId = await seedProfileSessions('reconcile_corrects', 3);
    await corruptAggregate(profileId);

    const result = await reconcileAggregates(createSchemaServiceRoleClient());
    const aggregate = await readAggregate(profileId);

    expect(result.correctedRows).toBeGreaterThanOrEqual(1);
    expect(aggregate).toEqual({
      total_tokens: '3306',
      total_sessions: 3,
    });
  }, 30000);

  it('is idempotent when run twice', async () => {
    const profileId = await seedProfileSessions('reconcile_idempotent');
    await corruptAggregate(profileId);

    const first = await reconcileAggregates(createSchemaServiceRoleClient());
    const second = await reconcileAggregates(createSchemaServiceRoleClient());
    const aggregate = await readAggregate(profileId);

    expect(first.driftedRows).toBe(1);
    expect(second.driftedRows).toBe(0);
    expect(second.correctedRows).toBe(0);
    expect(aggregate.total_tokens).toBe('2203');
  }, 30000);

  it('reports zero drifts when aggregates are consistent', async () => {
    await seedProfileSessions('reconcile_clean');

    const result = await reconcileAggregates(createSchemaServiceRoleClient());

    expect(result.error).toBeUndefined();
    expect(result.driftedRows).toBe(0);
    expect(result.correctedRows).toBe(0);
  }, 30000);

  it('completes within 60s with 50000 profiles', async () => {
    const quotedSchema = q(schema);

    await runSql(`
      WITH generated AS MATERIALIZED (
        SELECT
          gen_random_uuid() AS id,
          'perf_reconcile_' || generate_series AS handle
        FROM generate_series(1, 50000)
      ),
      inserted_users AS (
        INSERT INTO auth.users (
          id,
          aud,
          role,
          email,
          raw_app_meta_data,
          raw_user_meta_data,
          created_at,
          updated_at
        )
        SELECT
          id,
          'authenticated',
          'authenticated',
          handle || '_' || id::text || '@example.com',
          '{}'::jsonb,
          '{}'::jsonb,
          now(),
          now()
        FROM generated
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      )
      INSERT INTO ${quotedSchema}.profiles (id, user_id, handle, display_name, mode, verified)
      SELECT
        id,
        id,
        handle,
        handle,
        'script_verified',
        true
      FROM generated
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
        id,
        'claude',
        'claude-3-5-sonnet',
        'perf_' || id::text,
        encode(sha256(id::text::bytea), 'hex'),
        TIMESTAMPTZ '2026-04-27T10:00:00Z',
        TIMESTAMPTZ '2026-04-27T10:05:00Z',
        1,
        1,
        1,
        'script_verified'
      FROM ${quotedSchema}.profiles
      WHERE handle::text LIKE 'perf_reconcile_%'
    `);

    const result = await reconcileAggregates(createSchemaServiceRoleClient());

    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeLessThan(60000);
    expect(result.driftedRows).toBe(0);
  }, 180000);
});
