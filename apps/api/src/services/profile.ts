import { queryPublishedLeaderboard } from './leaderboard';
import { loadProfileEvidence } from './profile-evidence';
import {
  ProfileResponseSchema,
  type ProfileResponse,
  type ProfileResponseAccessKey,
  type ProfileUpdate,
  type ProfileWindow,
} from '@tokensrank/shared';

import { adminClient } from '../clients/supabase';
import {
  createPostgresClient,
  getActiveDatabaseSchema,
  quoteIdentifier,
} from '../lib/postgres';
import { costForSession, pricingKey, type PricingMap } from '../lib/cost';
import { purgeKeys as purgeVersionedCacheKeys } from './cache';
import { cacheService } from './cache.service';
import {
  computeTierProgression,
} from './metrics-computation';

export type UpdateProfileResult = {
  updated: true;
};

type HandleAvailabilityRow = {
  is_taken: boolean;
};

type ProfileUpdateTarget = {
  handle: string | null;
};

export type ProfileResponseProfile = {
  id: string;
  user_id: string;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  x_handle: string | null;
  mode: 'script_verified' | 'self_reported' | null;
  verified: boolean;
  share_projects: boolean | null;
  created_at: string;
};

type SessionRow = {
  profile_id: string;
  session_id: string;
  source: 'claude' | 'codex' | 'opencode';
  model: string | null;
  file_sha256: string;
  first_event_at: string;
  last_event_at: string;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  cache_create_tokens: number | string | null;
  cached_tokens: number | string | null;
  reasoning_tokens: number | string | null;
  total_tokens: number | string | null;
  turns: number | string | null;
  fingerprint: Record<string, unknown> | null;
};

type ModelCostSessionRow = Pick<SessionRow,
  | 'source'
  | 'model'
  | 'last_event_at'
  | 'input_tokens'
  | 'output_tokens'
  | 'cache_read_tokens'
  | 'cache_create_tokens'
  | 'cached_tokens'
  | 'reasoning_tokens'
  | 'total_tokens'
>;

type ModelCostSummary = {
  costUsdTotal: number;
  sessionsCount: number;
  tokensTotal: number;
};

type ModelSourceSummary = {
  source: 'claude' | 'codex' | 'opencode';
  model: string;
  costUsdTotal: number;
  sessionsCount: number;
  tokensTotal: number;
};

type ModelUsageInsights = {
  costSummaries: Map<string, ModelCostSummary>;
  dailyCostByDate: Map<string, number>;
  modelSourceSummaries: Map<string, ModelSourceSummary>;
  modelUsageHistory: ProfileResponse['models']['model_usage_history'];
  providerSpendHistory: ProfileResponse['models']['provider_spend_history'];
};

type UsageDailyAggregateRow = {
  date: string;
  source: 'claude' | 'codex' | 'opencode';
  provider: 'anthropic' | 'openai' | 'unknown';
  model: string;
  total_tokens: number | string | null;
  total_sessions: number | string | null;
  cost_usd_total: number | string | null;
};

type ModelCodeDailyRow = {
  date: string;
  source: 'claude' | 'codex' | 'opencode';
  provider: 'anthropic' | 'openai' | 'unknown';
  model: string;
  produced_loc: number | string | null;
  produced_loc_score: number | string | null;
  shipped_loc: number | string | null;
  shipped_loc_score: number | string | null;
  linked_commit_count: number | string | null;
  linked_tokens: number | string | null;
  linked_cost_usd: number | string | null;
};

type PublishedCodeDailyRow = {
  date: string;
  produced_loc: number | string | null;
  produced_loc_score: number | string | null;
  shipped_loc: number | string | null;
  shipped_loc_score: number | string | null;
  ai_linked_commit_count: number | string | null;
  high_confidence_commit_count: number | string | null;
  median_link_confidence: number | string | null;
};

type ProfileMetricsCacheRow = {
  rank: number | string | null;
  rank_30d_ago: number | string | null;
  percentile: number | string | null;
  total_ranked: number | string | null;
  tokens_total: number | string | null;
  cost_usd_total: number | string | null;
  sessions_count: number | string | null;
  days_active: number | string | null;
  avg_tokens_per_session: number | string | null;
  current_streak: number | string | null;
  longest_streak: number | string | null;
  after_midnight_count: number | string | null;
  after_midnight_pct: number | string | null;
  weekend_share: number | string | null;
  avg_concurrent: number | string | null;
  days_parallel_3: number | string | null;
  longest_sustained_3_seconds: number | string | null;
  peak_ever: number | string | null;
  peak_ever_date: string | null;
  peak_ever_time: string | null;
  peak_daily: number[] | null;
  busiest_hour: string | null;
  busiest_day_of_week: string | null;
  parallelism_buckets: unknown;
  longest_session_seconds: number | string | null;
  longest_session_date: string | null;
  largest_tokens_session_tokens: number | string | null;
  largest_tokens_session_date: string | null;
  most_expensive_session_cost_usd: number | string | null;
  most_expensive_session_date: string | null;
  median_session_seconds: number | string | null;
  sessions_over_1h: number | string | null;
  total_session_time_seconds: number | string | null;
  cache_hit_rate: number | string | null;
  first_model_name: string | null;
  first_model_date: string | null;
  latest_model_name: string | null;
  latest_model_date: string | null;
  top_model_by_sessions: string | null;
  distinct_models: number | string | null;
  tool_both_days: number | string | null;
  tool_days_observed: number | string | null;
  daily_tokens_90d: number[] | null;
  daily_sessions_90d: number[] | null;
  daily_peak_concurrent_90d: number[] | null;
  score_per_day_90d: number[] | null;
  shipped_commit_per_day_90d: number[] | null;
  streak_bands: unknown;
  dominant_model_per_day_90d: string[] | null;
  model_metrics_90d: unknown;
  tier_progression: unknown;
  first_session_at: string | null;
  last_session_at: string | null;
};

type ProfileModelCacheRow = {
  model: string;
  tokens_total: number | string | null;
  sessions_count: number | string | null;
  cost_usd: number | string | null;
  cost_usd_total: number | string | null;
  pct_of_total: number | string | null;
};

type ProfileToolCacheRow = {
  claude_tokens: number | string | null;
  codex_tokens: number | string | null;
  opencode_tokens: number | string | null;
  claude_pct: number | string | null;
  codex_pct: number | string | null;
  opencode_pct: number | string | null;
  claude_sessions: number | string | null;
  codex_sessions: number | string | null;
  opencode_sessions: number | string | null;
  both_days: number | string | null;
  days_observed: number | string | null;
};

type ProfileSessionCacheRow = {
  session_id: string;
  source: 'claude' | 'codex' | 'opencode';
  model: string | null;
  started_at: string;
  ended_at: string | null;
  tokens_total: number | string | null;
  cost_usd_total: number | string | null;
  turns: number | string | null;
  project_name: string | null;
  file_sha256: string;
};

type ProfileCadenceCacheRow = {
  hourly_pattern: number[] | null;
  daily_pattern: number[] | null;
  days: unknown;
  busiest_day: string | null;
  busiest_hour: string | null;
};

type ProfileProjectCacheRow = {
  project_name: string;
  tokens_total: number | string | null;
  cost_usd_total: number | string | null;
  sessions_count: number | string | null;
  percentage: number | string | null;
};

type IngestionRunRow = {
  id: string;
  status: 'processing' | 'completed' | 'partial' | 'failed';
  ingestion_mode: 'script_verified' | 'self_reported';
  session_count: number | string | null;
  duplicate_count: number | string | null;
  rejected_count: number | string | null;
  started_at: string;
  finished_at: string | null;
};

type AccessKeyRow = {
  id: string;
  key_prefix: string;
  scope: 'script' | 'self_reported';
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

type ProfileBadgeRow = {
  badge_slug: string;
  awarded_at: string;
  evidence: Record<string, unknown> | null;
  revoked_at: string | null;
};

type BadgeRow = {
  slug: string;
  name: string;
  description: string;
  icon_slug: string;
  criteria_json: Record<string, unknown>;
  requires_verification: boolean;
  tier: 'standard' | 'rare' | 'legendary';
  created_at: string;
  updated_at: string;
};

const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;
const windowDays: Record<ProfileWindow, number | null> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  all: null,
};
const PROFILE_WINDOWS = ['24h', '7d', '30d', 'all'] as const satisfies ProfileWindow[];
const staleSyncMs = 14 * 24 * 60 * 60 * 1000;
const fallbackSiteUrl = 'http://localhost:3000';

const profileUpdateColumnMap = {
  displayName: 'display_name',
  avatarUrl: 'avatar_url',
  bio: 'bio',
  xHandle: 'x_handle',
  shareProjects: 'share_projects',
} as const satisfies Record<keyof ProfileUpdate, string>;

function parseNumeric(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function dateOnly(value: string | null | undefined): string {
  const date = new Date(value ?? '');

  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function normalizeDateTime(value: string): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function normalizeNullableDateTime(value: string | null): string | null {
  return value ? normalizeDateTime(value) : null;
}

function sessionTokens(session: SessionRow): number {
  const generatedTotal = parseNumeric(session.total_tokens);

  if (generatedTotal > 0) {
    return generatedTotal;
  }

  return parseNumeric(session.input_tokens)
    + parseNumeric(session.output_tokens)
    + parseNumeric(session.cache_read_tokens)
    + parseNumeric(session.cache_create_tokens)
    + parseNumeric(session.cached_tokens)
    + parseNumeric(session.reasoning_tokens);
}

function roundCurrency(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatDurationSeconds(value: number): string {
  const seconds = Math.max(0, Math.trunc(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  return `${hours}h ${minutes}m`;
}

/** Format an ISO timestamp as "Mon D, YYYY", or "N/A" if absent/invalid. */
function formatSessionDate(value: string | null | undefined): string {
  if (!value) return 'N/A';
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return 'N/A';
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function percentages(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);

  if (total <= 0 || values.length === 0) {
    return values.map(() => 0);
  }

  const rounded = values.map((value) => roundPercent((value / total) * 100));
  const delta = roundPercent(100 - rounded.reduce((sum, value) => sum + value, 0));

  rounded[rounded.length - 1] = roundPercent((rounded[rounded.length - 1] ?? 0) + delta);

  return rounded;
}

function numericArray(value: unknown, length?: number): number[] {
  const array = Array.isArray(value) ? value.map((item) => Math.max(0, Math.trunc(parseNumeric(item)))) : [];

  if (length === undefined) {
    return array;
  }

  return Array.from({ length }, (_, index) => array[index] ?? 0);
}

function cachedNumericSeries(value: unknown, length: number, shouldRequireSignal: boolean): number[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const series = numericArray(value, length);

  if (shouldRequireSignal && series.every((item) => item === 0)) {
    return null;
  }

  return series;
}

function cachedStringSeries(value: unknown, length: number, shouldRequireSignal: boolean): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const series = Array.from({ length }, (_, index) => {
    const item = value[index];

    return typeof item === 'string' ? item : '';
  });

  if (shouldRequireSignal && series.every((item) => item.trim() === '')) {
    return null;
  }

  return series;
}

function cachedJsonArray(value: unknown): unknown[] | null {
  return Array.isArray(value) && value.length > 0 ? value : null;
}

/** The stored series' own length (full activity range), or `fallback` if absent. */
function seriesLen(value: unknown, fallback = 90): number {
  return Array.isArray(value) && value.length > 0 ? value.length : fallback;
}

function cachedTierProgression(value: unknown): ProfileResponse['parallelism']['tier_progression'] | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const row = value as {
    tier?: unknown;
    days_at_tier?: unknown;
    unlocked?: unknown;
    highest_unlocked?: unknown;
  };
  const tier = Math.trunc(parseNumeric(row.tier));
  const highestUnlocked = Math.trunc(parseNumeric(row.highest_unlocked));

  if (tier < 1 || tier > 5 || highestUnlocked < 1 || highestUnlocked > 5) {
    return null;
  }

  return {
    tier: tier as 1 | 2 | 3 | 4 | 5,
    days_at_tier: Math.max(0, Math.trunc(parseNumeric(row.days_at_tier))),
    unlocked: Array.isArray(row.unlocked)
      ? row.unlocked
        .map((item) => Math.trunc(parseNumeric(item)))
        .filter((item) => item >= 1 && item <= 5)
      : [],
    highest_unlocked: highestUnlocked as 1 | 2 | 3 | 4 | 5,
  };
}

function emptyNumericSeries(length: number): number[] {
  return Array.from({ length }, () => 0);
}

function emptyStringSeries(length: number): string[] {
  return Array.from({ length }, () => '');
}

function cadenceDays(value: unknown): ProfileResponse['cadence']['days'] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }

    const row = item as { date?: unknown; tokens_total?: unknown; sessions_count?: unknown };

    return typeof row.date === 'string'
      ? [{
        date: row.date,
        tokens_total: Math.max(0, Math.trunc(parseNumeric(row.tokens_total))),
        sessions_count: Math.max(0, Math.trunc(parseNumeric(row.sessions_count))),
      }]
      : [];
  });
}

function parallelismBuckets(value: unknown): ProfileResponse['parallelism']['buckets'] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }

    const row = item as { label?: unknown; sessions_count?: unknown; percentage?: unknown };

    return typeof row.label === 'string' && row.label.trim() !== ''
      ? [{
        label: row.label,
        sessions_count: Math.max(0, Math.trunc(parseNumeric(row.sessions_count))),
        percentage: Math.max(0, Math.min(100, parseNumeric(row.percentage))),
      }]
      : [];
  });
}

function formatClockTime(value: string | null | undefined): string {
  const date = new Date(value ?? '');

  return Number.isNaN(date.getTime())
    ? '00:00'
    : date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function projectNameForSession(session: SessionRow): string {
  const fingerprintProjectName = session.fingerprint?.project_name;

  if (typeof fingerprintProjectName === 'string' && fingerprintProjectName.trim() !== '') {
    return fingerprintProjectName.trim();
  }

  return `${session.source}-${session.file_sha256.slice(0, 8)}`;
}

// Defensive coalesce for cached sessions that may have null project_name
function projectNameOrFallback(projectName: string | null | undefined, source: string, fileSha256: string): string {
  if (typeof projectName === 'string' && projectName.trim() !== '') {
    return projectName.trim();
  }
  return `${source}-${fileSha256.slice(0, 8)}`;
}

function variantFor(profile: ProfileResponseProfile, isOwner: boolean): ProfileResponse['variant'] {
  if (isOwner) {
    return profile.share_projects === true ? 'owner_share_true' : 'owner_share_false';
  }

  return profile.share_projects === true ? 'public_share_true' : 'public_share_false';
}

function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || process.env.PUBLIC_SITE_URL || fallbackSiteUrl).replace(/\/$/u, '');
}

function modeOrDefault(mode: ProfileResponseProfile['mode']): 'script_verified' | 'self_reported' {
  return mode ?? 'self_reported';
}

function buildProfileUpdatePayload(update: ProfileUpdate): Record<string, string | boolean | null> {
  const payload: Record<string, string | boolean | null> = {};

  for (const [field, column] of Object.entries(profileUpdateColumnMap) as Array<[keyof ProfileUpdate, string]>) {
    if (Object.prototype.hasOwnProperty.call(update, field)) {
      payload[column] = update[field] ?? null;
    }
  }

  return payload;
}

export async function isHandleAvailableInDb(handle: string): Promise<boolean> {
  const client = await createPostgresClient();
  const schema = quoteIdentifier(getActiveDatabaseSchema());

  try {
    const result = await client.query<HandleAvailabilityRow>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM ${schema}.profiles
          WHERE LOWER(handle::text) = LOWER($1::text)
          LIMIT 1
        ) AS is_taken
      `,
      [handle.trim()],
    );

    return result.rows[0]?.is_taken !== true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown database error';

    throw new Error(`[profile] Handle availability lookup failed: ${message}`);
  } finally {
    await client.end();
  }
}

export async function updateProfile(
  userId: string,
  update: ProfileUpdate,
): Promise<UpdateProfileResult> {
  const { data: profile, error: profileError } = await adminClient
    .from('profiles')
    .select('handle')
    .eq('user_id', userId)
    .maybeSingle<ProfileUpdateTarget>();

  if (profileError) {
    throw new Error(`[profile] Profile lookup failed: ${profileError.message}`);
  }

  if (!profile) {
    throw new Error(`[profile] Profile not found for user ${userId}`);
  }

  const payload = buildProfileUpdatePayload(update);

  if (Object.keys(payload).length > 0) {
    const { error: updateError } = await adminClient
      .from('profiles')
      .update(payload)
      .eq('user_id', userId);

    if (updateError) {
      throw new Error(`[profile] Profile update failed: ${updateError.message}`);
    }
  }

  const handle = profile.handle;
  const keys = [
    ...(handle ? [`profile:v*:${handle}:*`] : []),
    `me:v*:${userId}`,
    'lb:v*:*',
  ];

  cacheService.purgeKeys(keys);
  purgeVersionedCacheKeys(keys);

  return { updated: true };
}

async function loadRecentIngestionRuns(profileId: string): Promise<IngestionRunRow[]> {
  const { data, error } = await adminClient
    .from('ingestion_runs')
    .select('id,status,ingestion_mode,session_count,duplicate_count,rejected_count,started_at,finished_at')
    .eq('profile_id', profileId)
    .order('started_at', { ascending: false })
    .limit(10)
    .returns<IngestionRunRow[]>();

  if (error) {
    throw new Error(`[profile] Ingestion run lookup failed: ${error.message}`);
  }

  return data ?? [];
}

async function loadAccessKeys(profileId: string): Promise<ProfileResponseAccessKey[]> {
  const { data, error } = await adminClient
    .from('access_keys')
    .select('id,key_prefix,scope,created_at,last_used_at,revoked_at')
    .eq('profile_id', profileId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
    .returns<AccessKeyRow[]>();

  if (error) {
    throw new Error(`[profile] Access key lookup failed: ${error.message}`);
  }

  return (data ?? []).map((key) => ({
    key_id: key.id,
    key_prefix: key.key_prefix,
    scope: key.scope,
    created_at: key.created_at,
    last_used_at: key.last_used_at,
    revoked_at: key.revoked_at,
  }));
}

async function loadLastScriptSyncAt(profileId: string): Promise<string | null> {
  const { data, error } = await adminClient
    .from('ingestion_runs')
    .select('finished_at')
    .eq('profile_id', profileId)
    .eq('ingestion_mode', 'script_verified')
    .not('finished_at', 'is', null)
    .order('finished_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ finished_at: string | null }>();

  if (error) {
    throw new Error(`[profile] Last sync lookup failed: ${error.message}`);
  }

  return data?.finished_at ?? null;
}

async function loadBadges(profileId: string): Promise<ProfileResponse['identity']['badges']> {
  const { data: profileBadges, error: profileBadgesError } = await adminClient
    .from('profile_badges')
    .select('badge_slug,awarded_at,evidence,revoked_at')
    .eq('profile_id', profileId)
    .is('revoked_at', null)
    .order('awarded_at', { ascending: false })
    .returns<ProfileBadgeRow[]>();

  if (profileBadgesError) {
    throw new Error(`[profile] Profile badge lookup failed: ${profileBadgesError.message}`);
  }

  const badgeSlugs = (profileBadges ?? []).map((badge) => badge.badge_slug);

  if (badgeSlugs.length === 0) {
    return [];
  }

  const { data: badges, error: badgesError } = await adminClient
    .from('badges')
    .select('slug,name,description,icon_slug,criteria_json,requires_verification,tier,created_at,updated_at')
    .in('slug', badgeSlugs)
    .returns<BadgeRow[]>();

  if (badgesError) {
    throw new Error(`[profile] Badge catalog lookup failed: ${badgesError.message}`);
  }

  const catalog = new Map((badges ?? []).map((badge) => [badge.slug, badge]));

  return (profileBadges ?? []).flatMap((profileBadge) => {
    const badge = catalog.get(profileBadge.badge_slug);

    if (!badge) {
      return [];
    }

    return [{
      ...badge,
      created_at: normalizeDateTime(badge.created_at),
      updated_at: normalizeDateTime(badge.updated_at),
      awarded_at: normalizeDateTime(profileBadge.awarded_at),
      evidence: profileBadge.evidence,
      revoked_at: normalizeNullableDateTime(profileBadge.revoked_at),
    }];
  });
}

function computeCurrentStreak(sessions: SessionRow[]): number {
  if (sessions.length === 0) {
    return 0;
  }

  // Get unique active dates and sort them
  const activeDates = Array.from(new Set(sessions.map((s) => dateOnly(s.first_event_at)).filter(Boolean)))
    .sort()
    .reverse(); // Sort descending to start from most recent

  if (activeDates.length === 0) {
    return 0;
  }

  // Start from today and count consecutive days backward
  const today = dateOnly(new Date().toISOString());
  let streak = 0;
  let expectedDate = new Date(today);

  for (const activeDate of activeDates) {
    const currentExpectedDate = dateOnly(expectedDate.toISOString());

    if (activeDate === currentExpectedDate) {
      streak += 1;
      expectedDate.setDate(expectedDate.getDate() - 1);
    } else if (activeDate < currentExpectedDate) {
      // Gap found, stop counting
      break;
    }
  }

  return streak;
}

function computeLongestStreak(sessions: SessionRow[]): number {
  if (sessions.length === 0) {
    return 0;
  }

  // Get unique active dates and sort them ascending
  const activeDates = Array.from(new Set(sessions.map((s) => dateOnly(s.first_event_at)).filter(Boolean)))
    .sort();

  if (activeDates.length === 0) {
    return 0;
  }

  let longestStreak = 1;
  let currentStreak = 1;

  for (let i = 1; i < activeDates.length; i += 1) {
    const currentDate = new Date(activeDates[i]!);
    const previousDate = new Date(activeDates[i - 1]!);

    // Check if dates are consecutive (1 day apart)
    const daysDifference = Math.floor(
      (currentDate.getTime() - previousDate.getTime()) / (24 * 60 * 60 * 1000),
    );

    if (daysDifference === 1) {
      currentStreak += 1;
    } else {
      longestStreak = Math.max(longestStreak, currentStreak);
      currentStreak = 1;
    }
  }

  // Don't forget to check the final streak
  longestStreak = Math.max(longestStreak, currentStreak);

  return longestStreak;
}

function buildBreakdownItems<T extends { label: string }>(
  groups: Map<string, T & { tokens_total: number; sessions_count: number }>,
): Array<T & { percentage: number; tokens_total: number; sessions_count: number }> {
  const items = Array.from(groups.values())
    .sort((left, right) => right.tokens_total - left.tokens_total);
  const itemPercentages = percentages(items.map((item) => item.tokens_total));

  return items.map((item, index) => ({
    ...item,
    percentage: itemPercentages[index] ?? 0,
  }));
}

function buildProjectBreakdown(sessions: SessionRow[]) {
  const groups = new Map<string, {
    project_name: string;
    tokens_total: number;
    cost_usd_total: number;
    sessions_count: number;
    percentage: number;
  }>();

  for (const session of sessions) {
    const projectName = projectNameForSession(session);
    const current = groups.get(projectName) ?? {
      project_name: projectName,
      tokens_total: 0,
      cost_usd_total: 0,
      sessions_count: 0,
      percentage: 0,
    };

    const tokens = sessionTokens(session);
    current.tokens_total += tokens;
    current.cost_usd_total = 0; // per-item cost not fabricated; headline cost comes from stored profile_summary
    current.sessions_count += 1;
    groups.set(projectName, current);
  }

  const items = Array.from(groups.values()).sort((left, right) => right.tokens_total - left.tokens_total);
  const itemPercentages = percentages(items.map((item) => item.tokens_total));

  return items.map((item, index) => ({
    ...item,
    percentage: itemPercentages[index] ?? 0,
  }));
}

function buildModelBreakdown(sessions: SessionRow[]) {
  const groups = new Map<string, { label: string; tokens_total: number; sessions_count: number }>();

  for (const session of sessions) {
    const label = session.model ?? 'unknown';
    const current = groups.get(label) ?? { label, tokens_total: 0, sessions_count: 0 };

    current.tokens_total += sessionTokens(session);
    current.sessions_count += 1;
    groups.set(label, current);
  }

  return buildBreakdownItems(groups);
}

function buildToolBreakdown(sessions: SessionRow[], shouldShowProjects: boolean) {
  const groups = new Map<string, {
    label: string;
    source: 'claude' | 'codex' | 'opencode';
    project_name?: string | null;
    tokens_total: number;
    sessions_count: number;
  }>();

  for (const session of sessions) {
    const projectName = shouldShowProjects ? projectNameForSession(session) : null;
    const groupKey = shouldShowProjects ? `${session.source}:${projectName}` : session.source;
    const current = groups.get(groupKey) ?? {
      label: shouldShowProjects && projectName ? `${session.source} / ${projectName}` : session.source,
      source: session.source,
      project_name: projectName,
      tokens_total: 0,
      sessions_count: 0,
    };

    current.tokens_total += sessionTokens(session);
    current.sessions_count += 1;
    groups.set(groupKey, current);
  }

  return buildBreakdownItems(groups);
}

function buildCadence(sessions: SessionRow[]) {
  const start = new Date(Date.now() - thirtyDaysMs);
  const byDate = new Map<string, { date: string; tokens_total: number; sessions_count: number }>();

  for (let day = 0; day < 30; day += 1) {
    const current = new Date(start.getTime() + day * 24 * 60 * 60 * 1000);
    const date = current.toISOString().slice(0, 10);
    byDate.set(date, { date, tokens_total: 0, sessions_count: 0 });
  }

  const hourlyCounts = new Map<string, number>();

  for (const session of sessions) {
    const eventDate = new Date(session.last_event_at);

    if (eventDate.getTime() < start.getTime()) {
      continue;
    }

    const date = eventDate.toISOString().slice(0, 10);
    const day = byDate.get(date);

    if (day) {
      day.tokens_total += sessionTokens(session);
      day.sessions_count += 1;
    }

    const hour = String(eventDate.getUTCHours()).padStart(2, '0');
    hourlyCounts.set(hour, (hourlyCounts.get(hour) ?? 0) + 1);
  }

  const days = Array.from(byDate.values());
  const busiestDay = days.reduce<typeof days[number] | null>(
    (best, day) => !best || day.tokens_total > best.tokens_total ? day : best,
    null,
  );
  const busiestHour = Array.from(hourlyCounts.entries())
    .sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;

  return {
    days,
    busiest_day: busiestDay && busiestDay.tokens_total > 0 ? busiestDay.date : null,
    busiest_hour: busiestHour,
  };
}

/**
 * Computes the average number of concurrent sessions across all time periods
 * where sessions overlap. Sessions are concurrent if their time ranges overlap.
 */
function computeAvgConcurrent(sessions: SessionRow[]): number {
  if (sessions.length === 0) {
    return 0;
  }

  // Parse all session time ranges
  const events: Array<{ timestamp: number; type: 'start' | 'end'; sessionId: string }> = [];

  for (const session of sessions) {
    const startMs = new Date(session.first_event_at).getTime();
    const endMs = new Date(session.last_event_at).getTime();

    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
      continue;
    }

    events.push({ timestamp: startMs, type: 'start', sessionId: session.session_id });
    events.push({ timestamp: endMs, type: 'end', sessionId: session.session_id });
  }

  if (events.length === 0) {
    return 0;
  }

  // Sort events by timestamp
  events.sort((a, b) => a.timestamp - b.timestamp);

  let totalConcurrencyMs = 0;
  let currentConcurrency = 0;
  let lastTimestamp = 0;

  for (const event of events) {
    // Add duration since last event (with current concurrency count)
    if (lastTimestamp > 0 && event.timestamp > lastTimestamp && currentConcurrency > 0) {
      totalConcurrencyMs += (event.timestamp - lastTimestamp) * currentConcurrency;
    }

    // Update concurrency
    if (event.type === 'start') {
      currentConcurrency += 1;
    } else {
      currentConcurrency = Math.max(0, currentConcurrency - 1);
    }

    lastTimestamp = event.timestamp;
  }

  // Compute average: sum of (sessions * duration) / total duration
  if (totalConcurrencyMs === 0) {
    return 0;
  }

  const timeSpanMs = events[events.length - 1]!.timestamp - events[0]!.timestamp;

  if (timeSpanMs === 0) {
    return currentConcurrency;
  }

  return totalConcurrencyMs / timeSpanMs;
}

/**
 * Counts the number of distinct days where there are 3+ concurrent sessions
 */
function computeDaysParallel3(sessions: SessionRow[]): number {
  if (sessions.length === 0) {
    return 0;
  }

  // Group sessions by day and compute max concurrency per day
  const daysConcurrency = new Map<string, number>();

  for (const session of sessions) {
    const startDate = new Date(session.first_event_at);
    const endDate = new Date(session.last_event_at);

    if (
      Number.isNaN(startDate.getTime())
      || Number.isNaN(endDate.getTime())
      || endDate.getTime() < startDate.getTime()
    ) {
      continue;
    }

    const endDayStr = endDate.toISOString().slice(0, 10);

    // Get all days this session spans
    const currentDate = new Date(startDate);
    currentDate.setUTCHours(0, 0, 0, 0);

    while (currentDate.toISOString().slice(0, 10) <= endDayStr) {
      const dayStr = currentDate.toISOString().slice(0, 10);

      // For each day, count how many sessions are active on that day
      const dayEvents: Array<{ timestamp: number; type: 'start' | 'end' }> = [];

      for (const s of sessions) {
        const sStart = new Date(s.first_event_at).getTime();
        const sEnd = new Date(s.last_event_at).getTime();
        const dayStart = new Date(dayStr).getTime();
        const dayEnd = dayStart + 24 * 60 * 60 * 1000;

        // Check if session overlaps with this day
        if (sStart < dayEnd && sEnd >= dayStart) {
          dayEvents.push({
            timestamp: Math.max(sStart, dayStart),
            type: 'start',
          });
          dayEvents.push({
            timestamp: Math.min(sEnd, dayEnd),
            type: 'end',
          });
        }
      }

      dayEvents.sort((a, b) => a.timestamp - b.timestamp);

      let maxConcurrency = 0;
      let currentConcurrency = 0;

      for (const evt of dayEvents) {
        if (evt.type === 'start') {
          currentConcurrency += 1;
          maxConcurrency = Math.max(maxConcurrency, currentConcurrency);
        } else {
          currentConcurrency = Math.max(0, currentConcurrency - 1);
        }
      }

      daysConcurrency.set(dayStr, Math.max(daysConcurrency.get(dayStr) ?? 0, maxConcurrency));

      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }
  }

  // Count days with 3+ concurrent sessions
  let count = 0;
  for (const concurrency of daysConcurrency.values()) {
    if (concurrency >= 3) {
      count += 1;
    }
  }

  return count;
}

/**
 * Finds the longest continuous period with 3+ concurrent sessions
 * Returns duration in "Xh Ym" format
 */
function computeLongestSustained3(sessions: SessionRow[]): string {
  if (sessions.length === 0) {
    return '0h 0m';
  }

  // Create events across all time
  const events: Array<{ timestamp: number; type: 'start' | 'end' }> = [];

  for (const session of sessions) {
    const startMs = new Date(session.first_event_at).getTime();
    const endMs = new Date(session.last_event_at).getTime();

    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
      continue;
    }

    events.push({ timestamp: startMs, type: 'start' });
    events.push({ timestamp: endMs, type: 'end' });
  }

  if (events.length === 0) {
    return '0h 0m';
  }

  events.sort((a, b) => a.timestamp - b.timestamp);

  let maxDurationMs = 0;
  let currentConcurrency = 0;
  let periodStartMs = 0;

  for (const event of events) {
    if (event.type === 'start') {
      // Starting a session
      if (currentConcurrency < 3 && currentConcurrency + 1 >= 3) {
        // Entering the 3+ zone
        periodStartMs = event.timestamp;
      }
      currentConcurrency += 1;
    } else {
      // Ending a session
      if (currentConcurrency >= 3 && currentConcurrency - 1 < 3) {
        // Exiting the 3+ zone
        maxDurationMs = Math.max(maxDurationMs, event.timestamp - periodStartMs);
      }
      currentConcurrency = Math.max(0, currentConcurrency - 1);
    }
  }

  // Format as "Xh Ym"
  const hours = Math.floor(maxDurationMs / (60 * 60 * 1000));
  const minutes = Math.floor((maxDurationMs % (60 * 60 * 1000)) / (60 * 1000));

  return `${hours}h ${minutes}m`;
}

function maxConcurrencyForRange(sessions: SessionRow[], rangeStartMs: number, rangeEndMs: number): {
  peak: number;
  peakAt: number | null;
} {
  const events: Array<{ timestamp: number; type: 'start' | 'end' }> = [];

  for (const session of sessions) {
    const sessionStartMs = new Date(session.first_event_at).getTime();
    const sessionEndMs = new Date(session.last_event_at).getTime();

    if (
      Number.isNaN(sessionStartMs)
      || Number.isNaN(sessionEndMs)
      || sessionEndMs < sessionStartMs
      || sessionStartMs >= rangeEndMs
      || sessionEndMs < rangeStartMs
    ) {
      continue;
    }

    events.push({ timestamp: Math.max(sessionStartMs, rangeStartMs), type: 'start' });
    events.push({ timestamp: Math.min(sessionEndMs, rangeEndMs), type: 'end' });
  }

  events.sort((left, right) => {
    if (left.timestamp !== right.timestamp) {
      return left.timestamp - right.timestamp;
    }

    return left.type === 'start' ? -1 : 1;
  });

  let current = 0;
  let peak = 0;
  let peakAt: number | null = null;

  for (const event of events) {
    if (event.type === 'start') {
      current += 1;
      if (current > peak) {
        peak = current;
        peakAt = event.timestamp;
      }
    } else {
      current = Math.max(0, current - 1);
    }
  }

  return { peak, peakAt };
}

function buildPeakDaily(sessions: SessionRow[], days = 90): {
  peakDaily: number[];
  peakEver: number;
  peakEverDate: string;
  peakEverTime: string;
} {
  const dayMs = 24 * 60 * 60 * 1000;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const firstDayMs = today.getTime() - (days - 1) * dayMs;
  const peakDaily: number[] = [];
  let peakEver = 0;
  let peakEverAt: number | null = null;

  for (let index = 0; index < days; index += 1) {
    const rangeStartMs = firstDayMs + index * dayMs;
    const { peak, peakAt } = maxConcurrencyForRange(sessions, rangeStartMs, rangeStartMs + dayMs);

    peakDaily.push(peak);

    if (peak > peakEver) {
      peakEver = peak;
      peakEverAt = peakAt;
    }
  }

  const peakDate = peakEverAt === null ? null : new Date(peakEverAt);

  return {
    peakDaily,
    peakEver,
    peakEverDate: peakDate
      ? peakDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
      : 'N/A',
    peakEverTime: peakDate
      ? peakDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })
      : '00:00',
  };
}

function buildParallelism(sessions: SessionRow[]) {
  const byDay = new Map<string, number>();

  for (const session of sessions) {
    const date = dateOnly(session.last_event_at);
    if (!date) {
      continue;
    }
    byDay.set(date, (byDay.get(date) ?? 0) + 1);
  }

  const buckets = [
    { label: '1 at a time', sessions_count: 0, percentage: 0 },
    { label: '2 parallel', sessions_count: 0, percentage: 0 },
    { label: '3+ concurrent', sessions_count: 0, percentage: 0 },
  ];

  for (const count of byDay.values()) {
    if (count <= 1) {
      buckets[0]!.sessions_count += count;
    } else if (count === 2) {
      buckets[1]!.sessions_count += count;
    } else {
      buckets[2]!.sessions_count += count;
    }
  }

  const bucketPercentages = percentages(buckets.map((bucket) => bucket.sessions_count));

  return {
    buckets: buckets.map((bucket, index) => ({
      ...bucket,
      percentage: bucketPercentages[index] ?? 0,
    })),
  };
}

function computeSyncStatus(lastSyncAt: string | null): ProfileResponse['sync_status'] {
  if (!lastSyncAt) {
    return 'ERROR';
  }

  return new Date(lastSyncAt).getTime() < Date.now() - staleSyncMs ? 'STALE' : 'SYNCED';
}

/**
 * Builds the public profile response contract for all four profile variants.
 */
// Mon-indexed to match metrics.dow (sessions per weekday, 0=Mon … 6=Sun).
const SUMMARY_DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function summaryArgmaxIndex(arr: number[]): number {
  let best = 0;
  for (let i = 1; i < arr.length; i += 1) {
    if ((arr[i] ?? 0) > (arr[best] ?? 0)) best = i;
  }
  return best;
}

async function loadProfileCadenceWindows(
  profileId: string,
): Promise<NonNullable<ProfileResponse['cadence']['windows']>> {
  const { data, error } = await adminClient
    .from('profile_summary')
    .select('window,sessions_count,metrics')
    .eq('profile_id', profileId)
    .in('window', PROFILE_WINDOWS)
    .returns<Array<{
      window: ProfileWindow;
      sessions_count: number | string | null;
      metrics: Record<string, any> | null;
    }>>();

  if (error || !data) {
    return {};
  }

  const entries = data.flatMap((row) => {
    if (!PROFILE_WINDOWS.includes(row.window)) {
      return [];
    }

    const metrics = row.metrics ?? {};
    const hourly = numericArray(metrics.hourly, 24);
    const daily = numericArray(metrics.dow, 7);
    const afterMidnightCount = Math.max(0, Math.trunc(parseNumeric(metrics.after_midnight?.count)));

    return [[row.window, {
      busiest_day: daily.some((value) => value > 0) ? SUMMARY_DAY_NAMES[summaryArgmaxIndex(daily)] ?? null : null,
      busiest_hour: hourly.some((value) => value > 0) ? `${String(summaryArgmaxIndex(hourly)).padStart(2, '0')}:00` : null,
      hourly,
      daily,
      after_midnight: {
        count: afterMidnightCount,
        pct: Math.max(0, Math.min(1, parseNumeric(metrics.after_midnight?.pct))),
      },
      weekend_share: Math.max(0, Math.min(1, parseNumeric(metrics.weekend_share))),
      sessions_count: Math.max(0, Math.trunc(parseNumeric(row.sessions_count))),
    }]];
  });

  return Object.fromEntries(entries) as NonNullable<ProfileResponse['cadence']['windows']>;
}

async function loadModelPricingMap(): Promise<PricingMap> {
  const { data, error } = await adminClient
    .from('model_pricing')
    .select('provider,model_id,input_per_mtok,output_per_mtok,cache_read_per_mtok,cache_write_per_mtok')
    .returns<Array<{
      provider: string;
      model_id: string;
      input_per_mtok: number | null;
      output_per_mtok: number | null;
      cache_read_per_mtok: number | null;
      cache_write_per_mtok: number | null;
    }>>();

  if (error) {
    throw new Error(`[profile] Model pricing lookup failed: ${error.message}`);
  }

  const pricing: PricingMap = new Map();

  for (const row of data ?? []) {
    pricing.set(pricingKey(row.provider, row.model_id), {
      input: row.input_per_mtok,
      output: row.output_per_mtok,
      cache_read: row.cache_read_per_mtok,
      cache_write: row.cache_write_per_mtok,
    });
  }

  return pricing;
}

async function loadAllModelCostSessions(profileId: string): Promise<ModelCostSessionRow[]> {
  const rows: ModelCostSessionRow[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await adminClient
      .from('sessions')
      .select([
        'source',
        'model',
        'last_event_at',
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'cache_create_tokens',
        'cached_tokens',
        'reasoning_tokens',
        'total_tokens',
      ].join(','))
      .eq('profile_id', profileId)
      .order('last_event_at', { ascending: true })
      .range(from, from + pageSize - 1)
      .returns<ModelCostSessionRow[]>();

    if (error) {
      throw new Error(`[profile] Model usage session lookup failed: ${error.message}`);
    }

    rows.push(...(data ?? []));

    if ((data ?? []).length < pageSize) {
      return rows;
    }
  }
}

async function loadUsageDailyAggregates(profileId: string): Promise<UsageDailyAggregateRow[]> {
  const rows: UsageDailyAggregateRow[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await adminClient
      .from('usage_daily_aggregates')
      .select('date,source,provider,model,total_tokens,total_sessions,cost_usd_total')
      .eq('profile_id', profileId)
      .lte('date',new Date().toISOString().slice(0,10))
      .order('date', { ascending: true })
      .order('source', { ascending: true })
      .order('provider', { ascending: true })
      .order('model', { ascending: true })
      .range(from, from + pageSize - 1)
      .returns<UsageDailyAggregateRow[]>();

    if (error) {
      throw new Error(`[profile] Usage daily aggregate lookup failed: ${error.message}`);
    }

    rows.push(...(data ?? []));

    if ((data ?? []).length < pageSize) {
      return rows;
    }
  }
}

async function loadDailySessionCounts(profileId: string): Promise<Array<{ date: string; total_sessions: number }>> {
  const rows: Array<{ date: string; total_sessions: number }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await adminClient.from('public_usage_sessions_daily')
      .select('date,total_sessions').eq('profile_id', profileId)
      .order('date').order('source').range(from, from + 999);
    if (error) throw new Error(`[profile] Daily sessions unavailable: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

async function loadPublishedCodeDailyRows(profileId: string): Promise<PublishedCodeDailyRow[]> {
  const rows: PublishedCodeDailyRow[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await adminClient
      .from('published_code_daily')
      .select([
        'date',
        'produced_loc',
        'produced_loc_score',
        'shipped_loc',
        'shipped_loc_score',
        'ai_linked_commit_count',
        'high_confidence_commit_count',
        'median_link_confidence',
      ].join(','))
      .eq('profile_id', profileId)
      .order('date', { ascending: true })
      .range(from, from + pageSize - 1)
      .returns<PublishedCodeDailyRow[]>();

    if (error) {
      throw new Error(`[profile] Published code daily lookup failed: ${error.message}`);
    }

    rows.push(...(data ?? []));

    if ((data ?? []).length < pageSize) {
      return rows;
    }
  }
}

async function loadModelCodeDailyRows(profileId: string): Promise<ModelCodeDailyRow[]> {
  const rows: ModelCodeDailyRow[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await adminClient
      .from('local_published_model_code_daily')
      .select([
        'date',
        'source',
        'provider',
        'model',
        'produced_loc',
        'produced_loc_score',
        'shipped_loc',
        'shipped_loc_score',
        'linked_commit_count',
        'linked_tokens',
        'linked_cost_usd',
      ].join(','))
      .eq('profile_id', profileId)
      .order('date', { ascending: true })
      .range(from, from + pageSize - 1)
      .returns<ModelCodeDailyRow[]>();

    if (error) {
      throw new Error(`[profile] Model code daily lookup failed: ${error.message}`);
    }

    rows.push(...(data ?? []));

    if ((data ?? []).length < pageSize) {
      return rows;
    }
  }
}

function modelCostSessionTokens(session: ModelCostSessionRow): number {
  const generatedTotal = parseNumeric(session.total_tokens);

  if (generatedTotal > 0) {
    return generatedTotal;
  }

  return parseNumeric(session.input_tokens)
    + parseNumeric(session.output_tokens)
    + parseNumeric(session.cache_read_tokens)
    + parseNumeric(session.cache_create_tokens)
    + parseNumeric(session.cached_tokens)
    + parseNumeric(session.reasoning_tokens);
}

type SpendProvider = 'claude' | 'codex' | 'opencode' | 'other';

function spendProviderForSource(source: string): SpendProvider {
  if (source === 'claude' || source === 'codex' || source === 'opencode') {
    return source;
  }

  return 'other';
}

function spendProviderForSession(session: ModelCostSessionRow): SpendProvider {
  if (session.source === 'claude' || session.source === 'codex' || session.source === 'opencode') {
    return session.source;
  }

  return 'other';
}

function addDay(date: string, days = 1): string {
  const value = new Date(`${date}T00:00:00.000Z`);

  if (Number.isNaN(value.getTime())) {
    return date;
  }

  value.setUTCDate(value.getUTCDate() + days);

  return value.toISOString().slice(0, 10);
}

function modelSourceKey(source: 'claude' | 'codex' | 'opencode', model: string): string {
  return JSON.stringify([source, model]);
}

function dateRange(start: string, end: string): string[] {
  if (!start || !end || start > end) {
    return [];
  }

  const days: string[] = [];
  let current = start;

  while (current <= end) {
    days.push(current);
    current = addDay(current);
  }

  return days;
}

function profileWindowCutoffDate(window: ProfileWindow): string | null {
  const days = windowDays[window];
  if (days === null) return null;
  return new Date(Date.now() - days * dayMs).toISOString().slice(0, 10);
}

function lastNDates(days: number): string[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today.getTime() - (days - 1 - index) * dayMs);
    return date.toISOString().slice(0, 10);
  });
}

function buildSpendPerShippedAiLoc30d(
  dates90: string[],
  dailyCostByDate: Map<string, number>,
  shippedAiCodedLocByDate: Map<string, number>,
) {
  return dates90.map((date, index) => {
    const windowDates = dates90.slice(Math.max(0, index - 29), index + 1);
    const costUsd = windowDates.reduce((sum, day) => sum + (dailyCostByDate.get(day) ?? 0), 0);
    const shippedAiCodedLoc = windowDates.reduce((sum, day) => sum + (shippedAiCodedLocByDate.get(day) ?? 0), 0);
    const roundedCost = roundCurrency(costUsd);

    if (costUsd <= 0 && shippedAiCodedLoc <= 0) {
      return { date, cost_usd: 0, shipped_ai_coded_loc: 0, value: null, status: 'no_activity' as const };
    }
    if (shippedAiCodedLoc <= 0) {
      return { date, cost_usd: roundedCost, shipped_ai_coded_loc: 0, value: null, status: 'no_shipped_code' as const };
    }
    if (costUsd <= 0) {
      return { date, cost_usd: 0, shipped_ai_coded_loc: shippedAiCodedLoc, value: 0, status: 'zero_cost' as const };
    }

    return {
      date,
      cost_usd: roundedCost,
      shipped_ai_coded_loc: shippedAiCodedLoc,
      value: Math.round((costUsd / shippedAiCodedLoc) * 10000) / 10000,
      status: 'ok' as const,
    };
  });
}

function buildModelUsageInsightsFromDaily(
  rows: UsageDailyAggregateRow[],
  window: ProfileWindow,
): ModelUsageInsights {
  const costSummaries = new Map<string, ModelCostSummary>();
  const dailyCostByDate = new Map<string, number>();
  const modelSourceSummaries = new Map<string, ModelSourceSummary>();
  const providerDailyCost = new Map<string, Record<SpendProvider, number>>();
  const modelDailyTokens = new Map<string, Map<string, number>>();
  const modelDailyCost = new Map<string, Map<string, number>>();
  const modelDates = new Map<string, { first: string; last: string }>();
  const cutoffDays = windowDays[window];
  const cutoffMs = cutoffDays === null ? Number.NEGATIVE_INFINITY : Date.now() - cutoffDays * dayMs;
  let firstDay = '';
  let lastDay = '';

  for (const row of rows) {
    const model = row.model?.trim() || 'unknown';
    const day = row.date;
    const dayMs = new Date(`${day}T00:00:00.000Z`).getTime();

    if (!day || Number.isNaN(dayMs)) {
      continue;
    }

    if (!firstDay || day < firstDay) firstDay = day;
    if (!lastDay || day > lastDay) lastDay = day;

    const tokensTotal = Math.max(0, Math.trunc(parseNumeric(row.total_tokens)));
    const costUsd = parseNumeric(row.cost_usd_total);
    dailyCostByDate.set(day, (dailyCostByDate.get(day) ?? 0) + costUsd);

    if (dayMs >= cutoffMs) {
      const current = costSummaries.get(model) ?? { costUsdTotal: 0, sessionsCount: 0, tokensTotal: 0 };

      current.costUsdTotal += costUsd;
      current.sessionsCount += Math.max(0, Math.trunc(parseNumeric(row.total_sessions)));
      current.tokensTotal += tokensTotal;
      costSummaries.set(model, current);

      const sourceKey = modelSourceKey(row.source, model);
      const sourceCurrent = modelSourceSummaries.get(sourceKey) ?? {
        source: row.source,
        model,
        costUsdTotal: 0,
        sessionsCount: 0,
        tokensTotal: 0,
      };
      sourceCurrent.costUsdTotal += costUsd;
      sourceCurrent.sessionsCount += Math.max(0, Math.trunc(parseNumeric(row.total_sessions)));
      sourceCurrent.tokensTotal += tokensTotal;
      modelSourceSummaries.set(sourceKey, sourceCurrent);
    }

    const provider = spendProviderForSource(row.source);
    const providerDay = providerDailyCost.get(day) ?? { claude: 0, codex: 0, opencode: 0, other: 0 };
    providerDay[provider] += costUsd;
    providerDailyCost.set(day, providerDay);

    const modelDay = modelDailyTokens.get(model) ?? new Map<string, number>();
    modelDay.set(day, (modelDay.get(day) ?? 0) + tokensTotal);
    modelDailyTokens.set(model, modelDay);

    const modelCostDay = modelDailyCost.get(model) ?? new Map<string, number>();
    modelCostDay.set(day, (modelCostDay.get(day) ?? 0) + costUsd);
    modelDailyCost.set(model, modelCostDay);

    const dates = modelDates.get(model);
    modelDates.set(model, {
      first: dates ? dates.first < day ? dates.first : day : day,
      last: dates ? dates.last > day ? dates.last : day : day,
    });
  }

  const providerTotals: Record<SpendProvider, number> = { claude: 0, codex: 0, opencode: 0, other: 0 };
  const providerPoints: Record<SpendProvider, Array<{ date: string; cost: number }>> = {
    claude: [],
    codex: [],
    opencode: [],
    other: [],
  };

  for (const day of dateRange(firstDay, lastDay)) {
    const costs = providerDailyCost.get(day);

    providerTotals.claude += costs?.claude ?? 0;
    providerTotals.codex += costs?.codex ?? 0;
    providerTotals.opencode += costs?.opencode ?? 0;
    providerTotals.other += costs?.other ?? 0;

    providerPoints.claude.push({ date: day, cost: roundCurrency(providerTotals.claude) });
    providerPoints.codex.push({ date: day, cost: roundCurrency(providerTotals.codex) });
    providerPoints.opencode.push({ date: day, cost: roundCurrency(providerTotals.opencode) });
    providerPoints.other.push({ date: day, cost: roundCurrency(providerTotals.other) });
  }

  const providerSpendHistory = (['claude', 'codex', 'opencode', 'other'] as const)
    .map((provider) => ({ provider, points: providerPoints[provider] }))
    .filter((series) => series.points.some((point) => point.cost > 0));

  const modelUsageHistory = Array.from(modelDailyTokens.entries())
    .map(([model, dailyTokens]) => {
      const dates = modelDates.get(model);
      const dailyCosts = modelDailyCost.get(model) ?? new Map<string, number>();

      if (!dates) {
        return { model, points: [] };
      }

      let tokenTotal = 0;
      let costTotal = 0;
      const points = dateRange(dates.first, dates.last).map((day) => {
        tokenTotal += Math.max(0, Math.trunc(dailyTokens.get(day) ?? 0));
        costTotal += Math.max(0, dailyCosts.get(day) ?? 0);

        return { date: day, tokens: tokenTotal, cost: roundCurrency(costTotal) };
      });

      return { model, points };
    })
    .filter((series) => series.points.some((point) => point.tokens > 0))
    .sort((left, right) => {
      const leftCost = left.points.at(-1)?.cost ?? 0;
      const rightCost = right.points.at(-1)?.cost ?? 0;
      const leftTotal = left.points.at(-1)?.tokens ?? 0;
      const rightTotal = right.points.at(-1)?.tokens ?? 0;

      return rightCost - leftCost || rightTotal - leftTotal;
    });

  return {
    costSummaries,
    dailyCostByDate,
    modelSourceSummaries,
    modelUsageHistory,
    providerSpendHistory,
  };
}

async function loadModelUsageInsights(profileId: string, window: ProfileWindow): Promise<ModelUsageInsights> {
  const usageDailyAggregates = await loadUsageDailyAggregates(profileId);

  if (usageDailyAggregates.length > 0) {
    return buildModelUsageInsightsFromDaily(usageDailyAggregates, window);
  }

  const [sessions, pricing] = await Promise.all([
    loadAllModelCostSessions(profileId),
    loadModelPricingMap(),
  ]);
  const costSummaries = new Map<string, ModelCostSummary>();
  const dailyCostByDate = new Map<string, number>();
  const modelSourceSummaries = new Map<string, ModelSourceSummary>();
  const providerDailyCost = new Map<string, Record<SpendProvider, number>>();
  const modelDailyTokens = new Map<string, Map<string, number>>();
  const modelDailyCost = new Map<string, Map<string, number>>();
  const modelDates = new Map<string, { first: string; last: string }>();
  const cutoffDays = windowDays[window];
  const cutoffMs = cutoffDays === null ? Number.NEGATIVE_INFINITY : Date.now() - cutoffDays * dayMs;
  let firstDay = '';
  let lastDay = '';

  for (const session of sessions) {
    const model = session.model?.trim() || 'unknown';
    const endedAtMs = new Date(session.last_event_at).getTime();
    const day = dateOnly(session.last_event_at);

    if (!day || Number.isNaN(endedAtMs)) {
      continue;
    }

    if (!firstDay || day < firstDay) firstDay = day;
    if (!lastDay || day > lastDay) lastDay = day;

    const tokensTotal = modelCostSessionTokens(session);
    const result = costForSession({
      source: session.source,
      model,
      input_tokens: parseNumeric(session.input_tokens),
      output_tokens: parseNumeric(session.output_tokens),
      cache_read_tokens: parseNumeric(session.cache_read_tokens),
      cache_create_tokens: parseNumeric(session.cache_create_tokens),
      cached_tokens: parseNumeric(session.cached_tokens),
      reasoning_tokens: parseNumeric(session.reasoning_tokens),
    }, pricing);
    dailyCostByDate.set(day, (dailyCostByDate.get(day) ?? 0) + result.costUsd);

    if (endedAtMs >= cutoffMs) {
      const current = costSummaries.get(model) ?? { costUsdTotal: 0, sessionsCount: 0, tokensTotal: 0 };

      current.costUsdTotal += result.costUsd;
      current.sessionsCount += 1;
      current.tokensTotal += tokensTotal;
      costSummaries.set(model, current);

      const sourceKey = modelSourceKey(session.source, model);
      const sourceCurrent = modelSourceSummaries.get(sourceKey) ?? {
        source: session.source,
        model,
        costUsdTotal: 0,
        sessionsCount: 0,
        tokensTotal: 0,
      };
      sourceCurrent.costUsdTotal += result.costUsd;
      sourceCurrent.sessionsCount += 1;
      sourceCurrent.tokensTotal += tokensTotal;
      modelSourceSummaries.set(sourceKey, sourceCurrent);
    }

    const provider = spendProviderForSession(session);
    const providerDay = providerDailyCost.get(day) ?? { claude: 0, codex: 0, opencode: 0, other: 0 };
    providerDay[provider] += result.costUsd;
    providerDailyCost.set(day, providerDay);

    const modelDay = modelDailyTokens.get(model) ?? new Map<string, number>();
    modelDay.set(day, (modelDay.get(day) ?? 0) + tokensTotal);
    modelDailyTokens.set(model, modelDay);

    const modelCostDay = modelDailyCost.get(model) ?? new Map<string, number>();
    modelCostDay.set(day, (modelCostDay.get(day) ?? 0) + result.costUsd);
    modelDailyCost.set(model, modelCostDay);

    const dates = modelDates.get(model);
    modelDates.set(model, {
      first: dates ? dates.first < day ? dates.first : day : day,
      last: dates ? dates.last > day ? dates.last : day : day,
    });
  }

  const providerTotals: Record<SpendProvider, number> = { claude: 0, codex: 0, opencode: 0, other: 0 };
  const providerPoints: Record<SpendProvider, Array<{ date: string; cost: number }>> = {
    claude: [],
    codex: [],
    opencode: [],
    other: [],
  };

  for (const day of dateRange(firstDay, lastDay)) {
    const costs = providerDailyCost.get(day);

    providerTotals.claude += costs?.claude ?? 0;
    providerTotals.codex += costs?.codex ?? 0;
    providerTotals.opencode += costs?.opencode ?? 0;
    providerTotals.other += costs?.other ?? 0;

    providerPoints.claude.push({ date: day, cost: roundCurrency(providerTotals.claude) });
    providerPoints.codex.push({ date: day, cost: roundCurrency(providerTotals.codex) });
    providerPoints.opencode.push({ date: day, cost: roundCurrency(providerTotals.opencode) });
    providerPoints.other.push({ date: day, cost: roundCurrency(providerTotals.other) });
  }

  const providerSpendHistory = (['claude', 'codex', 'opencode', 'other'] as const)
    .map((provider) => ({ provider, points: providerPoints[provider] }))
    .filter((series) => series.points.some((point) => point.cost > 0));

  const modelUsageHistory = Array.from(modelDailyTokens.entries())
    .map(([model, dailyTokens]) => {
      const dates = modelDates.get(model);
      const dailyCosts = modelDailyCost.get(model) ?? new Map<string, number>();

      if (!dates) {
        return { model, points: [] };
      }

      let tokenTotal = 0;
      let costTotal = 0;
      const points = dateRange(dates.first, dates.last).map((day) => {
        tokenTotal += Math.max(0, Math.trunc(dailyTokens.get(day) ?? 0));
        costTotal += Math.max(0, dailyCosts.get(day) ?? 0);

        return { date: day, tokens: tokenTotal, cost: roundCurrency(costTotal) };
      });

      return { model, points };
    })
    .filter((series) => series.points.some((point) => point.tokens > 0))
    .sort((left, right) => {
      const leftCost = left.points.at(-1)?.cost ?? 0;
      const rightCost = right.points.at(-1)?.cost ?? 0;
      const leftTotal = left.points.at(-1)?.tokens ?? 0;
      const rightTotal = right.points.at(-1)?.tokens ?? 0;

      return rightCost - leftCost || rightTotal - leftTotal;
    });

  return {
    costSummaries,
    dailyCostByDate,
    modelSourceSummaries,
    modelUsageHistory,
    providerSpendHistory,
  };
}

type ProfileSummaryAdapters = {
  cachedMetrics: ProfileMetricsCacheRow | null;
  cachedModelRows: ProfileModelCacheRow[];
  cachedToolRow: ProfileToolCacheRow | null;
  cachedSessionRows: ProfileSessionCacheRow[];
  cachedCadence: ProfileCadenceCacheRow | null;
  cachedProjectRows: ProfileProjectCacheRow[];
  shipped: { commit_per_day_90d: number[]; loc_per_day_90d: number[]; loc_total: number; commit_total: number };
};

/**
 * Reads the single profile_summary row for (profile, window) and reshapes its
 * scalars + metrics JSONB into the legacy cache-row shapes buildProfileResponse
 * already maps. Fields not yet computed by the new rebuild (concurrency/L4,
 * session superlative dates, model 14d-trend, dominant-model timeline, top
 * sessions, projects) default to 0/null/[]; the mapping is null-safe via
 * parseNumeric/numericArray/cachedTierProgression. Replaces the six legacy
 * per-table cache loaders (now dead pending the Step-6 teardown).
 */
async function loadProfileSummaryAdapters(profileId: string, window: ProfileWindow): Promise<ProfileSummaryAdapters> {
  const empty: ProfileSummaryAdapters = {
    cachedMetrics: null,
    cachedModelRows: [],
    cachedToolRow: null,
    cachedSessionRows: [],
    cachedCadence: null,
    cachedProjectRows: [],
    shipped: { commit_per_day_90d: [], loc_per_day_90d: [], loc_total: 0, commit_total: 0 },
  };

  const { data, error } = await adminClient
    .from('profile_summary')
    .select('rank,rank_delta,percentile,total_ranked,tokens_total,cost_usd_total,shipped_loc_total,commit_count_total,sessions_count,days_active,metrics')
    .eq('profile_id', profileId)
    .eq('window', window)
    .maybeSingle<{
      rank: number | null;
      rank_delta: number | null;
      percentile: number | null;
      total_ranked: number | null;
      tokens_total: number | string;
      cost_usd_total: number | string;
      shipped_loc_total: number | string;
      commit_count_total: number;
      sessions_count: number;
      days_active: number;
      metrics: Record<string, any> | null;
    }>();

  if (error || !data) {
    return empty;
  }

  const [rankRows, dailyRows, sessionResult] = await Promise.all([
    queryPublishedLeaderboard(adminClient, { period: window, scope: 'all', limit: 1, offset: 0 }, profileId),
    loadUsageDailyAggregates(profileId),
    loadDailySessionCounts(profileId),
  ]);
  const publicRank = rankRows[0];
  const byDay = new Map<string, { date: string; tokens_total: number; sessions_count: number }>();
  for (const row of dailyRows) {
    const day = byDay.get(row.date) ?? { date: row.date, tokens_total: 0, sessions_count: 0 };
    day.tokens_total += parseNumeric(row.total_tokens);
    day.sessions_count += parseNumeric(row.total_sessions);
    byDay.set(row.date, day);
  }
  if (sessionResult.length) {
    for (const day of byDay.values()) day.sessions_count = 0;
    for (const row of sessionResult) {
      const day = byDay.get(row.date) ?? { date: row.date, tokens_total: 0, sessions_count: 0 };
      day.sessions_count += Number(row.total_sessions);
      byDay.set(row.date, day);
    }
  }
  const today = Math.floor(Date.now() / 86400000) * 86400000;
  const first = Math.min(today - 29 * 86400000, ...[...byDay.keys()].map((day) => Date.parse(`${day}T00:00:00Z`)));
  const days = Array.from({ length: Math.min(36500, Math.floor((today - first) / 86400000) + 1) }, (_, i) => {
    const date = new Date(first + i * 86400000).toISOString().slice(0, 10);
    return byDay.get(date) ?? { date, tokens_total: 0, sessions_count: 0 };
  });
  const m = data.metrics ?? {};
  const tokensTotal = parseNumeric(data.tokens_total);
  const hourly: number[] = Array.isArray(m.hourly) ? m.hourly : [];
  const dow: number[] = Array.isArray(m.dow) ? m.dow : [];
  const models: Array<{ model: string; tokens: number; tokens14dCurr?: number; tokens14dPrev?: number }> =
    Array.isArray(m.models) ? m.models : [];
  const firstModelMeta = m.first_model && typeof m.first_model === 'object' ? m.first_model : null;
  const latestModelMeta = m.latest_model && typeof m.latest_model === 'object' ? m.latest_model : null;
  const busiestHour = hourly.length > 0 ? `${String(summaryArgmaxIndex(hourly)).padStart(2, '0')}:00` : null;
  const busiestDay = dow.length > 0 ? (SUMMARY_DAY_NAMES[summaryArgmaxIndex(dow)] ?? null) : null;
  const claudeTokens = Number(m.tools?.claude ?? 0);
  const codexTokens = Number(m.tools?.codex ?? 0);
  const opencodeTokens = Number(m.tools?.opencode ?? 0);

  const cachedMetrics = {
    rank: publicRank ? Number(publicRank.rank) : null,
    rank_30d_ago: null,
    percentile: publicRank ? Number(publicRank.rank) / Number(publicRank.total_count) * 100 : null,
    total_ranked: publicRank ? Number(publicRank.total_count) : 0,
    tokens_total: data.tokens_total,
    cost_usd_total: data.cost_usd_total,
    sessions_count: data.sessions_count,
    days_active: data.days_active,
    current_streak: m.current_streak ?? 0,
    longest_streak: m.longest_streak ?? 0,
    after_midnight_count: m.after_midnight?.count ?? 0,
    after_midnight_pct: m.after_midnight?.pct ?? 0,
    weekend_share: m.weekend_share ?? 0,
    busiest_hour: busiestHour,
    longest_session_seconds: m.longest_session_seconds ?? 0,
    longest_session_date: m.longest_session_date ?? null,
    largest_tokens_session_tokens: m.largest_tokens_session_tokens ?? 0,
    largest_tokens_session_date: m.largest_tokens_session_date ?? null,
    most_expensive_session_cost_usd: m.most_expensive_session_cost_usd ?? 0,
    most_expensive_session_date: m.most_expensive_session_date ?? null,
    median_session_seconds: m.median_session_seconds ?? 0,
    sessions_over_1h: m.sessions_over_1h ?? 0,
    total_session_time_seconds: m.total_session_time_seconds ?? 0,
    distinct_models: m.distinct_models ?? 0,
    top_model_by_sessions: models[0]?.model ?? null,
    daily_tokens_90d: Array.isArray(m.daily_tokens_90d) ? m.daily_tokens_90d : [],
    daily_sessions_90d: Array.isArray(m.daily_sessions_90d) ? m.daily_sessions_90d : [],
    daily_peak_concurrent_90d: [],
    score_per_day_90d: Array.isArray(m.score_per_day_90d) ? m.score_per_day_90d : [],
    shipped_commit_per_day_90d: Array.isArray(m.shipped_commit_per_day_90d) ? m.shipped_commit_per_day_90d : [],
    streak_bands: [],
    dominant_model_per_day_90d: Array.isArray(m.dominant_model_per_day_90d) ? m.dominant_model_per_day_90d : [],
    model_metrics_90d: models.map((mm) => {
      const prev = Number(mm.tokens14dPrev ?? 0);
      const curr = Number(mm.tokens14dCurr ?? 0);
      // ±15% band counts as flat so small noise doesn't read as a real swing.
      const trend = curr > prev * 1.15 ? 'up' : curr < prev * 0.85 ? 'down' : 'flat';
      return {
        model: mm.model,
        tokens_total: mm.tokens,
        tokens_14d_prev: prev,
        tokens_14d_curr: curr,
        trend,
      };
    }),
    tier_progression: null,
    parallelism_buckets: [],
    peak_daily: [],
    peak_ever: 0,
    cache_hit_rate: 0,
    first_session_at: m.first_session_at ?? null,
    last_session_at: m.last_session_at ?? null,
    first_model_name: firstModelMeta?.name ?? null,
    first_model_date: firstModelMeta?.date ?? null,
    latest_model_name: latestModelMeta?.name ?? null,
    latest_model_date: latestModelMeta?.date ?? null,
  } as unknown as ProfileMetricsCacheRow;

  const cachedModelRows = models.map((mm) => ({
    model: mm.model,
    tokens_total: mm.tokens,
    sessions_count: 0,
    cost_usd: 0,
    cost_usd_total: 0,
    pct_of_total: tokensTotal > 0 ? (mm.tokens / tokensTotal) * 100 : 0,
  })) as unknown as ProfileModelCacheRow[];

  const cachedToolRow = {
    claude_tokens: claudeTokens,
    codex_tokens: codexTokens,
    opencode_tokens: opencodeTokens,
    claude_pct: tokensTotal > 0 ? (claudeTokens / tokensTotal) * 100 : 0,
    codex_pct: tokensTotal > 0 ? (codexTokens / tokensTotal) * 100 : 0,
    opencode_pct: tokensTotal > 0 ? (opencodeTokens / tokensTotal) * 100 : 0,
    claude_sessions: 0,
    codex_sessions: 0,
    opencode_sessions: 0,
    both_days: 0,
    days_observed: 0,
  } as unknown as ProfileToolCacheRow;

  const cachedCadence = {
    hourly_pattern: hourly,
    daily_pattern: dow,
    days,
    busiest_day: busiestDay,
    busiest_hour: busiestHour,
  } as unknown as ProfileCadenceCacheRow;

  const shipped = {
    commit_per_day_90d: Array.isArray(m.shipped_commit_per_day_90d) ? m.shipped_commit_per_day_90d : [],
    loc_per_day_90d: Array.isArray(m.shipped_loc_per_day_90d) ? m.shipped_loc_per_day_90d : [],
    loc_total: Number(data.shipped_loc_total ?? 0),
    commit_total: Number(data.commit_count_total ?? 0),
  };

  return { cachedMetrics, cachedModelRows, cachedToolRow, cachedSessionRows: [], cachedCadence, cachedProjectRows: [], shipped };
}

export async function buildProfileResponse(
  profile: ProfileResponseProfile,
  window: ProfileWindow,
  isOwner: boolean,
): Promise<ProfileResponse> {
  const shouldShowProjects = profile.share_projects === true;
  const shouldShowOwnerFields = isOwner === true;
  const [
    summaryAdapters,
    recentRuns,
    badges,
    accessKeys,
    lastScriptSyncAt,
    modelUsageInsights,
    publishedCodeDailyRows,
    modelCodeDailyRows,
    cadenceWindows,
    evidence,
  ] = await Promise.all([
    loadProfileSummaryAdapters(profile.id, window),
    loadRecentIngestionRuns(profile.id),
    loadBadges(profile.id),
    shouldShowOwnerFields ? loadAccessKeys(profile.id) : Promise.resolve([]),
    shouldShowOwnerFields ? loadLastScriptSyncAt(profile.id) : Promise.resolve(null),
    loadModelUsageInsights(profile.id, window),
    loadPublishedCodeDailyRows(profile.id),
    loadModelCodeDailyRows(profile.id),
    loadProfileCadenceWindows(profile.id),
    loadProfileEvidence(profile.id,window),
  ]);
  // Read path now sources from profile_summary (see loadProfileSummaryAdapters).
  // shouldShowProjects is retained for the legacy fallback branch below.
  void shouldShowProjects;
  const {
    costSummaries: modelCostSummaries,
    dailyCostByDate,
    modelSourceSummaries,
    modelUsageHistory,
    providerSpendHistory,
  } = modelUsageInsights;
  const {
    cachedMetrics,
    cachedModelRows,
    cachedToolRow,
    cachedSessionRows,
    cachedCadence,
    cachedProjectRows,
    shipped,
  } = summaryAdapters;
  const allSessions: SessionRow[] = [];

  const sessions = allSessions;
  const rawTokensTotal = sessions.reduce((sum, session) => sum + sessionTokens(session), 0);
  const rawSessionsCount = sessions.length;
  const rawActiveDays = new Set(sessions.map((session) => dateOnly(session.last_event_at)).filter(Boolean)).size;
  const tokensTotal = cachedMetrics ? parseNumeric(cachedMetrics.tokens_total) : rawTokensTotal;
  const sessionsCount = cachedMetrics ? parseNumeric(cachedMetrics.sessions_count) : rawSessionsCount;
  const costUsdTotal = cachedMetrics
    ? roundCurrency(parseNumeric(cachedMetrics.cost_usd_total))
    : 0;
  const activeDays = cachedMetrics ? parseNumeric(cachedMetrics.days_active) : rawActiveDays;
  const lastSyncAt = shouldShowOwnerFields ? lastScriptSyncAt : null;
  const syncStatus = shouldShowOwnerFields ? computeSyncStatus(lastSyncAt) : null;
  const publicOwnerFields = {
    access_keys: shouldShowOwnerFields ? accessKeys : [],
    last_sync_at: shouldShowOwnerFields ? lastSyncAt : null,
    sync_status: syncStatus,
  };
  const baseUrl = siteUrl();

  // Format dates for display
  const joinedDate = new Date(profile.created_at);
  const monthFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' });
  const fullDateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const joinedFormatted = monthFormatter.format(joinedDate); // "Mar 2026"
  const joinedFullFormatted = fullDateFormatter.format(joinedDate); // "Mar 4, 2026"

  // Format last sync
  const lastSyncFormatted = lastSyncAt
    ? new Date(lastSyncAt).getTime() > Date.now() - 60000
      ? 'Just now'
      : lastSyncAt
    : null;
  const lastSyncStatus = syncStatus === 'SYNCED' ? 'live' : syncStatus === 'STALE' ? 'stale' : null;

  // Build window stats
  const windowSessions = sessions;
  const windowTokensTotal = tokensTotal;
  const windowSessionsCount = sessionsCount;
  const windowActiveDays = activeDays;
  const rawWindowMedianDuration = windowSessions.length > 0
    ? Math.round(windowSessions.reduce((sum, s) => {
      const startedAtMs = new Date(s.first_event_at).getTime();
      const endedAtMs = new Date(s.last_event_at).getTime();

      return Number.isNaN(startedAtMs) || Number.isNaN(endedAtMs) || endedAtMs < startedAtMs
        ? sum
        : sum + endedAtMs - startedAtMs;
    }, 0) / windowSessions.length / 1000 / 60)
    : 0;
  const rawWindowCacheHitRate = windowSessions.length > 0
    ? windowSessions.reduce((sum, s) => sum + (parseNumeric(s.cache_read_tokens) || 0), 0) / Math.max(1, windowTokensTotal)
    : 0;
  const windowMedianDuration = cachedMetrics
    ? Math.round(parseNumeric(cachedMetrics.median_session_seconds) / 60)
    : rawWindowMedianDuration;
  const windowCacheHitRate = cachedMetrics ? parseNumeric(cachedMetrics.cache_hit_rate) : rawWindowCacheHitRate;

  // Build models breakdown with costs
  const modelItems = cachedMetrics
    ? cachedModelRows.map((row) => ({
      label: row.model,
      tokens_total: Math.max(0, Math.trunc(parseNumeric(row.tokens_total))),
      sessions_count: Math.max(0, Math.trunc(parseNumeric(row.sessions_count))),
      percentage: Math.max(0, Math.min(100, parseNumeric(row.pct_of_total))),
    }))
    : buildModelBreakdown(sessions);
  const modelsWithCost = modelCostSummaries.size > 0
    ? [...modelCostSummaries].filter(([,value])=>value.tokensTotal>0).map(([name,value])=>({
      name, tokens:value.tokensTotal, cost:roundCurrency(value.costUsdTotal),
      share:tokensTotal>0?value.tokensTotal/tokensTotal:0, sessions:value.sessionsCount,
    })).sort((a,b)=>b.tokens-a.tokens || a.name.localeCompare(b.name))
    : cachedMetrics
    ? cachedModelRows.map((row) => {
      const tokens = Math.max(0, Math.trunc(parseNumeric(row.tokens_total)));
      const costSummary = modelCostSummaries.get(row.model);
      const cachedCost = parseNumeric(row.cost_usd_total) || parseNumeric(row.cost_usd);

      return {
        name: row.model,
        tokens,
        cost: roundCurrency(costSummary?.costUsdTotal ?? cachedCost),
        share: tokensTotal > 0 ? tokens / tokensTotal : 0,
        sessions: costSummary?.sessionsCount ?? Math.max(0, Math.trunc(parseNumeric(row.sessions_count))),
      };
    })
    : modelItems.map((m) => ({
      name: m.label,
      tokens: m.tokens_total,
      cost: roundCurrency(modelCostSummaries.get(m.label)?.costUsdTotal ?? 0),
      share: tokensTotal > 0 ? m.tokens_total / tokensTotal : 0,
      sessions: modelCostSummaries.get(m.label)?.sessionsCount ?? m.sessions_count,
    }));
  const distinctModels = cachedMetrics
    ? Math.max(0, Math.trunc(parseNumeric(cachedMetrics.distinct_models)))
    : new Set(sessions.map((s) => s.model).filter(Boolean)).size;
  const topModelBySessionCount = cachedMetrics
    ? Array.from(modelCostSummaries.entries())
      .sort((left, right) => right[1].sessionsCount - left[1].sessionsCount)[0]?.[0]
      ?? cachedMetrics.top_model_by_sessions
    : modelItems.length > 0 ? modelItems[0]?.label || null : null;
  const firstModel = cachedMetrics
    ? cachedMetrics.first_model_name && cachedMetrics.first_model_date
      ? { name: cachedMetrics.first_model_name, date: cachedMetrics.first_model_date }
      : null
    : sessions.length > 0 ? { name: sessions[sessions.length - 1]?.model || 'unknown', date: dateOnly(sessions[sessions.length - 1]?.first_event_at) } : null;
  const latestModel = cachedMetrics
    ? cachedMetrics.latest_model_name && cachedMetrics.latest_model_date
      ? { name: cachedMetrics.latest_model_name, date: cachedMetrics.latest_model_date }
      : null
    : sessions.length > 0 ? { name: sessions[0]?.model || 'unknown', date: dateOnly(sessions[0]?.last_event_at) || 'N/A' } : null;
  const windowCutoffDate = profileWindowCutoffDate(window);
  const publishedCodeRowsInWindow = publishedCodeDailyRows.filter((row) => !windowCutoffDate || row.date >= windowCutoffDate);
  const dates90 = lastNDates(90);
  const publishedCodeByDate = new Map(publishedCodeDailyRows.map((row) => [row.date, row]));
  const producedLocPerDay90d = dates90.map((day) => Math.max(0, Math.trunc(parseNumeric(publishedCodeByDate.get(day)?.produced_loc))));
  const producedShippedLocPerDay90d = dates90.map((day) => Math.max(0, Math.trunc(parseNumeric(publishedCodeByDate.get(day)?.shipped_loc))));
  const producedCommitPerDay90d = dates90.map((day) => Math.max(0, Math.trunc(parseNumeric(publishedCodeByDate.get(day)?.ai_linked_commit_count))));
  const shippedAiLocByDate = new Map(
    publishedCodeDailyRows.map((row) => [row.date, Math.max(0, Math.trunc(parseNumeric(row.shipped_loc)))]),
  );
  const enrichedShipped = {
    ...shipped,
    produced_loc_per_day_90d: producedLocPerDay90d,
    produced_shipped_loc_per_day_90d: producedShippedLocPerDay90d,
    produced_commit_per_day_90d: producedCommitPerDay90d,
    produced_loc_total: publishedCodeRowsInWindow.reduce((sum, row) => sum + Math.max(0, Math.trunc(parseNumeric(row.produced_loc))), 0),
    produced_shipped_loc_total: publishedCodeRowsInWindow.reduce((sum, row) => sum + Math.max(0, Math.trunc(parseNumeric(row.shipped_loc))), 0),
    produced_commit_total: publishedCodeRowsInWindow.reduce((sum, row) => sum + Math.max(0, Math.trunc(parseNumeric(row.ai_linked_commit_count))), 0),
    produced_high_confidence_commit_total: publishedCodeRowsInWindow.reduce((sum, row) => sum + Math.max(0, Math.trunc(parseNumeric(row.high_confidence_commit_count))), 0),
    produced_median_link_confidence: 0,
    linked_tokens_per_day_90d: new Array(90).fill(0),
    spend_per_shipped_ai_loc_30d: buildSpendPerShippedAiLoc30d(dates90, dailyCostByDate, shippedAiLocByDate),
  };
  const modelCodeTotals = new Map<string, {
    source: 'claude' | 'codex' | 'opencode';
    model: string;
    aiCodedLoc: number;
    shippedAiCodedLoc: number;
  }>();
  for (const row of modelCodeDailyRows) {
    if (windowCutoffDate && row.date < windowCutoffDate) continue;
    const key = modelSourceKey(row.source, row.model);
    const existing = modelCodeTotals.get(key) ?? {
      source: row.source,
      model: row.model,
      aiCodedLoc: 0,
      shippedAiCodedLoc: 0,
    };
    existing.aiCodedLoc += Math.max(0, Math.trunc(parseNumeric(row.produced_loc)));
    existing.shippedAiCodedLoc += Math.max(0, Math.trunc(parseNumeric(row.shipped_loc)));
    modelCodeTotals.set(key, existing);
  }
  const modelCodeBreakdown = Array.from(new Set([
    ...modelSourceSummaries.keys(),
    ...modelCodeTotals.keys(),
  ])).map((key) => {
    const usage = modelSourceSummaries.get(key);
    const code = modelCodeTotals.get(key);
    return {
      model: usage?.model ?? code?.model ?? 'unknown',
      source: usage?.source ?? code?.source ?? 'opencode',
      tokens_total: Math.max(0, Math.trunc(usage?.tokensTotal ?? 0)),
      cost_usd_total: roundCurrency(usage?.costUsdTotal ?? 0),
      ai_coded_loc: code?.aiCodedLoc ?? 0,
      shipped_ai_coded_loc: code?.shippedAiCodedLoc ?? 0,
    };
  }).sort((left, right) =>
    right.shipped_ai_coded_loc - left.shipped_ai_coded_loc
    || right.ai_coded_loc - left.ai_coded_loc
    || right.cost_usd_total - left.cost_usd_total
    || right.tokens_total - left.tokens_total
  ).slice(0, 20);

  // Build tools data
  const toolItems = cachedMetrics
    ? [
      {
        label: 'claude',
        source: 'claude' as const,
        project_name: null,
        tokens_total: Math.max(0, Math.trunc(parseNumeric(cachedToolRow?.claude_tokens))),
        sessions_count: Math.max(0, Math.trunc(parseNumeric(cachedToolRow?.claude_sessions))),
        percentage: Math.max(0, Math.min(100, parseNumeric(cachedToolRow?.claude_pct))),
      },
      {
        label: 'codex',
        source: 'codex' as const,
        project_name: null,
        tokens_total: Math.max(0, Math.trunc(parseNumeric(cachedToolRow?.codex_tokens))),
        sessions_count: Math.max(0, Math.trunc(parseNumeric(cachedToolRow?.codex_sessions))),
        percentage: Math.max(0, Math.min(100, parseNumeric(cachedToolRow?.codex_pct))),
      },
      {
        label: 'opencode',
        source: 'opencode' as const,
        project_name: null,
        tokens_total: Math.max(0, Math.trunc(parseNumeric(cachedToolRow?.opencode_tokens))),
        sessions_count: Math.max(0, Math.trunc(parseNumeric(cachedToolRow?.opencode_sessions))),
        percentage: Math.max(0, Math.min(100, parseNumeric(cachedToolRow?.opencode_pct))),
      },
    ].filter((item) => item.tokens_total > 0 || item.sessions_count > 0)
    : buildToolBreakdown(sessions, shouldShowProjects);
  const claudeTokens = cachedMetrics
    ? parseNumeric(cachedToolRow?.claude_tokens)
    : toolItems.filter((t) => t.source === 'claude').reduce((sum, t) => sum + t.tokens_total, 0);
  const codexTokens = cachedMetrics
    ? parseNumeric(cachedToolRow?.codex_tokens)
    : toolItems.filter((t) => t.source === 'codex').reduce((sum, t) => sum + t.tokens_total, 0);
  const claudePct = tokensTotal > 0 ? claudeTokens / tokensTotal : 0;
  const codexPct = tokensTotal > 0 ? codexTokens / tokensTotal : 0;

  const claudeDays = new Set(sessions.filter((s) => s.source === 'claude').map((s) => dateOnly(s.last_event_at)));
  const codexDays = new Set(sessions.filter((s) => s.source === 'codex').map((s) => dateOnly(s.last_event_at)));
  const daysWithBoth = cachedMetrics
    ? Math.max(0, Math.trunc(parseNumeric(cachedToolRow?.both_days ?? cachedMetrics.tool_both_days)))
    : new Set([...claudeDays].filter((d) => codexDays.has(d))).size;

  // Build session stats
  const sessionDurations = sessions.flatMap((s) => {
    const startedAtMs = new Date(s.first_event_at).getTime();
    const endedAtMs = new Date(s.last_event_at).getTime();

    if (Number.isNaN(startedAtMs) || Number.isNaN(endedAtMs) || endedAtMs < startedAtMs) {
      return [];
    }

    return [{
      duration: endedAtMs - startedAtMs,
      tokens: sessionTokens(s),
      cost: 0,
      date: dateOnly(s.last_event_at),
    }];
  });
  const longestSessionMs = Math.max(...sessionDurations.map((s) => s.duration), 0);
  const longestSessionHours = Math.floor(longestSessionMs / 3600000);
  const longestSessionMinutes = Math.floor((longestSessionMs % 3600000) / 60000);
  const largestTokensSession = sessionDurations.length > 0 ? sessionDurations.reduce((a, b) => a.tokens > b.tokens ? a : b) : null;
  const mostExpensiveSession = sessionDurations.length > 0 ? sessionDurations.reduce((a, b) => a.cost > b.cost ? a : b) : null;
  const medianSessionMs = sessionDurations.length > 0
    ? sessionDurations.sort((a, b) => a.duration - b.duration)[Math.floor(sessionDurations.length / 2)]?.duration || 0
    : 0;
  const medianSessionMinutes = Math.round(medianSessionMs / 60000);
  const sessionsOver1h = sessionDurations.filter((s) => s.duration > 3600000).length;
  const totalSessionTime = sessionDurations.reduce((sum, s) => sum + s.duration, 0);
  const totalSessionHours = Math.round(totalSessionTime / 3600000);
  const cachedLongestSessionSeconds = cachedMetrics ? parseNumeric(cachedMetrics.longest_session_seconds) : 0;
  const cachedLargestTokens = cachedMetrics ? parseNumeric(cachedMetrics.largest_tokens_session_tokens) : 0;
  const cachedMostExpensive = cachedMetrics ? parseNumeric(cachedMetrics.most_expensive_session_cost_usd) : 0;
  const cachedMedianSessionMinutes = cachedMetrics ? Math.round(parseNumeric(cachedMetrics.median_session_seconds) / 60) : 0;
  const cachedSessionsOver1h = cachedMetrics ? Math.max(0, Math.trunc(parseNumeric(cachedMetrics.sessions_over_1h))) : 0;
  const cachedTotalSessionHours = cachedMetrics ? Math.round(parseNumeric(cachedMetrics.total_session_time_seconds) / 3600) : 0;

  const cadenceData = cachedMetrics
    ? {
      days: cadenceDays(cachedCadence?.days),
      busiest_day: cachedCadence?.busiest_day ?? null,
      busiest_hour: cachedCadence?.busiest_hour ?? cachedMetrics.busiest_hour ?? null,
    }
    : buildCadence(sessions);
  const hourly = cachedMetrics ? numericArray(cachedCadence?.hourly_pattern, 24) : new Array(24).fill(0);
  const daily = cachedMetrics ? numericArray(cachedCadence?.daily_pattern, 7) : new Array(7).fill(0);

  // Compute after midnight and weekend counts from cached data if available
  let afterMidnightCount = 0;
  let weekendSessionCount = 0;

  if (!cachedMetrics) {
    sessions.forEach((session) => {
      const date = new Date(session.first_event_at);

      if (Number.isNaN(date.getTime())) {
        return;
      }

      const hour = date.getUTCHours();
      const day = date.getUTCDay();

      // Count sessions after midnight (00:00-05:59 UTC)
      if (hour >= 0 && hour < 6) {
        afterMidnightCount++;
      }

      // Count sessions on weekends (Saturday = 6, Sunday = 0)
      if (day === 0 || day === 6) {
        weekendSessionCount++;
      }
    });
  }

  // Compute streak values
  const currentStreak = cachedMetrics ? parseNumeric(cachedMetrics.current_streak) : computeCurrentStreak(sessions);
  const longestStreakValue = cachedMetrics ? parseNumeric(cachedMetrics.longest_streak) : computeLongestStreak(sessions);
  const hasSessionSignal = sessions.length > 0 || sessionsCount > 0;

  const parallelismData = cachedMetrics
    ? { buckets: parallelismBuckets(cachedMetrics.parallelism_buckets) }
    : buildParallelism(sessions);
  const cachedPeakDaily = cachedMetrics && Array.isArray(cachedMetrics.peak_daily) && cachedMetrics.peak_daily.length > 0
    ? numericArray(cachedMetrics.peak_daily)
    : null;
  const shouldUseCachedPeakDaily = Boolean(
    cachedPeakDaily && (!hasSessionSignal || cachedPeakDaily.some((value) => value > 0)),
  );
  const rawPeakData = shouldUseCachedPeakDaily ? null : buildPeakDaily(sessions);
  const peakDaily = shouldUseCachedPeakDaily && cachedPeakDaily ? cachedPeakDaily : rawPeakData?.peakDaily ?? [];
  const peakEver = shouldUseCachedPeakDaily && cachedMetrics
    ? Math.max(0, Math.trunc(parseNumeric(cachedMetrics.peak_ever)))
    : rawPeakData?.peakEver ?? 0;
  const peakEverDate = shouldUseCachedPeakDaily && cachedMetrics
    ? cachedMetrics.peak_ever_date ?? 'N/A'
    : rawPeakData?.peakEverDate ?? 'N/A';
  const peakEverTime = shouldUseCachedPeakDaily && cachedMetrics
    ? cachedMetrics.peak_ever_time ?? '00:00'
    : rawPeakData?.peakEverTime ?? '00:00';

  // Compute rank delta: difference between current rank and rank from 30 days ago
  const cachedRank = cachedMetrics?.rank === null || cachedMetrics?.rank === undefined
    ? null
    : parseNumeric(cachedMetrics.rank);
  const currentRank = cachedMetrics ? cachedRank && cachedRank > 0 ? cachedRank : null : null;
  const rankThirtyDaysAgo = cachedMetrics
    ? parseNumeric(cachedMetrics.rank_30d_ago) || null
    : null;
  const rankDelta30d = currentRank && rankThirtyDaysAgo
    ? rankThirtyDaysAgo - currentRank // positive = improvement, negative = decline
    : null;

  // Compute percentile from rank and total ranked count
  const totalRankedCount = cachedMetrics ? parseNumeric(cachedMetrics.total_ranked) : 0;
  const percentileValue = cachedMetrics
    ? cachedMetrics.percentile === null || cachedMetrics.percentile === undefined
      ? null
      : parseNumeric(cachedMetrics.percentile)
    : currentRank && totalRankedCount > 0
    ? ((totalRankedCount - currentRank) / totalRankedCount) * 100
    : null;
  const percentileString = percentileValue !== null
    ? `top ${percentileValue.toFixed(1)}%`
    : null;

  const profileMode = modeOrDefault(profile.mode);
  // Daily series keep their stored length (full activity range), not a fixed 90.
  const dailyTokens90d = cachedMetrics
    ? cachedNumericSeries(cachedMetrics.daily_tokens_90d, seriesLen(cachedMetrics.daily_tokens_90d), hasSessionSignal)
      ?? emptyNumericSeries(90)
    : emptyNumericSeries(90);
  // Float momentum series — read raw (cachedNumericSeries truncates to int).
  const scorePerDay90d = Array.isArray(cachedMetrics?.score_per_day_90d)
    ? (cachedMetrics!.score_per_day_90d as number[]).map((v) => Math.max(0, Number(v) || 0))
    : [];
  const dailySessions90d = cachedMetrics
    ? cachedNumericSeries(cachedMetrics.daily_sessions_90d, seriesLen(cachedMetrics.daily_sessions_90d), hasSessionSignal)
      ?? emptyNumericSeries(90)
    : emptyNumericSeries(90);
  const dailyPeakConcurrent90d = cachedMetrics
    ? cachedNumericSeries(cachedMetrics.daily_peak_concurrent_90d, 90, hasSessionSignal)
      ?? emptyNumericSeries(90)
    : emptyNumericSeries(90);
  const dominantModelPerDay90d = cachedMetrics
    ? cachedStringSeries(cachedMetrics.dominant_model_per_day_90d, seriesLen(cachedMetrics.dominant_model_per_day_90d), hasSessionSignal)
      ?? emptyStringSeries(90)
    : emptyStringSeries(90);
  const streakBands = cachedMetrics
    ? cachedJsonArray(cachedMetrics.streak_bands)
      ?? []
    : [];
  const modelMetrics90d = cachedMetrics
    ? cachedJsonArray(cachedMetrics.model_metrics_90d)
      ?? []
    : [];
  const tierProgression = cachedMetrics
    ? cachedTierProgression(cachedMetrics.tier_progression)
      ?? computeTierProgression(peakDaily)
    : computeTierProgression(peakDaily);

  const response = {
    evidence,
    window,
    user_is_owner: shouldShowOwnerFields,
    variant: variantFor(profile, shouldShowOwnerFields),
    identity: {
      handle: profile.handle,
      name: profile.display_name || `@${profile.handle}`,
      display_name: profile.display_name,
      avatar_url: profile.avatar_url,
      bio: profile.bio,
      x_handle: profile.x_handle,
      mode: profileMode,
      verified: profile.verified || profileMode === 'script_verified',
      share_projects: shouldShowProjects,
      joined_at: profile.created_at,
      joined: joinedFormatted,
      joined_full: joinedFullFormatted,
      os: null,
      archetype: null,
      // Public last-activity timestamp (from profile_summary) so "Last Session"
      // renders for every viewer; the owner-only script-sync detail falls back in.
      last_sync: cachedMetrics?.last_session_at ?? lastSyncFormatted,
      last_sync_status: lastSyncStatus,
      badges,
    },
    headline: {
      rank: currentRank,
      rank_delta_30d: rankDelta30d,
      total_ranked: totalRankedCount,
      percentile: percentileString,
      rank_percentile: null,
      tokens_total: tokensTotal,
      cost_usd_total: costUsdTotal,
    },
    at_glance: {
      tokens_total: tokensTotal,
      cost_usd_total: costUsdTotal,
      sessions_count: sessionsCount,
      days_active: activeDays,
      avg_tokens_per_session: sessionsCount > 0 ? tokensTotal / sessionsCount : 0,
      window_stats: {
        tokens: windowTokensTotal,
        sessions: windowSessionsCount,
        active_days: windowActiveDays,
        median_session: `${windowMedianDuration}m`,
        cache_hit_rate: windowCacheHitRate,
      },
      project_breakdown: shouldShowProjects
        ? cachedMetrics
          ? cachedProjectRows.map((row) => ({
            project_name: row.project_name,
            tokens_total: Math.max(0, Math.trunc(parseNumeric(row.tokens_total))),
            cost_usd_total: roundCurrency(parseNumeric(row.cost_usd_total)),
            sessions_count: Math.max(0, Math.trunc(parseNumeric(row.sessions_count))),
            percentage: Math.max(0, Math.min(100, parseNumeric(row.percentage))),
          }))
          : buildProjectBreakdown(sessions)
        : [],
    },
    models: {
      items: modelItems,
      models: modelsWithCost,
      distinct: distinctModels,
      top_by_sessions: topModelBySessionCount,
      first_model: firstModel,
      latest_model: latestModel,
      model_metrics_90d: modelMetrics90d,
      model_usage_weeks: [],
      provider_spend_history: providerSpendHistory,
      model_usage_history: modelUsageHistory,
      model_code_breakdown: modelCodeBreakdown,
    },
    tools: {
      items: toolItems,
      claude_pct_tokens: claudePct,
      codex_pct_tokens: codexPct,
      both_days: daysWithBoth,
      days_observed: cachedMetrics
        ? Math.max(0, Math.trunc(parseNumeric(cachedToolRow?.days_observed ?? cachedMetrics.tool_days_observed)))
        : activeDays,
    },
    session_stats: {
      longest_session: cachedMetrics
        ? { value: formatDurationSeconds(cachedLongestSessionSeconds), date: formatSessionDate(cachedMetrics.longest_session_date) }
        : { value: `${longestSessionHours}h ${longestSessionMinutes}m`, date: longestSessionMs > 0 ? sessionDurations.find((item) => item.duration === longestSessionMs)?.date ?? 'N/A' : 'N/A' },
      largest_by_tokens: cachedMetrics
        ? { value: cachedLargestTokens > 0 ? `${(cachedLargestTokens / 1e6).toFixed(1)}M tokens` : '0', date: formatSessionDate(cachedMetrics.largest_tokens_session_date) }
        : largestTokensSession ? { value: `${(largestTokensSession.tokens / 1e6).toFixed(1)}M tokens`, date: largestTokensSession.date } : { value: '0', date: 'N/A' },
      most_expensive: cachedMetrics
        ? { value: `$${Math.round(cachedMostExpensive)}`, date: formatSessionDate(cachedMetrics.most_expensive_session_date) }
        : mostExpensiveSession ? { value: `$${Math.round(mostExpensiveSession.cost)}`, date: mostExpensiveSession.date } : { value: '$0', date: 'N/A' },
      median_session: { value: `${cachedMetrics ? cachedMedianSessionMinutes : medianSessionMinutes}m` },
      sessions_over_1h: {
        value: `${cachedMetrics ? cachedSessionsOver1h : sessionsOver1h}`,
        sub: `${(((cachedMetrics ? cachedSessionsOver1h : sessionsOver1h) / Math.max(1, sessionsCount)) * 100).toFixed(0)}% of sessions`,
      },
      total_time_in_sessions: { value: `${cachedMetrics ? cachedTotalSessionHours : totalSessionHours}h` },
    },
    sessions: {
      items: cachedMetrics
        ? cachedSessionRows.map((session) => ({
          session_id: session.session_id,
          source: session.source,
          model: session.model,
          started_at: session.started_at,
          ended_at: session.ended_at,
          tokens_total: Math.max(0, Math.trunc(parseNumeric(session.tokens_total))),
          cost_usd_total: roundCurrency(parseNumeric(session.cost_usd_total)),
          turns: Math.max(0, Math.trunc(parseNumeric(session.turns))),
          project_name: shouldShowProjects ? projectNameOrFallback(session.project_name, session.source, session.file_sha256) : null,
          day: dateOnly(session.started_at),
          time: formatClockTime(session.started_at),
        }))
        : sessions.slice(0, 10).map((session) => ({
          session_id: session.session_id,
          source: session.source,
          model: session.model,
          started_at: session.first_event_at,
          ended_at: session.last_event_at,
          tokens_total: sessionTokens(session),
          cost_usd_total: 0,
          turns: parseNumeric(session.turns),
          project_name: shouldShowProjects ? projectNameForSession(session) : null,
          day: dateOnly(session.first_event_at),
          time: formatClockTime(session.first_event_at),
        })),
    },
    cadence: {
      ...cadenceData,
      hourly,
      daily,
      windows: cadenceWindows,
      current_streak: currentStreak,
      longest_streak: longestStreakValue,
      after_midnight: {
        count: cachedMetrics ? parseNumeric(cachedMetrics.after_midnight_count) : afterMidnightCount,
        // scoring.ts already stores pct as a 0–1 fraction; use it directly (do NOT /100).
        pct: cachedMetrics
          ? parseNumeric(cachedMetrics.after_midnight_pct)
          : sessions.length > 0 ? roundPercent((afterMidnightCount / sessions.length) * 100) / 100 : 0,
      },
      weekend_share: cachedMetrics
        ? parseNumeric(cachedMetrics.weekend_share)
        : sessions.length > 0 ? roundPercent((weekendSessionCount / sessions.length) * 100) / 100 : 0,
      daily_tokens_90d: dailyTokens90d,
      score_per_day_90d: scorePerDay90d,
      daily_sessions_90d: dailySessions90d,
      streak_bands: streakBands,
      dominant_model_per_day_90d: dominantModelPerDay90d,
    },
    parallelism: {
      ...parallelismData,
      peak_daily: peakDaily,
      peak_ever: peakEver,
      peak_ever_date: peakEverDate,
      peak_ever_time: peakEverTime,
      avg_concurrent: cachedMetrics ? parseNumeric(cachedMetrics.avg_concurrent) : computeAvgConcurrent(sessions),
      days_parallel_3: cachedMetrics ? parseNumeric(cachedMetrics.days_parallel_3) : computeDaysParallel3(sessions),
      longest_sustained_3: cachedMetrics
        ? formatDurationSeconds(parseNumeric(cachedMetrics.longest_sustained_3_seconds))
        : computeLongestSustained3(sessions),
      daily_peak_concurrent_90d: dailyPeakConcurrent90d,
      tier_progression: tierProgression,
    },
    shipped: enrichedShipped,
    recent_activity: {
      items: recentRuns.map((run) => ({
        ingestion_run_id: run.id,
        status: run.status,
        created_at: run.started_at,
        accepted_count: parseNumeric(run.session_count),
        rejected_count: parseNumeric(run.rejected_count),
        deduped_count: parseNumeric(run.duplicate_count),
        project_name: null,
      })),
    },
    data_range: {
      first_session_at: cachedMetrics?.first_session_at
        ?? (sessions.length > 0
          ? (() => {
            let min = Number.POSITIVE_INFINITY;
            for (const session of sessions) {
              const ms = new Date(session.first_event_at).getTime();
              if (!Number.isNaN(ms) && ms < min) min = ms;
            }
            return Number.isFinite(min) ? new Date(min).toISOString() : null;
          })()
          : null),
      last_session_at: cachedMetrics?.last_session_at
        ?? (sessions.length > 0
          ? (() => {
            let max = Number.NEGATIVE_INFINITY;
            for (const session of sessions) {
              const ms = new Date(session.last_event_at).getTime();
              if (!Number.isNaN(ms) && ms > max) max = ms;
            }
            return Number.isFinite(max) ? new Date(max).toISOString() : null;
          })()
          : null),
    },
    footer: {
      share_url: `${baseUrl}/u/${profile.handle}`,
      og_image_url: `${baseUrl}/api/og/profile/${profile.handle}`,
      owner: publicOwnerFields,
    },
    ...publicOwnerFields,
  };

  return ProfileResponseSchema.parse(response);
}
