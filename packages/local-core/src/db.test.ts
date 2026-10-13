import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { LocalStore } from './db.js';
import { LOCAL_SCHEMA_VERSION, initLocalDatabase, markInterruptedIngestionRuns, openLocalStore } from './db.js';

describe('local database migrations', () => {
  let store: LocalStore | null = null;

  afterEach(() => {
    store?.close();
    store = null;
  });

  it('records the current schema migration and remains idempotent', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-db-'));
    store = openLocalStore({ dataDir });

    initLocalDatabase(store.db);

    const rows = store.db.prepare(`
      SELECT version
      FROM local_schema_migrations
      ORDER BY version
    `).all() as Array<{ version: number }>;
    const userVersion = store.db.pragma('user_version', { simple: true }) as number;

    expect(rows).toEqual(
      Array.from({ length: LOCAL_SCHEMA_VERSION }, (_, index) => ({ version: index + 1 })),
    );
    expect(userVersion).toBe(LOCAL_SCHEMA_VERSION);
    const plan = store.db.prepare("EXPLAIN QUERY PLAN DELETE FROM ai_tool_events WHERE json_valid(metadata_json) AND json_extract(metadata_json, '$.source_path_hash') IN (?)").all('example') as { detail: string }[];
    expect(plan.some(row => row.detail.includes('idx_ai_tool_events_source_path'))).toBe(true);
  });

  it('migrates legacy ingestion run rows out of publish_runs', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-db-'));
    await mkdir(dataDir, { recursive: true });
    const databasePath = path.join(dataDir, 'tokensrank.db');
    const db = new Database(databasePath);
    db.exec(`
      CREATE TABLE local_schema_migrations (
        version integer PRIMARY KEY,
        applied_at text NOT NULL
      );
      CREATE TABLE publish_runs (
        run_id text PRIMARY KEY,
        status text NOT NULL,
        started_at text NOT NULL,
        finished_at text,
        usage_day_count integer NOT NULL DEFAULT 0,
        session_count integer NOT NULL DEFAULT 0,
        code_day_count integer NOT NULL DEFAULT 0,
        error text
      );
      INSERT INTO local_schema_migrations (version, applied_at)
      VALUES (1, '2026-06-01T00:00:00.000Z');
      INSERT INTO publish_runs (
        run_id,
        status,
        started_at,
        finished_at,
        usage_day_count,
        session_count,
        code_day_count,
        error
      )
      VALUES (
        'legacy-ingest-run',
        'completed',
        '2026-06-01T00:00:00.000Z',
        '2026-06-01T00:01:00.000Z',
        3,
        2,
        1,
        NULL
      );
      PRAGMA user_version = 1;
    `);
    db.close();

    store = openLocalStore({ dataDir });

    const row = store.db.prepare(`
      SELECT run_id, status, usage_day_count, session_count, code_day_count
      FROM ingestion_runs
      WHERE run_id = 'legacy-ingest-run'
    `).get();

    expect(row).toEqual({
      run_id: 'legacy-ingest-run',
      status: 'completed',
      usage_day_count: 3,
      session_count: 2,
      code_day_count: 1,
    });
  });

  it('marks orphaned running ingestion runs as interrupted', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-db-'));
    store = openLocalStore({ dataDir });
    store.db.prepare(`
      INSERT INTO ingestion_runs (run_id, status, started_at)
      VALUES ('orphaned-run', 'running', '2026-06-01T00:00:00.000Z')
    `).run();

    expect(markInterruptedIngestionRuns(store.db)).toBe(1);

    const row = store.db.prepare(`
      SELECT status, finished_at, error
      FROM ingestion_runs
      WHERE run_id = 'orphaned-run'
    `).get() as { status: string; finished_at: string | null; error: string | null };
    expect(row.status).toBe('interrupted');
    expect(row.finished_at).not.toBeNull();
    expect(row.error).toContain('stopped before this ingestion run finished');
  });
});
