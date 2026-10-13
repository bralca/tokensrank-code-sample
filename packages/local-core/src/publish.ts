import {
  LocalPublishPayloadSchema,
  type LocalPublishPayload,
} from '@tokensrank/shared';

import type { LocalDatabase } from './db.js';
import { nowIso } from './db.js';
import { getGithubIdentity, rebuildAiCommitLinks, verifyGithubInvariants } from './github.js';
import { pricingSnapshot } from './pricing.js';
import { readUsageEvidence } from './usage-evidence.js';

function assertSelectedReposRemotelyVerified(db: LocalDatabase): void {
  const rows = db.prepare(`
    SELECT full_name, local_root
    FROM local_repos
    WHERE selected = 1
      AND full_name IS NOT NULL
      AND local_root NOT LIKE '%/.worktrees/%'
      AND local_root NOT LIKE '%\\.worktrees\\%'
      AND (
        github_repo_id IS NULL
        OR last_remote_sync_at IS NULL
      )
    ORDER BY full_name, local_root
    LIMIT 5
  `).all() as Array<{ full_name: string | null; local_root: string }>;

  if (rows.length === 0) return;

  const repoLabels = rows
    .map((repo) => repo.full_name ?? repo.local_root)
    .join(', ');
  throw new Error(
    `[publish] Run GitHub verification before publishing. ${rows.length} selected repo(s) are not remotely verified: ${repoLabels}`,
  );
}

export function buildPublishPayload(
  db: LocalDatabase,
  options: { clientVersion?: string; includeCode?: boolean; githubUserId?: number } = {},
): LocalPublishPayload {
  const identity = getGithubIdentity(db);
  const githubUserId = options.githubUserId ?? identity?.github_user_id;
  if (!githubUserId) {
    throw new Error('[publish] GitHub identity is required before publishing.');
  }

  if (options.includeCode) {
    if (identity?.github_user_id !== githubUserId) throw new Error('Connect the same GitHub account locally before including code contributions.');
    assertSelectedReposRemotelyVerified(db);
    rebuildAiCommitLinks(db);
    const verification = verifyGithubInvariants(db);
    if (verification.invariant_violations.length > 0) {
      throw new Error(`[publish] GitHub verification failed: ${verification.invariant_violations[0]}`);
    }
  }

  const usageDaily = db.prepare(`
    SELECT date, source, provider, model, total_tokens, input_tokens, output_tokens,
      cache_read_tokens, cache_create_tokens, cached_tokens, reasoning_tokens,
      total_sessions, event_count, cost_usd_total
    FROM usage_daily_aggregates
    ORDER BY date, source, model
  `).all();


	  const githubCodeDaily = db.prepare(`
	    SELECT date, repo_id, full_name, prod_branch, github_shipped_loc,
	      github_shipped_loc_score, github_commit_count, verified_at, verification_source
	    FROM github_code_daily
	    WHERE EXISTS (
	      SELECT 1
	      FROM local_repos repos
	      WHERE repos.github_repo_id = github_code_daily.repo_id
	        AND repos.selected = 1
	        AND repos.local_root NOT LIKE '%/.worktrees/%'
	        AND repos.local_root NOT LIKE '%\\.worktrees\\%'
	    )
	    ORDER BY date, full_name
	  `).all();

  const selectedRepos = db.prepare(`
	    SELECT github_repo_id AS repo_id, full_name, COALESCE(prod_branch, default_branch, 'main') AS prod_branch
	    FROM local_repos
	    WHERE selected = 1 AND github_repo_id IS NOT NULL AND full_name IS NOT NULL
	      AND local_root NOT LIKE '%/.worktrees/%'
	      AND local_root NOT LIKE '%\\.worktrees\\%'
	    ORDER BY full_name
	  `).all();

  const summary = db.prepare(`
    SELECT
      COALESCE((
        SELECT SUM(total_tokens)
        FROM usage_daily_aggregates
      ), 0) AS total_tokens,
      COALESCE((
        SELECT SUM(cost_usd_total)
        FROM usage_daily_aggregates
      ), 0) AS total_cost_usd,
	      COALESCE((
	        SELECT COUNT(*)
	        FROM usage_session_rollups
	      ), 0) AS sessions_count,
	      COALESCE((SELECT SUM(produced_loc) FROM code_daily_rollups), 0) AS produced_loc_total,
	      COALESCE((SELECT SUM(produced_loc_score) FROM code_daily_rollups), 0) AS produced_loc_score_total,
	      COALESCE((
	        SELECT SUM(github_shipped_loc)
	        FROM github_code_daily
	        WHERE EXISTS (
	          SELECT 1
	          FROM local_repos repos
	          WHERE repos.github_repo_id = github_code_daily.repo_id
	            AND repos.selected = 1
	            AND repos.local_root NOT LIKE '%/.worktrees/%'
	            AND repos.local_root NOT LIKE '%\\.worktrees\\%'
	        )
	      ), 0) AS github_shipped_loc_total,
	      COALESCE((
	        SELECT SUM(github_shipped_loc_score)
	        FROM github_code_daily
	        WHERE EXISTS (
	          SELECT 1
	          FROM local_repos repos
	          WHERE repos.github_repo_id = github_code_daily.repo_id
	            AND repos.selected = 1
	            AND repos.local_root NOT LIKE '%/.worktrees/%'
	            AND repos.local_root NOT LIKE '%\\.worktrees\\%'
	        )
	      ), 0) AS github_shipped_loc_score_total,
	      COALESCE((
	        SELECT SUM(linked_shipped_loc)
	        FROM ai_linked_code_daily
	        WHERE EXISTS (
	          SELECT 1
	          FROM local_repos repos
	          WHERE repos.github_repo_id = ai_linked_code_daily.repo_id
	            AND repos.selected = 1
	            AND repos.local_root NOT LIKE '%/.worktrees/%'
	            AND repos.local_root NOT LIKE '%\\.worktrees\\%'
	        )
	      ), 0) AS ai_linked_shipped_loc_total,
	      COALESCE((
	        SELECT SUM(linked_shipped_loc_score)
	        FROM ai_linked_code_daily
	        WHERE EXISTS (
	          SELECT 1
	          FROM local_repos repos
	          WHERE repos.github_repo_id = ai_linked_code_daily.repo_id
	            AND repos.selected = 1
	            AND repos.local_root NOT LIKE '%/.worktrees/%'
	            AND repos.local_root NOT LIKE '%\\.worktrees\\%'
	        )
	      ), 0) AS ai_linked_shipped_loc_score_total
	  `).get() as {
	    total_tokens: number;
	    total_cost_usd: number;
	    sessions_count: number;
	    produced_loc_total: number;
	    produced_loc_score_total: number;
	    github_shipped_loc_total: number;
	    github_shipped_loc_score_total: number;
	    ai_linked_shipped_loc_total: number;
	    ai_linked_shipped_loc_score_total: number;
	  };

  return LocalPublishPayloadSchema.parse({
    usage_evidence: readUsageEvidence(db, options.includeCode && selectedRepos.length > 0),
    schema_version: 2,
    client_version: options.clientVersion ?? 'tokensrank-local-dev',
    generated_at: nowIso(),
    github_user_id: githubUserId,
    selected_repos: options.includeCode ? selectedRepos : [],
    usage_daily: usageDaily,
    model_daily: usageDaily,
    usage_session_rollups: [],
    session_counts_daily: db.prepare(`
      SELECT substr(last_event_at, 1, 10) AS date, source, count(*) AS total_sessions
      FROM usage_session_rollups GROUP BY date, source ORDER BY date, source
    `).all(),
    // Legacy code attribution spreads session tokens/lines across commits/models.
    // New receipts publish recorded GitHub totals and explicit reference counts only.
    produced_code_daily: [],
    github_code_daily: options.includeCode ? githubCodeDaily : [],
    ai_linked_code_daily: [],
    model_code_daily: [],
    pricing_snapshot: pricingSnapshot(db),
    summary: { ...summary,
      produced_loc_total: 0, produced_loc_score_total: 0,
      github_shipped_loc_total: options.includeCode ? summary.github_shipped_loc_total : 0,
      github_shipped_loc_score_total: options.includeCode ? summary.github_shipped_loc_score_total : 0,
      ai_linked_shipped_loc_total: 0, ai_linked_shipped_loc_score_total: 0,
    },
    privacy_report: {
      prompts_sent: 0,
      raw_commands_sent: 0,
      file_contents_sent: 0,
      absolute_paths_sent: 0,
      raw_transcripts_sent: 0,
    },
  });
}
