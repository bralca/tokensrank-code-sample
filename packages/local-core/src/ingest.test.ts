import { appendFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { LocalStore } from './db.js';
import { openLocalStore } from './db.js';
import { ingestUsageFiles } from './ingest.js';
import type { CcusageRunner } from './ccusage.js';
import { sha256Hex } from './hash.js';

async function writeJsonl(filePath: string, records: unknown[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n'), 'utf8');
}

const emptyCcusageRunner: CcusageRunner = async () => ({ sessions: [], totals: {} });

function codexCcusageRunner(session: Record<string, unknown>): CcusageRunner {
  return async (source) => (source === 'codex'
    ? { sessions: [session], totals: {} }
    : { sessions: [], totals: {} });
}

describe('ingestUsageFiles', () => {
  let store: LocalStore | null = null;

  afterEach(() => {
    store?.close();
    store = null;
  });

  it('does not double count Codex cached or reasoning token subdetails in total_tokens', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-ingest-'));
    store = openLocalStore({ dataDir });
    const filePath = path.join(dataDir, '.codex', 'sessions', 'rollout.jsonl');
    await writeJsonl(filePath, [
      {
        type: 'session_meta',
        timestamp: '2026-06-01T10:00:00.000Z',
        payload: {
          type: 'session_meta',
          id: 'codex-token-total',
          cwd: dataDir,
          model: 'gpt-5.5',
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-06-01T10:03:00.000Z',
        payload: {
          info: {
            model: 'gpt-5.5',
            last_token_usage: {
              input_tokens: 100,
              output_tokens: 40,
              cached_tokens: 80,
              reasoning_tokens: 25,
            },
          },
        },
      },
    ]);

    await ingestUsageFiles(store.db, [filePath], {
      ccusageRunner: codexCcusageRunner({
        sessionId: 'codex-token-total',
        lastActivity: '2026-06-01T10:03:00.000Z',
        inputTokens: 100,
        outputTokens: 40,
        cachedInputTokens: 80,
        reasoningOutputTokens: 25,
        totalTokens: 140,
        costUSD: 0.01,
        models: {
          'gpt-5.5': {
            inputTokens: 100,
            outputTokens: 40,
            cachedInputTokens: 80,
            reasoningOutputTokens: 25,
            totalTokens: 140,
          },
        },
      }),
    });

    const daily = store.db.prepare(`
      SELECT total_tokens, input_tokens, output_tokens, cached_tokens, reasoning_tokens
      FROM usage_daily_aggregates
      WHERE source = 'codex'
    `).get() as {
      total_tokens: number;
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
      reasoning_tokens: number;
    };

    expect(daily).toMatchObject({
      total_tokens: 140,
      input_tokens: 100,
      output_tokens: 40,
      cached_tokens: 80,
      reasoning_tokens: 25,
    });
  });

  it('keeps existing rollout line event IDs stable when a source file is appended', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-ingest-'));
    store = openLocalStore({ dataDir });
    const filePath = path.join(dataDir, '.codex', 'sessions', 'rollout.jsonl');
    await writeJsonl(filePath, [
      {
        type: 'session_meta',
        timestamp: '2026-06-01T10:00:00.000Z',
        payload: {
          type: 'session_meta',
          id: 'codex-append-stable',
          cwd: dataDir,
          model: 'gpt-5.5',
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-06-01T10:01:00.000Z',
        payload: {
          info: {
            model: 'gpt-5.5',
            last_token_usage: {
              input_tokens: 10,
              output_tokens: 5,
            },
          },
        },
      },
    ]);

    await ingestUsageFiles(store.db, [filePath], { ccusageRunner: emptyCcusageRunner });
    await appendFile(filePath, `\n${JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-06-01T10:02:00.000Z',
      payload: {
        info: {
          model: 'gpt-5.5',
          last_token_usage: {
            input_tokens: 20,
            output_tokens: 7,
          },
        },
      },
    })}`, 'utf8');
    await ingestUsageFiles(store.db, [filePath], { ccusageRunner: emptyCcusageRunner });

    const row = store.db.prepare('SELECT COUNT(*) AS event_count, SUM(total_tokens) AS total_tokens FROM usage_events').get() as {
      event_count: number;
      total_tokens: number;
    };

    expect(row).toMatchObject({
      event_count: 2,
      total_tokens: 42,
    });
    const unchanged = await ingestUsageFiles(store.db, [filePath], { ccusageRunner: emptyCcusageRunner });
    expect(unchanged.files_parsed).toBe(0);
    expect(unchanged.events_inserted).toBe(0);
    expect(store.db.prepare('SELECT COUNT(*) AS event_count, SUM(total_tokens) AS total_tokens FROM usage_events').get()).toEqual(row);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM usage_daily_aggregates').get()).toMatchObject({ count: 0 });
  });

  it('maps Windows-style session cwd paths to local repos for direct commit evidence', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-ingest-'));
    store = openLocalStore({ dataDir });
    const filePath = path.join(dataDir, '.codex', 'sessions', 'rollout.jsonl');
    const now = '2026-06-01T10:00:00.000Z';
    const commitSha = 'abcdef1234567890abcdef1234567890abcdef12';

    store.db.prepare(`
      INSERT INTO local_repos (
        id, local_root, local_root_hash, git_remote_url, github_repo_id,
        full_name, default_branch, prod_branch, selected, matched, created_at, updated_at
      )
      VALUES ('repo-win', 'C:\\Users\\dev\\project\\', 'hash', 'git@github.com:owner/repo.git', 101,
        'owner/repo', 'main', 'main', 1, 1, ?, ?)
    `).run(now, now);

    await writeJsonl(filePath, [
      {
        type: 'session_meta',
        timestamp: now,
        payload: {
          type: 'session_meta',
          id: 'codex-windows-cwd',
          cwd: 'C:\\Users\\dev\\project\\packages\\app',
          model: 'gpt-5.5',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-01T10:01:00.000Z',
        payload: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'git commit -m private-message' }),
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-01T10:02:00.000Z',
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: `[main ${commitSha}] private output`,
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-06-01T10:03:00.000Z',
        payload: {
          info: {
            model: 'gpt-5.5',
            last_token_usage: {
              input_tokens: 10,
              output_tokens: 5,
            },
          },
        },
      },
    ]);

    await ingestUsageFiles(store.db, [filePath], { ccusageRunner: emptyCcusageRunner });

    const toolEvent = store.db.prepare(`
      SELECT repo_id, commit_sha
      FROM ai_tool_events
      WHERE session_id = 'codex-windows-cwd'
        AND commit_sha IS NOT NULL
    `).get() as { repo_id: string | null; commit_sha: string | null };

    expect(toolEvent).toMatchObject({
      repo_id: 'repo-win',
      commit_sha: commitSha,
    });
  });

  it('refreshes file-derived tool events when a usage file is reimported', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-ingest-'));
    store = openLocalStore({ dataDir });
    const filePath = path.join(dataDir, '.codex', 'sessions', 'rollout.jsonl');
    const now = '2026-06-01T10:00:00.000Z';
    const commitSha = 'cccccc1234567890abcdef1234567890abcdef12';
    const pathHash = sha256Hex(filePath);

    store.db.prepare(`
      INSERT INTO ai_tool_events (
        event_id, source, provider, session_id, event_at, model, model_source,
        tool_name, command_kind, repo_id, commit_sha, confidence,
        evidence_origin, metadata_json, created_at
      )
      VALUES (
        'stale-tool-event', 'codex', 'unknown', 'old-session', ?, 'unknown', 'unknown',
        'exec_command', 'unknown_command', NULL, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 0.9,
        'unknown', ?, ?
      )
    `).run(now, JSON.stringify({ source_path_hash: pathHash }), now);

    await writeJsonl(filePath, [
      {
        type: 'session_meta',
        timestamp: now,
        payload: {
          type: 'session_meta',
          id: 'codex-refresh-tool-events',
          cwd: dataDir,
          model: 'gpt-5.5',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-01T10:01:00.000Z',
        payload: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'git commit -m private-message' }),
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-01T10:02:00.000Z',
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: `[main ${commitSha}] private output`,
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-06-01T10:03:00.000Z',
        payload: {
          info: {
            model: 'gpt-5.5',
            last_token_usage: {
              input_tokens: 10,
              output_tokens: 5,
            },
          },
        },
      },
    ]);

    await ingestUsageFiles(store.db, [filePath], { ccusageRunner: emptyCcusageRunner });

    expect(store.db.prepare(`
      SELECT COUNT(*) AS count
      FROM ai_tool_events
      WHERE event_id = 'stale-tool-event'
    `).get()).toMatchObject({ count: 0 });

    const refreshed = store.db.prepare(`
      SELECT session_id, model, command_kind, commit_sha
      FROM ai_tool_events
      WHERE commit_sha = ?
    `).get(commitSha) as {
      session_id: string;
      model: string;
      command_kind: string;
      commit_sha: string;
    };

    expect(refreshed).toMatchObject({
      session_id: 'codex-refresh-tool-events',
      model: 'gpt-5.5',
      command_kind: 'git_commit',
      commit_sha: commitSha,
    });
  });

  it('maps worktree cwd paths through canonical repo aliases', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-ingest-'));
    store = openLocalStore({ dataDir });
    const filePath = path.join(dataDir, '.codex', 'sessions', 'rollout.jsonl');
    const now = '2026-06-01T10:00:00.000Z';
    const canonicalRoot = '/Users/dev/project';
    const worktreeRoot = '/Users/dev/project/.worktrees/feature-a';
    const commitSha = 'bbbbbb1234567890abcdef1234567890abcdef12';

    store.db.prepare(`
      INSERT INTO local_repos (
        id, local_root, local_root_hash, git_remote_url, github_repo_id,
        full_name, default_branch, prod_branch, selected, matched, created_at, updated_at
      )
      VALUES ('repo-canonical', ?, 'root-hash', 'git@github.com:owner/repo.git', 101,
        'owner/repo', 'main', 'main', 1, 1, ?, ?)
    `).run(canonicalRoot, now, now);
    store.db.prepare(`
      INSERT INTO local_repo_roots (
        repo_id, local_root, local_root_hash, kind, created_at, updated_at
      )
      VALUES ('repo-canonical', ?, 'alias-hash', 'alias', ?, ?)
    `).run(worktreeRoot, now, now);

    await writeJsonl(filePath, [
      {
        type: 'session_meta',
        timestamp: now,
        payload: {
          type: 'session_meta',
          id: 'codex-worktree-cwd',
          cwd: `${worktreeRoot}/apps/web`,
          model: 'gpt-5.5',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-01T10:01:00.000Z',
        payload: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'git commit -m private-message' }),
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-01T10:02:00.000Z',
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: `[feature-a ${commitSha}] private output`,
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-06-01T10:03:00.000Z',
        payload: {
          info: {
            model: 'gpt-5.5',
            last_token_usage: {
              input_tokens: 10,
              output_tokens: 5,
            },
          },
        },
      },
    ]);

    await ingestUsageFiles(store.db, [filePath], { ccusageRunner: emptyCcusageRunner });

    const toolEvent = store.db.prepare(`
      SELECT repo_id, commit_sha
      FROM ai_tool_events
      WHERE session_id = 'codex-worktree-cwd'
        AND commit_sha IS NOT NULL
    `).get() as { repo_id: string | null; commit_sha: string | null };

    expect(toolEvent).toMatchObject({
      repo_id: 'repo-canonical',
      commit_sha: commitSha,
    });
  });
});
