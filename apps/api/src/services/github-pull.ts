import { GITHUB_CODE_METRICS_VERSION, GITHUB_CODE_PER_COMMIT_CAP, isNonShippingPath, readGithubCodeCounts } from '@tokensrank/shared';
import { adminClient } from '../clients/supabase';

/**
 * GitHub shipped-code pull.
 *
 * For each connected repo we walk the prod branch's commit history authored by
 * the connected user, sum non-doc line additions per commit (immutable, cached
 * by sha), and roll the result into `contrib_daily` (one row per profile/day).
 * Mechanics-agnostic: squash/rebase/direct-push all resolve to "is this commit
 * reachable from the prod branch and authored by this user".
 */

const GITHUB_API = 'https://api.github.com';
const COMMITS_PER_PAGE = 100;
const COMMIT_CACHE_UPSERT_BATCH_SIZE = 1000;

// GitHub secondary rate limit: most REST GETs are 1 point and REST is capped at
// 900 points/minute. Keep detail fetches below that with room for list pages,
// retries, and other user activity sharing the same token.
const DEFAULT_GITHUB_PULL_DETAIL_CONCURRENCY = 12;
const DEFAULT_GITHUB_PULL_REQUESTS_PER_SECOND = 12;
const MAX_GITHUB_PULL_DETAIL_CONCURRENCY = 50;
const MAX_GITHUB_PULL_REQUESTS_PER_SECOND = 14;

// Per-commit cap on counted non-doc additions (anti-LOC-gaming). Applied when
// rolling into contrib_daily so the daily series is score-ready; commit_cache
// keeps the raw figure.
export const PER_COMMIT_CAP = GITHUB_CODE_PER_COMMIT_CAP;
export { isNonShippingPath };

export type FetchImpl = typeof fetch;

type SupabaseLike = Pick<typeof adminClient, 'from'>;

type GithubCommitListItem = {
  sha: string;
  commit?: { author?: { date?: string; email?: string } | null } | null;
  author?: { login?: string } | null;
};

type GithubCommitDetail = {
  files?: Array<{ filename: string; additions?: number }> | null;
};

export type ConnectedRepoRef = {
  repo_id: number;
  full_name: string;
  prod_branch: string;
};

export type ProfileContribInput = {
  profileId: string;
  login: string;
  repos: ConnectedRepoRef[];
  token: string;
  sinceIso: string;
  verifiedEmails?: string[];
  supabaseClient?: SupabaseLike;
  fetchImpl?: FetchImpl;
  detailConcurrency?: number;
  requestsPerSecond?: number;
};

export type ProfileContribResult = {
  profileId: string;
  reposProcessed: number;
  commitsSeen: number;
  commitsFetched: number;
  daysWritten: number;
  shippedLocTotal: number;
};

export type GithubContribDailyRow = {
  profile_id: string;
  day: string;
  shipped_loc: number;
  commit_count: number;
  weighted_shipped: number;
  updated_at: string;
};

export type ProfileContribDailyComputation = {
  profileId: string;
  reposProcessed: number;
  commitsSeen: number;
  commitsFetched: number;
  rows: GithubContribDailyRow[];
  shippedLocTotal: number;
  verificationRows: GithubContribDailyRow[];
  rawShippedLocTotal: number;
};

const FETCH_TIMEOUT_MS = 20_000;
const FETCH_RETRIES = 4;

type GithubRequestLimiter = {
  waitTurn: () => Promise<void>;
  deferUntil: (untilMs: number) => void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampPositiveInteger(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(value), max);
}

function readPositiveIntegerEnv(name: string, fallback: number, max: number): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);

  return clampPositiveInteger(parsedValue, fallback, max);
}

function createGithubRequestLimiter(requestsPerSecond: number): GithubRequestLimiter {
  const minIntervalMs = Math.ceil(1000 / requestsPerSecond);
  let nextSlotAt = 0;
  let deferredUntil = 0;

  return {
    async waitTurn() {
      const now = Date.now();
      const slotAt = Math.max(now, nextSlotAt, deferredUntil);
      nextSlotAt = slotAt + minIntervalMs;

      const waitMs = slotAt - now;
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    },
    deferUntil(untilMs: number) {
      if (!Number.isFinite(untilMs) || untilMs <= 0) {
        return;
      }

      deferredUntil = Math.max(deferredUntil, untilMs);
      nextSlotAt = Math.max(nextSlotAt, deferredUntil);
    },
  };
}

function parseRetryAfterMs(response: Response): number | null {
  const retryAfter = response.headers?.get?.('retry-after');

  if (!retryAfter) {
    return null;
  }

  const seconds = Number.parseInt(retryAfter, 10);

  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function parsePrimaryResetDelayMs(response: Response): number | null {
  if (response.headers?.get?.('x-ratelimit-remaining') !== '0') {
    return null;
  }

  const resetSeconds = Number.parseInt(response.headers?.get?.('x-ratelimit-reset') ?? '', 10);

  if (!Number.isFinite(resetSeconds) || resetSeconds <= 0) {
    return null;
  }

  return Math.max(resetSeconds * 1000 - Date.now() + 1000, 1000);
}

function rateLimitDelayMs(response: Response, bodyText: string, attempt: number): number | null {
  if (response.status !== 403 && response.status !== 429) {
    return null;
  }

  const retryAfterMs = parseRetryAfterMs(response);
  if (retryAfterMs !== null) {
    return retryAfterMs;
  }

  const resetDelayMs = parsePrimaryResetDelayMs(response);
  if (resetDelayMs !== null) {
    return resetDelayMs;
  }

  if (response.status === 429 || /rate limit|secondary limit|abuse/i.test(bodyText)) {
    return Math.max(60_000, 2000 * 2 ** attempt);
  }

  return null;
}

function formatErrorBody(bodyText: string): string {
  const trimmed = bodyText.trim();

  if (!trimmed) {
    return '';
  }

  return `: ${trimmed.slice(0, 240)}`;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= items.length) {
        return;
      }

      results[index] = await mapper(items[index]!, index);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

async function githubFetch<T>(
  path: string,
  token: string,
  fetchImpl: FetchImpl,
  requestLimiter?: GithubRequestLimiter,
  onResponse?: (response: Response) => void,
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt += 1) {
    try {
      await requestLimiter?.waitTurn();

      // Hard per-request timeout so one stalled connection can't hang the whole
      // (potentially thousands-of-commits) backfill walk indefinitely.
      const response = await fetchImpl(`${GITHUB_API}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'tokensrank-pull',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (response.status === 409 && path.includes("/commits?")) {
        // An empty repository has no commits. Inaccessible repos/commits must
        // throw, not turn into zero-LOC evidence against the user.
        return [] as unknown as T;
      }

      if (!response.ok) {
        const bodyText = await response.text();
        const retryDelayMs = rateLimitDelayMs(response, bodyText, attempt);

        if (retryDelayMs !== null && attempt < FETCH_RETRIES) {
          const retryAt = Date.now() + retryDelayMs;
          requestLimiter?.deferUntil(retryAt);
          await sleep(retryDelayMs);
          continue;
        }

        throw new Error(`[github-pull] ${path} -> ${response.status} ${response.statusText}${formatErrorBody(bodyText)}`);
      }

      onResponse?.(response);
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_RETRIES) {
        await sleep(500 * (attempt + 1));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`[github-pull] ${path} failed`);
}

export async function listAuthoredCommits(input: {
  fullName: string;
  prodBranch: string;
  login: string;
  sinceIso: string;
  token: string;
  fetchImpl: FetchImpl;
  emails?: string[];
  requestLimiter?: GithubRequestLimiter;
}): Promise<Array<{ sha: string; committedDate: string }>> {
  const {
    fullName,
    prodBranch,
    login,
    sinceIso,
    token,
    fetchImpl,
    emails = [],
    requestLimiter,
  } = input;
  const collected: Array<{ sha: string; committedDate: string }> = [];
  const loginLc = login.toLowerCase();
  const emailSet = new Set(emails.map((email) => email.toLowerCase()));

  // We deliberately do NOT use GitHub's `author=` query filter: it is unreliable
  // (returns nothing for users.noreply.github.com emails / some linked accounts).
  // Instead we page the branch's commits and attribute client-side by resolved
  // author login OR verified commit-author email — the plan's attribution rule.
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({
      sha: prodBranch,
      since: sinceIso,
      per_page: String(COMMITS_PER_PAGE),
      page: String(page),
    });
    const items = await githubFetch<GithubCommitListItem[]>(
      `/repos/${fullName}/commits?${query.toString()}`,
      token,
      fetchImpl,
      requestLimiter,
    );

    if (!Array.isArray(items) || items.length === 0) {
      break;
    }

    for (const item of items) {
      const committedDate = item.commit?.author?.date;
      const authorLogin = item.author?.login?.toLowerCase();
      const authorEmail = item.commit?.author?.email?.toLowerCase();
      const isMine = (authorLogin !== undefined && authorLogin === loginLc)
        || (authorEmail !== undefined && emailSet.has(authorEmail));

      if (item.sha && committedDate && isMine) {
        collected.push({ sha: item.sha, committedDate });
      }
    }

    if (items.length < COMMITS_PER_PAGE) {
      break;
    }
  }

  return collected;
}

export async function commitNonDocAdditions(input: {
  fullName: string;
  sha: string;
  token: string;
  fetchImpl: FetchImpl;
  requestLimiter?: GithubRequestLimiter;
}): Promise<number> {
  const { fullName, sha, token, fetchImpl, requestLimiter } = input;
  const counts = await readGithubCodeCounts(async (page) => {
    let hasNextPage = false;
    const detail = await githubFetch<GithubCommitDetail>(
      `/repos/${fullName}/commits/${sha}${page === 1 ? '' : `?page=${page}`}`,
      token, fetchImpl, requestLimiter,
      (response) => { hasNextPage = /rel="next"/.test(response.headers?.get('link') ?? ''); },
    );
    return { files: detail?.files, hasNextPage };
  });
  return counts.raw;
}

function dayOf(isoDate: string): string {
  return isoDate.slice(0, 10);
}

async function upsertCommitCacheRows(
  supabaseClient: SupabaseLike,
  rows: Array<{
    repo_id: number;
    sha: string;
    author_login: string;
    committed_date: string;
    nondoc_additions: number;
  }>,
): Promise<void> {
  for (let start = 0; start < rows.length; start += COMMIT_CACHE_UPSERT_BATCH_SIZE) {
    const batch = rows.slice(start, start + COMMIT_CACHE_UPSERT_BATCH_SIZE);
    const { error } = await supabaseClient
      .from('commit_cache')
      .upsert(batch, { onConflict: 'repo_id,sha' });

    if (error) {
      throw new Error(`[github-pull] commit_cache upsert failed: ${error.message}`);
    }
  }
}

/**
 * Pull shipped-code contributions for one profile across its connected repos and
 * cache per-commit additions. The returned rows are GitHub-authoritative for the
 * given repo set/window, but are not written to contrib_daily by this helper.
 */
export async function calculateProfileContribDaily(input: ProfileContribInput): Promise<ProfileContribDailyComputation> {
  const {
    profileId,
    login,
    repos,
    token,
    sinceIso,
    verifiedEmails = [],
    supabaseClient = adminClient,
    fetchImpl = fetch,
    detailConcurrency,
    requestsPerSecond,
  } = input;

  const perDay = new Map<string, { loc: number; rawLoc: number; commits: number }>();
  let commitsSeen = 0;
  let commitsFetched = 0;
  const effectiveDetailConcurrency = clampPositiveInteger(
    detailConcurrency ?? readPositiveIntegerEnv(
      'GITHUB_PULL_DETAIL_CONCURRENCY',
      DEFAULT_GITHUB_PULL_DETAIL_CONCURRENCY,
      MAX_GITHUB_PULL_DETAIL_CONCURRENCY,
    ),
    DEFAULT_GITHUB_PULL_DETAIL_CONCURRENCY,
    MAX_GITHUB_PULL_DETAIL_CONCURRENCY,
  );
  const effectiveRequestsPerSecond = clampPositiveInteger(
    requestsPerSecond ?? readPositiveIntegerEnv(
      'GITHUB_PULL_REQUESTS_PER_SECOND',
      DEFAULT_GITHUB_PULL_REQUESTS_PER_SECOND,
      MAX_GITHUB_PULL_REQUESTS_PER_SECOND,
    ),
    DEFAULT_GITHUB_PULL_REQUESTS_PER_SECOND,
    MAX_GITHUB_PULL_REQUESTS_PER_SECOND,
  );
  const requestLimiter = createGithubRequestLimiter(effectiveRequestsPerSecond);

  for (const repo of repos) {
    const commits = await listAuthoredCommits({
      fullName: repo.full_name,
      prodBranch: repo.prod_branch,
      login,
      sinceIso,
      token,
      fetchImpl,
      emails: verifiedEmails,
      requestLimiter,
    });

    if (commits.length === 0) {
      continue;
    }

    // Reuse cached per-commit additions; only fetch detail for unseen shas.
    const shas = commits.map((commit) => commit.sha);
    const { data: cachedRows } = await supabaseClient
      .from('commit_cache')
      .select('sha,nondoc_additions')
      .eq('repo_id', repo.repo_id)
      .eq('metrics_version', GITHUB_CODE_METRICS_VERSION)
      .in('sha', shas);
    const cached = new Map<string, number>(
      (cachedRows ?? []).map((row: { sha: string; nondoc_additions: number }) => [row.sha, row.nondoc_additions]),
    );

    const fetchedCacheRows: Array<{
      repo_id: number;
      sha: string;
      author_login: string;
      committed_date: string;
      nondoc_additions: number;
      metrics_version: number;
    }> = [];
    const cachedContributions: Array<{ committedDate: string; nondoc: number }> = [];
    const uncachedCommits: Array<{ sha: string; committedDate: string }> = [];

    for (const commit of commits) {
      commitsSeen += 1;
      const nondoc = cached.get(commit.sha);

      if (nondoc === undefined) {
        uncachedCommits.push(commit);
      } else {
        cachedContributions.push({ committedDate: commit.committedDate, nondoc });
      }
    }

    const fetchedContributions = await mapWithConcurrency(
      uncachedCommits,
      effectiveDetailConcurrency,
      async (commit) => {
        const nondoc = await commitNonDocAdditions({
          fullName: repo.full_name,
          sha: commit.sha,
          token,
          fetchImpl,
          requestLimiter,
        });

        fetchedCacheRows.push({
          repo_id: repo.repo_id,
          sha: commit.sha,
          author_login: login,
          committed_date: commit.committedDate,
          nondoc_additions: nondoc,
          metrics_version: GITHUB_CODE_METRICS_VERSION,
        });

        return { committedDate: commit.committedDate, nondoc };
      },
    );

    commitsFetched += fetchedContributions.length;
    await upsertCommitCacheRows(supabaseClient, fetchedCacheRows);

    for (const contribution of [...cachedContributions, ...fetchedContributions]) {
      const day = dayOf(contribution.committedDate);
      const bucket = perDay.get(day) ?? { loc: 0, rawLoc: 0, commits: 0 };
      bucket.rawLoc += contribution.nondoc;
      bucket.loc += Math.min(contribution.nondoc, PER_COMMIT_CAP);
      bucket.commits += 1;
      perDay.set(day, bucket);
    }
  }

  // Rebuild contrib_daily for this profile across the touched days.
  const rows = Array.from(perDay.entries()).map(([day, bucket]) => ({
    profile_id: profileId,
    day,
    shipped_loc: bucket.loc,
    commit_count: bucket.commits,
    // v1 reputation weight is flat 1.0; weighted_shipped == shipped_loc.
    weighted_shipped: bucket.loc,
    updated_at: new Date().toISOString(),
  }));

  let shippedLocTotal = 0;
  if (rows.length > 0) {
    shippedLocTotal = rows.reduce((sum, row) => sum + row.shipped_loc, 0);
  }

  return {
    profileId,
    reposProcessed: repos.length,
    commitsSeen,
    commitsFetched,
    rows,
    shippedLocTotal,
    verificationRows: rows.map((row) => ({ ...row, shipped_loc: perDay.get(row.day)!.rawLoc })),
    rawShippedLocTotal: [...perDay.values()].reduce((sum, row) => sum + row.rawLoc, 0),
  };
}

/**
 * Pull shipped-code contributions for one profile across its connected repos,
 * caching per-commit additions and rebuilding contrib_daily for the window.
 */
export async function syncProfileContrib(input: ProfileContribInput): Promise<ProfileContribResult> {
  const calculation = await calculateProfileContribDaily(input);

  const {
    profileId,
    rows,
  } = calculation;
  const supabaseClient = input.supabaseClient ?? adminClient;

  if (rows.length > 0) {
    const { error } = await supabaseClient
      .from('contrib_daily')
      .upsert(rows, { onConflict: 'profile_id,day' });

    if (error) {
      throw new Error(`[github-pull] contrib_daily upsert failed for ${profileId}: ${error.message}`);
    }
  }

  return {
    profileId,
    reposProcessed: calculation.reposProcessed,
    commitsSeen: calculation.commitsSeen,
    commitsFetched: calculation.commitsFetched,
    daysWritten: rows.length,
    shippedLocTotal: calculation.shippedLocTotal,
  };
}

type GithubIdentityRow = { profile_id: string; login: string; provider_token: string | null; verified_emails?: string[] | null };
type ConnectedRepoRow = ConnectedRepoRef & { profile_id: string };

/**
 * Pull contributions for every connected profile. Intended for the daily cron;
 * on-connect backfill calls syncProfileContrib directly for one profile.
 */
export async function syncAllConnectedProfiles(options: {
  supabaseClient?: SupabaseLike;
  fetchImpl?: FetchImpl;
  sinceDays?: number;
  nowMs?: number;
} = {}): Promise<ProfileContribResult[]> {
  const {
    supabaseClient = adminClient,
    fetchImpl = fetch,
    sinceDays = 90,
    nowMs = Date.now(),
  } = options;

  const sinceIso = new Date(nowMs - sinceDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: identities, error: identitiesError } = await supabaseClient
    .from('github_identities')
    .select('profile_id,login,provider_token,verified_emails');

  if (identitiesError) {
    throw new Error(`[github-pull] identity load failed: ${identitiesError.message}`);
  }

  const { data: repoRows, error: reposError } = await supabaseClient
    .from('connected_repos')
    .select('profile_id,repo_id,full_name,prod_branch')
    .eq('enabled', true);

  if (reposError) {
    throw new Error(`[github-pull] repo load failed: ${reposError.message}`);
  }

  const reposByProfile = new Map<string, ConnectedRepoRef[]>();
  for (const row of (repoRows ?? []) as ConnectedRepoRow[]) {
    const list = reposByProfile.get(row.profile_id) ?? [];
    list.push({ repo_id: row.repo_id, full_name: row.full_name, prod_branch: row.prod_branch });
    reposByProfile.set(row.profile_id, list);
  }

  const results: ProfileContribResult[] = [];

  for (const identity of (identities ?? []) as GithubIdentityRow[]) {
    const repos = reposByProfile.get(identity.profile_id) ?? [];

    if (!identity.provider_token || repos.length === 0) {
      continue;
    }

    results.push(await syncProfileContrib({
      profileId: identity.profile_id,
      login: identity.login,
      repos,
      token: identity.provider_token,
      sinceIso,
      verifiedEmails: identity.verified_emails ?? [],
      supabaseClient,
      fetchImpl,
    }));
  }

  return results;
}
