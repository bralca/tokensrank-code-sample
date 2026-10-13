import { z } from 'zod';
import { ProfileEvidenceSchema } from './evidence.js';
import { UsageRecapSchema } from './usage-recap.js';

import { FullProfileBadgeSchema } from './badge.js';

const SupabaseDateTimeSchema = z.string().datetime({ offset: true });

// Access key response (no plaintext after creation)
export const AccessKeySchema = z.object({
  id: z.string().uuid(),
  key_prefix: z.string(),
  key_sha256: z.string(),
  label: z.string().nullable(),
  scope: z.enum(['script', 'self_reported']),
  last_used_at: z.string().datetime().nullable(),
  revoked_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();

export type AccessKey = z.infer<typeof AccessKeySchema>;

// Access key with plaintext (only returned at creation)
export const AccessKeyWithPlaintextSchema = AccessKeySchema.extend({
  plaintext: z.string(),
}).strict();

export type AccessKeyWithPlaintext = z.infer<typeof AccessKeyWithPlaintextSchema>;

// Generate access key request
export const GenerateAccessKeyRequestSchema = z.object({
  scope: z.enum(['script', 'self_reported']),
  label: z.string().max(255).optional(),
}).strict();

export type GenerateAccessKeyRequest = z.infer<typeof GenerateAccessKeyRequestSchema>;

// List access keys response
export const ListAccessKeysResponseSchema = z.object({
  keys: z.array(AccessKeySchema),
}).strict();

export type ListAccessKeysResponse = z.infer<typeof ListAccessKeysResponseSchema>;

// Revoke access key request
export const RevokeAccessKeyRequestSchema = z.object({
  prefix: z.string(),
}).strict();

export type RevokeAccessKeyRequest = z.infer<typeof RevokeAccessKeyRequestSchema>;

// Revoke access key response
export const RevokeAccessKeyResponseSchema = z.object({
  ok: z.boolean(),
}).strict();

export type RevokeAccessKeyResponse = z.infer<typeof RevokeAccessKeyResponseSchema>;

// Profile response (includes stats)
export const ProfileWithStatsSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  handle: z.string(),
  display_name: z.string().nullable(),
  avatar_url: z.string().url().nullable(),
  bio: z.string().nullable(),
  x_handle: z.string().nullable(),
  mode: z.enum(['script_verified', 'self_reported']).nullable(),
  verified: z.boolean(),
  onboarded_at: SupabaseDateTimeSchema.nullable(),
  share_projects: z.boolean(),
  lifetime_tokens: z.bigint(),
  lifetime_sessions: z.number(),
  last_active_date: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();

export type ProfileWithStats = z.infer<typeof ProfileWithStatsSchema>;

// Current user profile response (with access keys list)
export const CurrentUserProfileSchema = z.object({
  profile: ProfileWithStatsSchema,
  access_keys: z.array(AccessKeySchema),
}).strict();

export type CurrentUserProfile = z.infer<typeof CurrentUserProfileSchema>;

export const GetMeOnboardingStepSchema = z.enum([
  'not_started',
  'mode_chosen',
  'complete',
]);

export type GetMeOnboardingStep = z.infer<typeof GetMeOnboardingStepSchema>;

export const GetMeAccessKeySchema = z.object({
  keyId: z.string().uuid(),
  keyPrefix: z.string(),
  maskedKey: z.string(),
  scope: z.enum(['script', 'self_reported']),
  createdAt: SupabaseDateTimeSchema,
  revokedAt: SupabaseDateTimeSchema.nullable(),
  lastUsedAt: SupabaseDateTimeSchema.nullable(),
}).strict();

export type GetMeAccessKey = z.infer<typeof GetMeAccessKeySchema>;

export const GetMeRecentIngestionRunSchema = z.object({
  ingestionRunId: z.string().uuid(),
  ingestionMode: z.enum(['script_verified', 'self_reported']),
  status: z.enum(['processing', 'completed', 'partial', 'failed']),
  acceptedCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  dedupedCount: z.number().int().nonnegative(),
  startedAt: SupabaseDateTimeSchema,
  completedAt: SupabaseDateTimeSchema.nullable(),
}).strict();

export type GetMeRecentIngestionRun = z.infer<typeof GetMeRecentIngestionRunSchema>;

export const GetMeResponseSchema = z.object({
  data: z.object({
    userId: z.string().uuid(),
    email: z.string().email().nullable(),
    handle: z.string().nullable(),
    displayName: z.string().nullable(),
    avatarUrl: z.string().url().nullable(),
    bio: z.string().nullable(),
    xHandle: z.string().nullable(),
    mode: z.enum(['script_verified', 'self_reported']).nullable(),
    onboardedAt: SupabaseDateTimeSchema.nullable(),
    shareProjects: z.boolean(),
    onboarding: z.object({
      step: GetMeOnboardingStepSchema,
    }).strict(),
    accessKeys: z.array(GetMeAccessKeySchema),
    recentIngestionRuns: z.array(GetMeRecentIngestionRunSchema).max(5),
  }).strict(),
}).strict();

export type GetMeResponse = z.infer<typeof GetMeResponseSchema>;

export const ProfileWindowSchema = z.enum(['24h', '7d', '30d', 'all']);

export type ProfileWindow = z.infer<typeof ProfileWindowSchema>;

export const ProfileModeSchema = z.enum(['script_verified', 'self_reported']).nullable();

export type ProfileMode = z.infer<typeof ProfileModeSchema>;

export const ProfileSyncStatusSchema = z.enum(['SYNCED', 'STALE', 'ERROR']);

export type ProfileSyncStatus = z.infer<typeof ProfileSyncStatusSchema>;

export const ProfileResponseAccessKeySchema = z.object({
  key_id: z.string().uuid(),
  key_prefix: z.string(),
  scope: z.enum(['script', 'self_reported']),
  created_at: SupabaseDateTimeSchema,
  last_used_at: SupabaseDateTimeSchema.nullable(),
  revoked_at: SupabaseDateTimeSchema.nullable(),
}).strict();

export type ProfileResponseAccessKey = z.infer<typeof ProfileResponseAccessKeySchema>;

export const ProfileProjectUsageSchema = z.object({
  project_name: z.string().min(1),
  tokens_total: z.number().int().nonnegative(),
  cost_usd_total: z.number().nonnegative(),
  sessions_count: z.number().int().nonnegative(),
  percentage: z.number().min(0).max(100),
}).strict();

export type ProfileProjectUsage = z.infer<typeof ProfileProjectUsageSchema>;

export const ProfileSectionIdentitySchema = z.object({
  handle: z.string().min(1),
  name: z.string().min(1).nullable(),
  display_name: z.string().nullable(),
  avatar_url: z.string().url().nullable(),
  bio: z.string().nullable(),
  x_handle: z.string().nullable(),
  mode: ProfileModeSchema,
  verified: z.boolean(),
  share_projects: z.boolean(),
  joined_at: SupabaseDateTimeSchema,
  joined: z.string(), // "Mar 2026" format
  joined_full: z.string(), // "Mar 4, 2026" format
  os: z.enum(['mac', 'linux', 'windows']).nullable(),
  archetype: z.string().nullable(),
  last_sync: z.string().nullable(), // "2h ago", "Just now", etc.
  last_sync_status: z.enum(['live', 'stale']).nullable(),
  badges: z.array(FullProfileBadgeSchema),
}).strict();

export type ProfileSectionIdentity = z.infer<typeof ProfileSectionIdentitySchema>;

export const ProfileSectionHeadlineSchema = z.object({
  rank: z.number().int().positive().nullable(),
  rank_delta_30d: z.number().int().nullable(),
  total_ranked: z.number().int().nonnegative().nullable(),
  percentile: z.string().nullable(),
  rank_percentile: z.number().min(0).max(100).nullable(),
  tokens_total: z.number().int().nonnegative(),
  cost_usd_total: z.number().nonnegative(),
}).strict();

export type ProfileSectionHeadline = z.infer<typeof ProfileSectionHeadlineSchema>;

export const WindowStatsSchema = z.object({
  tokens: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  active_days: z.number().int().nonnegative(),
  median_session: z.string(), // "38m" format
  cache_hit_rate: z.number().min(0).max(1),
}).strict();

export type WindowStats = z.infer<typeof WindowStatsSchema>;

export const ProfileSectionAtGlanceSchema = z.object({
  tokens_total: z.number().int().nonnegative(),
  cost_usd_total: z.number().nonnegative(),
  sessions_count: z.number().int().nonnegative(),
  days_active: z.number().int().nonnegative(),
  avg_tokens_per_session: z.number().nonnegative(),
  window_stats: WindowStatsSchema,
  project_breakdown: z.array(ProfileProjectUsageSchema),
}).strict();

export type ProfileSectionAtGlance = z.infer<typeof ProfileSectionAtGlanceSchema>;

export const ProfileBreakdownItemSchema = z.object({
  label: z.string().min(1),
  tokens_total: z.number().int().nonnegative(),
  sessions_count: z.number().int().nonnegative(),
  percentage: z.number().min(0).max(100),
}).strict();

export type ProfileBreakdownItem = z.infer<typeof ProfileBreakdownItemSchema>;

export const ModelItemSchema = z.object({
  name: z.string().min(1),
  tokens: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
  share: z.number().min(0).max(1),
  sessions: z.number().int().nonnegative().optional(),
}).strict();

export type ModelItem = z.infer<typeof ModelItemSchema>;

export const ProfileModelUsageWeekSchema = z.object({
  week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  models: z.array(z.object({
    model: z.string().min(1),
    tokens: z.number().int().nonnegative(),
  }).strict()),
}).strict();

export type ProfileModelUsageWeek = z.infer<typeof ProfileModelUsageWeekSchema>;

export const ProfileProviderSpendHistoryItemSchema = z.object({
  provider: z.enum(['claude', 'codex', 'opencode', 'other']),
  points: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    cost: z.number().nonnegative(),
  }).strict()),
}).strict();

export type ProfileProviderSpendHistoryItem = z.infer<typeof ProfileProviderSpendHistoryItemSchema>;

export const ProfileModelUsageHistoryItemSchema = z.object({
  model: z.string().min(1),
  points: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    tokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative().optional(),
  }).strict()),
}).strict();

export type ProfileModelUsageHistoryItem = z.infer<typeof ProfileModelUsageHistoryItemSchema>;

export const ProfileModelMetrics90dItemSchema = z.object({
  model: z.string().min(1),
  tokens_total: z.number().int().nonnegative(),
  tokens_14d_prev: z.number().int().nonnegative(),
  tokens_14d_curr: z.number().int().nonnegative(),
  trend: z.enum(['up', 'down', 'flat']),
}).strict();

export type ProfileModelMetrics90dItem = z.infer<typeof ProfileModelMetrics90dItemSchema>;

export const ProfileModelCodeBreakdownItemSchema = z.object({
  model: z.string().min(1),
  source: z.enum(['claude', 'codex', 'opencode']),
  tokens_total: z.number().int().nonnegative(),
  cost_usd_total: z.number().nonnegative(),
  ai_coded_loc: z.number().int().nonnegative(),
  shipped_ai_coded_loc: z.number().int().nonnegative(),
}).strict();

export type ProfileModelCodeBreakdownItem = z.infer<typeof ProfileModelCodeBreakdownItemSchema>;

export const ProfileSectionModelsSchema = z.object({
  items: z.array(ProfileBreakdownItemSchema),
  models: z.array(ModelItemSchema),
  distinct: z.number().int().nonnegative(),
  top_by_sessions: z.string().min(1).nullable(),
  first_model: z.object({ name: z.string(), date: z.string() }).nullable(),
  latest_model: z.object({ name: z.string(), date: z.string() }).nullable(),
  model_metrics_90d: z.array(ProfileModelMetrics90dItemSchema),
  model_usage_weeks: z.array(ProfileModelUsageWeekSchema).default([]),
  provider_spend_history: z.array(ProfileProviderSpendHistoryItemSchema).default([]),
  model_usage_history: z.array(ProfileModelUsageHistoryItemSchema).default([]),
  model_code_breakdown: z.array(ProfileModelCodeBreakdownItemSchema).default([]),
}).strict();

export type ProfileSectionModels = z.infer<typeof ProfileSectionModelsSchema>;

export const ProfileToolBreakdownItemSchema = ProfileBreakdownItemSchema.extend({
  source: z.enum(['claude', 'codex', 'opencode']),
  project_name: z.string().min(1).nullable().optional(),
}).strict();

export type ProfileToolBreakdownItem = z.infer<typeof ProfileToolBreakdownItemSchema>;

export const ProfileSectionToolsSchema = z.object({
  items: z.array(ProfileToolBreakdownItemSchema),
  claude_pct_tokens: z.number().min(0).max(1),
  codex_pct_tokens: z.number().min(0).max(1),
  both_days: z.number().int().nonnegative(),
  days_observed: z.number().int().nonnegative(),
}).strict();

export type ProfileSectionTools = z.infer<typeof ProfileSectionToolsSchema>;

export const ProfileSessionItemSchema = z.object({
  session_id: z.string().min(1),
  source: z.enum(['claude', 'codex', 'opencode']),
  model: z.string().nullable(),
  started_at: SupabaseDateTimeSchema,
  ended_at: SupabaseDateTimeSchema.nullable(),
  tokens_total: z.number().int().nonnegative(),
  cost_usd_total: z.number().nonnegative(),
  turns: z.number().int().nonnegative(),
  project_name: z.string().min(1).nullable(),
  day: z.string(), // "Today", "Yesterday", "Apr 20"
  time: z.string(), // "14:32"
}).strict();

export type ProfileSessionItem = z.infer<typeof ProfileSessionItemSchema>;

export const ProfileSectionSessionsSchema = z.object({
  items: z.array(ProfileSessionItemSchema).max(10),
}).strict();

export type ProfileSectionSessions = z.infer<typeof ProfileSectionSessionsSchema>;

export const SessionStatsSchema = z.object({
  longest_session: z.object({ value: z.string(), date: z.string() }),
  largest_by_tokens: z.object({ value: z.string(), date: z.string() }),
  most_expensive: z.object({ value: z.string(), date: z.string() }),
  median_session: z.object({ value: z.string() }),
  sessions_over_1h: z.object({ value: z.string(), sub: z.string() }),
  total_time_in_sessions: z.object({ value: z.string() }),
}).strict();

export type SessionStats = z.infer<typeof SessionStatsSchema>;

export const ProfileCadenceDaySchema = z.object({
  date: z.string(),
  tokens_total: z.number().int().nonnegative(),
  sessions_count: z.number().int().nonnegative(),
}).strict();

export type ProfileCadenceDay = z.infer<typeof ProfileCadenceDaySchema>;

export const ProfileStreakBandSchema = z.object({
  from_date: z.string(),
  to_date: z.string(),
  length: z.number().int().nonnegative(),
}).strict();

export type ProfileStreakBand = z.infer<typeof ProfileStreakBandSchema>;

export const ProfileCadenceWindowSummarySchema = z.object({
  busiest_day: z.string().nullable(),
  busiest_hour: z.string().nullable(),
  hourly: z.array(z.number().int().nonnegative()).length(24),
  daily: z.array(z.number().int().nonnegative()).length(7),
  after_midnight: z.object({ count: z.number().int().nonnegative(), pct: z.number().min(0).max(1) }),
  weekend_share: z.number().min(0).max(1),
  sessions_count: z.number().int().nonnegative(),
}).strict();

export type ProfileCadenceWindowSummary = z.infer<typeof ProfileCadenceWindowSummarySchema>;

export const ProfileSectionCadenceSchema = z.object({
  days: z.array(ProfileCadenceDaySchema),
  busiest_day: z.string().nullable(),
  busiest_hour: z.string().nullable(),
  hourly: z.array(z.number().int().nonnegative()).length(24),
  daily: z.array(z.number().int().nonnegative()).length(7),
  windows: z.record(ProfileWindowSchema, ProfileCadenceWindowSummarySchema).optional(),
  current_streak: z.number().int().nonnegative(),
  longest_streak: z.number().int().nonnegative(),
  after_midnight: z.object({ count: z.number().int().nonnegative(), pct: z.number().min(0).max(1) }),
  weekend_share: z.number().min(0).max(1),
  // Daily chart series spanning the full activity range (≥90 days, last = today).
  daily_tokens_90d: z.array(z.number().int().nonnegative()).min(1),
  daily_sessions_90d: z.array(z.number().int().nonnegative()).min(1),
  // Trailing-30d composite-score momentum per day (same range/alignment); float.
  score_per_day_90d: z.array(z.number().nonnegative()).default([]),
  streak_bands: z.array(ProfileStreakBandSchema),
  dominant_model_per_day_90d: z.array(z.string()),
}).strict();

export type ProfileSectionCadence = z.infer<typeof ProfileSectionCadenceSchema>;

export const ProfileParallelismBucketSchema = z.object({
  label: z.string().min(1),
  sessions_count: z.number().int().nonnegative(),
  percentage: z.number().min(0).max(100),
}).strict();

export type ProfileParallelismBucket = z.infer<typeof ProfileParallelismBucketSchema>;

export const ProfileTierProgressionSchema = z.object({
  tier: z.number().int().min(1).max(5),
  days_at_tier: z.number().int().nonnegative(),
  unlocked: z.array(z.number().int().min(1).max(5)),
  highest_unlocked: z.number().int().min(1).max(5),
}).strict();

export type ProfileTierProgression = z.infer<typeof ProfileTierProgressionSchema>;

export const ProfileSectionParallelismSchema = z.object({
  buckets: z.array(ProfileParallelismBucketSchema),
  peak_daily: z.array(z.number().int().nonnegative()),
  peak_ever: z.number().int().nonnegative(),
  peak_ever_date: z.string(),
  peak_ever_time: z.string(),
  avg_concurrent: z.number().nonnegative(),
  days_parallel_3: z.number().int().nonnegative(),
  longest_sustained_3: z.string(),
  daily_peak_concurrent_90d: z.array(z.number().int().nonnegative()).length(90),
  tier_progression: ProfileTierProgressionSchema,
}).strict();

export type ProfileSectionParallelism = z.infer<typeof ProfileSectionParallelismSchema>;

export const ProfileSectionShippedSchema = z.object({
  loc_per_day_90d: z.array(z.number()),
  commit_per_day_90d: z.array(z.number()).default([]),
  loc_total: z.number(),
  commit_total: z.number(),
  produced_loc_per_day_90d: z.array(z.number()).default([]),
  produced_shipped_loc_per_day_90d: z.array(z.number()).default([]),
  produced_commit_per_day_90d: z.array(z.number()).default([]),
  linked_tokens_per_day_90d: z.array(z.number()).default([]),
  produced_loc_total: z.number().default(0),
  produced_shipped_loc_total: z.number().default(0),
  produced_commit_total: z.number().default(0),
  produced_high_confidence_commit_total: z.number().default(0),
  produced_median_link_confidence: z.number().min(0).max(1).default(0),
  spend_per_shipped_ai_loc_30d: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    cost_usd: z.number().nonnegative(),
    shipped_ai_coded_loc: z.number().int().nonnegative(),
    value: z.number().nonnegative().nullable(),
    status: z.enum(['ok', 'no_shipped_code', 'no_activity', 'zero_cost']),
  }).strict()).default([]),
}).strict();

export type ProfileSectionShipped = z.infer<typeof ProfileSectionShippedSchema>;

export const ProfileSectionSessionStatsSchema = z.object({
  longest_session: z.object({ value: z.string(), date: z.string() }),
  largest_by_tokens: z.object({ value: z.string(), date: z.string() }),
  most_expensive: z.object({ value: z.string(), date: z.string() }),
  median_session: z.object({ value: z.string() }),
  sessions_over_1h: z.object({ value: z.string(), sub: z.string() }),
  total_time_in_sessions: z.object({ value: z.string() }),
}).strict();

export type ProfileSectionSessionStats = z.infer<typeof ProfileSectionSessionStatsSchema>;

export const ProfileRecentActivityItemSchema = z.object({
  ingestion_run_id: z.string().uuid(),
  status: z.enum(['processing', 'completed', 'partial', 'failed']),
  created_at: SupabaseDateTimeSchema,
  accepted_count: z.number().int().nonnegative(),
  rejected_count: z.number().int().nonnegative(),
  deduped_count: z.number().int().nonnegative(),
  project_name: z.string().min(1).nullable(),
}).strict();

export type ProfileRecentActivityItem = z.infer<typeof ProfileRecentActivityItemSchema>;

export const ProfileSectionRecentActivitySchema = z.object({
  items: z.array(ProfileRecentActivityItemSchema).max(10),
}).strict();

export type ProfileSectionRecentActivity = z.infer<typeof ProfileSectionRecentActivitySchema>;

export const ProfileFooterOwnerFieldsSchema = z.object({
  access_keys: z.array(ProfileResponseAccessKeySchema),
  last_sync_at: SupabaseDateTimeSchema.nullable(),
  sync_status: ProfileSyncStatusSchema.nullable(),
}).strict();

export type ProfileFooterOwnerFields = z.infer<typeof ProfileFooterOwnerFieldsSchema>;

export const ProfileSectionFooterSchema = z.object({
  share_url: z.string().url(),
  og_image_url: z.string().url(),
  owner: ProfileFooterOwnerFieldsSchema.nullable(),
}).strict();

export type ProfileSectionFooter = z.infer<typeof ProfileSectionFooterSchema>;

export const PublicProfileResponseSchema = z.object({
  usage_recap: UsageRecapSchema.optional(),
  evidence: ProfileEvidenceSchema.optional(),
  token_mix: z.object({
    input: z.number().nonnegative(), output: z.number().nonnegative(),
    cache_read: z.number().nonnegative(), cache_write: z.number().nonnegative(),
    reasoning: z.number().nonnegative(),
  }).optional(),
  window: ProfileWindowSchema,
  user_is_owner: z.boolean(),
  identity: ProfileSectionIdentitySchema,
  headline: ProfileSectionHeadlineSchema,
  at_glance: ProfileSectionAtGlanceSchema,
  models: ProfileSectionModelsSchema,
  tools: ProfileSectionToolsSchema,
  session_stats: ProfileSectionSessionStatsSchema,
  sessions: ProfileSectionSessionsSchema,
  cadence: ProfileSectionCadenceSchema,
  parallelism: ProfileSectionParallelismSchema,
  shipped: ProfileSectionShippedSchema.optional(),
  recent_activity: ProfileSectionRecentActivitySchema,
  data_range: z.object({
    first_session_at: SupabaseDateTimeSchema.nullable(),
    last_session_at: SupabaseDateTimeSchema.nullable(),
  }).nullable().optional(),
  footer: ProfileSectionFooterSchema,
  access_keys: z.array(ProfileResponseAccessKeySchema).optional(),
  last_sync_at: SupabaseDateTimeSchema.nullable().optional(),
  sync_status: ProfileSyncStatusSchema.nullable().optional(),
}).strict();

export type PublicProfileResponse = z.infer<typeof PublicProfileResponseSchema>;

export const ProfileVariantSchema = z.enum([
  'public_share_false',
  'public_share_true',
  'owner_share_false',
  'owner_share_true',
]);

export type ProfileVariant = z.infer<typeof ProfileVariantSchema>;

const HiddenProjectAtGlanceSchema = ProfileSectionAtGlanceSchema.extend({
  project_breakdown: z.array(ProfileProjectUsageSchema).length(0),
}).strict();

const HiddenProjectSessionItemSchema = ProfileSessionItemSchema.extend({
  project_name: z.null(),
}).strict();

const VisibleProjectSessionItemSchema = ProfileSessionItemSchema.extend({
  project_name: z.string().min(1),
}).strict();

const HiddenProjectSessionsSchema = ProfileSectionSessionsSchema.extend({
  items: z.array(HiddenProjectSessionItemSchema).max(10),
}).strict();

const VisibleProjectSessionsSchema = ProfileSectionSessionsSchema.extend({
  items: z.array(VisibleProjectSessionItemSchema).max(10),
}).strict();

const HiddenProjectRecentActivityItemSchema = ProfileRecentActivityItemSchema.extend({
  project_name: z.null(),
}).strict();

const HiddenProjectRecentActivitySchema = ProfileSectionRecentActivitySchema.extend({
  items: z.array(HiddenProjectRecentActivityItemSchema).max(10),
}).strict();

const PublicProfileFooterSchema = ProfileSectionFooterSchema.extend({
  owner: ProfileFooterOwnerFieldsSchema.nullable(),
}).strict();

const OwnerProfileFooterSchema = ProfileSectionFooterSchema.extend({
  owner: ProfileFooterOwnerFieldsSchema,
}).strict();

const PublicShareFalseProfileResponseSchema = PublicProfileResponseSchema.extend({
  variant: z.literal('public_share_false'),
  user_is_owner: z.literal(false),
  identity: ProfileSectionIdentitySchema.extend({
    share_projects: z.literal(false),
  }).strict(),
  at_glance: HiddenProjectAtGlanceSchema,
  sessions: HiddenProjectSessionsSchema,
  recent_activity: HiddenProjectRecentActivitySchema,
  footer: PublicProfileFooterSchema,
  access_keys: z.array(ProfileResponseAccessKeySchema).length(0),
  last_sync_at: z.null(),
  sync_status: z.null(),
}).strict();

const PublicShareTrueProfileResponseSchema = PublicProfileResponseSchema.extend({
  variant: z.literal('public_share_true'),
  user_is_owner: z.literal(false),
  identity: ProfileSectionIdentitySchema.extend({
    share_projects: z.literal(true),
  }).strict(),
  sessions: VisibleProjectSessionsSchema,
  recent_activity: ProfileSectionRecentActivitySchema,
  footer: PublicProfileFooterSchema,
  access_keys: z.array(ProfileResponseAccessKeySchema).length(0),
  last_sync_at: z.null(),
  sync_status: z.null(),
}).strict();

const OwnerShareFalseProfileResponseSchema = PublicProfileResponseSchema.extend({
  variant: z.literal('owner_share_false'),
  user_is_owner: z.literal(true),
  identity: ProfileSectionIdentitySchema.extend({
    share_projects: z.literal(false),
  }).strict(),
  at_glance: HiddenProjectAtGlanceSchema,
  sessions: HiddenProjectSessionsSchema,
  recent_activity: HiddenProjectRecentActivitySchema,
  footer: OwnerProfileFooterSchema,
  access_keys: z.array(ProfileResponseAccessKeySchema),
  last_sync_at: SupabaseDateTimeSchema.nullable(),
  sync_status: ProfileSyncStatusSchema,
}).strict();

const OwnerShareTrueProfileResponseSchema = PublicProfileResponseSchema.extend({
  variant: z.literal('owner_share_true'),
  user_is_owner: z.literal(true),
  identity: ProfileSectionIdentitySchema.extend({
    share_projects: z.literal(true),
  }).strict(),
  sessions: VisibleProjectSessionsSchema,
  recent_activity: ProfileSectionRecentActivitySchema,
  footer: OwnerProfileFooterSchema,
  access_keys: z.array(ProfileResponseAccessKeySchema),
  last_sync_at: SupabaseDateTimeSchema.nullable(),
  sync_status: ProfileSyncStatusSchema,
}).strict();

/**
 * Server-side profile visibility contract. API handlers choose exactly one variant
 * after resolving the viewer and `share_projects`; clients render the returned
 * variant and must never receive owner fields or project names they are not
 * allowed to display.
 */
export const ProfileResponseVariantSchema = z.discriminatedUnion('variant', [
  PublicShareFalseProfileResponseSchema,
  PublicShareTrueProfileResponseSchema,
  OwnerShareFalseProfileResponseSchema,
  OwnerShareTrueProfileResponseSchema,
]);

export type ProfileResponseVariant = z.infer<typeof ProfileResponseVariantSchema>;

export const ProfileResponseSchema = ProfileResponseVariantSchema;

export type ProfileResponse = z.infer<typeof ProfileResponseSchema>;

// Update profile request
export const ProfileUpdateSchema = z.object({
  displayName: z.string().max(100).optional(),
  avatarUrl: z.string().url().nullable().optional(),
  bio: z.string().max(500).optional(),
  xHandle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/).nullable().optional(),
  shareProjects: z.boolean().optional(),
}).strict();

export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>;

export const UpdateProfileRequestSchema = z.object({
  display_name: z.string().max(100).optional(),
  avatar_url: z.string().url().nullable().optional(),
  bio: z.string().max(500).optional(),
  x_handle: z.string().max(50).optional(),
  share_projects: z.boolean().optional(),
}).strict();

export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;
