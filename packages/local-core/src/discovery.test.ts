import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import type { LocalDiscoveredRepo } from '@tokensrank/shared';

import { openLocalStore } from './db.js';
import { listStoredRepos, upsertDiscoveredRepos } from './discovery.js';
import { sha256Hex } from './hash.js';

describe('local repo discovery storage', () => {
  it('folds stale worktree repo rows into the canonical repo alias', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-discovery-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-01T10:00:00.000Z';
    const canonicalRoot = '/Users/dev/project';
    const worktreeRoot = '/Users/dev/project/.worktrees/feature-a';
    const commitSha = 'abcdef1234567890abcdef1234567890abcdef12';

    try {
      db.prepare(`
        INSERT INTO local_repos (
          id, local_root, local_root_hash, git_remote_url, github_repo_id,
          full_name, default_branch, prod_branch, selected, matched, created_at, updated_at
        )
        VALUES ('repo-worktree', ?, ?, 'git@github.com:owner/repo.git', 101,
          'owner/repo', 'feature-a', 'feature-a', 1, 1, ?, ?)
      `).run(worktreeRoot, sha256Hex(worktreeRoot), now, now);
      db.prepare(`
        INSERT INTO local_commits (
          repo_id, sha, committed_at, branch, nondoc_additions,
          nondoc_additions_score, prod_nondoc_additions, prod_nondoc_additions_score,
          reachable_from_prod, updated_at
        )
        VALUES ('repo-worktree', ?, ?, 'feature-a', 12, 12, 0, 0, 0, ?)
      `).run(commitSha, now, now);
      db.prepare(`
        INSERT INTO ai_threads (
          source, session_id, repo_id, first_event_at, last_event_at,
          total_tokens, metadata_json, updated_at
        )
        VALUES ('codex', 'worktree-session', 'repo-worktree', ?, ?, 1000, '{}', ?)
      `).run(now, now, now);
      db.prepare(`
        INSERT INTO ai_tool_events (
          event_id, source, session_id, event_at, tool_name, repo_id,
          commit_sha, confidence, metadata_json, created_at
        )
        VALUES ('worktree-tool', 'codex', 'worktree-session', ?, 'exec_command', 'repo-worktree',
          ?, 0.9, '{}', ?)
      `).run(now, commitSha, now);

      const canonicalRepo = {
        id: 'repo-canonical',
        local_root: canonicalRoot,
        git_remote_url: 'git@github.com:owner/repo.git',
        github_repo_id: 101,
        full_name: 'owner/repo',
        default_branch: 'main',
        prod_branch: 'main',
        last_remote_sync_at: null,
        remote_sync_error: null,
        branches: ['main', 'feature-a'],
        worktree_count: 1,
        selected: true,
        matched: true,
        root_aliases: [canonicalRoot, worktreeRoot],
      } satisfies LocalDiscoveredRepo & { root_aliases: string[] };

      upsertDiscoveredRepos(db, [canonicalRepo]);

      const storedRepos = listStoredRepos(db);
      const stale = db.prepare(`
        SELECT selected, matched
        FROM local_repos
        WHERE id = 'repo-worktree'
      `).get() as { selected: number; matched: number };
      const commit = db.prepare(`
        SELECT repo_id
        FROM local_commits
        WHERE sha = ?
      `).get(commitSha) as { repo_id: string };
      const toolEvent = db.prepare(`
        SELECT repo_id
        FROM ai_tool_events
        WHERE event_id = 'worktree-tool'
      `).get() as { repo_id: string };
      const thread = db.prepare(`
        SELECT repo_id
        FROM ai_threads
        WHERE session_id = 'worktree-session'
      `).get() as { repo_id: string };

      expect(storedRepos.map((repo) => repo.id)).toEqual(['repo-canonical']);
      expect(stale).toMatchObject({ selected: 0, matched: 0 });
      expect(commit.repo_id).toBe('repo-canonical');
      expect(toolEvent.repo_id).toBe('repo-canonical');
      expect(thread.repo_id).toBe('repo-canonical');
    } finally {
      store.close();
    }
  });

  it('folds stale worktree rows even when the worktree is not rediscovered as an alias', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-discovery-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-01T10:00:00.000Z';
    const canonicalRoot = '/Users/dev/project';
    const worktreeRoot = '/Users/dev/project/.worktrees/feature-b';
    const commitSha = 'bbbbbb1234567890abcdef1234567890abcdef12';

    try {
      db.prepare(`
        INSERT INTO local_repos (
          id, local_root, local_root_hash, git_remote_url, github_repo_id,
          full_name, default_branch, prod_branch, selected, matched, created_at, updated_at
        )
        VALUES ('repo-worktree-b', ?, ?, 'git@github.com:owner/repo.git', 101,
          'owner/repo', 'feature-b', 'feature-b', 1, 1, ?, ?)
      `).run(worktreeRoot, sha256Hex(worktreeRoot), now, now);
      db.prepare(`
        INSERT INTO local_commits (
          repo_id, sha, committed_at, branch, nondoc_additions,
          nondoc_additions_score, prod_nondoc_additions, prod_nondoc_additions_score,
          reachable_from_prod, updated_at
        )
        VALUES ('repo-worktree-b', ?, ?, 'feature-b', 18, 18, 0, 0, 0, ?)
      `).run(commitSha, now, now);
      db.prepare(`
        INSERT INTO ai_threads (
          source, session_id, repo_id, first_event_at, last_event_at,
          total_tokens, metadata_json, updated_at
        )
        VALUES ('claude', 'stale-worktree-session', 'repo-worktree-b', ?, ?, 1200, '{}', ?)
      `).run(now, now, now);
      db.prepare(`
        INSERT INTO ai_tool_events (
          event_id, source, session_id, event_at, tool_name, repo_id,
          commit_sha, confidence, metadata_json, created_at
        )
        VALUES ('stale-worktree-tool', 'claude', 'stale-worktree-session', ?, 'Bash', 'repo-worktree-b',
          ?, 0.9, '{}', ?)
      `).run(now, commitSha, now);

      const canonicalRepo = {
        id: 'repo-canonical',
        local_root: canonicalRoot,
        git_remote_url: 'git@github.com:owner/repo.git',
        github_repo_id: 101,
        full_name: 'owner/repo',
        default_branch: 'main',
        prod_branch: 'main',
        last_remote_sync_at: null,
        remote_sync_error: null,
        branches: ['main'],
        worktree_count: 0,
        selected: true,
        matched: true,
        root_aliases: [canonicalRoot],
      } satisfies LocalDiscoveredRepo & { root_aliases: string[] };

      upsertDiscoveredRepos(db, [canonicalRepo]);

      const stale = db.prepare(`
        SELECT selected, matched
        FROM local_repos
        WHERE id = 'repo-worktree-b'
      `).get() as { selected: number; matched: number };
      const alias = db.prepare(`
        SELECT repo_id, kind
        FROM local_repo_roots
        WHERE local_root_hash = ?
      `).get(sha256Hex(worktreeRoot)) as { repo_id: string; kind: string };
      const commit = db.prepare(`
        SELECT repo_id
        FROM local_commits
        WHERE sha = ?
      `).get(commitSha) as { repo_id: string };
      const toolEvent = db.prepare(`
        SELECT repo_id
        FROM ai_tool_events
        WHERE event_id = 'stale-worktree-tool'
      `).get() as { repo_id: string };
      const thread = db.prepare(`
        SELECT repo_id
        FROM ai_threads
        WHERE session_id = 'stale-worktree-session'
      `).get() as { repo_id: string };

      expect(stale).toMatchObject({ selected: 0, matched: 0 });
      expect(alias).toMatchObject({ repo_id: 'repo-canonical', kind: 'alias' });
      expect(commit.repo_id).toBe('repo-canonical');
      expect(toolEvent.repo_id).toBe('repo-canonical');
      expect(thread.repo_id).toBe('repo-canonical');
    } finally {
      store.close();
    }
  });
});
