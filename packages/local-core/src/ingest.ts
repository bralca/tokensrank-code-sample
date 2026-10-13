import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';

import type { LocalDatabase } from './db.js';
import { nowIso } from './db.js';
import { readCcusageUsage, writeCcusageRollups, type CcusageRunner } from './ccusage.js';
import { costForSession } from './cost.js';
import { syncLocalGitCommitEvidence } from './github.js';
import { sha256Hex } from './hash.js';
import { loadPricingMap } from './pricing.js';
import { LOCAL_PARSER_VERSION, parseUsageFile, sha256File } from './parser.js';
import { rebuildLocalProfileSummary } from './scoring.js';
import { recoverSessionTimes } from './usage-evidence.js';
import type { IngestRunResult, NormalizedToolEvent, NormalizedUsageEvent, ParsedUsageFile } from './types.js';

type UsageEventRow = NormalizedUsageEvent & {
  total_tokens: number;
};

type LocalRepoPathRow = {
  id: string;
  local_root: string;
};

export type IngestUsageProgress = {
  stage: 'reading_files' | 'rebuilding_rollups' | 'usage_ready' | 'linking_commits' | 'completed';
  files_total: number;
  files_scanned: number;
  files_parsed: number;
  events_seen: number;
  events_inserted: number;
  warnings: number;
};

function dateOnly(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : date.toISOString().slice(0, 10);
}

function totalTokens(event: NormalizedUsageEvent): number {
  return event.input_tokens
    + event.output_tokens
    + event.cache_read_tokens
    + event.cache_create_tokens;
}

function insertSourceFile(db: LocalDatabase, parsed: ParsedUsageFile): void {
  const file = parsed.file;
  const now = nowIso();
  db.prepare(`
    INSERT INTO source_files (
      source, path_hash, local_path, source_file_hash, source_file_size,
      line_count, parsed_event_count, ignored_line_count, warning_count,
      parser_version, metadata_json, first_seen_at, last_seen_at
    )
    VALUES (
      @source, @path_hash, @local_path, @source_file_hash, @source_file_size,
      @line_count, @parsed_event_count, @ignored_line_count, @warning_count,
      @parser_version, @metadata_json, @first_seen_at, @last_seen_at
    )
    ON CONFLICT(source, path_hash) DO UPDATE SET
      local_path = excluded.local_path,
      source_file_hash = excluded.source_file_hash,
      source_file_size = excluded.source_file_size,
      line_count = excluded.line_count,
      parsed_event_count = excluded.parsed_event_count,
      ignored_line_count = excluded.ignored_line_count,
      warning_count = excluded.warning_count,
      parser_version = excluded.parser_version,
      metadata_json = excluded.metadata_json,
      last_seen_at = excluded.last_seen_at
  `).run({
    source: file.source,
    path_hash: file.path_hash,
    local_path: file.path,
    source_file_hash: file.source_file_hash,
    source_file_size: file.source_file_size,
    line_count: file.line_count,
    parsed_event_count: file.parsed_event_count,
    ignored_line_count: file.ignored_line_count,
    warning_count: file.warning_count,
    parser_version: file.parser_version,
    metadata_json: JSON.stringify(file.metadata ?? {}),
    first_seen_at: now,
    last_seen_at: now,
  });
}

function insertEvents(db: LocalDatabase, events: NormalizedUsageEvent[]): number {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO usage_events (
      event_id, source, provider, event_kind, session_id, source_event_id,
      event_at, model, model_source, input_tokens, output_tokens, cache_read_tokens,
      cache_create_tokens, cached_tokens, reasoning_tokens, total_tokens,
      source_file_hash, source_file_size, line_number, parser_version,
      metadata_json, created_at
    )
    VALUES (
      @event_id, @source, @provider, @event_kind, @session_id, @source_event_id,
      @event_at, @model, @model_source, @input_tokens, @output_tokens, @cache_read_tokens,
      @cache_create_tokens, @cached_tokens, @reasoning_tokens, @total_tokens,
      @source_file_hash, @source_file_size, @line_number, @parser_version,
      @metadata_json, @created_at
    )
  `);
  const now = nowIso();
  let inserted = 0;

  const run = db.transaction((nextEvents: NormalizedUsageEvent[]) => {
    for (const event of nextEvents) {
      const result = stmt.run({
        ...event,
        source_event_id: event.source_event_id ?? null,
        source_file_size: event.source_file_size ?? null,
        line_number: event.line_number ?? null,
        total_tokens: totalTokens(event),
        metadata_json: JSON.stringify(event.metadata ?? {}),
        created_at: now,
      });
      inserted += result.changes;
    }
  });

  run(events);
  return inserted;
}

function loadRepoPathRows(db: LocalDatabase): LocalRepoPathRow[] {
  return db.prepare(`
    SELECT id, local_root
    FROM (
      SELECT repo_id AS id, local_root
      FROM local_repo_roots
      UNION
      SELECT id, local_root
      FROM local_repos
    )
    ORDER BY LENGTH(local_root) DESC
  `).all() as LocalRepoPathRow[];
}

function normalizeFsPath(value: string): string {
  const normalized = value.replace(/\\/gu, '/').replace(/\/+$/u, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function repoIdForCwd(cwd: string | undefined, repos: LocalRepoPathRow[]): string | null {
  if (!cwd) return null;
  const normalizedCwd = normalizeFsPath(cwd);
  for (const repo of repos) {
    const root = normalizeFsPath(repo.local_root);
    if (normalizedCwd === root || normalizedCwd.startsWith(`${root}/`)) {
      return repo.id;
    }
  }
  return null;
}

function deleteToolEventsForSourceFiles(db: LocalDatabase, filePaths: string[]): void {
  const pathHashes = Array.from(new Set(filePaths.map((filePath) => sha256Hex(filePath))));
  const chunkSize = 400;
  for (let index = 0; index < pathHashes.length; index += chunkSize) {
    const chunk = pathHashes.slice(index, index + chunkSize);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(',');
    db.prepare(`
      DELETE FROM ai_tool_events
      WHERE json_valid(metadata_json)
        AND json_extract(metadata_json, '$.source_path_hash') IN (${placeholders})
    `).run(...chunk);
  }
}

function insertToolEvents(db: LocalDatabase, toolEvents: NormalizedToolEvent[]): number {
  if (toolEvents.length === 0) return 0;
  const repos = loadRepoPathRows(db);
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO ai_tool_events (
      event_id, source, provider, session_id, event_at, model, model_source,
      tool_name, command_kind, repo_id, commit_sha, confidence,
      evidence_origin, metadata_json, created_at
    )
    VALUES (
      @event_id, @source, @provider, @session_id, @event_at, @model, @model_source,
      @tool_name, @command_kind, @repo_id, @commit_sha, @confidence,
      @evidence_origin, @metadata_json, @created_at
    )
  `);
  const now = nowIso();
  let inserted = 0;

  const run = db.transaction((nextEvents: NormalizedToolEvent[]) => {
    for (const event of nextEvents) {
      const result = stmt.run({
        event_id: event.event_id,
        source: event.source,
        provider: event.provider ?? 'unknown',
        session_id: event.session_id,
        event_at: event.event_at,
        model: event.model ?? 'unknown',
        model_source: event.model_source ?? 'unknown',
        tool_name: event.tool_name ?? null,
        command_kind: event.command_kind ?? 'unknown_command',
        repo_id: repoIdForCwd(event.cwd, repos),
        commit_sha: event.commit_sha ?? null,
        confidence: event.confidence,
        evidence_origin: event.evidence_origin ?? 'unknown',
        metadata_json: JSON.stringify(event.metadata ?? {}),
        created_at: now,
      });
      inserted += result.changes;
    }
  });

  run(toolEvents);
  return inserted;
}

function loadAllUsageEvents(db: LocalDatabase): UsageEventRow[] {
  return db.prepare(`
    SELECT event_id, source, provider, event_kind, session_id, source_event_id,
      event_at, model, model_source, input_tokens, output_tokens, cache_read_tokens,
      cache_create_tokens, cached_tokens, reasoning_tokens, total_tokens,
      source_file_hash, source_file_size, line_number, parser_version, metadata_json
    FROM usage_events
    ORDER BY event_at ASC, line_number ASC
  `).all().map((row) => {
    const event = row as Omit<UsageEventRow, 'metadata'> & { metadata_json: string };
    return {
      event_id: event.event_id,
      source: event.source,
      provider: event.provider,
      event_kind: event.event_kind,
      session_id: event.session_id,
      source_event_id: event.source_event_id ?? undefined,
      event_at: event.event_at,
      model: event.model,
      model_source: event.model_source,
      input_tokens: event.input_tokens,
      output_tokens: event.output_tokens,
      cache_read_tokens: event.cache_read_tokens,
      cache_create_tokens: event.cache_create_tokens,
      cached_tokens: event.cached_tokens,
      reasoning_tokens: event.reasoning_tokens,
      total_tokens: event.total_tokens,
      source_file_hash: event.source_file_hash,
      source_file_size: event.source_file_size ?? undefined,
      line_number: event.line_number ?? undefined,
      parser_version: event.parser_version,
      metadata: {},
    } satisfies UsageEventRow;
  });
}

export function rebuildAiThreads(db: LocalDatabase): void {
  const now = nowIso();
  db.transaction(() => {
    db.prepare('DELETE FROM ai_threads').run();
    db.prepare(`
      INSERT INTO ai_threads (
        source, session_id, repo_id, first_event_at, last_event_at,
        total_tokens, metadata_json, updated_at
      )
      SELECT
        session_rows.source,
        session_rows.session_id,
        (
          SELECT repo_id
          FROM ai_tool_events tool_rows
          WHERE tool_rows.source = session_rows.source
            AND tool_rows.session_id = session_rows.session_id
            AND tool_rows.repo_id IS NOT NULL
          GROUP BY repo_id
          ORDER BY COUNT(*) DESC
          LIMIT 1
        ) AS repo_id,
        MIN(session_rows.first_event_at) AS first_event_at,
        MAX(session_rows.last_event_at) AS last_event_at,
        SUM(session_rows.total_tokens) AS total_tokens,
        json_object(
          'token_event_count', SUM(session_rows.turns),
          'tool_event_count', COALESCE((
            SELECT COUNT(*)
            FROM ai_tool_events tool_rows
            WHERE tool_rows.source = session_rows.source
              AND tool_rows.session_id = session_rows.session_id
          ), 0)
        ) AS metadata_json,
        ? AS updated_at
      FROM usage_session_rollups session_rows
      GROUP BY session_rows.source, session_rows.session_id
    `).run(now);

    db.prepare(`
      INSERT INTO ai_threads (
        source, session_id, repo_id, first_event_at, last_event_at,
        total_tokens, metadata_json, updated_at
      )
      SELECT
        tool_rows.source,
        tool_rows.session_id,
        (
          SELECT repo_id
          FROM ai_tool_events ranked
          WHERE ranked.source = tool_rows.source
            AND ranked.session_id = tool_rows.session_id
            AND ranked.repo_id IS NOT NULL
          GROUP BY repo_id
          ORDER BY COUNT(*) DESC
          LIMIT 1
        ) AS repo_id,
        MIN(tool_rows.event_at) AS first_event_at,
        MAX(tool_rows.event_at) AS last_event_at,
        0 AS total_tokens,
        json_object('token_event_count', 0, 'tool_event_count', COUNT(*)) AS metadata_json,
        ? AS updated_at
      FROM ai_tool_events tool_rows
      WHERE NOT EXISTS (
        SELECT 1
        FROM ai_threads threads
        WHERE threads.source = tool_rows.source
          AND threads.session_id = tool_rows.session_id
      )
      GROUP BY tool_rows.source, tool_rows.session_id
    `).run(now);
  })();
}

export function rebuildUsageRollups(db: LocalDatabase): void {
  const ccusageModelCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type = 'table' AND name = 'usage_session_model_rollups'
  `).get() as { count: number };
  if (ccusageModelCount.count > 0) {
    const now = nowIso();
    db.transaction(() => {
      db.prepare(`DELETE FROM usage_daily_aggregates WHERE source NOT IN
        (SELECT source FROM usage_source_evidence WHERE daily_basis='event_dates')`).run();
      db.prepare(`
        INSERT INTO usage_daily_aggregates (
          date, source, provider, model, total_tokens, input_tokens, output_tokens,
          cache_read_tokens, cache_create_tokens, cached_tokens, reasoning_tokens,
          total_sessions, event_count, cost_usd_total, updated_at
        )
        SELECT
          substr(last_event_at, 1, 10) AS date,
          source,
          provider,
          model,
          SUM(total_tokens) AS total_tokens,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens,
          SUM(cache_create_tokens) AS cache_create_tokens,
          SUM(cached_tokens) AS cached_tokens,
          SUM(reasoning_tokens) AS reasoning_tokens,
          COUNT(DISTINCT source || ':' || session_id) AS total_sessions,
          SUM(CASE WHEN turns > 0 THEN turns ELSE 1 END) AS event_count,
          SUM(cost_usd_total) AS cost_usd_total,
          ? AS updated_at
        FROM usage_session_model_rollups WHERE source NOT IN
          (SELECT source FROM usage_source_evidence WHERE daily_basis='event_dates')
        GROUP BY substr(last_event_at, 1, 10), source, provider, model
      `).run(now);
    })();
    rebuildAiThreads(db);
    return;
  }

  const events = loadAllUsageEvents(db);
  const pricing = loadPricingMap(db);
  const now = nowIso();

  const sessions = new Map<string, {
    source: 'claude' | 'codex' | 'opencode';
    provider: 'anthropic' | 'openai' | 'unknown';
    session_id: string;
    model: string;
    first_event_at: string;
    last_event_at: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_create_tokens: number;
    cached_tokens: number;
    reasoning_tokens: number;
    total_tokens: number;
    turns: number;
    source_file_hashes: Set<string>;
  }>();
  const daily = new Map<string, {
    date: string;
    source: 'claude' | 'codex' | 'opencode';
    provider: 'anthropic' | 'openai' | 'unknown';
    model: string;
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_create_tokens: number;
    cached_tokens: number;
    reasoning_tokens: number;
    sessions: Set<string>;
    event_count: number;
    cost_usd_total: number;
  }>();

  for (const event of events) {
    const sessionKey = `${event.source}:${event.session_id}`;
    const existing = sessions.get(sessionKey);
    if (existing) {
      existing.input_tokens += event.input_tokens;
      existing.output_tokens += event.output_tokens;
      existing.cache_read_tokens += event.cache_read_tokens;
      existing.cache_create_tokens += event.cache_create_tokens;
      existing.cached_tokens += event.cached_tokens;
      existing.reasoning_tokens += event.reasoning_tokens;
      existing.total_tokens += event.total_tokens;
      existing.turns += 1;
      existing.source_file_hashes.add(event.source_file_hash);
      if (Date.parse(event.event_at) < Date.parse(existing.first_event_at)) existing.first_event_at = event.event_at;
      if (Date.parse(event.event_at) >= Date.parse(existing.last_event_at)) {
        existing.last_event_at = event.event_at;
        existing.model = event.model;
      }
    } else {
      sessions.set(sessionKey, {
        source: event.source,
        provider: event.provider,
        session_id: event.session_id,
        model: event.model,
        first_event_at: event.event_at,
        last_event_at: event.event_at,
        input_tokens: event.input_tokens,
        output_tokens: event.output_tokens,
        cache_read_tokens: event.cache_read_tokens,
        cache_create_tokens: event.cache_create_tokens,
        cached_tokens: event.cached_tokens,
        reasoning_tokens: event.reasoning_tokens,
        total_tokens: event.total_tokens,
        turns: 1,
        source_file_hashes: new Set([event.source_file_hash]),
      });
    }

    const day = dateOnly(event.event_at);
    const dailyKey = `${day}:${event.source}:${event.model}`;
    const cost = costForSession(event, pricing).costUsd;
    const existingDaily = daily.get(dailyKey);
    if (existingDaily) {
      existingDaily.total_tokens += event.total_tokens;
      existingDaily.input_tokens += event.input_tokens;
      existingDaily.output_tokens += event.output_tokens;
      existingDaily.cache_read_tokens += event.cache_read_tokens;
      existingDaily.cache_create_tokens += event.cache_create_tokens;
      existingDaily.cached_tokens += event.cached_tokens;
      existingDaily.reasoning_tokens += event.reasoning_tokens;
      existingDaily.sessions.add(sessionKey);
      existingDaily.event_count += 1;
      existingDaily.cost_usd_total += cost;
    } else {
      daily.set(dailyKey, {
        date: day,
        source: event.source,
        provider: event.provider,
        model: event.model,
        total_tokens: event.total_tokens,
        input_tokens: event.input_tokens,
        output_tokens: event.output_tokens,
        cache_read_tokens: event.cache_read_tokens,
        cache_create_tokens: event.cache_create_tokens,
        cached_tokens: event.cached_tokens,
        reasoning_tokens: event.reasoning_tokens,
        sessions: new Set([sessionKey]),
        event_count: 1,
        cost_usd_total: cost,
      });
    }
  }

  const write = db.transaction(() => {
    db.prepare('DELETE FROM usage_session_rollups').run();
    db.prepare('DELETE FROM usage_daily_aggregates').run();

    const sessionStmt = db.prepare(`
      INSERT INTO usage_session_rollups (
        source, provider, session_id, model, first_event_at, last_event_at,
        input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
        cached_tokens, reasoning_tokens, total_tokens, turns, cost_usd_total,
        source_file_hashes_json, updated_at
      )
      VALUES (
        @source, @provider, @session_id, @model, @first_event_at, @last_event_at,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_create_tokens,
        @cached_tokens, @reasoning_tokens, @total_tokens, @turns, @cost_usd_total,
        @source_file_hashes_json, @updated_at
      )
    `);

    for (const session of sessions.values()) {
      const cost = costForSession(session, pricing).costUsd;
      sessionStmt.run({
        ...session,
        cost_usd_total: Math.round(cost * 10000) / 10000,
        source_file_hashes_json: JSON.stringify(Array.from(session.source_file_hashes).slice(0, 50)),
        updated_at: now,
      });
    }

    const dailyStmt = db.prepare(`
      INSERT INTO usage_daily_aggregates (
        date, source, provider, model, total_tokens, input_tokens, output_tokens,
        cache_read_tokens, cache_create_tokens, cached_tokens, reasoning_tokens,
        total_sessions, event_count, cost_usd_total, updated_at
      )
      VALUES (
        @date, @source, @provider, @model, @total_tokens, @input_tokens, @output_tokens,
        @cache_read_tokens, @cache_create_tokens, @cached_tokens, @reasoning_tokens,
        @total_sessions, @event_count, @cost_usd_total, @updated_at
      )
    `);

    for (const row of daily.values()) {
      dailyStmt.run({
        ...row,
        total_sessions: row.sessions.size,
        cost_usd_total: Math.round(row.cost_usd_total * 10000) / 10000,
        updated_at: now,
      });
    }
  });

  write();
  rebuildAiThreads(db);
}

export async function ingestUsageFiles(
  db: LocalDatabase,
  filePaths: string[],
  options: {
    runId?: string;
    ccusageRunner?: CcusageRunner;
    onProgress?: (progress: IngestUsageProgress) => void;
  } = {},
): Promise<IngestRunResult> {
  const runId = options.runId ?? randomUUID();
  const startedAt = nowIso();
  const warnings: string[] = [];
  let filesScanned = 0;
  let filesParsed = 0;
  let eventsSeen = 0;
  let eventsInserted = 0;

  const reportProgress = (stage: IngestUsageProgress['stage']) => {
    options.onProgress?.({
      stage,
      files_total: filePaths.length,
      files_scanned: filesScanned,
      files_parsed: filesParsed,
      events_seen: eventsSeen,
      events_inserted: eventsInserted,
      warnings: warnings.length,
    });
  };

  db.prepare(`
    INSERT INTO ingestion_runs (run_id, status, started_at)
    VALUES (?, 'running', ?)
  `).run(runId, startedAt);
  reportProgress('reading_files');

  try {
    reportProgress('rebuilding_rollups');
    const ccusage = await readCcusageUsage({ runner: options.ccusageRunner, pricing: loadPricingMap(db) });
    warnings.push(...ccusage.warnings);
    writeCcusageRollups(db, ccusage);
    rebuildLocalProfileSummary(db);
    reportProgress('usage_ready');
    for (const filePath of filePaths) {
      filesScanned += 1;
      try {
        const info = await stat(filePath);
        const previous = db.prepare('SELECT source_file_hash, source_file_size, parser_version, metadata_json, warning_count FROM source_files WHERE path_hash = ?').get(sha256Hex(filePath)) as { source_file_hash: string; source_file_size: number; parser_version: string; metadata_json: string; warning_count: number } | undefined;
        // SQLite sources may change through their WAL without changing the main file.
        if (filePath.endsWith('.jsonl') && previous?.warning_count === 0
          && previous.parser_version === LOCAL_PARSER_VERSION
          && previous.source_file_size === info.size) {
          const metadata = JSON.parse(previous.metadata_json);
          const unchanged = metadata.mtime_ms === info.mtimeMs
            || await sha256File(filePath) === previous.source_file_hash;
          if (unchanged) {
            db.prepare('UPDATE source_files SET metadata_json = ?, last_seen_at = ? WHERE path_hash = ?')
              .run(JSON.stringify({ ...metadata, mtime_ms: info.mtimeMs }), nowIso(), sha256Hex(filePath));
            if (filesScanned % 25 === 0 || filesScanned === filePaths.length) reportProgress('reading_files');
            continue;
          }
        }
        const parsed = await parseUsageFile(filePath);
        if (!parsed) {
          if (filesScanned % 25 === 0 || filesScanned === filePaths.length) reportProgress('reading_files');
          continue;
        }
        filesParsed += 1;
        eventsSeen += parsed.events.length;
        warnings.push(...parsed.warnings);
        db.transaction(() => {
          deleteToolEventsForSourceFiles(db, [filePath]);
          parsed.file.metadata = { ...parsed.file.metadata, mtime_ms: info.mtimeMs };
          insertSourceFile(db, parsed);
          eventsInserted += insertEvents(db, parsed.events);
          insertToolEvents(db, parsed.tool_events);
        })();
      } catch (error) {
        warnings.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (filesScanned % 25 === 0 || filesScanned === filePaths.length) reportProgress('reading_files');
    }

    recoverSessionTimes(db);
    rebuildAiThreads(db);
    reportProgress('linking_commits');
    await syncLocalGitCommitEvidence(db);
    rebuildLocalProfileSummary(db);
  } catch (error) {
    const finishedAt = nowIso();
    const message = error instanceof Error ? error.message : String(error);
    db.prepare(`
      UPDATE ingestion_runs
      SET status = 'failed', finished_at = ?, error = ?
      WHERE run_id = ?
    `).run(finishedAt, message, runId);
    throw error;
  }

  const finishedAt = nowIso();
  const status = warnings.length > 0 ? 'partial' : 'completed';
  const deduped = Math.max(0, eventsSeen - eventsInserted);
  db.prepare(`
    UPDATE ingestion_runs
    SET status = ?, finished_at = ?, usage_day_count = (
      SELECT COUNT(*) FROM usage_daily_aggregates
    ), session_count = (
      SELECT COUNT(*) FROM usage_session_rollups
    ), error = ?
    WHERE run_id = ?
  `).run(status, finishedAt, warnings.length > 0 ? warnings.slice(0, 20).join('\n') : null, runId);
  reportProgress('completed');

  return {
    run_id: runId,
    status,
    files_seen: filePaths.length,
    files_parsed: filesParsed,
    events_seen: eventsSeen,
    events_inserted: eventsInserted,
    events_deduped: deduped,
    warnings: Array.from(new Set(warnings)).slice(0, 50),
    started_at: startedAt,
    finished_at: finishedAt,
  };
}
