import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

import type { LocalDiscoveredRepo, LocalDiscoveredUsageSource } from '@tokensrank/shared';

import type { LocalDatabase } from './db.js';
import { nowIso } from './db.js';
import { sha256Hex } from './hash.js';
import type { LocalCoreOptions } from './types.js';
import { resolveHomeDir } from './paths.js';
import { shouldParseUsageFile, usageSourceForPath } from './parser.js';

const execFileAsync = promisify(execFile);
const MAX_USAGE_SCAN_DEPTH = 7;
const MAX_REPO_SCAN_DEPTH = 5;

type WalkEntry = {
  path: string;
  depth: number;
};

type RepoCandidate = {
  localRoot: string;
  sourceRoot: string;
  gitOriginUrl: string | null;
  gitBranch: string | null;
};

type DiscoveredRepoWithAliases = LocalDiscoveredRepo & {
  root_aliases: string[];
};

export function candidateUsageRoots(options: LocalCoreOptions = {}): string[] {
  const home = resolveHomeDir(options);
  const platform = os.platform();
  const roots = new Set<string>();

  roots.add(path.join(home, '.claude', 'projects'));
  roots.add(path.join(home, '.codex', 'sessions'));
  roots.add(path.join(home, '.codex', 'state_5.sqlite'));
  roots.add(path.join(home, '.local', 'share', 'opencode', 'opencode.db'));

  if (platform === 'win32') {
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    if (appData) {
      roots.add(path.join(appData, 'Claude'));
      roots.add(path.join(appData, 'Codex'));
      roots.add(path.join(appData, 'opencode', 'opencode.db'));
    }
    if (localAppData) {
      roots.add(path.join(localAppData, 'Claude'));
      roots.add(path.join(localAppData, 'Codex'));
      roots.add(path.join(localAppData, 'opencode', 'opencode.db'));
    }
  } else if (platform === 'darwin') {
    roots.add(path.join(home, 'Library', 'Application Support', 'Claude'));
    roots.add(path.join(home, 'Library', 'Application Support', 'Codex'));
  } else {
    roots.add(path.join(home, '.config', 'claude'));
    roots.add(path.join(home, '.config', 'codex'));
    roots.add(path.join(home, '.config', 'opencode', 'opencode.db'));
    roots.add(path.join(home, '.local', 'share', 'claude'));
    roots.add(path.join(home, '.local', 'share', 'codex'));
  }

  return Array.from(roots);
}

export function candidateRepoRoots(options: LocalCoreOptions = {}): string[] {
  const home = resolveHomeDir(options);
  return [
    process.cwd(),
    path.join(home, 'Code'),
    path.join(home, 'Developer'),
    path.join(home, 'Projects'),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
  ];
}

async function existsDirectory(root: string): Promise<boolean> {
  try {
    const fileStat = await stat(root);
    return fileStat.isDirectory();
  } catch {
    return false;
  }
}

async function existsFile(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

async function walkFiles(root: string, maxDepth: number): Promise<string[]> {
  const files: string[] = [];
  const queue: WalkEntry[] = [{ path: root, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    let entries: Dirent<string>[];
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const childPath = path.join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        if (current.depth < maxDepth) {
          queue.push({ path: childPath, depth: current.depth + 1 });
        }
        continue;
      }

      if (entry.isFile()) {
        files.push(childPath);
      }
    }
  }

  return files;
}

function shouldAutoDiscoverUsageFile(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  return (basename.endsWith('.jsonl') || basename === 'opencode.db')
    && shouldParseUsageFile(filePath)
    && usageSourceForPath(filePath) !== 'unknown';
}

function usageSourceForRoot(root: string): 'claude' | 'codex' | 'opencode' {
  const lower = root.toLowerCase().replace(/\\/gu, '/');
  if (lower.includes('opencode')) return 'opencode';
  if (lower.includes('claude')) return 'claude';
  return 'codex';
}

export async function discoverUsageFiles(options: LocalCoreOptions = {}): Promise<string[]> {
  const found = new Set<string>();
  for (const root of candidateUsageRoots(options)) {
    if (root.endsWith('.sqlite') || root.endsWith('.db')) {
      if ((await existsFile(root)) && shouldAutoDiscoverUsageFile(root)) {
        found.add(root);
      }
      continue;
    }
    if (!(await existsDirectory(root))) continue;
    const files = await walkFiles(root, MAX_USAGE_SCAN_DEPTH);
    for (const filePath of files) {
      if (shouldAutoDiscoverUsageFile(filePath)) {
        found.add(filePath);
      }
    }
  }
  return Array.from(found).sort();
}

export async function discoverUsageSources(options: LocalCoreOptions = {}): Promise<LocalDiscoveredUsageSource[]> {
  const sources = new Map<string, LocalDiscoveredUsageSource>();
  for (const root of candidateUsageRoots(options)) {
    const isFileRoot = root.endsWith('.sqlite') || root.endsWith('.db');
    const readable = isFileRoot ? await existsFile(root) : await existsDirectory(root);
    if (!readable) {
      const source = usageSourceForRoot(root);
      sources.set(root, {
        source,
        root_path: root,
        file_count: 0,
        readable: false,
        last_seen_at: null,
      });
      continue;
    }

    const files = isFileRoot
      ? [root]
      : (await walkFiles(root, MAX_USAGE_SCAN_DEPTH))
        .filter((filePath) => shouldAutoDiscoverUsageFile(filePath));
    const source = usageSourceForRoot(root);
    sources.set(root, {
      source,
      root_path: root,
      file_count: files.length,
      readable: true,
      last_seen_at: files.length > 0 ? nowIso() : null,
    });
  }

  return Array.from(sources.values());
}

function parseGithubFullName(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const ssh = remoteUrl.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/iu);
  if (ssh) {
    return `${ssh[1]}/${ssh[2]}`;
  }
  try {
    const url = new URL(remoteUrl);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    const parts = url.pathname.replace(/^\/|\.git$/gu, '').split('/');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return `${parts[0]}/${parts[1]}`;
    }
  } catch {
    return null;
  }
  return null;
}

async function gitConfig(repoPath: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'config', '--get', key], { timeout: 5000 });
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

async function gitRoot(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--show-toplevel'], { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function gitCommonDir(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function displayRootForGitRoot(repoPath: string): Promise<string> {
  const commonDir = await gitCommonDir(repoPath);
  if (!commonDir) return repoPath;
  const normalized = commonDir.replace(/\\/gu, '/');
  const worktreeMarker = '/.git/worktrees/';
  const worktreeIndex = normalized.indexOf(worktreeMarker);
  if (worktreeIndex >= 0) {
    return commonDir.slice(0, worktreeIndex);
  }
  return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : repoPath;
}

async function gitBranches(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'branch', '--format=%(refname:short)'], { timeout: 5000 });
    return Array.from(new Set(stdout
      .split('\n')
      .map((branch) => branch.trim())
      .filter(Boolean)
      .filter((branch) => !branch.includes(' -> '))
    )).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function orderedBranches(...groups: Array<string | null | undefined | string[]>): string[] {
  const out: string[] = [];
  for (const group of groups) {
    const values = Array.isArray(group) ? group : [group];
    for (const value of values) {
      const branch = value?.trim();
      if (branch && !out.includes(branch)) {
        out.push(branch);
      }
    }
  }
  return out;
}

async function isGitRepo(root: string): Promise<boolean> {
  try {
    const fileStat = await stat(path.join(root, '.git'));
    return fileStat.isDirectory() || fileStat.isFile();
  } catch {
    return false;
  }
}

async function walkRepos(root: string): Promise<string[]> {
  const repos = new Set<string>();
  const queue: WalkEntry[] = [{ path: root, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    if (await isGitRepo(current.path)) {
      repos.add(current.path);
      continue;
    }

    let entries: Dirent<string>[];
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (
        entry.name === 'node_modules'
        || entry.name === '.git'
        || entry.name === '.worktrees'
        || entry.name.startsWith('.cache')
      ) continue;
      if (current.depth < MAX_REPO_SCAN_DEPTH) {
        queue.push({ path: path.join(current.path, entry.name), depth: current.depth + 1 });
      }
    }
  }

  return Array.from(repos);
}

async function discoverCodexStateRepoRoots(options: LocalCoreOptions = {}): Promise<Array<{
  localRoot: string;
  sourceRoot: string;
  gitOriginUrl: string | null;
  gitBranch: string | null;
}>> {
  const statePath = path.join(resolveHomeDir(options), '.codex', 'state_5.sqlite');
  if (!(await existsFile(statePath))) {
    return [];
  }

  let sqlite: Database.Database | null = null;
  try {
    sqlite = new Database(statePath, { readonly: true, fileMustExist: true });
    const rows = sqlite.prepare(`
      SELECT DISTINCT cwd, git_origin_url, git_branch
      FROM threads
      WHERE cwd IS NOT NULL AND cwd != ''
      ORDER BY updated_at DESC
      LIMIT 500
    `).all() as Array<{ cwd: string; git_origin_url: string | null; git_branch: string | null }>;

    const roots = new Map<string, { localRoot: string; sourceRoot: string; gitOriginUrl: string | null; gitBranch: string | null }>();
    for (const row of rows) {
      const root = await gitRoot(row.cwd);
      if (!root) continue;
      const displayRoot = await displayRootForGitRoot(root);
      const existing = roots.get(displayRoot);
      if (!existing) {
        roots.set(displayRoot, {
          localRoot: displayRoot,
          sourceRoot: root,
          gitOriginUrl: row.git_origin_url,
          gitBranch: row.git_branch,
        });
      }
    }
    return Array.from(roots.values());
  } catch {
    return [];
  } finally {
    sqlite?.close();
  }
}

export async function discoverLocalRepos(options: LocalCoreOptions = {}): Promise<DiscoveredRepoWithAliases[]> {
  const found = new Map<string, RepoCandidate[]>();
  function addCandidate(candidate: RepoCandidate): void {
    const current = found.get(candidate.localRoot) ?? [];
    current.push(candidate);
    found.set(candidate.localRoot, current);
  }

  const codexStateRepos = await discoverCodexStateRepoRoots(options);
  for (const repo of codexStateRepos) {
    addCandidate(repo);
  }
  for (const root of candidateRepoRoots(options)) {
    if (!(await existsDirectory(root))) continue;
    for (const repoPath of await walkRepos(root)) {
      const displayRoot = await displayRootForGitRoot(repoPath);
      addCandidate({
        localRoot: displayRoot,
        sourceRoot: repoPath,
        gitOriginUrl: null,
        gitBranch: null,
      });
    }
  }

  const repos: DiscoveredRepoWithAliases[] = [];
  for (const [repoPath, candidates] of Array.from(found.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    const remoteUrl = await gitConfig(repoPath, 'remote.origin.url');
    const codexStateMatch = candidates.find((repo) => repo.gitOriginUrl || repo.gitBranch);
    const effectiveRemoteUrl = remoteUrl ?? codexStateMatch?.gitOriginUrl ?? null;
    const fullName = parseGithubFullName(remoteUrl);
    const fullNameFromCodex = parseGithubFullName(effectiveRemoteUrl);
    const discoveredBranches = await gitBranches(repoPath);
    const configuredDefaultBranch = await gitConfig(repoPath, 'init.defaultBranch');
    const defaultBranch = discoveredBranches.find((branch) => branch === 'main')
      ?? discoveredBranches.find((branch) => branch === 'master')
      ?? configuredDefaultBranch
      ?? discoveredBranches[0]
      ?? 'main';
    const branches = orderedBranches(defaultBranch, codexStateMatch?.gitBranch, 'main', discoveredBranches);
    const worktreeCount = Math.max(0, new Set(candidates.map((candidate) => candidate.sourceRoot)).size - 1);
    const rootAliases = Array.from(new Set([
      repoPath,
      ...candidates.map((candidate) => candidate.sourceRoot),
    ])).sort((a, b) => a.localeCompare(b));
    repos.push({
      id: sha256Hex(repoPath),
      local_root: repoPath,
      git_remote_url: effectiveRemoteUrl,
      github_repo_id: null,
      full_name: fullName ?? fullNameFromCodex,
      default_branch: defaultBranch,
      prod_branch: defaultBranch,
      last_remote_sync_at: null,
      remote_sync_error: null,
      branches,
      worktree_count: worktreeCount,
      selected: Boolean(fullName ?? fullNameFromCodex),
      matched: Boolean(fullName ?? fullNameFromCodex),
      root_aliases: rootAliases,
    });
  }

  return repos;
}

export function upsertDiscoveredRepos(db: LocalDatabase, repos: LocalDiscoveredRepo[]): number {
  const stmt = db.prepare(`
    INSERT INTO local_repos (
      id, local_root, local_root_hash, git_remote_url, github_repo_id, full_name,
      default_branch, prod_branch, branches_json, worktree_count, selected, matched, created_at, updated_at
    )
    VALUES (
      @id, @local_root, @local_root_hash, @git_remote_url, @github_repo_id, @full_name,
      @default_branch, @prod_branch, @branches_json, @worktree_count, @selected, @matched, @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      git_remote_url = excluded.git_remote_url,
      github_repo_id = COALESCE(local_repos.github_repo_id, excluded.github_repo_id),
      full_name = COALESCE(local_repos.full_name, excluded.full_name),
      default_branch = COALESCE(excluded.default_branch, local_repos.default_branch),
      prod_branch = COALESCE(local_repos.prod_branch, excluded.prod_branch),
      branches_json = excluded.branches_json,
      worktree_count = excluded.worktree_count,
      matched = excluded.matched,
      updated_at = excluded.updated_at
  `);
	  const now = nowIso();
	  const rootStmt = db.prepare(`
	    INSERT INTO local_repo_roots (
	      repo_id, local_root, local_root_hash, kind, created_at, updated_at
	    )
	    VALUES (?, ?, ?, ?, ?, ?)
	    ON CONFLICT(local_root_hash) DO UPDATE SET
	      repo_id = excluded.repo_id,
	      local_root = excluded.local_root,
	      kind = excluded.kind,
	      updated_at = excluded.updated_at
	  `);
	  const aliasRowsStmt = db.prepare(`
	    SELECT id
	    FROM local_repos
	    WHERE id != ?
	      AND local_root_hash = ?
	  `);
	  const staleRepoRowsStmt = db.prepare(`
	    SELECT id, local_root
	    FROM local_repos
	    WHERE id != ?
	  `);
	  const copyCommitStmt = db.prepare(`
	    INSERT OR IGNORE INTO local_commits (
	      repo_id, sha, committed_at, author_email, branch, nondoc_additions,
	      nondoc_additions_score, prod_nondoc_additions, prod_nondoc_additions_score,
	      reachable_from_prod, updated_at
	    )
	    SELECT ?, sha, committed_at, author_email, branch, nondoc_additions,
	      nondoc_additions_score, prod_nondoc_additions, prod_nondoc_additions_score,
	      reachable_from_prod, ?
	    FROM local_commits
	    WHERE repo_id = ?
	  `);
	  const deleteOldCommitsStmt = db.prepare('DELETE FROM local_commits WHERE repo_id = ?');
	  const updateToolEventsStmt = db.prepare('UPDATE ai_tool_events SET repo_id = ? WHERE repo_id = ?');
	  const updateThreadsStmt = db.prepare('UPDATE ai_threads SET repo_id = ?, updated_at = ? WHERE repo_id = ?');
	  const deleteOldLinksStmt = db.prepare('DELETE FROM ai_commit_links WHERE repo_id = ?');
	  const disableAliasRepoStmt = db.prepare(`
	    UPDATE local_repos
	    SET selected = 0,
	      matched = 0,
	      updated_at = ?
	    WHERE id = ?
	  `);
	  const run = db.transaction((nextRepos: LocalDiscoveredRepo[]) => {
	    for (const repo of nextRepos) {
	      const foldedRepoIds = new Set<string>();
	      const foldStaleRepo = (staleId: string) => {
	        if (foldedRepoIds.has(staleId)) return;
	        foldedRepoIds.add(staleId);
	        copyCommitStmt.run(repo.id, now, staleId);
	        deleteOldCommitsStmt.run(staleId);
	        updateToolEventsStmt.run(repo.id, staleId);
	        updateThreadsStmt.run(repo.id, now, staleId);
	        deleteOldLinksStmt.run(staleId);
	        disableAliasRepoStmt.run(now, staleId);
	      };
	      stmt.run({
        ...repo,
        local_root_hash: sha256Hex(repo.local_root),
        branches_json: JSON.stringify(repo.branches),
        selected: repo.selected ? 1 : 0,
        matched: repo.matched ? 1 : 0,
        created_at: now,
	        updated_at: now,
	      });

	      const aliases = Array.from(new Set([
	        repo.local_root,
	        ...(((repo as DiscoveredRepoWithAliases).root_aliases) ?? []),
	      ]));
	      for (const alias of aliases) {
	        const aliasHash = sha256Hex(alias);
	        rootStmt.run(
	          repo.id,
	          alias,
	          aliasHash,
	          alias === repo.local_root ? 'root' : 'alias',
	          now,
	          now,
	        );
	        const staleRows = aliasRowsStmt.all(repo.id, aliasHash) as Array<{ id: string }>;
	        for (const stale of staleRows) {
	          foldStaleRepo(stale.id);
	        }
	      }

	      const normalizedRepoRoot = repo.local_root.replace(/\\/gu, '/').replace(/\/+$/u, '');
	      const staleRepoRows = staleRepoRowsStmt.all(repo.id) as Array<{ id: string; local_root: string }>;
	      for (const stale of staleRepoRows) {
	        const normalizedStaleRoot = stale.local_root.replace(/\\/gu, '/').replace(/\/+$/u, '');
	        if (!normalizedStaleRoot.startsWith(`${normalizedRepoRoot}/.worktrees/`)) continue;
	        rootStmt.run(
	          repo.id,
	          stale.local_root,
	          sha256Hex(stale.local_root),
	          'alias',
	          now,
	          now,
	        );
	        foldStaleRepo(stale.id);
	      }
	    }
	  });
  run(repos);
  return repos.length;
}

export function listStoredRepos(db: LocalDatabase): LocalDiscoveredRepo[] {
  const rows = db.prepare(`
    SELECT id, local_root, git_remote_url, github_repo_id, full_name,
      default_branch, prod_branch, last_remote_sync_at, remote_sync_error,
      branches_json, worktree_count, selected, matched
    FROM local_repos
    ORDER BY selected DESC, full_name ASC, local_root ASC
  `).all() as Array<{
    id: string;
    local_root: string;
    git_remote_url: string | null;
    github_repo_id: number | null;
    full_name: string | null;
    default_branch: string | null;
    prod_branch: string | null;
    last_remote_sync_at: string | null;
    remote_sync_error: string | null;
    branches_json: string | null;
    worktree_count: number;
    selected: 0 | 1;
    matched: 0 | 1;
  }>;

  return rows
    .filter((row) => !row.local_root.includes('/.worktrees/') && !row.local_root.includes('\\.worktrees\\'))
    .map((row) => {
    const { branches_json: branchesJson, selected, matched, ...repo } = row;
    let branches: string[] = [];
    try {
      const parsed = JSON.parse(branchesJson || '[]') as unknown;
      branches = Array.isArray(parsed) ? parsed.filter((branch): branch is string => typeof branch === 'string' && branch.length > 0) : [];
    } catch {
      branches = [];
    }

    return {
      ...repo,
      branches,
      worktree_count: Number(repo.worktree_count ?? 0),
      selected: selected === 1,
      matched: matched === 1,
    };
  });
}
