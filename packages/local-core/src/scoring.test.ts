import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { openLocalStore } from './db.js';
import { computeLocalScore, rebuildLocalProfileSummary, readLocalProfileSummary } from './scoring.js';

describe('local profile scoring', () => {
  it('uses the hosted-style score formula and requires both usage and shipped code', () => {
    const nowMs = Date.parse('2026-06-04T00:00:00.000Z');
    const tokensByDay = new Map([
      ['2026-06-03', 1_000_000],
    ]);

    expect(computeLocalScore({
      window: '7d',
      nowMs,
      tokensByDay,
      shippedByDay: new Map(),
    }).score).toBe(0);

    expect(computeLocalScore({
      window: '7d',
      nowMs,
      tokensByDay,
      shippedByDay: new Map([['2026-06-03', 250]]),
    }).score).toBeGreaterThan(0);
  });

  it('rebuilds local profile summaries for 24h, 7d, 30d, and all windows', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-scoring-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-04T00:00:00.000Z';
    const nowMs = Date.parse(now);

    try {
      db.prepare(`
        INSERT INTO local_repos (
          id, local_root, local_root_hash, git_remote_url, github_repo_id,
          full_name, default_branch, prod_branch, selected, matched, created_at, updated_at
        )
        VALUES ('repo-1', '/Users/example/project', 'hash', 'git@github.com:owner/repo.git', 101,
          'owner/repo', 'main', 'main', 1, 1, ?, ?)
      `).run(now, now);

      const sessionStmt = db.prepare(`
        INSERT INTO usage_session_rollups (
          source, provider, session_id, model, first_event_at, last_event_at,
          input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
          cached_tokens, reasoning_tokens, total_tokens, turns, cost_usd_total,
          source_file_hashes_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, '[]', ?)
      `);
      const threadStmt = db.prepare(`
        INSERT INTO ai_threads (
          source, session_id, repo_id, first_event_at, last_event_at,
          total_tokens, metadata_json, updated_at
        )
        VALUES (?, ?, 'repo-1', ?, ?, ?, '{}', ?)
      `);
      function insertSession(input: {
        source: 'codex' | 'claude';
        provider: 'openai' | 'anthropic';
        sessionId: string;
        model: string;
        lastEventAt: string;
        inputTokens: number;
        outputTokens: number;
        turns: number;
        cost: number;
      }) {
        sessionStmt.run(
          input.source,
          input.provider,
          input.sessionId,
          input.model,
          input.lastEventAt,
          input.lastEventAt,
          input.inputTokens,
          input.outputTokens,
          input.inputTokens + input.outputTokens,
          input.turns,
          input.cost,
          now,
        );
        threadStmt.run(
          input.source,
          input.sessionId,
          input.lastEventAt,
          input.lastEventAt,
          input.inputTokens + input.outputTokens,
          now,
        );
      }

      insertSession({
        source: 'codex',
        provider: 'openai',
        sessionId: 'recent-1',
        model: 'gpt-5.5',
        lastEventAt: '2026-06-03T10:00:00.000Z',
        inputTokens: 300,
        outputTokens: 200,
        turns: 2,
        cost: 0.61,
      });
      insertSession({
        source: 'codex',
        provider: 'openai',
        sessionId: 'recent-2',
        model: 'gpt-5.5',
        lastEventAt: '2026-06-03T11:00:00.000Z',
        inputTokens: 300,
        outputTokens: 200,
        turns: 2,
        cost: 0.62,
      });
      for (let index = 1; index <= 3; index += 1) {
        insertSession({
          source: 'codex',
          provider: 'openai',
          sessionId: `mid-${index}`,
          model: 'gpt-5.5',
          lastEventAt: `2026-05-20T1${index}:00:00.000Z`,
          inputTokens: index === 3 ? 300 : 400,
          outputTokens: 300,
          turns: 2,
          cost: index === 3 ? 0.8 : 0.77,
        });
      }
      for (let index = 1; index <= 4; index += 1) {
        insertSession({
          source: 'claude',
          provider: 'anthropic',
          sessionId: `old-${index}`,
          model: 'claude-opus-4-7',
          lastEventAt: `2026-04-01T1${index}:00:00.000Z`,
          inputTokens: index === 4 ? 300 : 400,
          outputTokens: index === 4 ? 300 : 400,
          turns: 2,
          cost: index === 4 ? 0.87 : 0.86,
        });
      }

      const usageStmt = db.prepare(`
        INSERT INTO usage_daily_aggregates (
          date, source, provider, model, total_tokens, input_tokens, output_tokens,
          cache_read_tokens, cache_create_tokens, total_sessions, event_count,
          cost_usd_total, updated_at
        )
        VALUES (?, 'codex', 'openai', ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
      `);
      usageStmt.run('2026-06-03', 'gpt-5.5', 1_000, 600, 400, 2, 4, 1.23, now);
      usageStmt.run('2026-05-20', 'gpt-5.5', 2_000, 1_200, 800, 3, 6, 2.34, now);
      usageStmt.run('2026-04-01', 'claude-opus-4-7', 3_000, 1_500, 1_500, 4, 8, 3.45, now);

      const githubStmt = db.prepare(`
        INSERT INTO github_code_daily (
          date, repo_id, full_name, prod_branch, github_shipped_loc,
          github_commit_count, verified_at, verification_source, updated_at
        )
        VALUES (?, 101, 'owner/repo', 'main', ?, ?, ?, 'github_remote_prod', ?)
      `);
      githubStmt.run('2026-06-03', 50, 1, now, now);
      githubStmt.run('2026-05-20', 100, 2, now, now);
      githubStmt.run('2026-04-01', 150, 3, now, now);

      const linkedStmt = db.prepare(`
        INSERT INTO ai_linked_code_daily (
          date, repo_id, full_name, linked_shipped_loc, linked_commit_count,
          linked_tokens, high_confidence_commit_count, median_link_confidence, updated_at
        )
        VALUES (?, 101, 'owner/repo', ?, ?, ?, ?, 0.9, ?)
      `);
      linkedStmt.run('2026-06-03', 25, 1, 500, 1, now);
      linkedStmt.run('2026-05-20', 50, 2, 800, 2, now);
      linkedStmt.run('2026-04-01', 75, 3, 900, 3, now);

      expect(rebuildLocalProfileSummary(db, { nowMs })).toBe(4);

      const rows = readLocalProfileSummary(db);
      expect(rows.map((row) => row.window)).toEqual(['24h', '7d', '30d', 'all']);

      const byWindow = new Map(rows.map((row) => [row.window, row]));
      expect(byWindow.get('24h')).toMatchObject({
        tokens_total: 1_000,
        cost_usd_total: 1.23,
        github_shipped_loc_total: 50,
        ai_linked_loc_total: 25,
        sessions_count: 2,
        days_active: 1,
      });
      expect(byWindow.get('7d')).toMatchObject({
        tokens_total: 1_000,
        github_shipped_loc_total: 50,
        sessions_count: 2,
      });
      expect(byWindow.get('30d')).toMatchObject({
        tokens_total: 3_000,
        github_shipped_loc_total: 150,
        ai_linked_loc_total: 75,
        sessions_count: 5,
        days_active: 2,
      });
      expect(byWindow.get('all')).toMatchObject({
        tokens_total: 6_000,
        github_shipped_loc_total: 300,
        ai_linked_loc_total: 150,
        sessions_count: 9,
        days_active: 3,
      });

      expect(byWindow.get('30d')?.score).toBeGreaterThan(0);
      expect(JSON.parse(byWindow.get('all')?.metrics_json ?? '{}')).toMatchObject({
        github_commit_count_total: 6,
        ai_linked_commit_count_total: 6,
        source: 'local',
      });
    } finally {
      store.close();
    }
  });
});
