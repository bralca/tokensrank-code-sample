import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { adminClient } from '../../clients/supabase';
import { requireAuth, type AuthContext } from '../../middleware/auth';
import { withPostgrestSchemaRetry } from '../../lib/postgrest-schema-retry';
import { purgeIngestionCaches } from '../../services/cache';
import { syncProfileContrib } from '../../services/github-pull';
import { scheduleSummaryRebuild } from '../../services/summary-rebuild-scheduler';

const GITHUB_API = 'https://api.github.com';
// On-connect backfill depth. 5 years (matches scoring.ts MAX_SERIES_DAYS, the
// chart ceiling) so the full prod-branch history is pulled, not just the last
// 90 days. `since` before repo creation harmlessly returns all commits; commit
// pagination is uncapped and commit_cache makes any re-run cheap.
const BACKFILL_WINDOW_MS = 1825 * 24 * 60 * 60 * 1000;

function errorEnvelope(code: string, message: string) {
  return { error: { code, message } };
}

function getAuthContext(request: FastifyRequest): AuthContext {
  const auth = (request as typeof request & { auth?: AuthContext }).auth;

  if (!auth) {
    throw new Error('[github-repos] Missing auth context after requireAuth');
  }

  return auth;
}

type GithubIdentityRow = { login: string; provider_token: string | null; verified_emails: string[] | null };

type GithubRepoApi = {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
  stargazers_count: number;
};

type ConnectedRepoRow = { repo_id: number; prod_branch: string; enabled: boolean };

const ConnectReposBodySchema = z.object({
  repos: z.array(z.object({
    repo_id: z.number().int().positive(),
    full_name: z.string().min(1).max(255),
    prod_branch: z.string().min(1).max(255),
    is_private: z.boolean().optional().default(false),
    stars: z.number().int().min(0).optional().default(0),
  })).max(100),
}).strict();

async function loadIdentity(profileId: string): Promise<GithubIdentityRow | null> {
  const { data } = await adminClient
    .from('github_identities')
    .select('login,provider_token,verified_emails')
    .eq('profile_id', profileId)
    .maybeSingle<GithubIdentityRow>();

  return data ?? null;
}

/**
 * GitHub repo connection. The user picks which repos count toward their rank and
 * declares each repo's prod branch; the daily github-pull cron (plus an immediate
 * best-effort backfill) then measures non-doc lines merged to that branch.
 */
export const githubReposRoutes: FastifyPluginAsync = async (fastify) => {
  // List the repos the authenticated user can connect, merged with prior selections.
  fastify.get('/api/github/repos', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = getAuthContext(request);
    const identity = await loadIdentity(auth.profileId);

    if (!identity?.provider_token) {
      return reply.code(409).send(errorEnvelope('github_not_connected', 'Connect your GitHub account first'));
    }

    const repos: GithubRepoApi[] = [];
    try {
      const MAX_PAGES = 10; // up to 1000 repos
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const response = await fetch(
          `${GITHUB_API}/user/repos?per_page=100&page=${page}&sort=pushed&visibility=all&affiliation=owner,collaborator,organization_member`,
          {
            headers: {
              Authorization: `Bearer ${identity.provider_token}`,
              Accept: 'application/vnd.github+json',
              'User-Agent': 'tokensrank',
              'X-GitHub-Api-Version': '2022-11-28',
            },
          },
        );

        if (!response.ok) {
          request.log.warn({ event: 'github.repos.list_failed', status: response.status, page }, 'GitHub repo list failed');
          return reply.code(502).send(errorEnvelope('github_api_error', 'Could not load repositories from GitHub'));
        }

        const batch = await response.json() as GithubRepoApi[];
        if (!Array.isArray(batch) || batch.length === 0) {
          break;
        }

        repos.push(...batch);

        if (batch.length < 100) {
          break;
        }

        if (page === MAX_PAGES) {
          request.log.warn({ event: 'github.repos.list_capped', count: repos.length }, 'GitHub repo list hit page cap');
        }
      }
    } catch (error) {
      request.log.error({ err: error, event: 'github.repos.list_error' }, 'GitHub repo list error');
      return reply.code(502).send(errorEnvelope('github_api_error', 'Could not load repositories from GitHub'));
    }

    const { data: connectedRows } = await withPostgrestSchemaRetry(async () => {
      const result = await adminClient
        .from('connected_repos')
        .select('repo_id,prod_branch,enabled')
        .eq('profile_id', auth.profileId)
        .returns<ConnectedRepoRow[]>();

      if (result.error) {
        throw result.error;
      }

      return result;
    }, { context: 'github.repos.connected', event: 'github.repos.connected_retry', logger: request.log });

    const connectedById = new Map((connectedRows ?? []).map((row) => [row.repo_id, row] as const));

    const data = (Array.isArray(repos) ? repos : []).map((repo) => {
      const existing = connectedById.get(repo.id);

      return {
        repo_id: repo.id,
        full_name: repo.full_name,
        is_private: repo.private,
        default_branch: repo.default_branch,
        stars: repo.stargazers_count,
        connected: Boolean(existing?.enabled),
        prod_branch: existing?.prod_branch ?? repo.default_branch,
      };
    });

    return reply.code(200).send({ data });
  });

  // Save the user's repo selections (enable picks, disable de-selected) + backfill.
  fastify.post('/api/github/repos', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = getAuthContext(request);
    const parsed = ConnectReposBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope('schema_invalid', 'Invalid repo selection'));
    }

    const { repos } = parsed.data;
    const identity = await loadIdentity(auth.profileId);

    if (!identity?.provider_token) {
      return reply.code(409).send(errorEnvelope('github_not_connected', 'Connect your GitHub account first'));
    }

    const selectedIds = new Set(repos.map((repo) => repo.repo_id));

    if (repos.length > 0) {
      const rows = repos.map((repo) => ({
        profile_id: auth.profileId,
        repo_id: repo.repo_id,
        full_name: repo.full_name,
        prod_branch: repo.prod_branch,
        is_private: repo.is_private,
        stars: repo.stars,
        enabled: true,
        updated_at: new Date().toISOString(),
      }));

      const { error } = await adminClient
        .from('connected_repos')
        .upsert(rows, { onConflict: 'profile_id,repo_id' });

      if (error) {
        request.log.error({ err: error, event: 'github.repos.save_failed' }, 'connected_repos upsert failed');
        return reply.code(500).send(errorEnvelope('repos_save_failed', 'Could not save repository selection'));
      }
    }

    // De-select: disable any previously-enabled repo not in the new set.
    const { data: existingRows } = await adminClient
      .from('connected_repos')
      .select('repo_id,enabled')
      .eq('profile_id', auth.profileId)
      .returns<{ repo_id: number; enabled: boolean }[]>();

    const toDisable = (existingRows ?? [])
      .filter((row) => row.enabled && !selectedIds.has(row.repo_id))
      .map((row) => row.repo_id);

    if (toDisable.length > 0) {
      await adminClient
        .from('connected_repos')
        .update({ enabled: false, updated_at: new Date().toISOString() })
        .eq('profile_id', auth.profileId)
        .in('repo_id', toDisable);
    }

    // Best-effort immediate backfill; the daily github-pull cron is the reliable path.
    if (repos.length > 0) {
      const sinceIso = new Date(Date.now() - BACKFILL_WINDOW_MS).toISOString();
      const backfillStartedAt = Date.now();

      void syncProfileContrib({
        profileId: auth.profileId,
        login: identity.login,
        token: identity.provider_token,
        sinceIso,
        verifiedEmails: identity.verified_emails ?? [],
        repos: repos.map((repo) => ({
          repo_id: repo.repo_id,
          full_name: repo.full_name,
          prod_branch: repo.prod_branch,
        })),
      })
        .then((result) => {
          const cacheVersion = purgeIngestionCaches();
          scheduleSummaryRebuild(request.log);
          request.log.info({
            event: 'github.repos.backfill_done',
            duration_ms: Date.now() - backfillStartedAt,
            cache_version: cacheVersion,
            ...result,
          }, 'On-connect backfill complete');
        })
        .catch((error) => {
          request.log.warn({ err: error, event: 'github.repos.backfill_failed' }, 'On-connect backfill failed');
        });
    }

    return reply.code(200).send({ data: { connected: repos.length, disabled: toDisable.length } });
  });
};
