import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { GITHUB_CODE_METRICS_VERSION, GITHUB_CODE_PER_COMMIT_CAP, isNonShippingPath, readGithubCodeCounts, type LocalGithubIdentity } from '@tokensrank/shared';

import type { LocalDatabase } from './db.js';
import { nowIso, readJson, writeSyncState } from './db.js';
import { rebuildLocalProfileSummary } from './scoring.js';
import { readGithubToken, secretRef, storeSecret } from './secrets.js';
import type { GithubVerificationResult } from './types.js';

const execFileAsync = promisify(execFile);
const GITHUB_API = 'https://api.github.com';
const COMMITS_PER_PAGE = 100;
const DEFAULT_DETAIL_CONCURRENCY = 12;
const DEFAULT_REQUESTS_PER_SECOND = 12;
const PER_COMMIT_CAP = GITHUB_CODE_PER_COMMIT_CAP;
const DIRECT_COMMIT_CONFIDENCE = 0.9;
const FETCH_TIMEOUT_MS = 20_000;
const FETCH_RETRIES = 4;
const RATE_LIMIT_BACKOFF_FLOOR_MS = 60_000;

type FetchImpl = typeof fetch;

type GithubUser = {
  id: number;
  login: string;
  avatar_url?: string | null;
};

type GithubEmail = {
  email?: string;
  verified?: boolean;
};

type GithubRepo = {
  id: number;
  full_name: string;
  default_branch: string;
};

type GithubCommitListItem = {
  sha: string;
  commit?: { author?: { date?: string; email?: string } | null } | null;
  author?: { login?: string } | null;
};

type GithubCommitDetail = {
  sha: string;
  commit?: { author?: { date?: string; email?: string } | null } | null;
  files?: Array<{ filename: string; additions?: number }> | null;
};

type SelectedRepoRow = {
  id: string;
  local_root?: string;
  github_repo_id: number | null;
  full_name: string;
  default_branch: string | null;
  prod_branch: string;
};

type UsageSource = 'claude' | 'codex' | 'opencode';

type ModelTokenPool = {
  source: UsageSource;
  sessionId: string;
  model: string;
  totalTokens: number;
  costUsd: number;
};

type CommitContribution = {
  localRepoId: string;
  repoId: number;
  fullName: string;
  prodBranch: string;
  sha: string;
  date: string;
  commitMs: number;
  rawLoc: number;
  scoreLoc: number;
};

export type GithubSyncProgress = {
  stage: 'matching_repos' | 'listing_commits' | 'fetching_commit_details' | 'rebuilding_links' | 'completed';
  repos_total: number;
  repos_synced: number;
  commits_total: number;
  commits_processed: number;
  current_repo: string | null;
  errors: number;
};

type LocalCommitRow = {
  repo_id: string;
  github_repo_id: number | null;
  full_name: string | null;
  sha: string;
  committed_at: string;
  nondoc_additions: number;
  nondoc_additions_score: number;
  prod_nondoc_additions: number;
  prod_nondoc_additions_score: number;
  reachable_from_prod: number;
};

type LocCounts = {
  raw: number;
  score: number;
};

type GithubRequestLimiter = {
  waitTurn: () => Promise<void>;
  deferUntil: (untilMs: number) => void;
  stop: (error: Error) => void;
};

type CachedRemoteCommitRow = {
  sha: string;
  committed_at: string;
  rawLoc: number;
  scoreLoc: number;
};

function modelPoolKey(source: UsageSource, sessionId: string, model: string): string {
  return JSON.stringify([source, sessionId, model]);
}

function candidateKey(candidate: LinkCandidate): string {
  return JSON.stringify([
    candidate.source,
    candidate.sessionId,
    candidate.model,
    candidate.repoId,
    candidate.commitSha,
  ]);
}

function commitKey(repoId: string, sha: string): string {
  return JSON.stringify([repoId, sha]);
}

function repoSyncErrorMessage(repo: Pick<SelectedRepoRow, 'full_name'>, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${repo.full_name}: ${message}`;
}

function markRepoRemoteSyncError(db: LocalDatabase, repo: Pick<SelectedRepoRow, 'id' | 'full_name'>, error: unknown): string {
  const message = repoSyncErrorMessage(repo, error);
  const now = nowIso();
  db.prepare(`
    UPDATE local_repos
    SET remote_sync_error = ?,
      last_remote_sync_at = NULL,
      updated_at = ?
    WHERE id = ?
  `).run(message, now, repo.id);
  return message;
}

type SelectedLocalRepoRow = {
  id: string;
  local_root: string;
  github_repo_id: number | null;
  full_name: string | null;
  prod_branch: string | null;
};

type ToolCommitEvidenceRow = {
  source: UsageSource;
  provider: 'anthropic' | 'openai' | 'unknown';
  session_id: string;
  model: string;
  repo_id: string | null;
  commit_sha: string;
  confidence: number;
};

type LinkCandidate = {
  source: UsageSource;
  provider: 'anthropic' | 'openai' | 'unknown';
  sessionId: string;
  model: string;
  repoId: string;
  commitSha: string;
  confidence: number;
  reason: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}



function dateOnly(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : date.toISOString().slice(0, 10);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function createLimiter(requestsPerSecond = DEFAULT_REQUESTS_PER_SECOND): GithubRequestLimiter {
  const intervalMs = Math.ceil(1000 / requestsPerSecond);
  let nextSlotAt = 0;
  let deferredUntil = 0;
  let stopped: Error | null = null;
  return {
    waitTurn: async () => {
      if (stopped) throw stopped;
      const now = Date.now();
      const waitUntil = Math.max(now, nextSlotAt, deferredUntil);
      nextSlotAt = waitUntil + intervalMs;
      if (waitUntil > now) await sleep(waitUntil - now);
      if (stopped) throw stopped;
    },
    deferUntil: (untilMs: number) => {
      deferredUntil = Math.max(deferredUntil, untilMs);
    },
    stop: (error) => { stopped = error; },
  };
}

function parseRetryAfterMs(response: Response): number | null {
  const retryAfter = response.headers.get('retry-after');
  if (!retryAfter) return null;
  const seconds = Number.parseInt(retryAfter, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function parsePrimaryResetDelayMs(response: Response): number | null {
  if (response.headers.get('x-ratelimit-remaining') !== '0') return null;
  const reset = Number.parseInt(response.headers.get('x-ratelimit-reset') ?? '', 10);
  if (!Number.isFinite(reset) || reset <= 0) return null;
  return Math.max(1000, (reset * 1000) - Date.now() + 1000);
}

function rateLimitDelayMs(response: Response, bodyText: string, attempt: number): number | null {
  if (response.status !== 403 && response.status !== 429) return null;
  const retryAfterMs = parseRetryAfterMs(response);
  if (retryAfterMs !== null) return retryAfterMs;
  const primaryResetMs = parsePrimaryResetDelayMs(response);
  if (primaryResetMs !== null) return primaryResetMs;
  if (/rate limit|secondary limit|abuse/iu.test(bodyText)) {
    return Math.max(RATE_LIMIT_BACKOFF_FLOOR_MS, 2000 * (2 ** attempt));
  }
  return null;
}

async function githubFetch<T>(
  path: string,
  token: string,
  fetchImpl: FetchImpl,
  limiter: GithubRequestLimiter,
  onResponse?: (response: Response) => void,
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt += 1) {
    try {
      await limiter.waitTurn();
      const response = await fetchImpl(`${GITHUB_API}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'tokensrank-local',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (response.ok) {
        onResponse?.(response);
        return await response.json() as T;
      }

      const text = await response.text().catch(() => '');
      const delayMs = rateLimitDelayMs(response, text, attempt);
      if (delayMs !== null && delayMs > 5_000) {
        const retryAt = new Date(Date.now() + delayMs).toISOString();
        const error = new Error(`[github] GitHub refresh paused: API request limit reached. Try again after ${retryAt}. Your local usage totals are still available.`);
        // Release the refresh job instead of silently sleeping for up to an hour.
        // The normal refresh schedule can retry after GitHub's allowance resets.
        limiter.stop(error);
        throw error;
      }
      if (delayMs !== null && attempt < FETCH_RETRIES) {
        limiter.deferUntil(Date.now() + delayMs);
        await sleep(delayMs);
        continue;
      }

      throw new Error(`[github] ${path} -> ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 240)}` : ''}`);
    } catch (error) {
      lastError = error;
      if (attempt >= FETCH_RETRIES) break;
      if (error instanceof Error && error.message.startsWith('[github]')) {
        break;
      }
      await sleep(500 * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`[github] ${path} failed`);
}

export async function connectGithubWithToken(
  db: LocalDatabase,
  token: string,
  fetchImpl: FetchImpl = fetch,
): Promise<LocalGithubIdentity> {
  const limiter = createLimiter();
  const [user, emails] = await Promise.all([
    githubFetch<GithubUser>('/user', token, fetchImpl, limiter),
    githubFetch<GithubEmail[]>('/user/emails', token, fetchImpl, limiter).catch(() => []),
  ]);
  const verifiedEmails = emails
    .filter((email) => email.verified && email.email)
    .map((email) => email.email as string);
  const now = nowIso();

  db.prepare(`
    INSERT INTO github_identity (
      github_user_id, login, avatar_url, verified_emails_json, token_ref, connected_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(github_user_id) DO UPDATE SET
      login = excluded.login,
      avatar_url = excluded.avatar_url,
      verified_emails_json = excluded.verified_emails_json,
      token_ref = excluded.token_ref,
      updated_at = excluded.updated_at
  `).run(
    user.id,
    user.login,
    user.avatar_url ?? null,
    JSON.stringify(verifiedEmails),
    token === process.env.GITHUB_DEV_TOKEN || token === process.env.GITHUB_TOKEN
      ? 'env:GITHUB_TOKEN'
      : await storeSecret('github', token),
    now,
    now,
  );
  writeSyncState(db, 'github_token_ref', {
    token_ref: token === process.env.GITHUB_DEV_TOKEN || token === process.env.GITHUB_TOKEN
      ? 'env:GITHUB_TOKEN'
      : secretRef('github'),
  });

  return {
    github_user_id: user.id,
    login: user.login,
    avatar_url: user.avatar_url ?? null,
    verified_emails: verifiedEmails,
    connected_at: now,
  };
}

export function getGithubIdentity(db: LocalDatabase): LocalGithubIdentity | null {
  const row = db.prepare(`
    SELECT github_user_id, login, avatar_url, verified_emails_json, connected_at
    FROM github_identity
    ORDER BY updated_at DESC
    LIMIT 1
  `).get() as {
    github_user_id: number;
    login: string;
    avatar_url: string | null;
    verified_emails_json: string;
    connected_at: string;
  } | undefined;

  if (!row) return null;
  return {
    github_user_id: row.github_user_id,
    login: row.login,
    avatar_url: row.avatar_url,
    verified_emails: readJson<string[]>(row.verified_emails_json, []),
    connected_at: row.connected_at,
  };
}

function selectedRepos(db: LocalDatabase): SelectedRepoRow[] {
  return db.prepare(`
    SELECT
      id,
      local_root,
      github_repo_id,
      full_name,
      default_branch,
      COALESCE(prod_branch, default_branch, 'main') AS prod_branch
    FROM local_repos
    WHERE selected = 1 AND full_name IS NOT NULL
      AND local_root NOT LIKE '%/.worktrees/%'
      AND local_root NOT LIKE '%\\.worktrees\\%'
    ORDER BY full_name
  `).all() as SelectedRepoRow[];
}

function selectedLocalRepos(db: LocalDatabase): SelectedLocalRepoRow[] {
  return db.prepare(`
    SELECT id, local_root, github_repo_id, full_name, COALESCE(prod_branch, default_branch, 'main') AS prod_branch
    FROM local_repos
    WHERE selected = 1
      AND local_root NOT LIKE '%/.worktrees/%'
      AND local_root NOT LIKE '%\\.worktrees\\%'
    ORDER BY full_name, local_root
  `).all() as SelectedLocalRepoRow[];
}

async function ensureGithubRepoIds(
  db: LocalDatabase,
  repos: SelectedRepoRow[],
  token: string,
  fetchImpl: FetchImpl,
  limiter: GithubRequestLimiter,
  syncErrors: string[],
): Promise<Array<SelectedRepoRow & { github_repo_id: number }>> {
  const out: Array<SelectedRepoRow & { github_repo_id: number }> = [];
  for (const repo of repos) {
    try {
      const githubRepo = await githubFetch<GithubRepo>(`/repos/${repo.full_name}`, token, fetchImpl, limiter);
      const remoteDefault = githubRepo.default_branch || 'main';
      const currentProdBranch = repo.prod_branch?.trim();
      const currentDefaultBranch = repo.default_branch?.trim();
      const prodBranch = !currentProdBranch
        || (currentDefaultBranch !== undefined && currentDefaultBranch.length > 0
          && currentProdBranch === currentDefaultBranch
          && currentDefaultBranch !== remoteDefault)
        ? remoteDefault
        : currentProdBranch;
      db.prepare(`
        UPDATE local_repos
        SET github_repo_id = ?,
          default_branch = ?,
          prod_branch = ?,
          remote_sync_error = NULL,
          updated_at = ?
        WHERE id = ?
      `).run(githubRepo.id, remoteDefault, prodBranch, nowIso(), repo.id);
      out.push({
        ...repo,
        github_repo_id: githubRepo.id,
        default_branch: remoteDefault,
        prod_branch: prodBranch,
      });
    } catch (error) {
      syncErrors.push(markRepoRemoteSyncError(db, repo, error));
    }
  }
  return out;
}

function earliestUsageDate(db: LocalDatabase): string | null {
  const row = db.prepare('SELECT MIN(event_at) AS first_event_at FROM usage_events').get() as { first_event_at: string | null };
  return row.first_event_at;
}

async function listCommitsForRepo(
  repo: SelectedRepoRow & { github_repo_id: number },
  login: string,
  emails: string[],
  sinceIso: string | null,
  token: string,
  fetchImpl: FetchImpl,
  limiter: GithubRequestLimiter,
): Promise<GithubCommitListItem[]> {
  const commits: GithubCommitListItem[] = [];
  const loginLc = login.toLowerCase();
  const emailSet = new Set(emails.map((email) => email.toLowerCase()));
  for (let page = 1; ; page += 1) {
    const params = new URLSearchParams({
      sha: repo.prod_branch,
      per_page: String(COMMITS_PER_PAGE),
      page: String(page),
    });
    if (sinceIso) params.set('since', sinceIso);
    const batch = await githubFetch<GithubCommitListItem[]>(
      `/repos/${repo.full_name}/commits?${params.toString()}`,
      token,
      fetchImpl,
      limiter,
    );
    for (const item of batch) {
      const authorLogin = item.author?.login?.toLowerCase();
      const authorEmail = item.commit?.author?.email?.toLowerCase();
      const isMine = (authorLogin !== undefined && authorLogin === loginLc)
        || (authorEmail !== undefined && emailSet.has(authorEmail));
      if (isMine) {
        commits.push(item);
      }
    }
    if (batch.length < COMMITS_PER_PAGE) break;
  }
  return commits;
}

function countShippingLocFromNumstat(numstat: string): LocCounts {
  let loc = 0;
  for (const line of numstat.split(/\r?\n/u)) {
    const [additions, , filePath] = line.split('\t');
    if (!filePath || additions === '-' || isNonShippingPath(filePath)) continue;
    const parsed = Number.parseInt(additions ?? '0', 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      loc += parsed;
    }
  }
  return { raw: loc, score: Math.min(loc, PER_COMMIT_CAP) };
}

async function resolveLocalCommit(repoRoot: string, sha: string): Promise<{
  sha: string;
  committedAt: string;
  nondocAdditions: number;
  nondocAdditionsScore: number;
} | null> {
  try {
    const rev = await execFileAsync('git', ['-C', repoRoot, 'rev-parse', '--verify', `${sha}^{commit}`], { timeout: 5000 });
    const fullSha = rev.stdout.trim();
    if (!fullSha) return null;
    const show = await execFileAsync('git', [
      '-C',
      repoRoot,
      'show',
      '--no-renames',
      '--format=%aI',
      '--numstat',
      fullSha,
    ], { timeout: 10000 });
    const [committedAtRaw = '', ...numstatLines] = show.stdout.split(/\r?\n/u);
    const committedAt = new Date(committedAtRaw.trim());
    if (Number.isNaN(committedAt.getTime())) return null;
    const loc = countShippingLocFromNumstat(numstatLines.join('\n'));
    return {
      sha: fullSha,
      committedAt: committedAt.toISOString(),
      nondocAdditions: loc.raw,
      nondocAdditionsScore: loc.score,
    };
  } catch {
    return null;
  }
}

async function listLocalCommitShas(repoRoot: string): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoRoot,
      'rev-list',
      '--all',
    ], { timeout: 20000 });
    return new Set(stdout
      .split(/\r?\n/u)
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean));
  } catch {
    return new Set();
  }
}

function resolveKnownSha(commitShas: Set<string>, sha: string): string | null {
  const normalized = sha.toLowerCase();
  if (commitShas.has(normalized)) return normalized;

  let match: string | null = null;
  for (const candidate of commitShas) {
    if (!candidate.startsWith(normalized) && !normalized.startsWith(candidate)) continue;
    if (match) return null;
    match = candidate;
  }
  return match;
}

function loadModelTokenPools(db: LocalDatabase): ModelTokenPool[] {
  return db.prepare(`
    SELECT source, session_id, model, total_tokens, cost_usd_total
    FROM usage_session_model_rollups
  `).all().map((row) => {
    const value = row as {
      source: UsageSource;
      session_id: string;
      model: string;
      total_tokens: number;
      cost_usd_total: number;
    };
    return {
      source: value.source,
      sessionId: value.session_id,
      model: value.model,
      totalTokens: value.total_tokens,
      costUsd: value.cost_usd_total,
    };
  });
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function upsertGithubAndLocalCommitRows(
  db: LocalDatabase,
  commits: CommitContribution[],
  verifiedAt: string,
  verifiedRepos: Array<SelectedRepoRow & { github_repo_id: number }>,
): void {
	  const githubDaily = new Map<string, {
	    date: string;
	    repo_id: number;
	    full_name: string;
	    prod_branch: string;
	    loc: number;
	    scoreLoc: number;
	    commits: number;
	  }>();

  for (const commit of commits) {
    const key = `${commit.date}:${commit.repoId}`;
    const existing = githubDaily.get(key);
	    if (existing) {
	      existing.loc += commit.rawLoc;
	      existing.scoreLoc += commit.scoreLoc;
	      existing.commits += 1;
	    } else {
	      githubDaily.set(key, {
        date: commit.date,
        repo_id: commit.repoId,
	        full_name: commit.fullName,
	        prod_branch: commit.prodBranch,
	        loc: commit.rawLoc,
	        scoreLoc: commit.scoreLoc,
	        commits: 1,
	      });
	    }
  }

  const write = db.transaction(() => {
	    const githubStmt = db.prepare(`
	      INSERT INTO github_code_daily (
	        date, repo_id, full_name, prod_branch, github_shipped_loc,
	        github_shipped_loc_score, github_commit_count, verified_at, verification_source, updated_at
	      )
	      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'github_remote_prod', ?)
	      ON CONFLICT(date, repo_id) DO UPDATE SET
	        full_name = excluded.full_name,
	        prod_branch = excluded.prod_branch,
	        github_shipped_loc = excluded.github_shipped_loc,
	        github_shipped_loc_score = excluded.github_shipped_loc_score,
	        github_commit_count = excluded.github_commit_count,
	        verified_at = excluded.verified_at,
	        verification_source = excluded.verification_source,
	        updated_at = excluded.updated_at
    `);
    const commitStmt = db.prepare(`
	      INSERT INTO local_commits (
	        repo_id, sha, committed_at, author_email, branch, nondoc_additions,
	        nondoc_additions_score, prod_nondoc_additions, prod_nondoc_additions_score,
	        reachable_from_prod, remote_metrics_version, updated_at
	      )
	      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, 2, ?)
	      ON CONFLICT(repo_id, sha) DO UPDATE SET
	        committed_at = excluded.committed_at,
	        branch = excluded.branch,
	        nondoc_additions = CASE
	          WHEN local_commits.nondoc_additions = 0 THEN excluded.nondoc_additions
	          ELSE local_commits.nondoc_additions
	        END,
	        nondoc_additions_score = CASE
	          WHEN local_commits.nondoc_additions_score = 0 THEN excluded.nondoc_additions_score
	          ELSE local_commits.nondoc_additions_score
	        END,
	        prod_nondoc_additions = excluded.prod_nondoc_additions,
	        prod_nondoc_additions_score = excluded.prod_nondoc_additions_score,
	        reachable_from_prod = 1,
        remote_metrics_version = 2,
	        updated_at = excluded.updated_at
	    `);

    const deleteGithubDailyStmt = db.prepare('DELETE FROM github_code_daily WHERE repo_id = ?');
    const resetProdLocalCommitsStmt = db.prepare(`
      UPDATE local_commits
      SET prod_nondoc_additions = 0,
        prod_nondoc_additions_score = 0,
        reachable_from_prod = 0,
        updated_at = ?
      WHERE repo_id = ?
    `);
    for (const repo of verifiedRepos) {
      deleteGithubDailyStmt.run(repo.github_repo_id);
      resetProdLocalCommitsStmt.run(verifiedAt, repo.id);
    }

    for (const commit of commits) {
      commitStmt.run(
        commit.localRepoId,
        commit.sha,
	        new Date(commit.commitMs).toISOString(),
	        commit.prodBranch,
	        commit.rawLoc,
	        commit.scoreLoc,
	        commit.rawLoc,
	        commit.scoreLoc,
	        verifiedAt,
	      );
	    }

	    for (const row of githubDaily.values()) {
	      githubStmt.run(row.date, row.repo_id, row.full_name, row.prod_branch, row.loc, row.scoreLoc, row.commits, verifiedAt, verifiedAt);
	    }
  });

  write();
}

function markReposRemoteSynced(
  db: LocalDatabase,
  repos: Array<SelectedRepoRow & { github_repo_id: number }>,
  verifiedAt: string,
): void {
  if (repos.length === 0) return;

  const stmt = db.prepare(`
    UPDATE local_repos
    SET last_remote_sync_at = ?,
      remote_sync_error = NULL,
      updated_at = ?
    WHERE id = ?
  `);
  db.transaction(() => {
    for (const repo of repos) {
      stmt.run(verifiedAt, verifiedAt, repo.id);
    }
  })();
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

function loadCachedRemoteCommitRows(
  db: LocalDatabase,
  repo: SelectedRepoRow & { github_repo_id: number },
  shas: string[],
): Map<string, CachedRemoteCommitRow> {
  const uniqueShas = Array.from(new Set(shas.map((sha) => sha.toLowerCase()).filter(Boolean)));
  const out = new Map<string, CachedRemoteCommitRow>();
  if (uniqueShas.length === 0) return out;

  for (const batch of chunks(uniqueShas, 500)) {
    const placeholders = batch.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT sha, committed_at, nondoc_additions, nondoc_additions_score,
        prod_nondoc_additions, prod_nondoc_additions_score
      FROM local_commits
      WHERE repo_id = ?
        AND lower(sha) IN (${placeholders})
        AND committed_at IS NOT NULL
        AND remote_metrics_version = ?
    `).all(repo.id, ...batch, GITHUB_CODE_METRICS_VERSION) as Array<{
      sha: string;
      committed_at: string;
      nondoc_additions: number | null;
      nondoc_additions_score: number | null;
      prod_nondoc_additions: number | null;
      prod_nondoc_additions_score: number | null;
    }>;

    for (const row of rows) {
      const rawLoc = Math.max(0, Number(row.prod_nondoc_additions ?? 0));
      const scoreLoc = Math.min(rawLoc, PER_COMMIT_CAP);
      out.set(row.sha.toLowerCase(), {
        sha: row.sha,
        committed_at: row.committed_at,
        rawLoc,
        scoreLoc,
      });
    }
  }

  return out;
}

function loadLocalCommits(db: LocalDatabase): LocalCommitRow[] {
  return db.prepare(`
    SELECT
      commits.repo_id,
      repos.github_repo_id,
      repos.full_name,
	      commits.sha,
	      commits.committed_at,
	      commits.nondoc_additions,
	      commits.nondoc_additions_score,
	      commits.prod_nondoc_additions,
	      commits.prod_nondoc_additions_score,
	      commits.reachable_from_prod
    FROM local_commits commits
    LEFT JOIN local_repos repos ON repos.id = commits.repo_id
    WHERE repos.selected = 1
      AND repos.local_root NOT LIKE '%/.worktrees/%'
      AND repos.local_root NOT LIKE '%\\.worktrees\\%'
  `).all() as LocalCommitRow[];
}

function loadToolCommitEvidence(db: LocalDatabase): ToolCommitEvidenceRow[] {
  return db.prepare(`
    SELECT source, provider, session_id, model, repo_id, lower(commit_sha) AS commit_sha, confidence
    FROM ai_tool_events
    WHERE commit_sha IS NOT NULL
      AND confidence >= ${DIRECT_COMMIT_CONFIDENCE}
      AND command_kind = 'git_commit'
  `).all() as ToolCommitEvidenceRow[];
}

function addCandidate(candidates: Map<string, LinkCandidate>, candidate: LinkCandidate): void {
  const key = candidateKey(candidate);
  const existing = candidates.get(key);
  if (!existing || candidate.confidence > existing.confidence) {
    candidates.set(key, candidate);
  }
}

function resolveCommitEvidence(
  evidence: ToolCommitEvidenceRow,
  commits: LocalCommitRow[],
): LocalCommitRow | null {
  const normalized = evidence.commit_sha.toLowerCase();
  const matches = commits.filter((commit) => {
    if (evidence.repo_id && evidence.repo_id !== commit.repo_id) return false;
    const commitSha = commit.sha.toLowerCase();
    return commitSha === normalized
      || commitSha.startsWith(normalized)
      || normalized.startsWith(commitSha);
  });
  if (matches.length === 1) return matches[0]!;
  return null;
}

export async function syncLocalGitCommitEvidence(db: LocalDatabase): Promise<number> {
  const repos = selectedLocalRepos(db);
  if (repos.length === 0) return 0;

  const evidenceRows = Array.from(new Map(
    loadToolCommitEvidence(db).map((row) => [`${row.repo_id ?? '*'}:${row.commit_sha}`, row])
  ).values());
  if (evidenceRows.length === 0) {
    rebuildAiCommitLinks(db);
    return 0;
  }

  const reposById = new Map(repos.map((repo) => [repo.id, repo]));
  const repoCommitShas = new Map<string, Set<string>>();
  for (const repo of repos) {
    repoCommitShas.set(repo.id, await listLocalCommitShas(repo.local_root));
  }

  const now = nowIso();
  let synced = 0;
	  const commitStmt = db.prepare(`
	    INSERT INTO local_commits (
	      repo_id, sha, committed_at, author_email, branch, nondoc_additions,
	      nondoc_additions_score, prod_nondoc_additions, prod_nondoc_additions_score,
	      reachable_from_prod, updated_at
	    )
	    VALUES (?, ?, ?, NULL, ?, ?, ?, 0, 0, 0, ?)
	    ON CONFLICT(repo_id, sha) DO UPDATE SET
	      committed_at = CASE WHEN local_commits.remote_metrics_version = 2 THEN local_commits.committed_at ELSE excluded.committed_at END,
	      branch = COALESCE(local_commits.branch, excluded.branch),
	      nondoc_additions = excluded.nondoc_additions,
	      nondoc_additions_score = excluded.nondoc_additions_score,
	      reachable_from_prod = CASE
	        WHEN local_commits.reachable_from_prod = 1 THEN 1
	        ELSE excluded.reachable_from_prod
      END,
      updated_at = excluded.updated_at
  `);

  for (const evidence of evidenceRows) {
    const candidateRepos = evidence.repo_id
      ? [reposById.get(evidence.repo_id)].filter((repo): repo is SelectedLocalRepoRow => Boolean(repo))
      : repos;
    const resolved: Array<{ repo: SelectedLocalRepoRow; commit: Awaited<ReturnType<typeof resolveLocalCommit>> }> = [];

    for (const repo of candidateRepos) {
      const knownSha = resolveKnownSha(repoCommitShas.get(repo.id) ?? new Set(), evidence.commit_sha);
      if (!knownSha) continue;
      const commit = await resolveLocalCommit(repo.local_root, knownSha);
      if (commit) {
        resolved.push({ repo, commit });
      }
    }

    if (resolved.length !== 1) continue;
    const { repo, commit } = resolved[0]!;
    if (!commit) continue;
    const result = commitStmt.run(
      repo.id,
      commit.sha,
	      commit.committedAt,
	      repo.prod_branch ?? 'main',
	      commit.nondocAdditions,
	      commit.nondocAdditionsScore,
	      now,
	    );
    synced += result.changes;
  }

  rebuildAiCommitLinks(db);
  return synced;
}

export function rebuildAiCommitLinks(db: LocalDatabase): void {
  db.transaction(() => rebuildAiCommitLinksInTransaction(db))();
}

function rebuildAiCommitLinksInTransaction(db: LocalDatabase): void {
  const commits = loadLocalCommits(db);
  const tokenPools = loadModelTokenPools(db);
  const evidenceRows = loadToolCommitEvidence(db);
  const candidates = new Map<string, LinkCandidate>();

  for (const evidence of evidenceRows) {
    const commit = resolveCommitEvidence(evidence, commits);
    if (!commit) continue;
    addCandidate(candidates, {
      source: evidence.source,
      provider: evidence.provider,
      sessionId: evidence.session_id,
      model: evidence.model || 'unknown',
      repoId: commit.repo_id,
      commitSha: commit.sha,
      confidence: Math.max(DIRECT_COMMIT_CONFIDENCE, evidence.confidence),
      reason: 'direct_commit_sha',
    });
  }

  const modelCandidateCounts = new Map<string, number>();
  for (const candidate of candidates.values()) {
    const key = modelPoolKey(candidate.source, candidate.sessionId, candidate.model);
    modelCandidateCounts.set(key, (modelCandidateCounts.get(key) ?? 0) + 1);
  }
  const modelPools = new Map(tokenPools.map((pool) => [
    modelPoolKey(pool.source, pool.sessionId, pool.model),
    pool,
  ]));
  const commitByKey = new Map(commits.map((commit) => [commitKey(commit.repo_id, commit.sha), commit]));
  const linkedCommits = new Map<string, {
    commit: LocalCommitRow;
    linkedTokens: number;
    linkedCostUsd: number;
    confidence: number;
  }>();
  const modelLinks: Array<{
    commitKey: string;
    date: string;
    source: UsageSource;
    provider: 'anthropic' | 'openai' | 'unknown';
    model: string;
    producedLoc: number;
    producedScoreLoc: number;
    shippedLoc: number;
    shippedScoreLoc: number;
    tokens: number;
    costUsd: number;
  }> = [];

  const write = db.transaction(() => {
    db.prepare('DELETE FROM ai_commit_links').run();
    db.prepare('DELETE FROM ai_linked_code_daily').run();
    db.prepare('DELETE FROM code_daily_rollups').run();
    db.prepare('DELETE FROM ai_code_model_daily').run();

    const linkStmt = db.prepare(`
      INSERT INTO ai_commit_links (
        source, session_id, repo_id, commit_sha, confidence, provider, model,
        linked_tokens, linked_cost_usd, allocation_status, link_reason, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, session_id, repo_id, commit_sha) DO UPDATE SET
        confidence = excluded.confidence,
        provider = excluded.provider,
        model = excluded.model,
        linked_tokens = excluded.linked_tokens,
        linked_cost_usd = excluded.linked_cost_usd,
        allocation_status = excluded.allocation_status,
        link_reason = excluded.link_reason,
        created_at = excluded.created_at
    `);
    const now = nowIso();

    for (const candidate of candidates.values()) {
      const modelKey = modelPoolKey(candidate.source, candidate.sessionId, candidate.model);
      const pool = modelPools.get(modelKey);
      const candidateCount = Math.max(1, modelCandidateCounts.get(modelKey) ?? 1);
      const linkedTokens = pool ? Math.round(pool.totalTokens / candidateCount) : 0;
      const linkedCostUsd = pool ? Math.round((pool.costUsd / candidateCount) * 10000) / 10000 : 0;
      const allocationStatus = pool ? 'matched' : 'missing_token_pool';
      linkStmt.run(
        candidate.source,
        candidate.sessionId,
        candidate.repoId,
        candidate.commitSha,
        candidate.confidence,
        candidate.provider,
        candidate.model,
        linkedTokens,
        linkedCostUsd,
        allocationStatus,
        candidate.reason,
        now,
      );

      const commit = commitByKey.get(commitKey(candidate.repoId, candidate.commitSha));
      if (!commit) continue;
      const linkedKey = commitKey(candidate.repoId, candidate.commitSha);
      const existing = linkedCommits.get(linkedKey);
      if (existing) {
        existing.linkedTokens += linkedTokens;
        existing.linkedCostUsd += linkedCostUsd;
        existing.confidence = Math.max(existing.confidence, candidate.confidence);
      } else {
        linkedCommits.set(linkedKey, {
          commit,
          linkedTokens,
          linkedCostUsd,
          confidence: candidate.confidence,
        });
      }

      const date = dateOnly(commit.committed_at);
      modelLinks.push({
        commitKey: linkedKey,
        date,
        source: candidate.source,
        provider: candidate.provider,
        model: candidate.model,
        producedLoc: commit.nondoc_additions,
        producedScoreLoc: commit.nondoc_additions_score,
        shippedLoc: commit.reachable_from_prod ? (commit.prod_nondoc_additions || commit.nondoc_additions) : 0,
        shippedScoreLoc: commit.reachable_from_prod ? (commit.prod_nondoc_additions_score || commit.nondoc_additions_score) : 0,
        tokens: linkedTokens,
        costUsd: linkedCostUsd,
      });
    }
  });

  write();

  // A commit may be referenced by several sessions/models. Count its code once
  // and apportion model credit by linked tokens (equal shares if none exist).
  // Largest-remainder rounding preserves the exact integer LOC total.
  const byCommit = new Map<string, Map<string, typeof modelLinks[number]>>();
  for (const row of modelLinks) {
    const models = byCommit.get(row.commitKey) ?? new Map<string, typeof row>();
    const key = `${row.source}:${row.provider}:${row.model}`;
    const existing = models.get(key);
    if (existing) { existing.tokens += row.tokens; existing.costUsd += row.costUsd; }
    else models.set(key, { ...row });
    byCommit.set(row.commitKey, models);
  }
  const attributedModelLinks: typeof modelLinks = [];
  for (const models of byCommit.values()) {
    const rows = [...models.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
    const tokenTotal = rows.reduce((sum, row) => sum + row.tokens, 0);
    for (const field of ['producedLoc', 'producedScoreLoc', 'shippedLoc', 'shippedScoreLoc'] as const) {
      const total = rows[0]![field];
      const shares = rows.map((row, index) => {
        const exact = total * (tokenTotal > 0 ? row.tokens / tokenTotal : 1 / rows.length);
        return { index, value: Math.floor(exact), fraction: exact - Math.floor(exact) };
      });
      const remaining = total - shares.reduce((sum, share) => sum + share.value, 0);
      const ranked = [...shares].sort((a, b) => b.fraction - a.fraction || a.index - b.index);
      for (let i = 0; i < remaining; i++) ranked[i % ranked.length]!.value += 1;
      for (const share of shares) rows[share.index]![field] = share.value;
    }
    attributedModelLinks.push(...rows);
  }

	  const linkedDaily = new Map<string, {
	    date: string;
	    repo_id: number;
	    full_name: string;
	    loc: number;
	    scoreLoc: number;
	    commits: number;
	    tokens: number;
	    costUsd: number;
	    highConfidenceCommits: number;
    confidences: number[];
  }>();
	  const codeDaily = new Map<string, {
	    date: string;
	    producedLoc: number;
	    producedScoreLoc: number;
	    shippedLoc: number;
	    shippedScoreLoc: number;
	    commits: number;
	    highConfidenceCommits: number;
    confidences: number[];
  }>();

	  for (const linked of linkedCommits.values()) {
	    const commit = linked.commit;
	    const date = dateOnly(commit.committed_at);
	    const producedLoc = commit.nondoc_additions;
	    const producedScoreLoc = commit.nondoc_additions_score;
	    const shippedLoc = commit.reachable_from_prod
	      ? (commit.prod_nondoc_additions || commit.nondoc_additions)
	      : 0;
	    const shippedScoreLoc = commit.reachable_from_prod
	      ? (commit.prod_nondoc_additions_score || commit.nondoc_additions_score)
	      : 0;
	    const codeExisting = codeDaily.get(date);
	    if (codeExisting) {
	      codeExisting.producedLoc += producedLoc;
	      codeExisting.producedScoreLoc += producedScoreLoc;
	      codeExisting.shippedLoc += shippedLoc;
	      codeExisting.shippedScoreLoc += shippedScoreLoc;
	      codeExisting.commits += 1;
	      codeExisting.highConfidenceCommits += linked.confidence >= DIRECT_COMMIT_CONFIDENCE ? 1 : 0;
      codeExisting.confidences.push(linked.confidence);
    } else {
	      codeDaily.set(date, {
	        date,
	        producedLoc,
	        producedScoreLoc,
	        shippedLoc,
	        shippedScoreLoc,
	        commits: 1,
        highConfidenceCommits: linked.confidence >= DIRECT_COMMIT_CONFIDENCE ? 1 : 0,
        confidences: [linked.confidence],
      });
    }

    if (!commit.reachable_from_prod || !commit.github_repo_id || !commit.full_name) continue;
    const linkedKey = `${date}:${commit.github_repo_id}`;
    const linkedExisting = linkedDaily.get(linkedKey);
	    if (linkedExisting) {
	      linkedExisting.loc += shippedLoc;
	      linkedExisting.scoreLoc += shippedScoreLoc;
	      linkedExisting.commits += 1;
	      linkedExisting.tokens += linked.linkedTokens;
	      linkedExisting.costUsd += linked.linkedCostUsd;
      linkedExisting.highConfidenceCommits += linked.confidence >= DIRECT_COMMIT_CONFIDENCE ? 1 : 0;
      linkedExisting.confidences.push(linked.confidence);
    } else {
      linkedDaily.set(linkedKey, {
        date,
	        repo_id: commit.github_repo_id,
	        full_name: commit.full_name,
	        loc: shippedLoc,
	        scoreLoc: shippedScoreLoc,
	        commits: 1,
        tokens: linked.linkedTokens,
        costUsd: linked.linkedCostUsd,
        highConfidenceCommits: linked.confidence >= DIRECT_COMMIT_CONFIDENCE ? 1 : 0,
        confidences: [linked.confidence],
      });
    }
  }

  db.transaction(() => {
	    const linkedStmt = db.prepare(`
	      INSERT INTO ai_linked_code_daily (
	        date, repo_id, full_name, linked_shipped_loc, linked_shipped_loc_score, linked_commit_count,
	        linked_tokens, linked_cost_usd, high_confidence_commit_count, median_link_confidence, updated_at
	      )
	      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	    `);
	    const codeStmt = db.prepare(`
	      INSERT INTO code_daily_rollups (
	        date, produced_loc, produced_loc_score, shipped_loc, shipped_loc_score, ai_linked_commit_count,
	        high_confidence_commit_count, median_link_confidence, updated_at
	      )
	      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	    `);
	    const modelStmt = db.prepare(`
	      INSERT INTO ai_code_model_daily (
	        date, source, provider, model, produced_loc, produced_loc_score,
	        shipped_loc, shipped_loc_score, linked_commit_count, linked_tokens,
	        linked_cost_usd, updated_at
	      )
	      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	      ON CONFLICT(date, source, model) DO UPDATE SET
	        produced_loc = ai_code_model_daily.produced_loc + excluded.produced_loc,
	        produced_loc_score = ai_code_model_daily.produced_loc_score + excluded.produced_loc_score,
	        shipped_loc = ai_code_model_daily.shipped_loc + excluded.shipped_loc,
	        shipped_loc_score = ai_code_model_daily.shipped_loc_score + excluded.shipped_loc_score,
	        linked_commit_count = ai_code_model_daily.linked_commit_count + excluded.linked_commit_count,
	        linked_tokens = ai_code_model_daily.linked_tokens + excluded.linked_tokens,
	        linked_cost_usd = ai_code_model_daily.linked_cost_usd + excluded.linked_cost_usd,
	        updated_at = excluded.updated_at
	    `);
    const now = nowIso();
    for (const row of linkedDaily.values()) {
      linkedStmt.run(
        row.date,
        row.repo_id,
	        row.full_name,
	        row.loc,
	        row.scoreLoc,
	        row.commits,
	        row.tokens,
	        Math.round(row.costUsd * 10000) / 10000,
        row.highConfidenceCommits,
        median(row.confidences),
        now,
      );
    }
    for (const row of codeDaily.values()) {
      codeStmt.run(
	        row.date,
	        row.producedLoc,
	        row.producedScoreLoc,
	        row.shippedLoc,
	        row.shippedScoreLoc,
	        row.commits,
        row.highConfidenceCommits,
        median(row.confidences),
        now,
      );
    }
    for (const row of attributedModelLinks) {
      modelStmt.run(
        row.date,
        row.source,
        row.provider,
        row.model,
        row.producedLoc,
        row.producedScoreLoc,
        row.shippedLoc,
        row.shippedScoreLoc,
        1,
        row.tokens,
        row.costUsd,
        now,
      );
    }
  })();
}

export async function syncGithubCodeTotals(
  db: LocalDatabase,
  options: {
    token?: string;
    fetchImpl?: FetchImpl;
    onProgress?: (progress: GithubSyncProgress) => void;
  } = {},
): Promise<GithubVerificationResult> {
  const token = options.token ?? await readGithubToken();
  if (!token) {
    throw new Error('[github] Missing GitHub token. Connect GitHub locally first.');
  }

  let identity = getGithubIdentity(db);
  if (!identity) {
    identity = await connectGithubWithToken(db, token, options.fetchImpl ?? fetch);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const limiter = createLimiter();
  const syncErrors: string[] = [];
  const selected = selectedRepos(db);
  let reposSynced = 0;
  let commitsTotal = 0;
  let commitsProcessed = 0;
  let currentRepo: string | null = null;
  const reportProgress = (stage: GithubSyncProgress['stage']) => {
    options.onProgress?.({
      stage,
      repos_total: selected.length,
      repos_synced: reposSynced,
      commits_total: commitsTotal,
      commits_processed: commitsProcessed,
      current_repo: currentRepo,
      errors: syncErrors.length,
    });
  };

  reportProgress('matching_repos');
  const repos = await ensureGithubRepoIds(db, selected, token, fetchImpl, limiter, syncErrors);
  const sinceIso = earliestUsageDate(db);
  const allContributions: CommitContribution[] = [];
  const verifiedRepos: Array<SelectedRepoRow & { github_repo_id: number }> = [];

  for (const repo of repos) {
    currentRepo = repo.full_name;
    try {
      reportProgress('listing_commits');
	      const commits = await listCommitsForRepo(repo, identity.login, identity.verified_emails, sinceIso, token, fetchImpl, limiter);
      commitsTotal += commits.length;
      const cachedRows = loadCachedRemoteCommitRows(db, repo, commits.map((commit) => commit.sha));
      reportProgress('fetching_commit_details');
      const details = await mapWithConcurrency(commits, DEFAULT_DETAIL_CONCURRENCY, async (commit) => {
        const cached = cachedRows.get(commit.sha.toLowerCase());
        if (cached) {
          commitsProcessed += 1;
          if (commitsProcessed % 10 === 0 || commitsProcessed === commitsTotal) reportProgress('fetching_commit_details');
          const commitMs = Date.parse(commit.commit?.author?.date ?? cached.committed_at);
          if (!Number.isFinite(commitMs) || cached.rawLoc <= 0) return null;
          return {
            localRepoId: repo.id,
            repoId: repo.github_repo_id,
            fullName: repo.full_name,
            prodBranch: repo.prod_branch,
            sha: cached.sha,
            date: dateOnly(new Date(commitMs).toISOString()),
            commitMs,
            rawLoc: cached.rawLoc,
            scoreLoc: cached.scoreLoc,
          } satisfies CommitContribution;
        }
        const loc = await readGithubCodeCounts(async (page) => {
          let hasNextPage = false;
          const detail = await githubFetch<GithubCommitDetail>(
            `/repos/${repo.full_name}/commits/${commit.sha}${page === 1 ? '' : `?page=${page}`}`,
            token, fetchImpl, limiter,
            (response) => { hasNextPage = /rel="next"/.test(response.headers.get('link') ?? ''); },
          );
          return { files: detail.files, hasNextPage };
        });
        commitsProcessed += 1;
        if (commitsProcessed % 10 === 0 || commitsProcessed === commitsTotal) reportProgress('fetching_commit_details');
        const commitAt = commit.commit?.author?.date;
        const commitMs = commitAt ? Date.parse(commitAt) : Number.NaN;
        if (!Number.isFinite(commitMs)) return null;
	        if (loc.raw <= 0) return null;
	        return {
          localRepoId: repo.id,
          repoId: repo.github_repo_id,
          fullName: repo.full_name,
          prodBranch: repo.prod_branch,
          sha: commit.sha,
          date: dateOnly(new Date(commitMs).toISOString()),
          commitMs,
	          rawLoc: loc.raw,
	          scoreLoc: loc.score,
	        } satisfies CommitContribution;
      });
      allContributions.push(...details.filter((row): row is CommitContribution => row !== null));
      verifiedRepos.push(repo);
      reposSynced += 1;
      reportProgress('fetching_commit_details');
    } catch (error) {
      syncErrors.push(markRepoRemoteSyncError(db, repo, error));
      reportProgress('fetching_commit_details');
    }
  }

  const verifiedAt = nowIso();
  currentRepo = null;
  reportProgress('rebuilding_links');
  upsertGithubAndLocalCommitRows(db, allContributions, verifiedAt, verifiedRepos);
  markReposRemoteSynced(db, verifiedRepos, verifiedAt);
  writeSyncState(db, 'github_repo_sync_errors', syncErrors);
  await syncLocalGitCommitEvidence(db);
  rebuildLocalProfileSummary(db);
  reportProgress('completed');
  return verifyGithubInvariants(db);
}

export function verifyGithubInvariants(db: LocalDatabase): GithubVerificationResult {
  const totals = db.prepare(`
    SELECT
      COALESCE((
        SELECT COUNT(*)
        FROM local_repos
        WHERE selected = 1
          AND last_remote_sync_at IS NOT NULL
          AND local_root NOT LIKE '%/.worktrees/%'
          AND local_root NOT LIKE '%\\.worktrees\\%'
      ), 0) AS verified_repo_count,
      COALESCE((
        SELECT SUM(g.github_shipped_loc)
        FROM github_code_daily g
        WHERE EXISTS (
          SELECT 1
          FROM local_repos r
          WHERE r.github_repo_id = g.repo_id
            AND r.selected = 1
            AND r.local_root NOT LIKE '%/.worktrees/%'
            AND r.local_root NOT LIKE '%\\.worktrees\\%'
        )
      ), 0) AS github_total_loc,
      COALESCE((
        SELECT SUM(g.github_commit_count)
        FROM github_code_daily g
        WHERE EXISTS (
          SELECT 1
          FROM local_repos r
          WHERE r.github_repo_id = g.repo_id
            AND r.selected = 1
            AND r.local_root NOT LIKE '%/.worktrees/%'
            AND r.local_root NOT LIKE '%\\.worktrees\\%'
        )
      ), 0) AS github_total_commits,
      COALESCE((
        SELECT SUM(l.linked_shipped_loc)
        FROM ai_linked_code_daily l
        WHERE EXISTS (
          SELECT 1
          FROM local_repos r
          WHERE r.github_repo_id = l.repo_id
            AND r.selected = 1
            AND r.local_root NOT LIKE '%/.worktrees/%'
            AND r.local_root NOT LIKE '%\\.worktrees\\%'
        )
      ), 0) AS ai_linked_loc,
      COALESCE((
        SELECT SUM(l.linked_commit_count)
        FROM ai_linked_code_daily l
        WHERE EXISTS (
          SELECT 1
          FROM local_repos r
          WHERE r.github_repo_id = l.repo_id
            AND r.selected = 1
            AND r.local_root NOT LIKE '%/.worktrees/%'
            AND r.local_root NOT LIKE '%\\.worktrees\\%'
        )
      ), 0) AS ai_linked_commits,
      COALESCE(
        (
          SELECT MAX(last_remote_sync_at)
          FROM local_repos
          WHERE selected = 1
            AND local_root NOT LIKE '%/.worktrees/%'
            AND local_root NOT LIKE '%\\.worktrees\\%'
        ),
        (SELECT MAX(verified_at) FROM github_code_daily)
      ) AS last_verified_at
  `).get() as Omit<GithubVerificationResult, 'invariant_violations'>;

  const rows = db.prepare(`
    SELECT
      l.date,
      l.repo_id,
      l.full_name,
      l.linked_shipped_loc,
      l.linked_commit_count,
      COALESCE(g.github_shipped_loc, 0) AS github_shipped_loc,
      COALESCE(g.github_commit_count, 0) AS github_commit_count
    FROM ai_linked_code_daily l
    LEFT JOIN github_code_daily g ON g.date = l.date AND g.repo_id = l.repo_id
    WHERE (
        l.linked_shipped_loc > COALESCE(g.github_shipped_loc, 0)
        OR l.linked_commit_count > COALESCE(g.github_commit_count, 0)
      )
      AND EXISTS (
        SELECT 1
        FROM local_repos r
        WHERE r.github_repo_id = l.repo_id
          AND r.selected = 1
          AND r.local_root NOT LIKE '%/.worktrees/%'
          AND r.local_root NOT LIKE '%\\.worktrees\\%'
      )
    ORDER BY l.date DESC
    LIMIT 100
  `).all() as Array<{
    date: string;
    repo_id: number;
    full_name: string;
    linked_shipped_loc: number;
    linked_commit_count: number;
    github_shipped_loc: number;
    github_commit_count: number;
  }>;
  const repoErrors = db.prepare(`
    SELECT full_name, remote_sync_error
    FROM local_repos
    WHERE selected = 1
      AND local_root NOT LIKE '%/.worktrees/%'
      AND local_root NOT LIKE '%\\.worktrees\\%'
      AND remote_sync_error IS NOT NULL
    ORDER BY full_name ASC
    LIMIT 25
  `).all() as Array<{
    full_name: string | null;
    remote_sync_error: string;
  }>;

  return {
    verified_repo_count: Number(totals.verified_repo_count ?? 0),
    github_total_loc: Number(totals.github_total_loc ?? 0),
    github_total_commits: Number(totals.github_total_commits ?? 0),
    ai_linked_loc: Number(totals.ai_linked_loc ?? 0),
    ai_linked_commits: Number(totals.ai_linked_commits ?? 0),
    last_verified_at: totals.last_verified_at ?? null,
    invariant_violations: [
      ...repoErrors.map((row) => row.remote_sync_error || `${row.full_name ?? 'selected repo'}: GitHub verification failed`),
      ...rows.map((row) =>
        `${row.full_name} ${row.date}: linked ${row.linked_shipped_loc} LOC/${row.linked_commit_count} commits exceeds GitHub ${row.github_shipped_loc} LOC/${row.github_commit_count} commits`
      ),
    ].slice(0, 100),
  };
}
