import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { openLocalStore } from './db.js';
import { rebuildAiCommitLinks, syncGithubCodeTotals, syncLocalGitCommitEvidence, verifyGithubInvariants } from './github.js';
import { buildLocalProfile } from './profile.js';

const execFileAsync = promisify(execFile);

describe('rebuildAiCommitLinks', () => {
  it('links only direct commit evidence and counts code once across repeated sessions and models', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-core-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-01T10:00:00.000Z';
    const directSha = 'abcdef1234567890abcdef1234567890abcdef12';
    const unrelatedSha = 'bbbbbb1234567890abcdef1234567890abcdef12';

    try {
      db.prepare(`
        INSERT INTO local_repos (
          id, local_root, local_root_hash, git_remote_url, github_repo_id,
          full_name, default_branch, prod_branch, selected, matched, created_at, updated_at
        )
        VALUES ('repo-1', '/Users/example/project', 'hash', 'git@github.com:owner/repo.git', 101,
          'owner/repo', 'main', 'main', 1, 1, ?, ?)
      `).run(now, now);
      db.prepare(`
        INSERT INTO usage_session_model_rollups (
          source, provider, session_id, model, first_event_at, last_event_at,
          total_tokens, cost_usd_total, updated_at
        )
        VALUES
          ('codex', 'openai', 'direct-session', 'gpt-5.5', ?, ?, 1000, 1.25, ?),
          ('codex', 'openai', 'nearby-but-unlinked-session', 'gpt-5.5', ?, ?, 2000, 2.5, ?)
      `).run(now, now, now, now, now, now);
      db.prepare(`
        INSERT INTO local_commits (
          repo_id, sha, committed_at, branch, nondoc_additions,
          reachable_from_prod, updated_at
        )
        VALUES
          ('repo-1', ?, '2026-06-01T10:05:00.000Z', 'main', 42, 1, ?),
          ('repo-1', ?, '2026-06-01T10:06:00.000Z', 'main', 99, 1, ?)
      `).run(directSha, now, unrelatedSha, now);
      db.prepare(`
        INSERT INTO github_code_daily (
          date, repo_id, full_name, prod_branch, github_shipped_loc,
          github_commit_count, verified_at, verification_source, updated_at
        )
        VALUES ('2026-06-01', 101, 'owner/repo', 'main', 141, 2, ?, 'github_remote_prod', ?)
      `).run(now, now);
      db.prepare(`
        INSERT INTO ai_tool_events (
          event_id, source, provider, session_id, event_at, model, model_source,
          tool_name, command_kind, repo_id, commit_sha, confidence, evidence_origin,
          metadata_json, created_at
        )
        VALUES ('tool-1', 'codex', 'openai', 'direct-session', ?, 'gpt-5.5', 'explicit',
          'exec_command', 'git_commit', 'repo-1', 'abcdef1', 0.9, 'fixture', '{}', ?)
      `).run(now, now);

      rebuildAiCommitLinks(db);

      const links = db.prepare('SELECT * FROM ai_commit_links ORDER BY commit_sha').all() as Array<{
        source: string;
        session_id: string;
        repo_id: string;
        commit_sha: string;
        linked_tokens: number;
        link_reason: string;
      }>;
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({
        source: 'codex',
        session_id: 'direct-session',
        repo_id: 'repo-1',
        commit_sha: directSha,
        linked_tokens: 1000,
        link_reason: 'direct_commit_sha',
      });

      const linkedDaily = db.prepare('SELECT * FROM ai_linked_code_daily').get() as {
        linked_shipped_loc: number;
        linked_commit_count: number;
        linked_tokens: number;
      };
      expect(linkedDaily).toMatchObject({
        linked_shipped_loc: 42,
        linked_commit_count: 1,
        linked_tokens: 1000,
      });

      const codeDaily = db.prepare('SELECT * FROM code_daily_rollups').get() as {
        produced_loc: number;
        shipped_loc: number;
        ai_linked_commit_count: number;
      };
      expect(codeDaily).toMatchObject({
        produced_loc: 42,
        shipped_loc: 42,
        ai_linked_commit_count: 1,
      });

      expect(verifyGithubInvariants(db).invariant_violations).toEqual([]);
      db.prepare(`INSERT INTO usage_session_model_rollups
        (source,provider,session_id,model,first_event_at,last_event_at,total_tokens,cost_usd_total,updated_at)
        VALUES ('codex','openai','second-session','gpt-5.5',?,?,1000,1,?),
          ('claude','anthropic','third-session','sonnet',?,?,1234,1,?)
      `).run(now,now,now,now,now,now);
      db.prepare(`INSERT INTO ai_tool_events
        (event_id,source,provider,session_id,event_at,model,model_source,tool_name,command_kind,repo_id,commit_sha,confidence,evidence_origin,metadata_json,created_at)
        VALUES ('tool-2','codex','openai','second-session',?,'gpt-5.5','explicit','exec_command','git_commit','repo-1','abcdef1',0.9,'fixture','{}',?),
          ('tool-3','claude','anthropic','third-session',?,'sonnet','explicit','bash','git_commit','repo-1','abcdef1',0.9,'fixture','{}',?)
      `).run(now,now,now,now);
      for (let rebuild = 0; rebuild < 2; rebuild++) {
        rebuildAiCommitLinks(db);
        expect(db.prepare('SELECT model,produced_loc,shipped_loc,linked_commit_count FROM ai_code_model_daily ORDER BY model').all()).toEqual([
          { model: 'gpt-5.5', produced_loc: 26, shipped_loc: 26, linked_commit_count: 1 },
          { model: 'sonnet', produced_loc: 16, shipped_loc: 16, linked_commit_count: 1 },
        ]);
        expect(db.prepare('SELECT produced_loc,ai_linked_commit_count FROM code_daily_rollups').get()).toEqual({ produced_loc: 42, ai_linked_commit_count: 1 });
      }
    } finally {
      store.close();
    }
  });

  it('rejects ambiguous direct SHA evidence even when a repo id is present', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-core-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-01T10:00:00.000Z';
    const firstSha = 'abcdef1111111111111111111111111111111111';
    const secondSha = 'abcdef2222222222222222222222222222222222';

    try {
      db.prepare(`
        INSERT INTO local_repos (
          id, local_root, local_root_hash, git_remote_url, github_repo_id,
          full_name, default_branch, prod_branch, selected, matched, created_at, updated_at
        )
        VALUES ('repo-1', '/Users/example/project', 'hash', 'git@github.com:owner/repo.git', 101,
          'owner/repo', 'main', 'main', 1, 1, ?, ?)
      `).run(now, now);
      db.prepare(`
        INSERT INTO usage_session_model_rollups (
          source, provider, session_id, model, first_event_at, last_event_at,
          total_tokens, cost_usd_total, updated_at
        )
        VALUES ('codex', 'openai', 'ambiguous-session', 'gpt-5.5', ?, ?, 1000, 1.25, ?)
      `).run(now, now, now);
      db.prepare(`
        INSERT INTO local_commits (
          repo_id, sha, committed_at, branch, nondoc_additions,
          reachable_from_prod, updated_at
        )
        VALUES
          ('repo-1', ?, '2026-06-01T10:05:00.000Z', 'main', 42, 1, ?),
          ('repo-1', ?, '2026-06-01T10:06:00.000Z', 'main', 99, 1, ?)
      `).run(firstSha, now, secondSha, now);
      db.prepare(`
        INSERT INTO ai_tool_events (
          event_id, source, provider, session_id, event_at, model, model_source,
          tool_name, command_kind, repo_id, commit_sha, confidence, evidence_origin,
          metadata_json, created_at
        )
        VALUES ('tool-ambiguous', 'codex', 'openai', 'ambiguous-session', ?, 'gpt-5.5', 'explicit',
          'exec_command', 'git_commit', 'repo-1', 'abcdef', 0.9, 'fixture', '{}', ?)
      `).run(now, now);

      rebuildAiCommitLinks(db);

      expect(db.prepare('SELECT COUNT(*) AS count FROM ai_commit_links').get()).toMatchObject({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM code_daily_rollups').get()).toMatchObject({ count: 0 });
    } finally {
      store.close();
    }
  });

  it('allocates linked tokens and cost from the matching model pool in a multi-model session', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-core-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-01T10:00:00.000Z';
    const gptSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const claudeSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    try {
      db.prepare(`
        INSERT INTO local_repos (
          id, local_root, local_root_hash, git_remote_url, github_repo_id,
          full_name, default_branch, prod_branch, selected, matched, created_at, updated_at
        )
        VALUES ('repo-1', '/Users/example/project', 'hash', 'git@github.com:owner/repo.git', 101,
          'owner/repo', 'main', 'main', 1, 1, ?, ?)
      `).run(now, now);
      db.prepare(`
        INSERT INTO usage_session_model_rollups (
          source, provider, session_id, model, first_event_at, last_event_at,
          total_tokens, cost_usd_total, updated_at
        )
        VALUES
          ('opencode', 'unknown', 'multi-session', 'gpt-5.5', ?, ?, 1200, 1.2, ?),
          ('opencode', 'unknown', 'multi-session', 'claude-opus-4-8', ?, ?, 800, 2.4, ?)
      `).run(now, now, now, now, now, now);
      db.prepare(`
        INSERT INTO local_commits (
          repo_id, sha, committed_at, branch, nondoc_additions,
          reachable_from_prod, updated_at
        )
        VALUES
          ('repo-1', ?, '2026-06-01T10:05:00.000Z', 'main', 10, 1, ?),
          ('repo-1', ?, '2026-06-01T10:06:00.000Z', 'main', 20, 1, ?)
      `).run(gptSha, now, claudeSha, now);
      db.prepare(`
        INSERT INTO ai_tool_events (
          event_id, source, provider, session_id, event_at, model, model_source,
          tool_name, command_kind, repo_id, commit_sha, confidence, evidence_origin,
          metadata_json, created_at
        )
        VALUES
          ('tool-gpt', 'opencode', 'unknown', 'multi-session', ?, 'gpt-5.5', 'explicit',
            'bash', 'git_commit', 'repo-1', ?, 0.9, 'fixture', '{}', ?),
          ('tool-claude', 'opencode', 'unknown', 'multi-session', ?, 'claude-opus-4-8', 'explicit',
            'bash', 'git_commit', 'repo-1', ?, 0.9, 'fixture', '{}', ?)
      `).run(now, gptSha, now, now, claudeSha, now);

      rebuildAiCommitLinks(db);

      const links = db.prepare(`
        SELECT commit_sha, model, linked_tokens, linked_cost_usd, allocation_status
        FROM ai_commit_links
        ORDER BY commit_sha
      `).all() as Array<{
        commit_sha: string;
        model: string;
        linked_tokens: number;
        linked_cost_usd: number;
        allocation_status: string;
      }>;
      expect(links).toEqual([
        {
          commit_sha: gptSha,
          model: 'gpt-5.5',
          linked_tokens: 1200,
          linked_cost_usd: 1.2,
          allocation_status: 'matched',
        },
        {
          commit_sha: claudeSha,
          model: 'claude-opus-4-8',
          linked_tokens: 800,
          linked_cost_usd: 2.4,
          allocation_status: 'matched',
        },
      ]);
    } finally {
      store.close();
    }
  });

  it('counts strict AI-coded LOC when the matching token pool is missing', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-core-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-01T10:00:00.000Z';
    const sha = 'cccccccccccccccccccccccccccccccccccccccc';

    try {
      db.prepare(`
        INSERT INTO local_repos (
          id, local_root, local_root_hash, git_remote_url, github_repo_id,
          full_name, default_branch, prod_branch, selected, matched, created_at, updated_at
        )
        VALUES ('repo-1', '/Users/example/project', 'hash', 'git@github.com:owner/repo.git', 101,
          'owner/repo', 'main', 'main', 1, 1, ?, ?)
      `).run(now, now);
      db.prepare(`
        INSERT INTO local_commits (
          repo_id, sha, committed_at, branch, nondoc_additions,
          reachable_from_prod, updated_at
        )
        VALUES ('repo-1', ?, '2026-06-01T10:05:00.000Z', 'main', 42, 1, ?)
      `).run(sha, now);
      db.prepare(`
        INSERT INTO ai_tool_events (
          event_id, source, provider, session_id, event_at, model, model_source,
          tool_name, command_kind, repo_id, commit_sha, confidence, evidence_origin,
          metadata_json, created_at
        )
        VALUES ('tool-missing-pool', 'opencode', 'unknown', 'missing-pool-session', ?, 'deepseek-chat-v3', 'explicit',
          'bash', 'git_commit', 'repo-1', ?, 0.9, 'fixture', '{}', ?)
      `).run(now, sha, now);

      rebuildAiCommitLinks(db);

      const link = db.prepare(`
        SELECT linked_tokens, linked_cost_usd, allocation_status
        FROM ai_commit_links
      `).get() as {
        linked_tokens: number;
        linked_cost_usd: number;
        allocation_status: string;
      };
      expect(link).toMatchObject({
        linked_tokens: 0,
        linked_cost_usd: 0,
        allocation_status: 'missing_token_pool',
      });
      expect(db.prepare('SELECT produced_loc, shipped_loc FROM code_daily_rollups').get()).toMatchObject({
        produced_loc: 42,
        shipped_loc: 42,
      });
    } finally {
      store.close();
    }
  });

  it('marks selected GitHub repos as remotely synced even with no shipped commits', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-core-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-01T10:00:00.000Z';
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = input.toString();
      calls.push(url);
      if (url.endsWith('/repos/owner/repo')) {
        return new Response(JSON.stringify({
          id: 101,
          full_name: 'owner/repo',
          default_branch: 'main',
        }), { status: 200 });
      }
      if (url.includes('/repos/owner/repo/commits?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error(`unexpected GitHub request: ${url}`);
    };

    try {
      db.prepare(`
        INSERT INTO github_identity (
          github_user_id, login, avatar_url, verified_emails_json, connected_at, updated_at
        )
        VALUES (123, 'dev-user', NULL, '[]', ?, ?)
      `).run(now, now);
      db.prepare(`
        INSERT INTO local_repos (
          id, local_root, local_root_hash, git_remote_url, github_repo_id,
          full_name, default_branch, prod_branch, selected, matched, created_at, updated_at
        )
        VALUES ('repo-1', '/Users/example/project', 'hash', 'git@github.com:owner/repo.git', NULL,
          'owner/repo', 'main', 'main', 1, 1, ?, ?)
      `).run(now, now);

      const result = await syncGithubCodeTotals(db, { token: 'test-token', fetchImpl });
      const repo = db.prepare(`
        SELECT github_repo_id, last_remote_sync_at
        FROM local_repos
        WHERE id = 'repo-1'
      `).get() as { github_repo_id: number | null; last_remote_sync_at: string | null };

      expect(result.invariant_violations).toEqual([]);
      expect(result.verified_repo_count).toBe(1);
      expect(repo.github_repo_id).toBe(101);
      expect(repo.last_remote_sync_at).not.toBeNull();
      expect(calls.some((url) => url.endsWith('/repos/owner/repo'))).toBe(true);
      expect(db.prepare('SELECT COUNT(*) AS count FROM profile_summary_local').get()).toMatchObject({ count: 4 });
    } finally {
      store.close();
    }
  });

  it('continues remote verification when one selected repo is inaccessible', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-core-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-01T10:00:00.000Z';
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = input.toString();
      calls.push(url);
      if (url.endsWith('/repos/owner/missing')) {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, statusText: 'Not Found' });
      }
      if (url.endsWith('/repos/owner/good')) {
        return new Response(JSON.stringify({
          id: 202,
          full_name: 'owner/good',
          default_branch: 'main',
        }), { status: 200 });
      }
      if (url.includes('/repos/owner/good/commits?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error(`unexpected GitHub request: ${url}`);
    };

    try {
      db.prepare(`
        INSERT INTO github_identity (
          github_user_id, login, avatar_url, verified_emails_json, connected_at, updated_at
        )
        VALUES (123, 'dev-user', NULL, '[]', ?, ?)
      `).run(now, now);
      db.prepare(`
        INSERT INTO local_repos (
          id, local_root, local_root_hash, git_remote_url, github_repo_id,
          full_name, default_branch, prod_branch, selected, matched, created_at, updated_at
        )
        VALUES
          ('repo-missing', '/Users/example/missing', 'hash-missing', 'git@github.com:owner/missing.git', NULL,
            'owner/missing', 'main', 'main', 1, 1, ?, ?),
          ('repo-good', '/Users/example/good', 'hash-good', 'git@github.com:owner/good.git', NULL,
            'owner/good', 'main', 'main', 1, 1, ?, ?)
      `).run(now, now, now, now);

      const result = await syncGithubCodeTotals(db, { token: 'test-token', fetchImpl });
      const repos = db.prepare(`
        SELECT id, github_repo_id, last_remote_sync_at, remote_sync_error
        FROM local_repos
        ORDER BY id
      `).all() as Array<{
        id: string;
        github_repo_id: number | null;
        last_remote_sync_at: string | null;
        remote_sync_error: string | null;
      }>;
      const good = repos.find((repo) => repo.id === 'repo-good');
      const missing = repos.find((repo) => repo.id === 'repo-missing');

      expect(result.verified_repo_count).toBe(1);
      expect(result.invariant_violations[0]).toContain('owner/missing');
      expect(good?.github_repo_id).toBe(202);
      expect(good?.last_remote_sync_at).not.toBeNull();
      expect(good?.remote_sync_error).toBeNull();
      expect(missing?.github_repo_id).toBeNull();
      expect(missing?.last_remote_sync_at).toBeNull();
      expect(missing?.remote_sync_error).toContain('404 Not Found');
      expect(calls.some((url) => url.endsWith('/repos/owner/good'))).toBe(true);
      expect(calls.some((url) => url.endsWith('/repos/owner/missing'))).toBe(true);
    } finally {
      store.close();
    }
  });

  it('refreshes a stale local prod branch from the GitHub default branch', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-core-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-01T10:00:00.000Z';
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = input.toString();
      calls.push(url);
      if (url.endsWith('/repos/owner/repo')) {
        return new Response(JSON.stringify({
          id: 101,
          full_name: 'owner/repo',
          default_branch: 'main',
        }), { status: 200 });
      }
      if (url.includes('/repos/owner/repo/commits?')) {
        expect(url).toContain('sha=main');
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error(`unexpected GitHub request: ${url}`);
    };

    try {
      db.prepare(`
        INSERT INTO github_identity (
          github_user_id, login, avatar_url, verified_emails_json, connected_at, updated_at
        )
        VALUES (123, 'dev-user', NULL, '[]', ?, ?)
      `).run(now, now);
      db.prepare(`
        INSERT INTO local_repos (
          id, local_root, local_root_hash, git_remote_url, github_repo_id,
          full_name, default_branch, prod_branch, selected, matched, created_at, updated_at
        )
        VALUES ('repo-1', '/Users/example/project', 'hash', 'git@github.com:owner/repo.git', 101,
          'owner/repo', 'feat/local-worktree', 'feat/local-worktree', 1, 1, ?, ?)
      `).run(now, now);

      await syncGithubCodeTotals(db, { token: 'test-token', fetchImpl });

      const repo = db.prepare(`
        SELECT default_branch, prod_branch, remote_sync_error
        FROM local_repos
        WHERE id = 'repo-1'
      `).get() as { default_branch: string; prod_branch: string; remote_sync_error: string | null };
      expect(repo).toMatchObject({
        default_branch: 'main',
        prod_branch: 'main',
        remote_sync_error: null,
      });
      expect(calls.some((url) => url.endsWith('/repos/owner/repo'))).toBe(true);
    } finally {
      store.close();
    }
  });

  it('releases a rate-limited refresh promptly and explains when to retry', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-github-paused-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    let requests = 0;
    try {
      db.exec("INSERT INTO github_identity(github_user_id,login,connected_at,updated_at) VALUES(123,'fixture',datetime('now'),datetime('now'))");
      for (const id of ['one', 'two']) db.prepare(`INSERT INTO local_repos(id,local_root,local_root_hash,full_name,prod_branch,selected,matched,created_at,updated_at)
        VALUES(?,?,?,?,'main',1,1,datetime('now'),datetime('now'))`).run(id, `/nonexistent/${id}`, id, `owner/${id}`);
      const result = await syncGithubCodeTotals(db, { token: 'fixture', fetchImpl: async () => {
        requests++;
        return Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'retry-after': '3600' } });
      } });
      expect(requests).toBe(1);
      expect(result.verified_repo_count).toBe(0);
      const rows = db.prepare('SELECT remote_sync_error FROM local_repos').all() as { remote_sync_error: string }[];
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.remote_sync_error).toContain('GitHub refresh paused: API request limit reached. Try again after');
    } finally { store.close(); }
  });

  it('retries retry-after GitHub rate-limit responses before syncing a repo', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-core-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-01T10:00:00.000Z';
    let repoRequestCount = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.endsWith('/repos/owner/repo')) {
        repoRequestCount += 1;
        if (repoRequestCount === 1) {
          return new Response(JSON.stringify({ message: 'secondary rate limit' }), {
            status: 403,
            statusText: 'Forbidden',
            headers: { 'Retry-After': '0' },
          });
        }
        return new Response(JSON.stringify({
          id: 101,
          full_name: 'owner/repo',
          default_branch: 'main',
        }), { status: 200 });
      }
      if (url.includes('/repos/owner/repo/commits?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error(`unexpected GitHub request: ${url}`);
    };

    try {
      db.prepare(`
        INSERT INTO github_identity (
          github_user_id, login, avatar_url, verified_emails_json, connected_at, updated_at
        )
        VALUES (123, 'dev-user', NULL, '[]', ?, ?)
      `).run(now, now);
      db.prepare(`
        INSERT INTO local_repos (
          id, local_root, local_root_hash, git_remote_url, github_repo_id,
          full_name, default_branch, prod_branch, selected, matched, created_at, updated_at
        )
        VALUES ('repo-1', '/Users/example/project', 'hash', 'git@github.com:owner/repo.git', NULL,
          'owner/repo', 'main', 'main', 1, 1, ?, ?)
      `).run(now, now);

      const result = await syncGithubCodeTotals(db, { token: 'test-token', fetchImpl });

      expect(repoRequestCount).toBe(2);
      expect(result.verified_repo_count).toBe(1);
      expect(result.invariant_violations).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('replaces local rename counts and dates with remote evidence, then reuses verified cache', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-core-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-01T10:00:00.000Z';
    const sha = 'abcdef1234567890abcdef1234567890abcdef12';
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = input.toString();
      calls.push(url);
      if (url.endsWith('/repos/owner/repo')) {
        return new Response(JSON.stringify({
          id: 101,
          full_name: 'owner/repo',
          default_branch: 'main',
        }), { status: 200 });
      }
      if (url.includes('/repos/owner/repo/commits?')) {
        return new Response(JSON.stringify([
          {
            sha,
            author: { login: 'dev-user' },
            commit: { author: { email: 'dev@example.com', date: now } },
          },
        ]), { status: 200 });
      }
      if (url.endsWith(`/repos/owner/repo/commits/${sha}`)) {
        return new Response(JSON.stringify({ files: [{ filename: 'src/renamed.ts', additions: 4 }] }), { status: 200 });
      }
      throw new Error(`unexpected GitHub request: ${url}`);
    };

    try {
      db.prepare(`
        INSERT INTO github_identity (
          github_user_id, login, avatar_url, verified_emails_json, connected_at, updated_at
        )
        VALUES (123, 'dev-user', NULL, ?, ?, ?)
      `).run(JSON.stringify(['dev@example.com']), now, now);
      db.prepare(`
        INSERT INTO local_repos (
          id, local_root, local_root_hash, git_remote_url, github_repo_id,
          full_name, default_branch, prod_branch, selected, matched, created_at, updated_at
        )
        VALUES ('repo-1', '/Users/example/project', 'hash', 'git@github.com:owner/repo.git', 101,
          'owner/repo', 'main', 'main', 1, 1, ?, ?)
      `).run(now, now);
      db.prepare(`
        INSERT INTO local_commits (
          repo_id, sha, committed_at, branch, nondoc_additions,
          nondoc_additions_score, prod_nondoc_additions, prod_nondoc_additions_score,
          reachable_from_prod, updated_at
        )
        VALUES ('repo-1', ?, ?, 'main', 775954, 2000, 775954, 2000, 1, ?)
      `).run(sha, '2026-06-02T10:00:00.000Z', now);

      await syncGithubCodeTotals(db, { token: 'test-token', fetchImpl });

      const shipped = db.prepare(`
        SELECT github_shipped_loc, github_shipped_loc_score, github_commit_count
        FROM github_code_daily
      `).get() as {
        github_shipped_loc: number;
        github_shipped_loc_score: number;
        github_commit_count: number;
      };
      expect(shipped).toMatchObject({
        github_shipped_loc: 4,
        github_shipped_loc_score: 4,
        github_commit_count: 1,
      });
      expect(calls.some((url) => url.endsWith(`/repos/owner/repo/commits/${sha}`))).toBe(true);
      expect(db.prepare('SELECT committed_at, remote_metrics_version FROM local_commits').get()).toEqual({ committed_at: now, remote_metrics_version: 2 });
      const detailCalls = () => calls.filter((url) => url.endsWith(`/commits/${sha}`)).length;
      expect(detailCalls()).toBe(1);
      await syncGithubCodeTotals(db, { token: 'test-token', fetchImpl });
      expect(detailCalls()).toBe(1);
    } finally {
      store.close();
    }
  });

  it('fetches prod commits without author filtering and attributes by verified email', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-core-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-01T10:00:00.000Z';
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = input.toString();
      calls.push(url);
      if (url.endsWith('/repos/owner/repo')) {
        return new Response(JSON.stringify({
          id: 101,
          full_name: 'owner/repo',
          default_branch: 'main',
        }), { status: 200 });
      }
      if (url.includes('/repos/owner/repo/commits?')) {
        return new Response(JSON.stringify([
          {
            sha: 'mine-by-email',
            author: null,
            commit: {
              author: {
                email: 'dev@example.com',
                date: '2026-06-01T09:00:00.000Z',
              },
            },
          },
          {
            sha: 'someone-else',
            author: { login: 'other-user' },
            commit: {
              author: {
                email: 'other@example.com',
                date: '2026-06-01T09:05:00.000Z',
              },
            },
          },
        ]), { status: 200 });
      }
      if (url.endsWith('/repos/owner/repo/commits/mine-by-email')) {
        return new Response(JSON.stringify({
          sha: 'mine-by-email',
          commit: {
            author: { date: '2026-06-01T09:00:00.000Z' },
          },
          files: [
            { filename: 'src/app.ts', additions: 25 },
            { filename: 'README.md', additions: 100 },
          ],
        }), { status: 200 });
      }
      throw new Error(`unexpected GitHub request: ${url}`);
    };

    try {
      db.prepare(`
        INSERT INTO github_identity (
          github_user_id, login, avatar_url, verified_emails_json, connected_at, updated_at
        )
        VALUES (123, 'dev-user', NULL, ?, ?, ?)
      `).run(JSON.stringify(['dev@example.com']), now, now);
      db.prepare(`
        INSERT INTO local_repos (
          id, local_root, local_root_hash, git_remote_url, github_repo_id,
          full_name, default_branch, prod_branch, selected, matched, created_at, updated_at
        )
        VALUES ('repo-1', '/Users/example/project', 'hash', 'git@github.com:owner/repo.git', 101,
          'owner/repo', 'main', 'main', 1, 1, ?, ?)
      `).run(now, now);

      const result = await syncGithubCodeTotals(db, { token: 'test-token', fetchImpl });
      const shipped = db.prepare(`
        SELECT github_shipped_loc, github_shipped_loc_score, github_commit_count
        FROM github_code_daily
      `).get() as {
        github_shipped_loc: number;
        github_shipped_loc_score: number;
        github_commit_count: number;
      };

      expect(calls.some((url) => url.includes('/repos/owner/repo/commits?'))).toBe(true);
      expect(calls.every((url) => !url.includes('author='))).toBe(true);
      expect(calls.some((url) => url.endsWith('/repos/owner/repo/commits/someone-else'))).toBe(false);
      expect(shipped).toMatchObject({
        github_shipped_loc: 25,
        github_shipped_loc_score: 25,
        github_commit_count: 1,
      });
      expect(result.invariant_violations).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('clears stale shipped reachability when a prod sync no longer returns a commit', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-core-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-01T10:00:00.000Z';
    const oldSha = 'abcdef1234567890abcdef1234567890abcdef12';
    const fetchImpl: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.endsWith('/repos/owner/repo')) {
        return new Response(JSON.stringify({
          id: 101,
          full_name: 'owner/repo',
          default_branch: 'main',
        }), { status: 200 });
      }
      if (url.includes('/repos/owner/repo/commits?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error(`unexpected GitHub request: ${url}`);
    };

    try {
      db.prepare(`
        INSERT INTO github_identity (
          github_user_id, login, avatar_url, verified_emails_json, connected_at, updated_at
        )
        VALUES (123, 'dev-user', NULL, '[]', ?, ?)
      `).run(now, now);
      db.prepare(`
        INSERT INTO local_repos (
          id, local_root, local_root_hash, git_remote_url, github_repo_id,
          full_name, default_branch, prod_branch, selected, matched, created_at, updated_at
        )
        VALUES ('repo-1', '/Users/example/project', 'hash', 'git@github.com:owner/repo.git', 101,
          'owner/repo', 'main', 'main', 1, 1, ?, ?)
      `).run(now, now);
      db.prepare(`
        INSERT INTO usage_session_model_rollups (
          source, provider, session_id, model, first_event_at, last_event_at,
          total_tokens, cost_usd_total, updated_at
        )
        VALUES ('codex', 'openai', 'old-session', 'gpt-5.5', ?, ?, 1000, 1, ?)
      `).run(now, now, now);
      db.prepare(`
        INSERT INTO ai_tool_events (
          event_id, source, provider, session_id, event_at, model, model_source,
          tool_name, command_kind, repo_id, commit_sha, confidence, evidence_origin,
          metadata_json, created_at
        )
        VALUES ('old-tool', 'codex', 'openai', 'old-session', ?, 'gpt-5.5', 'explicit',
          'exec_command', 'git_commit', 'repo-1', ?, 0.9, 'fixture', '{}', ?)
      `).run(now, oldSha, now);
      db.prepare(`
        INSERT INTO local_commits (
          repo_id, sha, committed_at, branch, nondoc_additions,
          nondoc_additions_score, prod_nondoc_additions, prod_nondoc_additions_score,
          reachable_from_prod, updated_at
        )
        VALUES ('repo-1', ?, ?, 'main', 10, 10, 10, 10, 1, ?)
      `).run(oldSha, now, now);

      await syncGithubCodeTotals(db, { token: 'test-token', fetchImpl });

      const commit = db.prepare(`
        SELECT reachable_from_prod, prod_nondoc_additions, prod_nondoc_additions_score
        FROM local_commits
        WHERE sha = ?
      `).get(oldSha) as {
        reachable_from_prod: number;
        prod_nondoc_additions: number;
        prod_nondoc_additions_score: number;
      };
      const codeDaily = db.prepare(`
        SELECT produced_loc, shipped_loc
        FROM code_daily_rollups
      `).get() as { produced_loc: number; shipped_loc: number };

      expect(commit).toMatchObject({
        reachable_from_prod: 0,
        prod_nondoc_additions: 0,
        prod_nondoc_additions_score: 0,
      });
      expect(codeDaily).toMatchObject({
        produced_loc: 10,
        shipped_loc: 0,
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM ai_linked_code_daily').get()).toMatchObject({ count: 0 });
    } finally {
      store.close();
    }
  });

  it('resolves direct SHA evidence from local git without marking it shipped', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-core-'));
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-repo-'));
    const store = openLocalStore({ dataDir });
    const db = store.db;
    const now = '2026-06-01T10:00:00.000Z';

    try {
      await execFileAsync('git', ['-C', repoRoot, 'init']);
      await execFileAsync('git', ['-C', repoRoot, 'config', 'user.email', 'dev@example.com']);
      await execFileAsync('git', ['-C', repoRoot, 'config', 'user.name', 'Dev Example']);
      await mkdir(path.join(repoRoot, 'src'), { recursive: true });
      await writeFile(path.join(repoRoot, 'src', 'feature.ts'), 'export const value = 1;\nexport const next = 2;\n', 'utf8');
      await writeFile(path.join(repoRoot, 'README.md'), 'ignored doc\n', 'utf8');
      await execFileAsync('git', ['-C', repoRoot, 'add', '.']);
      await execFileAsync('git', ['-C', repoRoot, 'commit', '-m', 'local produced work']);
      const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'rev-parse', 'HEAD']);
      const sha = stdout.trim();

      db.prepare(`
        INSERT INTO local_repos (
          id, local_root, local_root_hash, git_remote_url, github_repo_id,
          full_name, default_branch, prod_branch, selected, matched, created_at, updated_at
        )
        VALUES ('repo-local', ?, 'hash', 'git@github.com:owner/local.git', 202,
          'owner/local', 'main', 'main', 1, 1, ?, ?)
      `).run(repoRoot, now, now);
      db.prepare(`
        INSERT INTO usage_session_model_rollups (
          source, provider, session_id, model, first_event_at, last_event_at,
          total_tokens, cost_usd_total, updated_at
        )
        VALUES ('claude', 'anthropic', 'local-session', 'claude-opus-4-8', ?, ?, 3000, 3, ?)
      `).run(now, now, now);
      db.prepare(`
        INSERT INTO ai_tool_events (
          event_id, source, provider, session_id, event_at, model, model_source,
          tool_name, command_kind, repo_id, commit_sha, confidence, evidence_origin,
          metadata_json, created_at
        )
        VALUES ('tool-local', 'claude', 'anthropic', 'local-session', ?, 'claude-opus-4-8', 'explicit',
          'Bash', 'git_commit', 'repo-local', ?, 0.9, 'fixture', '{}', ?)
      `).run(now, sha.slice(0, 12), now);

      const synced = await syncLocalGitCommitEvidence(db);

      expect(synced).toBeGreaterThanOrEqual(1);
      const commit = db.prepare('SELECT sha, nondoc_additions, reachable_from_prod FROM local_commits').get() as {
        sha: string;
        nondoc_additions: number;
        reachable_from_prod: number;
      };
      expect(commit.sha).toBe(sha);
      expect(commit.nondoc_additions).toBe(2);
      expect(commit.reachable_from_prod).toBe(0);

      const codeDaily = db.prepare('SELECT produced_loc, shipped_loc, ai_linked_commit_count FROM code_daily_rollups').get() as {
        produced_loc: number;
        shipped_loc: number;
        ai_linked_commit_count: number;
      };
      expect(codeDaily).toMatchObject({
        produced_loc: 2,
        shipped_loc: 0,
        ai_linked_commit_count: 1,
      });
      const profile = buildLocalProfile(db);
      expect(profile.shipped?.produced_loc_total).toBe(2);
      expect(profile.shipped?.produced_shipped_loc_total).toBe(0);
      expect(profile.shipped?.linked_tokens_per_day_90d.some((value) => value === 3000)).toBe(true);
      expect(db.prepare('SELECT COUNT(*) AS count FROM ai_linked_code_daily').get()).toMatchObject({ count: 0 });
    } finally {
      store.close();
    }
  });
});
