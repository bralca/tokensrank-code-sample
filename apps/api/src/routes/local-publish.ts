import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  LocalPublishPayloadSchema,
  LOCAL_PUBLISH_BODY_LIMIT_BYTES,
  PublishLinkExchangeRequestSchema,
  PublishLinkExchangeResponseSchema,
  PublishLinkStartResponseSchema,
  PublishLocalResponseSchema,
  type LocalPublishPayload,
} from '@tokensrank/shared';
import { randomBytes, randomUUID } from 'node:crypto';

import { adminClient } from '../clients/supabase';
import type { AuthContext } from '../middleware/auth';
import { computeKeyHash } from '../services/access-keys';
import {
  calculateProfileContribDaily,
  type ConnectedRepoRef,
  type GithubContribDailyRow,
} from '../services/github-pull';
import { comparePricingSnapshotToHostedRows } from '../services/local-publish-pricing';
import { finishPublishJob, registerPublishWorker, type PublishJob } from '../services/publish-jobs';

const MAX_PUBLIC_FAILURE_DETAILS = 100;
const MAX_PRICING_MISMATCHES = 100;

export type PublishVerificationStatus = 'pending' | 'processing' | 'passed' | 'failed' | 'unavailable';

const PublishRunStatusParamsSchema = z.object({
  runId: z.string().uuid(),
}).strict();

function errorEnvelope(code: string, message: string, details?: Record<string, unknown>) {
  return {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}

function getAuthContext(request: FastifyRequest): AuthContext {
  const auth = (request as FastifyRequest & { auth?: AuthContext }).auth;
  if (!auth) {
    throw new Error('[local-publish] Missing auth context after requireAuth');
  }
  return auth;
}

function extractBearerToken(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) {
    return '';
  }

  return header.slice(7);
}

function randomCode(): string {
  return randomBytes(24).toString('base64url');
}

function randomPublishToken(): string {
  return `tr_pub_${randomBytes(32).toString('base64url')}`;
}

export function payloadInvariantViolations(payload: LocalPublishPayload): string[] {
  const githubByKey = new Map(payload.github_code_daily.map((row) => [
    `${row.date}:${row.repo_id}`,
    row,
  ]));
  const producedByDay = new Map(payload.produced_code_daily.map((row) => [
    row.date,
    row,
  ]));
  const modelCodeByDay = new Map<string, { producedLoc: number; shippedLoc: number }>();
  const violations: string[] = [];

  for (const linked of payload.ai_linked_code_daily) {
    const github = githubByKey.get(`${linked.date}:${linked.repo_id}`);
    if (!github) {
      violations.push(`${linked.full_name} ${linked.date}: linked row has no GitHub verification row`);
      continue;
    }
    if (linked.linked_shipped_loc > github.github_shipped_loc) {
      violations.push(`${linked.full_name} ${linked.date}: linked LOC exceeds GitHub LOC`);
    }
    if (linked.linked_commit_count > github.github_commit_count) {
      violations.push(`${linked.full_name} ${linked.date}: linked commits exceed GitHub commits`);
    }
  }

  if (payload.summary.ai_linked_shipped_loc_total > payload.summary.github_shipped_loc_total) {
    violations.push('summary: AI-linked shipped LOC exceeds GitHub shipped LOC');
  }

  for (const row of payload.model_code_daily) {
    const existing = modelCodeByDay.get(row.date) ?? { producedLoc: 0, shippedLoc: 0 };
    existing.producedLoc += row.produced_loc;
    existing.shippedLoc += row.shipped_loc;
    modelCodeByDay.set(row.date, existing);
  }

  for (const [day, modelTotals] of modelCodeByDay) {
    const aggregate = producedByDay.get(day);
    if (!aggregate) {
      violations.push(`${day}: model code rows have no produced-code aggregate row`);
      continue;
    }
    if (modelTotals.producedLoc > aggregate.produced_loc) {
      violations.push(`${day}: model produced LOC exceeds aggregate produced LOC`);
    }
    if (modelTotals.shippedLoc > aggregate.shipped_loc) {
      violations.push(`${day}: model shipped LOC exceeds aggregate shipped LOC`);
    }
  }

  return violations.slice(0, 100);
}

async function pricingSnapshotMismatches(payload: LocalPublishPayload): Promise<string[]> {
  const { data, error } = await adminClient
    .from('model_pricing')
    .select('provider,model_id,content_hash');

  if (error) {
    throw new Error(`[local-publish] model pricing lookup failed: ${error.message}`);
  }

  return comparePricingSnapshotToHostedRows(payload, data ?? [], MAX_PRICING_MISMATCHES);
}

type ProfileGithubIdentity = {
  githubUserId: number;
  login: string;
  providerToken: string | null;
  verifiedEmails: string[];
};

type ProfileVerificationTrustRow = {
  failed_publish_count: number | string | null;
  consecutive_failed_publish_count: number | string | null;
  leaderboard_hidden_at: string | null;
  last_verified_at: string | null;
  last_failed_at: string | null;
};

export type ProfileVerificationTrustUpdate = {
  profile_id: string;
  latest_publish_run_id: string;
  latest_verification_status: PublishVerificationStatus;
  failed_publish_count: number;
  consecutive_failed_publish_count: number;
  deboost_multiplier: number;
  rank_eligible: boolean;
  leaderboard_hidden_at: string | null;
  last_verified_at: string | null;
  last_failed_at: string | null;
  failure_reasons: string[];
  updated_at: string;
};

export function deboostMultiplierForFailures(failedPublishCount: number): number {
  if (failedPublishCount <= 0) {
    return 1;
  }

  if (failedPublishCount === 1) {
    return 0.5;
  }

  if (failedPublishCount === 2) {
    return 0.25;
  }

  return 0;
}

export function parseCount(value: number | string | null | undefined): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);

    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

export function buildProfileVerificationTrustUpdate(input: {
  profileId: string;
  runId: string;
  status: PublishVerificationStatus;
  existing?: ProfileVerificationTrustRow | null;
  now: string;
  failureReasons?: string[];
}): ProfileVerificationTrustUpdate {
  const currentFailures = parseCount(input.existing?.failed_publish_count);
  const currentConsecutiveFailures = parseCount(input.existing?.consecutive_failed_publish_count);
  const isFailure = input.status === 'failed';
  const failedPublishCount = isFailure ? currentFailures + 1 : currentFailures;
  const consecutiveFailedPublishCount = input.status === 'passed'
    ? 0
    : isFailure
      ? currentConsecutiveFailures + 1
      : currentConsecutiveFailures;
  const deboostMultiplier = deboostMultiplierForFailures(failedPublishCount);
  const leaderboardHiddenAt = failedPublishCount >= 3
    ? input.existing?.leaderboard_hidden_at ?? input.now
    : input.existing?.leaderboard_hidden_at ?? null;

  return {
    profile_id: input.profileId,
    latest_publish_run_id: input.runId,
    latest_verification_status: input.status,
    failed_publish_count: failedPublishCount,
    consecutive_failed_publish_count: consecutiveFailedPublishCount,
    deboost_multiplier: deboostMultiplier,
    rank_eligible: leaderboardHiddenAt === null && (input.status === 'passed' || Boolean(input.existing?.last_verified_at)),
    leaderboard_hidden_at: leaderboardHiddenAt,
    last_verified_at: input.status === 'passed' ? input.now : input.existing?.last_verified_at ?? null,
    last_failed_at: isFailure ? input.now : input.existing?.last_failed_at ?? null,
    failure_reasons: (input.failureReasons ?? []).slice(0, MAX_PUBLIC_FAILURE_DETAILS),
    updated_at: input.now,
  };
}

async function loadProfileGithubIdentity(profileId: string): Promise<ProfileGithubIdentity | null> {
  const { data, error } = await adminClient
    .from('github_identities')
    .select('github_user_id,login,provider_token,verified_emails')
    .eq('profile_id', profileId)
    .maybeSingle<{
      github_user_id: number;
      login: string;
      provider_token: string | null;
      verified_emails: string[] | null;
    }>();

  if (error) {
    throw new Error(`[local-publish] GitHub identity lookup failed: ${error.message}`);
  }

  return data
    ? {
      githubUserId: data.github_user_id,
      login: data.login,
      providerToken: data.provider_token,
      verifiedEmails: data.verified_emails ?? [],
    }
    : null;
}

async function loadPublishTokenAuth(token: string): Promise<{ profileId: string; githubUserId: number; expiresAt: string } | null> {
  if (!token) {
    return null;
  }

  const { data, error } = await adminClient
    .from('local_publish_links')
    .select('profile_id,github_user_id,expires_at,publish_token_hash')
    .eq('publish_token_hash', computeKeyHash(token))
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle<{
      profile_id: string;
      github_user_id: number;
      expires_at: string;
      publish_token_hash: string;
    }>();

  if (error) {
    throw new Error(`[local-publish] publish token lookup failed: ${error.message}`);
  }

  return data ? { profileId: data.profile_id, githubUserId: data.github_user_id, expiresAt: data.expires_at } : null;
}

async function publicProfileUrl(profileId: string): Promise<string | null> {
  const { data, error } = await adminClient.from('profiles').select('handle').eq('id', profileId).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.handle ? new URL(`/u/${encodeURIComponent(data.handle)}`, process.env.NEXT_PUBLIC_SITE_URL ?? 'https://tokensrank.ai').href : null;
}

function firstPayloadDate(payload: LocalPublishPayload): string {
  const modelRows = publishModelDailyRows(payload);
  const dates = [
    ...payload.usage_daily.map((row) => row.date),
    ...modelRows.map((row) => row.date),
    ...payload.produced_code_daily.map((row) => row.date),
    ...payload.github_code_daily.map((row) => row.date),
    ...payload.ai_linked_code_daily.map((row) => row.date),
    ...payload.model_code_daily.map((row) => row.date),
  ].sort();

  return dates[0] ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function publishModelDailyRows(payload: LocalPublishPayload): LocalPublishPayload['usage_daily'] {
  return payload.model_daily.length > 0 ? payload.model_daily : payload.usage_daily;
}

function sumPayloadGithubByDay(payload: LocalPublishPayload): Map<string, { loc: number; commits: number }> {
  const byDay = new Map<string, { loc: number; commits: number }>();
  for (const row of payload.github_code_daily) {
    const existing = byDay.get(row.date) ?? { loc: 0, commits: 0 };
    existing.loc += row.github_shipped_loc;
    existing.commits += row.github_commit_count;
    byDay.set(row.date, existing);
  }
  return byDay;
}

function sumPayloadLinkedByDay(payload: LocalPublishPayload): Map<string, { loc: number; commits: number }> {
  const byDay = new Map<string, { loc: number; commits: number }>();
  for (const row of payload.ai_linked_code_daily) {
    const existing = byDay.get(row.date) ?? { loc: 0, commits: 0 };
    existing.loc += row.linked_shipped_loc;
    existing.commits += row.linked_commit_count;
    byDay.set(row.date, existing);
  }
  return byDay;
}

function compareDayClaims(
  label: string,
  claims: Map<string, { loc: number; commits: number }>,
  authoritativeByDay: Map<string, GithubContribDailyRow>,
): string[] {
  const violations: string[] = [];
  for (const [day, claim] of claims) {
    const authoritative = authoritativeByDay.get(day);
    const authoritativeLoc = authoritative?.shipped_loc ?? 0;
    const authoritativeCommits = authoritative?.commit_count ?? 0;
    if (claim.loc > authoritativeLoc) {
      violations.push(`${day}: ${label} LOC ${claim.loc} exceeds hosted GitHub LOC ${authoritativeLoc}`);
    }
    if (claim.commits > authoritativeCommits) {
      violations.push(`${day}: ${label} commits ${claim.commits} exceeds hosted GitHub commits ${authoritativeCommits}`);
    }
  }
  return violations;
}

async function verifyPayloadAgainstHostedGithub(
  profileId: string,
  payload: LocalPublishPayload,
): Promise<{
  rows: GithubContribDailyRow[];
  shippedLocTotal: number;
  commitTotal: number;
  verifiedAt: string;
  violations: string[];
}> {
  const identity = await loadProfileGithubIdentity(profileId);
  const hasCode = payload.selected_repos.length > 0 || payload.github_code_daily.length > 0
    || payload.ai_linked_code_daily.length > 0 || payload.summary.github_shipped_loc_total > 0
    || payload.summary.ai_linked_shipped_loc_total > 0;
  if (!identity || identity.githubUserId !== payload.github_user_id) throw new Error('Reconnect the matching GitHub account before publishing.');
  if (!hasCode) return { rows: [], shippedLocTotal: 0, commitTotal: 0, verifiedAt: new Date().toISOString(), violations: [] };
  if (!identity.providerToken) {
    throw new Error('[local-publish] Hosted GitHub provider token is required to verify published shipped-code totals.');
  }

  if (identity.githubUserId !== payload.github_user_id) throw new Error('Reconnect the matching GitHub account before publishing.');

  const repos: ConnectedRepoRef[] = payload.selected_repos.map((repo) => ({
    repo_id: repo.repo_id,
    full_name: repo.full_name,
    prod_branch: repo.prod_branch,
  }));
  const computed = await calculateProfileContribDaily({
    profileId,
    login: identity.login,
    repos,
    token: identity.providerToken,
    sinceIso: `${firstPayloadDate(payload)}T00:00:00.000Z`,
    verifiedEmails: identity.verifiedEmails,
    supabaseClient: adminClient,
  });

  const authoritativeByDay = new Map(computed.verificationRows.map((row) => [row.day, row]));
  const violations = [
    ...compareDayClaims('local GitHub', sumPayloadGithubByDay(payload), authoritativeByDay),
    ...compareDayClaims('AI-linked', sumPayloadLinkedByDay(payload), authoritativeByDay),
  ];
  const commitTotal = computed.rows.reduce((sum, row) => sum + row.commit_count, 0);

  if (payload.summary.github_shipped_loc_total > computed.rawShippedLocTotal) {
    violations.push(`summary: local GitHub LOC ${payload.summary.github_shipped_loc_total} exceeds hosted GitHub LOC ${computed.rawShippedLocTotal}`);
  }
  if (payload.summary.ai_linked_shipped_loc_total > computed.rawShippedLocTotal) {
    violations.push(`summary: AI-linked LOC ${payload.summary.ai_linked_shipped_loc_total} exceeds hosted GitHub LOC ${computed.rawShippedLocTotal}`);
  }

  return {
    rows: computed.rows,
    shippedLocTotal: computed.rawShippedLocTotal,
    commitTotal,
    verifiedAt: new Date().toISOString(),
    violations: violations.slice(0, 100),
  };
}

async function persistPayload(
  job: PublishJob,
  payload: LocalPublishPayload,
  remoteVerification: Awaited<ReturnType<typeof verifyPayloadAgainstHostedGithub>>,
): Promise<void> {
  const profileId = job.profile_id;
  const runId = job.run_id;
  const tables: Record<string, Record<string, unknown>[]> = {};

  tables['connected_repos'] = payload.selected_repos.map((repo) => ({
    profile_id: profileId,
    repo_id: repo.repo_id,
    full_name: repo.full_name,
    prod_branch: repo.prod_branch,
    enabled: true,
    updated_at: new Date().toISOString(),
  }));

  const modelDailyRows = publishModelDailyRows(payload);

  tables['usage_daily_aggregates'] = modelDailyRows.map((row) => ({
    profile_id: profileId,
    ...row,
    updated_at: new Date().toISOString(),
  }));

  tables['usage_session_rollups'] = payload.usage_session_rollups.map((row) => ({
    profile_id: profileId,
    ...row,
    source_file_hashes: row.source_file_hashes,
    updated_at: new Date().toISOString(),
  }));

  tables['published_code_daily'] = payload.produced_code_daily.map((row) => ({
    profile_id: profileId,
    ...row,
    updated_at: new Date().toISOString(),
  }));

  tables['local_published_github_code_daily'] = payload.github_code_daily.map((row) => ({
    profile_id: profileId,
    publish_run_id: runId,
    ...row,
    updated_at: new Date().toISOString(),
  }));

  tables['local_published_ai_linked_code_daily'] = payload.ai_linked_code_daily.map((row) => ({
    profile_id: profileId,
    publish_run_id: runId,
    ...row,
    updated_at: new Date().toISOString(),
  }));

  tables['local_published_model_code_daily'] = payload.model_code_daily.map((row) => ({
    profile_id: profileId,
    publish_run_id: runId,
    ...row,
    updated_at: new Date().toISOString(),
  }));

  tables['contrib_daily'] = remoteVerification.rows;

  await finishPublishJob(job, 'passed', {
    remote_github_shipped_loc_total: remoteVerification.shippedLocTotal,
    remote_github_commit_total: remoteVerification.commitTotal,
    remote_github_day_count: remoteVerification.rows.length,
    remote_github_verified_at: remoteVerification.verifiedAt,
    verification_violations: [],
  }, tables);
}

export async function processPublishVerification(job: PublishJob): Promise<'passed' | 'failed'> {
  const payload = LocalPublishPayloadSchema.parse(job.payload);
  const localViolations = payloadInvariantViolations(payload);
  if (localViolations.length) {
    await finishPublishJob(job, 'failed', {
      verification_violations: localViolations,
      error: 'Published code claims are inconsistent.',
    });
    return 'failed';
  }
  // Transient GitHub/database failures are retried by the durable worker.
  const remote = await verifyPayloadAgainstHostedGithub(job.profile_id, payload);
  if (remote.violations.length) {
    await finishPublishJob(job, 'failed', {
      verification_violations: remote.violations,
      remote_github_shipped_loc_total: remote.shippedLocTotal,
      remote_github_commit_total: remote.commitTotal,
      remote_github_day_count: remote.rows.length,
      remote_github_verified_at: remote.verifiedAt,
      error: 'Published code exceeds hosted GitHub verification totals.',
    });
    return 'failed';
  }
  await persistPayload(job, payload, remote);
  return 'passed';
}

export async function localPublishRoutes(fastify: FastifyInstance) {
  const worker = registerPublishWorker(fastify, processPublishVerification);
  fastify.post(
    '/api/publish/link/start',
    {
      preHandler: fastify.requireAuth,
    },
    async (request, reply) => {
      const auth = getAuthContext(request);
      const githubIdentity = await loadProfileGithubIdentity(auth.profileId);
      if (!githubIdentity) {
        return reply.code(400).send(errorEnvelope(
          'github_identity_missing',
          'Sign in with GitHub before creating a local publish code.',
        ));
      }

      const code = randomCode();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const { error } = await adminClient
        .from('local_publish_links')
        .insert({
          code_hash: computeKeyHash(code),
          profile_id: auth.profileId,
          github_user_id: githubIdentity.githubUserId,
          expires_at: expiresAt,
        });

      if (error) {
        throw new Error(`[local-publish] link start failed: ${error.message}`);
      }

      return reply.code(201).send(PublishLinkStartResponseSchema.parse({
        data: {
          code,
          expires_at: expiresAt,
        },
      }));
    },
  );

  fastify.post('/api/publish/link/exchange', async (request, reply) => {
    const parsed = PublishLinkExchangeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope(
        'schema_invalid',
        'Publish link exchange payload failed schema validation',
        parsed.error.flatten() as Record<string, unknown>,
      ));
    }

    const { data, error } = await adminClient
      .from('local_publish_links')
      .select('code_hash,profile_id,github_user_id,expires_at,exchanged_at')
      .eq('code_hash', computeKeyHash(parsed.data.code))
      .maybeSingle<{
        code_hash: string;
        profile_id: string;
        github_user_id: number;
        expires_at: string;
        exchanged_at: string | null;
      }>();

    if (error) {
      throw new Error(`[local-publish] link exchange lookup failed: ${error.message}`);
    }

    if (!data || Date.parse(data.expires_at) <= Date.now() || data.exchanged_at) {
      return reply.code(404).send(errorEnvelope(
        'publish_code_invalid',
        'Publish code is invalid, expired, or already used.',
      ));
    }

    if (parsed.data.github_user_id !== undefined && data.github_user_id !== parsed.data.github_user_id) {
      return reply.code(403).send(errorEnvelope(
        'github_identity_mismatch',
        'Local GitHub identity does not match this publish code.',
      ));
    }

    const publishToken = randomPublishToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: exchanged, error: updateError } = await adminClient
      .from('local_publish_links')
      .update({
        publish_token_hash: computeKeyHash(publishToken),
        expires_at: expiresAt,
        exchanged_at: new Date().toISOString(),
      })
      .eq('code_hash', data.code_hash)
      .is('exchanged_at', null)
      .gt('expires_at', new Date().toISOString())
      .select('code_hash').maybeSingle();

    if (updateError) {
      throw new Error(`[local-publish] link exchange update failed: ${updateError.message}`);
    }

    if (!exchanged) return reply.code(409).send(errorEnvelope('publish_code_used', 'This code has already been exchanged. Create a new code.'));

    return reply.code(201).send(PublishLinkExchangeResponseSchema.parse({
      data: {
        publish_token: publishToken,
        github_user_id: data.github_user_id,
        expires_at: expiresAt,
        public_profile_url: await publicProfileUrl(data.profile_id),
      },
    }));
  });

  fastify.get('/api/publish/token/status', async (request, reply) => {
    const auth = await loadPublishTokenAuth(extractBearerToken(request.headers.authorization));
    if (!auth) return reply.code(401).send(errorEnvelope('publish_token_invalid', 'Connection expired or revoked. Create a new publish code.'));
    return { data: { github_user_id: auth.githubUserId, expires_at: auth.expiresAt, public_profile_url: await publicProfileUrl(auth.profileId) } };
  });

  fastify.post('/api/publish/token/revoke', async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    const auth = await loadPublishTokenAuth(token);
    if (!auth) return reply.code(401).send(errorEnvelope('publish_token_invalid', 'Connection already expired or revoked.'));
    const { error } = await adminClient.from('local_publish_links').update({ revoked_at: new Date().toISOString() })
      .eq('publish_token_hash', computeKeyHash(token)).eq('profile_id', auth.profileId);
    if (error) throw new Error(error.message);
    return { data: { disconnected: true } };
  });

  fastify.post(
    '/api/publish/local',
    { bodyLimit: LOCAL_PUBLISH_BODY_LIMIT_BYTES },
    async (request, reply: FastifyReply) => {
      const publishAuth = await loadPublishTokenAuth(extractBearerToken(request.headers.authorization));
      if (!publishAuth) {
        return reply.code(401).send(errorEnvelope(
          'publish_token_invalid',
          'A valid local publish token is required.',
        ));
      }

      const parsed = LocalPublishPayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(errorEnvelope(
          'schema_invalid',
          'Local publish payload failed schema validation',
          parsed.error.flatten() as Record<string, unknown>,
        ));
      }

      const payload = parsed.data;
      const modelDailyRows = publishModelDailyRows(payload);
      if (publishAuth.githubUserId !== payload.github_user_id) {
        return reply.code(403).send(errorEnvelope(
          'github_identity_mismatch',
          'Local GitHub identity does not match the signed-in TokensRank GitHub identity.',
        ));
      }

      const violations = payloadInvariantViolations(payload);
      const pricingMismatches = await pricingSnapshotMismatches(payload);

      const runId = randomUUID();
      const { error: runError } = await adminClient.rpc('enqueue_local_publish', { p_run: {
          id: runId,
          profile_id: publishAuth.profileId,
          github_user_id: payload.github_user_id,
          status: 'processing',
          schema_version: payload.schema_version,
          verification_metrics_version: 2,
          client_version: payload.client_version,
          generated_at: payload.generated_at,
          started_at: new Date().toISOString(),
          verification_status: 'pending',
          usage_day_count: new Set(modelDailyRows.map((row) => row.date)).size,
          session_count: payload.summary.sessions_count,
          github_code_day_count: payload.github_code_daily.length,
          ai_linked_code_day_count: payload.ai_linked_code_daily.length,
          model_code_day_count: payload.model_code_daily.length,
          summary: payload.summary,
          privacy_report: payload.privacy_report,
          pricing_mismatches: pricingMismatches,
          local_invariant_violations: violations.slice(0, MAX_PUBLIC_FAILURE_DETAILS),
        }, p_payload: payload });

      if (runError) {
        throw new Error(`[local-publish] run open failed: ${runError.message}`);
      }

      worker.wake();

      return reply.code(202).send(PublishLocalResponseSchema.parse({
        data: {
          publish_run_id: runId,
          verification_status: 'pending',
          accepted_usage_days: new Set(modelDailyRows.map((row) => row.date)).size,
          accepted_sessions: payload.summary.sessions_count,
          accepted_code_days: payload.github_code_daily.length,
          remote_github_shipped_loc_total: 0,
          remote_github_commit_total: 0,
          remote_github_day_count: 0,
          pricing_mismatches: pricingMismatches,
        },
      }));
    },
  );

  fastify.get('/api/publish/local/runs/:runId', async (request, reply) => {
    const publishAuth = await loadPublishTokenAuth(extractBearerToken(request.headers.authorization));
    if (!publishAuth) {
      return reply.code(401).send(errorEnvelope(
        'publish_token_invalid',
        'A valid local publish token is required.',
      ));
    }

    const parsed = PublishRunStatusParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope(
        'schema_invalid',
        'Publish run parameters failed schema validation',
        parsed.error.flatten() as Record<string, unknown>,
      ));
    }

    const { data: run, error: runError } = await adminClient
      .from('local_publish_runs')
      .select(`
        id,
        status,
        verification_status,
        started_at,
        completed_at,
        verification_started_at,
        verification_completed_at,
        verification_attempt_count,
        usage_day_count,
        session_count,
        github_code_day_count,
        ai_linked_code_day_count,
        remote_github_shipped_loc_total,
        remote_github_commit_total,
        remote_github_day_count,
        remote_github_verified_at,
        pricing_mismatches,
        local_invariant_violations,
        verification_violations,
        error
      `)
      .eq('id', parsed.data.runId)
      .eq('profile_id', publishAuth.profileId)
      .maybeSingle<Record<string, unknown>>();

    if (runError) {
      throw new Error(`[local-publish] run status lookup failed: ${runError.message}`);
    }

    if (!run) {
      return reply.code(404).send(errorEnvelope(
        'publish_run_not_found',
        'Publish run was not found for this local publish token.',
      ));
    }

    const { data: trust, error: trustError } = await adminClient
      .from('profile_verification_trust')
      .select(`
        latest_verification_status,
        failed_publish_count,
        consecutive_failed_publish_count,
        deboost_multiplier,
        rank_eligible,
        leaderboard_hidden_at,
        last_verified_at,
        last_failed_at,
        failure_reasons,
        updated_at
      `)
      .eq('profile_id', publishAuth.profileId)
      .maybeSingle<Record<string, unknown>>();

    if (trustError) {
      throw new Error(`[local-publish] trust status lookup failed: ${trustError.message}`);
    }

    const { data: job, error: jobError } = await adminClient.from('local_publish_jobs').select('run_id')
      .eq('run_id', parsed.data.runId).maybeSingle();
    if (jobError) throw new Error(jobError.message);
    return {
      data: {
        publish_run: { ...run, publication_ready: run.verification_status === 'passed' && !job },
        public_profile_url: await publicProfileUrl(publishAuth.profileId),
        trust: trust ?? null,
      },
    };
  });
}
