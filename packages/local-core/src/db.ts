import Database from 'better-sqlite3';

import { ensureLocalConfig } from './config.js';
import { ensureLocalDataDirs } from './paths.js';
import type { LocalCoreOptions } from './types.js';

export type LocalDatabase = Database.Database;

export type LocalStore = {
  db: LocalDatabase;
  dataDir: string;
  databasePath: string;
  configPath: string;
  logsDir: string;
  close: () => void;
};

export const LOCAL_SCHEMA_VERSION = 10;

export function openLocalStore(options: LocalCoreOptions = {}): LocalStore {
  const paths = ensureLocalDataDirs(options);
  ensureLocalConfig(paths.configPath);
  const db = new Database(paths.databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initLocalDatabase(db);

  return {
    db,
    dataDir: paths.dataDir,
    databasePath: paths.databasePath,
    configPath: paths.configPath,
    logsDir: paths.logsDir,
    close: () => db.close(),
  };
}

function ensureMigrationsTable(db: LocalDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_schema_migrations (
      version integer PRIMARY KEY,
      applied_at text NOT NULL
    );
  `);
}

function hasMigration(db: LocalDatabase, version: number): boolean {
  const row = db.prepare('SELECT version FROM local_schema_migrations WHERE version = ?').get(version) as { version: number } | undefined;
  return Boolean(row);
}

function applyMigration(db: LocalDatabase, version: number, up: () => void): void {
  if (hasMigration(db, version)) return;

  db.transaction(() => {
    up();
    db.prepare(`
      INSERT OR IGNORE INTO local_schema_migrations (version, applied_at)
      VALUES (?, ?)
    `).run(version, nowIso());
    db.pragma(`user_version = ${version}`);
  })();
}

function hasColumn(db: LocalDatabase, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function hasTable(db: LocalDatabase, table: string): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(table) as { name: string } | undefined;
  return Boolean(row);
}

export function initLocalDatabase(db: LocalDatabase): void {
  ensureMigrationsTable(db);
  applyMigration(db, 1, () => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS github_identity (
      github_user_id integer PRIMARY KEY,
      login text NOT NULL,
      avatar_url text,
      verified_emails_json text NOT NULL DEFAULT '[]',
      token_ref text,
      connected_at text NOT NULL,
      updated_at text NOT NULL
    );

	    CREATE TABLE IF NOT EXISTS local_repos (
	      id text PRIMARY KEY,
      local_root text NOT NULL,
      local_root_hash text NOT NULL,
      git_remote_url text,
      github_repo_id integer,
      full_name text,
      default_branch text,
      prod_branch text,
      branches_json text NOT NULL DEFAULT '[]',
      worktree_count integer NOT NULL DEFAULT 0,
      selected integer NOT NULL DEFAULT 0,
      matched integer NOT NULL DEFAULT 0,
      last_remote_sync_at text,
      remote_sync_error text,
      created_at text NOT NULL,
	      updated_at text NOT NULL
	    );

	    CREATE TABLE IF NOT EXISTS local_repo_roots (
	      repo_id text NOT NULL,
	      local_root text NOT NULL,
	      local_root_hash text NOT NULL,
	      kind text NOT NULL DEFAULT 'root',
	      created_at text NOT NULL,
	      updated_at text NOT NULL,
	      PRIMARY KEY (repo_id, local_root),
	      UNIQUE (local_root_hash)
	    );

	    CREATE INDEX IF NOT EXISTS idx_local_repo_roots_repo ON local_repo_roots (repo_id);

    CREATE TABLE IF NOT EXISTS source_files (
      source text NOT NULL,
      path_hash text NOT NULL,
      local_path text NOT NULL,
      source_file_hash text NOT NULL,
      source_file_size integer NOT NULL DEFAULT 0,
      line_count integer NOT NULL DEFAULT 0,
      parsed_event_count integer NOT NULL DEFAULT 0,
      ignored_line_count integer NOT NULL DEFAULT 0,
      warning_count integer NOT NULL DEFAULT 0,
      parser_version text NOT NULL,
      metadata_json text NOT NULL DEFAULT '{}',
      first_seen_at text NOT NULL,
      last_seen_at text NOT NULL,
      PRIMARY KEY (source, path_hash)
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      event_id text PRIMARY KEY,
      source text NOT NULL,
      provider text NOT NULL,
      event_kind text NOT NULL,
      session_id text NOT NULL,
      source_event_id text,
      event_at text NOT NULL,
      model text NOT NULL DEFAULT 'unknown',
      model_source text NOT NULL,
      input_tokens integer NOT NULL DEFAULT 0,
      output_tokens integer NOT NULL DEFAULT 0,
      cache_read_tokens integer NOT NULL DEFAULT 0,
      cache_create_tokens integer NOT NULL DEFAULT 0,
      cached_tokens integer NOT NULL DEFAULT 0,
      reasoning_tokens integer NOT NULL DEFAULT 0,
      total_tokens integer NOT NULL DEFAULT 0,
      source_file_hash text NOT NULL,
      source_file_size integer,
      line_number integer,
      parser_version text NOT NULL,
      metadata_json text NOT NULL DEFAULT '{}',
      created_at text NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_usage_events_event_at ON usage_events (event_at);
    CREATE INDEX IF NOT EXISTS idx_usage_events_model_event_at ON usage_events (model, event_at);
    CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events (source, session_id);

    CREATE TABLE IF NOT EXISTS ai_threads (
      source text NOT NULL,
      session_id text NOT NULL,
      repo_id text,
      first_event_at text,
      last_event_at text,
      total_tokens integer NOT NULL DEFAULT 0,
      metadata_json text NOT NULL DEFAULT '{}',
      updated_at text NOT NULL,
      PRIMARY KEY (source, session_id)
    );

    CREATE TABLE IF NOT EXISTS ai_tool_events (
      event_id text PRIMARY KEY,
      source text NOT NULL,
      provider text NOT NULL DEFAULT 'unknown',
      session_id text NOT NULL,
      event_at text NOT NULL,
      model text NOT NULL DEFAULT 'unknown',
      model_source text NOT NULL DEFAULT 'unknown',
      tool_name text,
      command_kind text NOT NULL DEFAULT 'unknown_command',
      repo_id text,
      commit_sha text,
      confidence real NOT NULL DEFAULT 0,
      evidence_origin text NOT NULL DEFAULT 'unknown',
      metadata_json text NOT NULL DEFAULT '{}',
      created_at text NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ai_tool_events_session ON ai_tool_events (source, session_id);
    CREATE INDEX IF NOT EXISTS idx_ai_tool_events_commit ON ai_tool_events (commit_sha);

	    CREATE TABLE IF NOT EXISTS local_commits (
	      repo_id text NOT NULL,
	      sha text NOT NULL,
	      committed_at text NOT NULL,
	      author_email text,
	      branch text,
	      nondoc_additions integer NOT NULL DEFAULT 0,
	      nondoc_additions_score integer NOT NULL DEFAULT 0,
	      prod_nondoc_additions integer NOT NULL DEFAULT 0,
	      prod_nondoc_additions_score integer NOT NULL DEFAULT 0,
	      reachable_from_prod integer NOT NULL DEFAULT 0,
	      updated_at text NOT NULL,
	      PRIMARY KEY (repo_id, sha)
	    );

    CREATE INDEX IF NOT EXISTS idx_local_commits_repo_date ON local_commits (repo_id, committed_at);

    CREATE TABLE IF NOT EXISTS ai_commit_links (
      source text NOT NULL,
      session_id text NOT NULL,
      repo_id text NOT NULL,
      commit_sha text NOT NULL,
      confidence real NOT NULL DEFAULT 0,
      provider text NOT NULL DEFAULT 'unknown',
      model text NOT NULL DEFAULT 'unknown',
      linked_tokens integer NOT NULL DEFAULT 0,
      linked_cost_usd real NOT NULL DEFAULT 0,
      allocation_status text NOT NULL DEFAULT 'matched',
      link_reason text NOT NULL,
      created_at text NOT NULL,
      PRIMARY KEY (source, session_id, repo_id, commit_sha)
    );

    CREATE INDEX IF NOT EXISTS idx_ai_commit_links_commit ON ai_commit_links (repo_id, commit_sha);

    CREATE TABLE IF NOT EXISTS usage_session_rollups (
      source text NOT NULL,
      provider text NOT NULL,
      session_id text NOT NULL,
      model text NOT NULL DEFAULT 'unknown',
      first_event_at text NOT NULL,
      last_event_at text NOT NULL,
      input_tokens integer NOT NULL DEFAULT 0,
      output_tokens integer NOT NULL DEFAULT 0,
      cache_read_tokens integer NOT NULL DEFAULT 0,
      cache_create_tokens integer NOT NULL DEFAULT 0,
      cached_tokens integer NOT NULL DEFAULT 0,
      reasoning_tokens integer NOT NULL DEFAULT 0,
      total_tokens integer NOT NULL DEFAULT 0,
      turns integer NOT NULL DEFAULT 0,
      cost_usd_total real NOT NULL DEFAULT 0,
      source_file_hashes_json text NOT NULL DEFAULT '[]',
      ccusage_version text,
      updated_at text NOT NULL,
      PRIMARY KEY (source, session_id)
    );

    CREATE TABLE IF NOT EXISTS usage_session_model_rollups (
      source text NOT NULL,
      provider text NOT NULL,
      session_id text NOT NULL,
      model text NOT NULL DEFAULT 'unknown',
      first_event_at text NOT NULL,
      last_event_at text NOT NULL,
      input_tokens integer NOT NULL DEFAULT 0,
      output_tokens integer NOT NULL DEFAULT 0,
      cache_read_tokens integer NOT NULL DEFAULT 0,
      cache_create_tokens integer NOT NULL DEFAULT 0,
      cached_tokens integer NOT NULL DEFAULT 0,
      reasoning_tokens integer NOT NULL DEFAULT 0,
      total_tokens integer NOT NULL DEFAULT 0,
      turns integer NOT NULL DEFAULT 0,
      cost_usd_total real NOT NULL DEFAULT 0,
      ccusage_version text,
      updated_at text NOT NULL,
      PRIMARY KEY (source, session_id, model)
    );

    CREATE TABLE IF NOT EXISTS usage_daily_aggregates (
      date text NOT NULL,
      source text NOT NULL,
      provider text NOT NULL,
      model text NOT NULL DEFAULT 'unknown',
      total_tokens integer NOT NULL DEFAULT 0,
      input_tokens integer NOT NULL DEFAULT 0,
      output_tokens integer NOT NULL DEFAULT 0,
      cache_read_tokens integer NOT NULL DEFAULT 0,
      cache_create_tokens integer NOT NULL DEFAULT 0,
      cached_tokens integer NOT NULL DEFAULT 0,
      reasoning_tokens integer NOT NULL DEFAULT 0,
      total_sessions integer NOT NULL DEFAULT 0,
      event_count integer NOT NULL DEFAULT 0,
      cost_usd_total real NOT NULL DEFAULT 0,
      updated_at text NOT NULL,
      PRIMARY KEY (date, source, model)
    );

    CREATE TABLE IF NOT EXISTS model_pricing (
      provider text NOT NULL,
      model_id text NOT NULL,
      name text,
      family text,
      input_per_mtok real,
      output_per_mtok real,
      cache_read_per_mtok real,
      cache_write_per_mtok real,
      source_last_updated text,
      content_hash text NOT NULL,
      fetched_at text NOT NULL,
      PRIMARY KEY (provider, model_id)
    );

    CREATE INDEX IF NOT EXISTS idx_model_pricing_model ON model_pricing (model_id);

    CREATE TABLE IF NOT EXISTS profile_summary_local (
      window text PRIMARY KEY,
      score real NOT NULL DEFAULT 0,
      tokens_total integer NOT NULL DEFAULT 0,
      cost_usd_total real NOT NULL DEFAULT 0,
      github_shipped_loc_total integer NOT NULL DEFAULT 0,
      ai_linked_loc_total integer NOT NULL DEFAULT 0,
      sessions_count integer NOT NULL DEFAULT 0,
      days_active integer NOT NULL DEFAULT 0,
      metrics_json text NOT NULL DEFAULT '{}',
      computed_at text NOT NULL
    );

	    CREATE TABLE IF NOT EXISTS code_daily_rollups (
	      date text PRIMARY KEY,
	      produced_loc integer NOT NULL DEFAULT 0,
	      produced_loc_score integer NOT NULL DEFAULT 0,
	      shipped_loc integer NOT NULL DEFAULT 0,
	      shipped_loc_score integer NOT NULL DEFAULT 0,
	      ai_linked_commit_count integer NOT NULL DEFAULT 0,
	      high_confidence_commit_count integer NOT NULL DEFAULT 0,
	      median_link_confidence real NOT NULL DEFAULT 0,
	      updated_at text NOT NULL
    );

	    CREATE TABLE IF NOT EXISTS github_code_daily (
	      date text NOT NULL,
	      repo_id integer NOT NULL,
	      full_name text NOT NULL,
	      prod_branch text NOT NULL,
	      github_shipped_loc integer NOT NULL DEFAULT 0,
	      github_shipped_loc_score integer NOT NULL DEFAULT 0,
	      github_commit_count integer NOT NULL DEFAULT 0,
	      verified_at text NOT NULL,
	      verification_source text NOT NULL DEFAULT 'github_remote_prod',
	      updated_at text NOT NULL,
      PRIMARY KEY (date, repo_id)
    );

    CREATE INDEX IF NOT EXISTS idx_github_code_daily_date ON github_code_daily (date);
    CREATE INDEX IF NOT EXISTS idx_github_code_daily_repo ON github_code_daily (repo_id);

	    CREATE TABLE IF NOT EXISTS ai_linked_code_daily (
	      date text NOT NULL,
	      repo_id integer NOT NULL,
	      full_name text NOT NULL,
	      linked_shipped_loc integer NOT NULL DEFAULT 0,
	      linked_shipped_loc_score integer NOT NULL DEFAULT 0,
      linked_commit_count integer NOT NULL DEFAULT 0,
      linked_tokens integer NOT NULL DEFAULT 0,
      linked_cost_usd real NOT NULL DEFAULT 0,
      high_confidence_commit_count integer NOT NULL DEFAULT 0,
      median_link_confidence real NOT NULL DEFAULT 0,
      updated_at text NOT NULL,
      PRIMARY KEY (date, repo_id)
    );

    CREATE INDEX IF NOT EXISTS idx_ai_linked_code_daily_date ON ai_linked_code_daily (date);
    CREATE INDEX IF NOT EXISTS idx_ai_linked_code_daily_repo ON ai_linked_code_daily (repo_id);

    CREATE TABLE IF NOT EXISTS ai_code_model_daily (
      date text NOT NULL,
      source text NOT NULL,
      provider text NOT NULL,
      model text NOT NULL DEFAULT 'unknown',
      produced_loc integer NOT NULL DEFAULT 0,
      produced_loc_score integer NOT NULL DEFAULT 0,
      shipped_loc integer NOT NULL DEFAULT 0,
      shipped_loc_score integer NOT NULL DEFAULT 0,
      linked_commit_count integer NOT NULL DEFAULT 0,
      linked_tokens integer NOT NULL DEFAULT 0,
      linked_cost_usd real NOT NULL DEFAULT 0,
      updated_at text NOT NULL,
      PRIMARY KEY (date, source, model)
    );

    CREATE TABLE IF NOT EXISTS publish_runs (
      run_id text PRIMARY KEY,
      status text NOT NULL,
      started_at text NOT NULL,
      finished_at text,
      usage_day_count integer NOT NULL DEFAULT 0,
      session_count integer NOT NULL DEFAULT 0,
      code_day_count integer NOT NULL DEFAULT 0,
      error text
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key text PRIMARY KEY,
      value_json text NOT NULL,
      updated_at text NOT NULL
    );
  `);
  });

  applyMigration(db, 2, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ingestion_runs (
        run_id text PRIMARY KEY,
        status text NOT NULL,
        started_at text NOT NULL,
        finished_at text,
        usage_day_count integer NOT NULL DEFAULT 0,
        session_count integer NOT NULL DEFAULT 0,
        code_day_count integer NOT NULL DEFAULT 0,
        error text
      );

      INSERT OR IGNORE INTO ingestion_runs (
        run_id,
        status,
        started_at,
        finished_at,
        usage_day_count,
        session_count,
        code_day_count,
        error
      )
      SELECT
        run_id,
        status,
        started_at,
        finished_at,
        usage_day_count,
        session_count,
        code_day_count,
        error
      FROM publish_runs;
    `);
  });

  applyMigration(db, 3, () => {
    if (hasTable(db, 'local_repos') && !hasColumn(db, 'local_repos', 'remote_sync_error')) {
      db.exec('ALTER TABLE local_repos ADD COLUMN remote_sync_error text');
    }
  });

	  applyMigration(db, 4, () => {
    if (hasTable(db, 'local_repos') && !hasColumn(db, 'local_repos', 'branches_json')) {
      db.exec("ALTER TABLE local_repos ADD COLUMN branches_json text NOT NULL DEFAULT '[]'");
    }
    if (hasTable(db, 'local_repos') && !hasColumn(db, 'local_repos', 'worktree_count')) {
      db.exec('ALTER TABLE local_repos ADD COLUMN worktree_count integer NOT NULL DEFAULT 0');
    }
	  });

	  applyMigration(db, 5, () => {
	    db.exec(`
	      CREATE TABLE IF NOT EXISTS local_repo_roots (
	        repo_id text NOT NULL,
	        local_root text NOT NULL,
	        local_root_hash text NOT NULL,
	        kind text NOT NULL DEFAULT 'root',
	        created_at text NOT NULL,
	        updated_at text NOT NULL,
	        PRIMARY KEY (repo_id, local_root),
	        UNIQUE (local_root_hash)
	      );

	      CREATE INDEX IF NOT EXISTS idx_local_repo_roots_repo ON local_repo_roots (repo_id);
	    `);

	    if (hasTable(db, 'local_commits') && !hasColumn(db, 'local_commits', 'nondoc_additions_score')) {
	      db.exec('ALTER TABLE local_commits ADD COLUMN nondoc_additions_score integer NOT NULL DEFAULT 0');
	      db.exec('UPDATE local_commits SET nondoc_additions_score = nondoc_additions WHERE nondoc_additions_score = 0 AND nondoc_additions > 0');
	    }
	    if (hasTable(db, 'local_commits') && !hasColumn(db, 'local_commits', 'prod_nondoc_additions')) {
	      db.exec('ALTER TABLE local_commits ADD COLUMN prod_nondoc_additions integer NOT NULL DEFAULT 0');
	      db.exec('UPDATE local_commits SET prod_nondoc_additions = nondoc_additions WHERE reachable_from_prod = 1 AND prod_nondoc_additions = 0');
	    }
	    if (hasTable(db, 'local_commits') && !hasColumn(db, 'local_commits', 'prod_nondoc_additions_score')) {
	      db.exec('ALTER TABLE local_commits ADD COLUMN prod_nondoc_additions_score integer NOT NULL DEFAULT 0');
	      db.exec('UPDATE local_commits SET prod_nondoc_additions_score = nondoc_additions_score WHERE reachable_from_prod = 1 AND prod_nondoc_additions_score = 0');
	    }

	    if (hasTable(db, 'code_daily_rollups') && !hasColumn(db, 'code_daily_rollups', 'produced_loc_score')) {
	      db.exec('ALTER TABLE code_daily_rollups ADD COLUMN produced_loc_score integer NOT NULL DEFAULT 0');
	      db.exec('UPDATE code_daily_rollups SET produced_loc_score = produced_loc WHERE produced_loc_score = 0 AND produced_loc > 0');
	    }
	    if (hasTable(db, 'code_daily_rollups') && !hasColumn(db, 'code_daily_rollups', 'shipped_loc_score')) {
	      db.exec('ALTER TABLE code_daily_rollups ADD COLUMN shipped_loc_score integer NOT NULL DEFAULT 0');
	      db.exec('UPDATE code_daily_rollups SET shipped_loc_score = shipped_loc WHERE shipped_loc_score = 0 AND shipped_loc > 0');
	    }

	    if (hasTable(db, 'github_code_daily') && !hasColumn(db, 'github_code_daily', 'github_shipped_loc_score')) {
	      db.exec('ALTER TABLE github_code_daily ADD COLUMN github_shipped_loc_score integer NOT NULL DEFAULT 0');
	      db.exec('UPDATE github_code_daily SET github_shipped_loc_score = github_shipped_loc WHERE github_shipped_loc_score = 0 AND github_shipped_loc > 0');
	    }
	    if (hasTable(db, 'ai_linked_code_daily') && !hasColumn(db, 'ai_linked_code_daily', 'linked_shipped_loc_score')) {
	      db.exec('ALTER TABLE ai_linked_code_daily ADD COLUMN linked_shipped_loc_score integer NOT NULL DEFAULT 0');
	      db.exec('UPDATE ai_linked_code_daily SET linked_shipped_loc_score = linked_shipped_loc WHERE linked_shipped_loc_score = 0 AND linked_shipped_loc > 0');
	    }

	    if (hasTable(db, 'local_repos')) {
	      db.exec(`
	        INSERT OR IGNORE INTO local_repo_roots (
	          repo_id, local_root, local_root_hash, kind, created_at, updated_at
	        )
	        SELECT id, local_root, local_root_hash, 'root', created_at, updated_at
	        FROM local_repos;
	      `);
	    }
	  });

  applyMigration(db, 6, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS operation_runs (
        operation_id text PRIMARY KEY,
        type text NOT NULL,
        label text NOT NULL,
        status text NOT NULL,
        stage text NOT NULL DEFAULT 'queued',
        progress_percent real,
        current integer,
        total integer,
        message text,
        result_json text NOT NULL DEFAULT '{}',
        error text,
        started_at text NOT NULL,
        updated_at text NOT NULL,
        finished_at text
      );

      CREATE INDEX IF NOT EXISTS idx_operation_runs_status ON operation_runs (status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_operation_runs_type_updated ON operation_runs (type, updated_at);
    `);
  });

  applyMigration(db, 7, () => {
    if (hasTable(db, 'ai_tool_events')) {
      if (!hasColumn(db, 'ai_tool_events', 'provider')) {
        db.exec("ALTER TABLE ai_tool_events ADD COLUMN provider text NOT NULL DEFAULT 'unknown'");
      }
      if (!hasColumn(db, 'ai_tool_events', 'model')) {
        db.exec("ALTER TABLE ai_tool_events ADD COLUMN model text NOT NULL DEFAULT 'unknown'");
      }
      if (!hasColumn(db, 'ai_tool_events', 'model_source')) {
        db.exec("ALTER TABLE ai_tool_events ADD COLUMN model_source text NOT NULL DEFAULT 'unknown'");
      }
      if (!hasColumn(db, 'ai_tool_events', 'command_kind')) {
        db.exec("ALTER TABLE ai_tool_events ADD COLUMN command_kind text NOT NULL DEFAULT 'unknown_command'");
      }
      if (!hasColumn(db, 'ai_tool_events', 'evidence_origin')) {
        db.exec("ALTER TABLE ai_tool_events ADD COLUMN evidence_origin text NOT NULL DEFAULT 'unknown'");
      }
    }

    if (hasTable(db, 'usage_session_rollups') && !hasColumn(db, 'usage_session_rollups', 'ccusage_version')) {
      db.exec('ALTER TABLE usage_session_rollups ADD COLUMN ccusage_version text');
    }

    if (hasTable(db, 'ai_commit_links')) {
      if (!hasColumn(db, 'ai_commit_links', 'provider')) {
        db.exec("ALTER TABLE ai_commit_links ADD COLUMN provider text NOT NULL DEFAULT 'unknown'");
      }
      if (!hasColumn(db, 'ai_commit_links', 'model')) {
        db.exec("ALTER TABLE ai_commit_links ADD COLUMN model text NOT NULL DEFAULT 'unknown'");
      }
      if (!hasColumn(db, 'ai_commit_links', 'linked_cost_usd')) {
        db.exec('ALTER TABLE ai_commit_links ADD COLUMN linked_cost_usd real NOT NULL DEFAULT 0');
      }
      if (!hasColumn(db, 'ai_commit_links', 'allocation_status')) {
        db.exec("ALTER TABLE ai_commit_links ADD COLUMN allocation_status text NOT NULL DEFAULT 'matched'");
      }
    }

    if (hasTable(db, 'ai_linked_code_daily') && !hasColumn(db, 'ai_linked_code_daily', 'linked_cost_usd')) {
      db.exec('ALTER TABLE ai_linked_code_daily ADD COLUMN linked_cost_usd real NOT NULL DEFAULT 0');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_session_model_rollups (
        source text NOT NULL,
        provider text NOT NULL,
        session_id text NOT NULL,
        model text NOT NULL DEFAULT 'unknown',
        first_event_at text NOT NULL,
        last_event_at text NOT NULL,
        input_tokens integer NOT NULL DEFAULT 0,
        output_tokens integer NOT NULL DEFAULT 0,
        cache_read_tokens integer NOT NULL DEFAULT 0,
        cache_create_tokens integer NOT NULL DEFAULT 0,
        cached_tokens integer NOT NULL DEFAULT 0,
        reasoning_tokens integer NOT NULL DEFAULT 0,
        total_tokens integer NOT NULL DEFAULT 0,
        turns integer NOT NULL DEFAULT 0,
        cost_usd_total real NOT NULL DEFAULT 0,
        ccusage_version text,
        updated_at text NOT NULL,
        PRIMARY KEY (source, session_id, model)
      );

      CREATE TABLE IF NOT EXISTS ai_code_model_daily (
        date text NOT NULL,
        source text NOT NULL,
        provider text NOT NULL,
        model text NOT NULL DEFAULT 'unknown',
        produced_loc integer NOT NULL DEFAULT 0,
        produced_loc_score integer NOT NULL DEFAULT 0,
        shipped_loc integer NOT NULL DEFAULT 0,
        shipped_loc_score integer NOT NULL DEFAULT 0,
        linked_commit_count integer NOT NULL DEFAULT 0,
        linked_tokens integer NOT NULL DEFAULT 0,
        linked_cost_usd real NOT NULL DEFAULT 0,
        updated_at text NOT NULL,
        PRIMARY KEY (date, source, model)
      );
    `);
  });
  applyMigration(db, 8, () => {
    if (!hasTable(db, 'ai_tool_events')) return;
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ai_tool_events_source_path
      ON ai_tool_events (json_extract(metadata_json, '$.source_path_hash'))
      WHERE json_valid(metadata_json);
    `);
  });
  applyMigration(db, 9, () => {
    if (hasTable(db, 'local_commits')) db.exec('ALTER TABLE local_commits ADD COLUMN remote_metrics_version integer NOT NULL DEFAULT 1');
    // Keep old totals visible until a successful remote refresh replaces them.
    if (hasTable(db, 'local_repos')) db.exec('UPDATE local_repos SET last_remote_sync_at = NULL WHERE last_remote_sync_at IS NOT NULL');
  });
  applyMigration(db, 10, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS usage_source_evidence (
      source text PRIMARY KEY,
      daily_basis text NOT NULL CHECK(daily_basis IN ('event_dates','session_dates')),
      read_at text NOT NULL
    )`);
  });

	}

export function nowIso(): string {
  return new Date().toISOString();
}

export function readJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function writeSyncState(db: LocalDatabase, key: string, value: unknown): void {
  db.prepare(`
    INSERT INTO sync_state (key, value_json, updated_at)
    VALUES (@key, @value_json, @updated_at)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run({
    key,
    value_json: JSON.stringify(value),
    updated_at: nowIso(),
  });
}

export function deleteSyncState(db: LocalDatabase, key: string): void {
  db.prepare('DELETE FROM sync_state WHERE key = ?').run(key);
}

export function readSyncState<T>(db: LocalDatabase, key: string, fallback: T): T {
  const row = db.prepare('SELECT value_json FROM sync_state WHERE key = ?').get(key) as { value_json?: string } | undefined;
  return readJson(row?.value_json, fallback);
}

export function markInterruptedIngestionRuns(db: LocalDatabase): number {
  const result = db.prepare(`
    UPDATE ingestion_runs
    SET status = 'interrupted',
      finished_at = COALESCE(finished_at, ?),
      error = COALESCE(error, 'Local API stopped before this ingestion run finished.')
    WHERE status = 'running'
  `).run(nowIso());
  return result.changes;
}
