import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FastifyBaseLogger } from 'fastify';

import { createPostgresClient, getActiveDatabaseSchema, quoteIdentifier } from '../lib/postgres';
import {
  purgeKeys,
} from './cache';
import {
  evaluateCacheWhisperer,
  evaluateConductor,
  evaluateDefectionArc,
  evaluateDetonation,
  evaluateDrifter,
  evaluateIronStreak,
  evaluateLongContext,
  evaluateMarathoner,
  evaluateMultiProvider,
  evaluateNightOwl,
  evaluateOperator,
  evaluateOutageWitness,
  evaluateReasoningJunkie,
  evaluateSniper,
  evaluateTier,
  evaluateTwoTool,
} from './badges/criteria';
import {
  type AggregateSnapshot,
  type BadgeCriteria,
  type BadgeCriteriaValidator,
  type BadgeEvaluationResult,
  type BadgeSlug,
  type ProfileSnapshot,
  type SessionSnapshot,
  toUtcDateKey,
} from './badges/types';

export const BADGE_EVALUATOR_LOCK_NAME = 'badge_evaluator';
export const BADGE_EVALUATOR_TIMEOUT_WARN_MS = 15 * 60 * 1000;

export interface BadgeSnapshot {
  slug: BadgeSlug | string;
  requires_verification?: boolean;
  criteria_json?: BadgeCriteria | null;
}

export interface BadgeDispatchResult {
  awarded: boolean;
  evidence: BadgeEvaluationResult['evidence'];
  reason?: 'awarded' | 'criteria_invalid' | 'criteria_not_met' | 'verification_gated' | 'validator_not_found';
}

export interface BadgeCatalogRow extends BadgeSnapshot {
  slug: BadgeSlug | string;
  name?: string | null;
  description?: string | null;
  icon_slug?: string | null;
  tier?: string | null;
}

export interface ProfileRow extends ProfileSnapshot {
  id: string;
  user_id: string;
  handle: string | null;
  mode?: ProfileSnapshot['mode'];
}

export interface BadgeEvaluatorLogger {
  debug?: FastifyBaseLogger['debug'];
  error?: FastifyBaseLogger['error'];
  info?: FastifyBaseLogger['info'];
  warn?: FastifyBaseLogger['warn'];
}

export interface EvaluateAllProfilesOptions {
  logger?: BadgeEvaluatorLogger;
  acquireLock?: boolean;
  filterProfileIds?: string[];
  timeoutWarnMs?: number;
}

export interface EvaluateAllProfilesResult {
  evaluated: number;
  badgesEvaluated: number;
  awarded: number;
  skipped: number;
  errors: Array<{ profile_id?: string; badge_slug?: string; error: string }>;
  lockAcquired: boolean;
  durationMs: number;
}

export const criteriaValidators: Record<BadgeSlug, BadgeCriteriaValidator> = {
  tier: evaluateTier,
  iron_streak: evaluateIronStreak,
  operator: evaluateOperator,
  cache_whisperer: evaluateCacheWhisperer,
  night_owl: evaluateNightOwl,
  multi_provider: evaluateMultiProvider,
  conductor: evaluateConductor,
  outage_witness: evaluateOutageWitness,
  reasoning_junkie: evaluateReasoningJunkie,
  marathoner: evaluateMarathoner,
  detonation: evaluateDetonation,
  long_context: evaluateLongContext,
  defection_arc: evaluateDefectionArc,
  two_tool: evaluateTwoTool,
  drifter: evaluateDrifter,
  sniper: evaluateSniper,
};

export const criteriaEvaluators = criteriaValidators;

const criteriaSchemas: Record<BadgeSlug, z.ZodType<BadgeCriteria>> = {
  tier: z.object({ threshold_tokens: z.number().positive().optional() }).strict(),
  iron_streak: z.object({ min_consecutive_days: z.number().positive().optional() }).strict(),
  operator: z.object({ min_sessions_per_day_avg: z.number().positive().optional() }).strict(),
  cache_whisperer: z.object({ min_cache_read_ratio: z.number().min(0).max(1).optional() }).strict(),
  night_owl: z.object({
    min_night_sessions_pct: z.number().min(0).max(1).optional(),
    night_start_hour: z.number().int().min(0).max(23).optional(),
    night_end_hour: z.number().int().min(0).max(23).optional(),
  }).strict(),
  multi_provider: z.object({
    requires_claude: z.boolean().optional(),
    requires_codex: z.boolean().optional(),
  }).strict(),
  conductor: z.object({ min_models_used: z.number().positive().optional() }).strict(),
  outage_witness: z.object({ requires_error_tag: z.boolean().optional() }).strict(),
  reasoning_junkie: z.object({
    min_reasoning_tokens: z.number().min(0).optional(),
    min_reasoning_ratio: z.number().min(0).max(1).optional(),
  }).strict(),
  marathoner: z.object({ min_session_hours: z.number().positive().optional() }).strict(),
  detonation: z.object({ min_daily_tokens: z.number().positive().optional() }).strict(),
  long_context: z.object({ min_context_tokens: z.number().positive().optional() }).strict(),
  defection_arc: z.object({
    from_model: z.string().min(1).optional(),
    to_model: z.string().min(1).optional(),
  }).strict(),
  two_tool: z.object({ requires_both_models: z.boolean().optional() }).strict(),
  drifter: z.object({ min_models_used: z.number().positive().optional() }).strict(),
  sniper: z.object({
    require_singular_focus: z.boolean().optional(),
    focus_ratio_threshold: z.number().min(0).max(1).optional(),
  }).strict(),
};

function isBadgeSlug(slug: string): slug is BadgeSlug {
  return Object.prototype.hasOwnProperty.call(criteriaValidators, slug);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function toIntegerHash(value: string): number {
  let hash = 0x811c9dc5;

  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash | 0;
}

export function hashAdvisoryLockKey(value: string): number {
  return toIntegerHash(value);
}

function validateCriteria(slug: BadgeSlug, criteria: BadgeCriteria | null | undefined): BadgeCriteria {
  return criteriaSchemas[slug].parse(criteria ?? {});
}

/**
 * Dispatches a catalog badge row to the matching pure criteria validator.
 *
 * Task 26 owns persistence, advisory locking, and audit logging. This function
 * owns only eligibility gating and criteria dispatch.
 */
export function evaluateBadge(
  profile: ProfileSnapshot,
  sessions: SessionSnapshot[],
  aggregates: AggregateSnapshot[],
  badge: BadgeSnapshot,
): BadgeDispatchResult {
  if (badge.requires_verification === true && profile.mode !== 'script_verified') {
    return {
      awarded: false,
      reason: 'verification_gated',
      evidence: {
        badge_slug: badge.slug,
        required_mode: 'script_verified',
        profile_mode: profile.mode ?? null,
      },
    };
  }

  if (!isBadgeSlug(badge.slug)) {
    return {
      awarded: false,
      reason: 'validator_not_found',
      evidence: {
        badge_slug: badge.slug,
      },
    };
  }

  let validatedCriteria: BadgeCriteria;

  try {
    validatedCriteria = validateCriteria(badge.slug, badge.criteria_json);
  } catch (error) {
    return {
      awarded: false,
      reason: 'criteria_invalid',
      evidence: {
        badge_slug: badge.slug,
        error: getErrorMessage(error),
      },
    };
  }

  const evaluation = criteriaValidators[badge.slug](
    profile,
    sessions,
    aggregates,
    validatedCriteria,
  );

  return {
    awarded: evaluation.earned,
    reason: evaluation.earned ? 'awarded' : 'criteria_not_met',
    evidence: evaluation.evidence,
  };
}

async function fetchRows<T>(
  supabaseClient: Pick<SupabaseClient, 'from'>,
  table: string,
  select: string,
  logger?: BadgeEvaluatorLogger,
): Promise<T[]> {
  const { data, error } = await supabaseClient
    .from(table)
    .select(select);

  if (error) {
    logger?.error?.({
      event: 'badge.fetch_failed',
      table,
      error: error.message,
    }, 'Badge evaluator failed to fetch rows');
    throw new Error(`Failed to fetch ${table}: ${error.message}`);
  }

  return (data ?? []) as T[];
}

async function fetchProfileRows(
  supabaseClient: Pick<SupabaseClient, 'from'>,
  filterProfileIds?: string[],
): Promise<ProfileRow[]> {
  let query = supabaseClient
    .from('profiles')
    .select('id,user_id,handle,mode')
    .order('updated_at', { ascending: false });

  if (filterProfileIds && filterProfileIds.length > 0) {
    query = query.in('id', filterProfileIds);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to fetch profiles: ${error.message}`);
  }

  return (data ?? []) as ProfileRow[];
}

async function fetchProfileSessions(
  supabaseClient: Pick<SupabaseClient, 'from'>,
  profileId: string,
): Promise<SessionSnapshot[]> {
  const { data, error } = await supabaseClient
    .from('sessions')
    .select([
      'id',
      'profile_id',
      'source',
      'session_id',
      'model',
      'first_event_at',
      'last_event_at',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_create_tokens',
      'cached_tokens',
      'reasoning_tokens',
      'total_tokens',
      'turns',
      'fingerprint',
    ].join(','))
    .eq('profile_id', profileId)
    .order('first_event_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch sessions for profile ${profileId}: ${error.message}`);
  }

  return (data ?? []) as SessionSnapshot[];
}

async function fetchProfileAggregates(
  supabaseClient: Pick<SupabaseClient, 'from'>,
  profileId: string,
): Promise<AggregateSnapshot[]> {
  async function load(table: string, select: string): Promise<AggregateSnapshot[]> {
    const rows: AggregateSnapshot[] = [];
    for (let from = 0; ; from += 1000) {
      let query = supabaseClient.from(table).select(select).eq('profile_id', profileId).order('date').order('source');
      if (table === 'public_usage_daily') query = query.order('model');
      const { data, error } = await query.range(from, from + 999);
      if (error) throw new Error(`Failed to fetch aggregates for profile ${profileId}: ${error.message}`);
      rows.push(...(data ?? []) as AggregateSnapshot[]);
      if ((data ?? []).length < 1000) return rows;
    }
  }
  const [rows, counts] = await Promise.all([
    load('public_usage_daily', 'profile_id,date,source,model,total_tokens,total_sessions'),
    load('public_usage_sessions_daily', 'profile_id,date,source,total_sessions'),
  ]);
  return applyUniqueSessionCounts(rows, counts);
}

/** Keep model token rows while counting each tool's daily sessions only once. */
export function applyUniqueSessionCounts(rows: AggregateSnapshot[], counts: AggregateSnapshot[]): AggregateSnapshot[] {
  const key = (row: AggregateSnapshot) => `${row.profile_id}:${toUtcDateKey(row.date)}:${row.source}`;
  const remaining = new Map(counts.map((row) => [key(row), Number(row.total_sessions) || 0]));
  return rows.map((row) => {
    const rowKey = key(row);
    const total_sessions = remaining.get(rowKey) ?? 0;
    remaining.set(rowKey, 0);
    return { ...row, total_sessions };
  });
}

function groupByProfileId<T extends { profile_id?: string | null }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();

  for (const row of rows) {
    if (!row.profile_id) {
      continue;
    }

    const bucket = grouped.get(row.profile_id) ?? [];
    bucket.push(row);
    grouped.set(row.profile_id, bucket);
  }

  return grouped;
}

async function fetchProfileSnapshots(profileIds: string[]): Promise<{
  sessionsByProfile: Map<string, SessionSnapshot[]>;
  aggregatesByProfile: Map<string, AggregateSnapshot[]>;
}> {
  if (profileIds.length === 0) {
    return {
      sessionsByProfile: new Map(),
      aggregatesByProfile: new Map(),
    };
  }

  const schema = getActiveDatabaseSchema();
  const client = await createPostgresClient();

  try {
    const sessions = await client.query<SessionSnapshot & { profile_id: string }>(
      `
        SELECT
          id::text,
          profile_id::text,
          source,
          session_id,
          model,
          first_event_at::text,
          last_event_at::text,
          input_tokens::double precision AS input_tokens,
          output_tokens::double precision AS output_tokens,
          cache_read_tokens::double precision AS cache_read_tokens,
          cache_create_tokens::double precision AS cache_create_tokens,
          cached_tokens::double precision AS cached_tokens,
          reasoning_tokens::double precision AS reasoning_tokens,
          total_tokens::double precision AS total_tokens,
          turns,
          fingerprint
        FROM ${quoteIdentifier(schema)}.sessions
        WHERE profile_id = ANY($1::uuid[])
        ORDER BY profile_id, first_event_at ASC
      `,
      [profileIds],
    );
    const aggregates = await client.query<AggregateSnapshot & { profile_id: string }>(
      `
        SELECT
          profile_id::text,
          date::text,
          source,
          model,
          total_tokens::double precision AS total_tokens,
          total_sessions
        FROM ${quoteIdentifier(schema)}.public_usage_daily
        WHERE profile_id = ANY($1::uuid[])
        ORDER BY profile_id, date ASC
      `,
      [profileIds],
    );

    const counts = await client.query<AggregateSnapshot>(
      `SELECT profile_id::text,date::text,source,total_sessions FROM ${quoteIdentifier(schema)}.public_usage_sessions_daily WHERE profile_id = ANY($1::uuid[])`,
      [profileIds],
    );
    return {
      sessionsByProfile: groupByProfileId(sessions.rows),
      aggregatesByProfile: groupByProfileId(applyUniqueSessionCounts(aggregates.rows, counts.rows)),
    };
  } finally {
    await client.end();
  }
}

async function tryInsertProfileBadge(
  profileId: string,
  badgeSlug: string,
  evidence: BadgeEvaluationResult['evidence'],
): Promise<boolean> {
  const schema = getActiveDatabaseSchema();
  const client = await createPostgresClient();

  try {
    const result = await client.query(
      `
        INSERT INTO ${quoteIdentifier(schema)}.profile_badges
          (profile_id, badge_slug, awarded_at, evidence)
        VALUES ($1, $2, now(), $3::jsonb)
        ON CONFLICT DO NOTHING
      `,
      [profileId, badgeSlug, JSON.stringify(evidence ?? {})],
    );

    return (result.rowCount ?? 0) > 0;
  } finally {
    await client.end();
  }
}

async function purgeProfileBadgeCaches(
  profile: ProfileRow,
  logger?: BadgeEvaluatorLogger,
): Promise<void> {
  try {
    const keys = [
      `me:v*:${profile.user_id}`,
    ];

    if (profile.handle) {
      keys.push(`profile:v*:${profile.handle}`);
      keys.push(`badges:v*:${profile.handle}`);
    }

    const purged = purgeKeys(keys);

    logger?.debug?.({
      event: 'badge.cache_purged',
      profile_id: profile.id,
      user_id: profile.user_id,
      handle: profile.handle,
      keys,
      purged,
    }, 'Badge award cache keys purged');
  } catch (error) {
    logger?.warn?.({
      event: 'badge.cache_purge_failed',
      profile_id: profile.id,
      user_id: profile.user_id,
      handle: profile.handle,
      error: getErrorMessage(error),
    }, 'Badge award cache purge failed');
  }
}

async function logBadgeAward(
  supabaseClient: Pick<SupabaseClient, 'from'>,
  profile: ProfileRow,
  badge: BadgeCatalogRow,
  evidence: BadgeEvaluationResult['evidence'],
  logger?: BadgeEvaluatorLogger,
): Promise<void> {
  const requestLog = logger?.debug && logger.error && logger.info && logger.warn
    ? logger as Pick<FastifyBaseLogger, 'debug' | 'error' | 'info' | 'warn'>
    : undefined;
  const { logAuditEvent } = await import('../lib/audit');

  await logAuditEvent({
    severity: 'info',
    event_type: 'profile.badge_awarded',
    profile_id: profile.id,
    payload: {
      badge_slug: badge.slug,
      badge_id: badge.slug,
      evidence,
      requires_verification: badge.requires_verification === true,
      mode_at_award: profile.mode ?? null,
    },
    requestLog,
    supabaseClient,
  });
}

async function acquireBadgeEvaluatorLock(): Promise<{
  client: Awaited<ReturnType<typeof createPostgresClient>>;
  acquired: boolean;
}> {
  const client = await createPostgresClient();
  const result = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS acquired',
    [hashAdvisoryLockKey(BADGE_EVALUATOR_LOCK_NAME)],
  );

  return {
    client,
    acquired: result.rows[0]?.acquired === true,
  };
}

export async function evaluateAllProfiles(
  supabaseClient?: Pick<SupabaseClient, 'from'>,
  options: EvaluateAllProfilesOptions = {},
): Promise<EvaluateAllProfilesResult> {
  const startedAt = Date.now();
  const timeoutWarnMs = options.timeoutWarnMs ?? BADGE_EVALUATOR_TIMEOUT_WARN_MS;
  const result: EvaluateAllProfilesResult = {
    evaluated: 0,
    badgesEvaluated: 0,
    awarded: 0,
    skipped: 0,
    errors: [],
    lockAcquired: false,
    durationMs: 0,
  };
  let lockClient: Awaited<ReturnType<typeof createPostgresClient>> | null = null;

  try {
    const evaluatorClient = supabaseClient ?? (await import('../clients/supabase')).adminClient;

    if (options.acquireLock !== false) {
      const lock = await acquireBadgeEvaluatorLock();
      lockClient = lock.client;
      result.lockAcquired = lock.acquired;

      if (!lock.acquired) {
        result.durationMs = Date.now() - startedAt;
        options.logger?.info?.({
          event: 'badge_cron.skipped',
          reason: 'advisory_lock_held',
          duration_ms: result.durationMs,
        }, 'Badge evaluator skipped because advisory lock is held');
        return result;
      }
    } else {
      result.lockAcquired = true;
    }

    const [profiles, badges] = await Promise.all([
      fetchProfileRows(evaluatorClient, options.filterProfileIds),
      fetchRows<BadgeCatalogRow>(evaluatorClient, 'badges', 'slug,name,description,icon_slug,requires_verification,criteria_json,tier', options.logger),
    ]);
    const useBatchSnapshots = options.acquireLock !== false;
    const snapshots = useBatchSnapshots
      ? await fetchProfileSnapshots(profiles.map((profile) => profile.id))
      : null;

    for (const profile of profiles) {
      try {
        const [sessions, aggregates] = snapshots
          ? [
            snapshots.sessionsByProfile.get(profile.id) ?? [],
            snapshots.aggregatesByProfile.get(profile.id) ?? [],
          ]
          : await Promise.all([
            fetchProfileSessions(evaluatorClient, profile.id),
            fetchProfileAggregates(evaluatorClient, profile.id),
          ]);

        for (const badge of badges) {
          try {
            const evaluation = evaluateBadge(profile, sessions, aggregates, badge);
            result.badgesEvaluated += 1;

            if (!evaluation.awarded) {
              result.skipped += 1;

              if (evaluation.reason === 'validator_not_found') {
                options.logger?.warn?.({
                  event: 'badge.validator_missing',
                  badge_slug: badge.slug,
                  profile_id: profile.id,
                }, 'Badge validator missing');
              }

              if (evaluation.reason === 'criteria_invalid') {
                options.logger?.error?.({
                  event: 'badge.criteria_invalid',
                  badge_slug: badge.slug,
                  profile_id: profile.id,
                  evidence: evaluation.evidence,
                  severity: 'critical',
                }, 'Badge criteria JSON is invalid');
              }

              continue;
            }

            const inserted = await tryInsertProfileBadge(profile.id, badge.slug, evaluation.evidence);

            if (!inserted) {
              continue;
            }

            result.awarded += 1;
            await logBadgeAward(evaluatorClient, profile, badge, evaluation.evidence, options.logger);
            await purgeProfileBadgeCaches(profile, options.logger);
          } catch (error) {
            const message = getErrorMessage(error);
            const errorCode = getErrorCode(error);
            result.skipped += 1;
            result.errors.push({
              profile_id: profile.id,
              badge_slug: badge.slug,
              error: message,
            });
            options.logger?.warn?.({
              event: errorCode === '23503' ? 'badge.profile_deleted' : 'badge.evaluation_failed',
              profile_id: profile.id,
              badge_slug: badge.slug,
              error_code: errorCode,
              error: message,
            }, 'Badge evaluation failed for profile badge');
          }
        }

        result.evaluated += 1;
      } catch (error) {
        const message = getErrorMessage(error);
        result.errors.push({
          profile_id: profile.id,
          error: message,
        });
        options.logger?.warn?.({
          event: 'badge.profile_failed',
          profile_id: profile.id,
          error: message,
        }, 'Badge evaluator failed for profile');
      }
    }

    return result;
  } finally {
    result.durationMs = Date.now() - startedAt;

    if (result.durationMs > timeoutWarnMs) {
      options.logger?.warn?.({
        event: 'badge_cron.slow',
        duration_ms: result.durationMs,
        timeout_warn_ms: timeoutWarnMs,
      }, 'Badge evaluator exceeded timeout warning threshold');
    }

    if (lockClient) {
      try {
        await lockClient.query('SELECT pg_advisory_unlock($1)', [hashAdvisoryLockKey(BADGE_EVALUATOR_LOCK_NAME)]);
      } finally {
        await lockClient.end();
      }
    }
  }
}
