import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { openLocalStore } from './db.js';
import { buildPublishPayload } from './publish.js';

const sourceHashPrivate = 'a'.repeat(64);

function insertGithubIdentity(db: ReturnType<typeof openLocalStore>['db'], now: string): void {
  db.prepare(`
    INSERT INTO github_identity (
      github_user_id, login, avatar_url, verified_emails_json, connected_at, updated_at
    )
    VALUES (123, 'dev-user', NULL, '[]', ?, ?)
  `).run(now, now);
}

describe('buildPublishPayload', () => {
  it('rejects selected GitHub repos that have not been remotely verified', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-publish-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-01T10:00:00.000Z';

    try {
      insertGithubIdentity(db, now);
      db.prepare(`
        INSERT INTO local_repos (
          id, local_root, local_root_hash, git_remote_url, github_repo_id,
          full_name, default_branch, prod_branch, selected, matched, created_at, updated_at
        )
        VALUES ('repo-1', '/Users/example/project', 'hash', 'git@github.com:owner/repo.git', NULL,
          'owner/repo', 'main', 'main', 1, 1, ?, ?)
      `).run(now, now);

      expect(() => buildPublishPayload(db, { includeCode: true })).toThrow(/Run GitHub verification before publishing/u);
    } finally {
      store.close();
    }
  });

  it('includes selected repos after remote verification even when there are no shipped commits', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-publish-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-01T10:00:00.000Z';

    try {
      insertGithubIdentity(db, now);
      db.prepare(`
        INSERT INTO local_repos (
          id, local_root, local_root_hash, git_remote_url, github_repo_id,
          full_name, default_branch, prod_branch, selected, matched,
          last_remote_sync_at, created_at, updated_at
        )
        VALUES ('repo-1', '/Users/example/project', 'hash', 'git@github.com:owner/repo.git', 456,
          'owner/repo', 'main', 'main', 1, 1, ?, ?, ?)
      `).run(now, now, now);
      db.prepare(`
        INSERT INTO usage_daily_aggregates (
          date, source, provider, model, total_tokens, input_tokens, output_tokens,
          cache_read_tokens, cache_create_tokens, cached_tokens, reasoning_tokens,
          total_sessions, event_count, cost_usd_total, updated_at
        )
        VALUES (
          '2026-06-01', 'codex', 'openai', 'gpt-5.5', 100, 60, 40,
          0, 0, 0, 0, 1, 1, 1.25, ?
        )
      `).run(now);
      db.prepare(`
        INSERT INTO usage_session_rollups (
          source, provider, session_id, model, first_event_at, last_event_at,
          input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
          cached_tokens, reasoning_tokens, total_tokens, turns, cost_usd_total,
          source_file_hashes_json, updated_at
        )
        VALUES (
          'codex', 'openai', 'session-1', 'gpt-5.5', ?, ?,
          60, 40, 0, 0, 0, 0, 100, 1, 1.25,
          '[]',
          ?
        )
      `).run(now, now, now);
      db.prepare(`
        INSERT INTO ai_threads (
          source, session_id, repo_id, first_event_at, last_event_at,
          total_tokens, metadata_json, updated_at
        )
        VALUES ('codex', 'session-1', 'repo-1', ?, ?, 100, '{}', ?)
      `).run(now, now, now);

      const payload = buildPublishPayload(db, { includeCode: true });

      expect(payload.selected_repos).toEqual([
        {
          repo_id: 456,
          full_name: 'owner/repo',
          prod_branch: 'main',
        },
      ]);
      expect(payload.model_daily).toEqual(payload.usage_daily);
      expect(payload.model_daily).toHaveLength(1);
      expect(payload.produced_code_daily).toEqual([]);
      expect(payload.ai_linked_code_daily).toEqual([]);
      expect(payload.model_code_daily).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('does not include local paths, prompts, commands, or raw transcript content', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-publish-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-01T10:00:00.000Z';

    try {
      insertGithubIdentity(db, now);
      db.prepare(`
        INSERT INTO local_repos (
          id, local_root, local_root_hash, git_remote_url, github_repo_id,
          full_name, default_branch, prod_branch, selected, matched,
          last_remote_sync_at, created_at, updated_at
        )
        VALUES ('repo-1', '/Users/example/project', 'hash', 'git@github.com:owner/repo.git', 456,
          'owner/repo', 'main', 'main', 1, 1, ?, ?, ?)
      `).run(now, now, now);
      db.prepare(`
        INSERT INTO source_files (
          source, path_hash, local_path, source_file_hash, source_file_size,
          line_count, parsed_event_count, ignored_line_count, warning_count,
          parser_version, metadata_json, first_seen_at, last_seen_at
        )
        VALUES (
          'codex', 'path-hash-private', '/Users/dev/secret/project/session.jsonl',
          ?, 100, 1, 1, 0, 0, 'test-parser',
          '{"raw_prompt":"build the private thing"}', ?, ?
        )
      `).run(sourceHashPrivate, now, now);
      db.prepare(`
        INSERT INTO usage_events (
          event_id, source, provider, event_kind, session_id, source_event_id,
          event_at, model, model_source, input_tokens, output_tokens,
          cache_read_tokens, cache_create_tokens, cached_tokens, reasoning_tokens,
          total_tokens, source_file_hash, source_file_size, line_number,
          parser_version, metadata_json, created_at
        )
        VALUES (
          'event-private', 'codex', 'openai', 'token_usage', 'session-private', NULL,
          ?, 'gpt-5.5', 'record', 60, 40, 0, 0, 0, 0, 100,
          ?, 100, 1, 'test-parser',
          '{"prompt":"secret prompt text","command":"cat /Users/dev/.ssh/id_rsa","transcript":"raw transcript text"}',
          ?
        )
      `).run(now, sourceHashPrivate, now);
      db.prepare(`
        INSERT INTO usage_daily_aggregates (
          date, source, provider, model, total_tokens, input_tokens, output_tokens,
          cache_read_tokens, cache_create_tokens, cached_tokens, reasoning_tokens,
          total_sessions, event_count, cost_usd_total, updated_at
        )
        VALUES (
          '2026-06-01', 'codex', 'openai', 'gpt-5.5', 100, 60, 40,
          0, 0, 0, 0, 1, 1, 1.25, ?
        )
      `).run(now);
      db.prepare(`
        INSERT INTO usage_session_rollups (
          source, provider, session_id, model, first_event_at, last_event_at,
          input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
          cached_tokens, reasoning_tokens, total_tokens, turns, cost_usd_total,
          source_file_hashes_json, updated_at
        )
        VALUES (
          'codex', 'openai', 'session-private', 'gpt-5.5', ?, ?,
          60, 40, 0, 0, 0, 0, 100, 1, 1.25,
          ?,
          ?
        )
      `).run(now, now, JSON.stringify([sourceHashPrivate]), now);
      db.prepare(`
        INSERT INTO ai_threads (
          source, session_id, repo_id, first_event_at, last_event_at,
          total_tokens, metadata_json, updated_at
        )
        VALUES ('codex', 'session-private', 'repo-1', ?, ?, 100, '{}', ?)
      `).run(now, now, now);

      const payloadJson = JSON.stringify(buildPublishPayload(db, { includeCode: true }));

      expect(payloadJson).not.toContain('/Users/dev');
      expect(payloadJson).not.toContain('secret prompt');
      expect(payloadJson).not.toContain('id_rsa');
      expect(payloadJson).not.toContain('raw transcript');
      expect(payloadJson).not.toContain(sourceHashPrivate);
      expect(payloadJson).not.toContain('session-private');
      const shared = JSON.parse(payloadJson);
      expect(shared.schema_version).toBe(2);
      expect(shared.usage_session_rollups).toEqual([]);
      const usageOnly = buildPublishPayload(db);
      expect(usageOnly.selected_repos).toEqual([]);
      expect(usageOnly.github_code_daily).toEqual([]);
    } finally {
      store.close();
    }
  });
});
