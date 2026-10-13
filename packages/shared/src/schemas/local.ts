import { z } from 'zod';

import { ProfileResponseSchema } from './profile.js';

const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const LocalSetupStepSchema = z.enum([
  'github_auth',
  'discovery',
  'repo_selection',
  'ingestion',
  'ready',
]);

export type LocalSetupStep = z.infer<typeof LocalSetupStepSchema>;

export const LocalOnboardingStatusSchema = z.object({
  completed_at: IsoDateTimeSchema.nullable(),
  completed_version: z.string().min(1).nullable(),
  last_completed_step: z.string().min(1).nullable(),
}).strict();

export type LocalOnboardingStatus = z.infer<typeof LocalOnboardingStatusSchema>;

export const LocalGithubIdentitySchema = z.object({
  github_user_id: z.number().int().positive(),
  login: z.string().min(1),
  avatar_url: z.string().url().nullable(),
  verified_emails: z.array(z.string().email()),
  connected_at: IsoDateTimeSchema,
}).strict();

export type LocalGithubIdentity = z.infer<typeof LocalGithubIdentitySchema>;

export const LocalDiscoveredUsageSourceSchema = z.object({
  source: z.enum(['claude', 'codex', 'opencode']),
  root_path: z.string().min(1),
  file_count: z.number().int().nonnegative(),
  readable: z.boolean(),
  last_seen_at: IsoDateTimeSchema.nullable(),
}).strict();

export type LocalDiscoveredUsageSource = z.infer<typeof LocalDiscoveredUsageSourceSchema>;

export const LocalDiscoveredRepoSchema = z.object({
  id: z.string().min(1),
  local_root: z.string().min(1),
  git_remote_url: z.string().nullable(),
  github_repo_id: z.number().int().positive().nullable(),
  full_name: z.string().nullable(),
  default_branch: z.string().nullable(),
  prod_branch: z.string().nullable(),
  last_remote_sync_at: IsoDateTimeSchema.nullable(),
  remote_sync_error: z.string().nullable(),
  branches: z.array(z.string().min(1)),
  worktree_count: z.number().int().nonnegative(),
  selected: z.boolean(),
  matched: z.boolean(),
}).strict();

export type LocalDiscoveredRepo = z.infer<typeof LocalDiscoveredRepoSchema>;

export const LocalGithubVerificationStatusSchema = z.object({
  verified_repo_count: z.number().int().nonnegative(),
  github_total_loc: z.number().int().nonnegative(),
  github_total_commits: z.number().int().nonnegative(),
  ai_linked_loc: z.number().int().nonnegative(),
  ai_linked_commits: z.number().int().nonnegative(),
  last_verified_at: IsoDateTimeSchema.nullable(),
  invariant_violations: z.array(z.string()).max(100),
}).strict();

export type LocalGithubVerificationStatus = z.infer<typeof LocalGithubVerificationStatusSchema>;

export const LocalPricingStatusSchema = z.object({
  row_count: z.number().int().nonnegative(),
  fetched_at: IsoDateTimeSchema.nullable(),
  source: z.enum(['models.dev', 'bundled_snapshot', 'empty']),
  last_error: z.string().nullable(),
}).strict();

export type LocalPricingStatus = z.infer<typeof LocalPricingStatusSchema>;

export const LocalIngestionRunStatusSchema = z.object({
  run_id: z.string().min(1),
  status: z.enum(['idle', 'running', 'completed', 'partial', 'failed', 'interrupted']),
  started_at: IsoDateTimeSchema.nullable(),
  finished_at: IsoDateTimeSchema.nullable(),
  files_seen: z.number().int().nonnegative(),
  files_parsed: z.number().int().nonnegative(),
  events_seen: z.number().int().nonnegative(),
  events_inserted: z.number().int().nonnegative(),
  events_deduped: z.number().int().nonnegative(),
  warnings: z.array(z.string()).max(50),
}).strict();

export type LocalIngestionRunStatus = z.infer<typeof LocalIngestionRunStatusSchema>;

export const LocalOperationTypeSchema = z.enum([
  'discover',
  'pricing_sync',
  'usage_ingest',
  'github_sync',
  'repo_selection',
  'schedule_run',
  'version_check',
  'onboarding_reset',
]);

export type LocalOperationType = z.infer<typeof LocalOperationTypeSchema>;

export const LocalOperationStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'interrupted',
]);

export type LocalOperationStatus = z.infer<typeof LocalOperationStatusSchema>;

export const LocalOperationRunSchema = z.object({
  operation_id: z.string().min(1),
  type: LocalOperationTypeSchema,
  label: z.string().min(1),
  status: LocalOperationStatusSchema,
  stage: z.string().min(1),
  progress_percent: z.number().min(0).max(100).nullable(),
  current: z.number().int().nonnegative().nullable(),
  total: z.number().int().nonnegative().nullable(),
  message: z.string().nullable(),
  result: z.record(z.unknown()).nullable(),
  error: z.string().nullable(),
  started_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
  finished_at: IsoDateTimeSchema.nullable(),
}).strict();

export type LocalOperationRun = z.infer<typeof LocalOperationRunSchema>;

export const LocalScheduleConfigSchema = z.object({
  enabled: z.boolean(),
  interval_minutes: z.number().int().min(15).max(1440),
  auto_publish: z.boolean(),
}).strict();

export type LocalScheduleConfig = z.infer<typeof LocalScheduleConfigSchema>;

export const LocalScheduleStatusSchema = z.object({
  config: LocalScheduleConfigSchema,
  running: z.boolean(),
  next_run_at: IsoDateTimeSchema.nullable(),
  last_run_at: IsoDateTimeSchema.nullable(),
  last_finished_at: IsoDateTimeSchema.nullable(),
  last_error: z.string().nullable(),
  usage_updated_at: IsoDateTimeSchema.nullable().optional(),
  last_reason: z.enum(['manual', 'interval', 'startup']).nullable(),
  last_result: z.object({
    files_seen: z.number().int().nonnegative(),
    events_inserted: z.number().int().nonnegative(),
    events_deduped: z.number().int().nonnegative(),
    github_verified_repo_count: z.number().int().nonnegative(),
    github_total_loc: z.number().int().nonnegative(),
    published: z.boolean(),
    warnings: z.array(z.string()).optional(),
  }).strict().nullable(),
}).strict();

export type LocalScheduleStatus = z.infer<typeof LocalScheduleStatusSchema>;

export const LocalVersionStatusSchema = z.object({
  package_name: z.string().min(1),
  current_version: z.string().min(1),
  latest_version: z.string().min(1).nullable(),
  update_available: z.boolean(),
  checked_at: IsoDateTimeSchema.nullable(),
  source: z.enum(['npm', 'cached', 'unknown']),
  release_url: z.string().url().nullable(),
  last_error: z.string().nullable(),
}).strict();

export type LocalVersionStatus = z.infer<typeof LocalVersionStatusSchema>;

export const LocalSetupStatusSchema = z.object({
  step: LocalSetupStepSchema,
  data_dir: z.string().min(1),
  database_path: z.string().min(1),
  config_path: z.string().min(1),
  logs_path: z.string().min(1),
  github: LocalGithubIdentitySchema.nullable(),
  usage_sources: z.array(LocalDiscoveredUsageSourceSchema),
  repos: z.array(LocalDiscoveredRepoSchema),
  pricing: LocalPricingStatusSchema,
  github_verification: LocalGithubVerificationStatusSchema,
  ingestion: LocalIngestionRunStatusSchema,
  operations: z.array(LocalOperationRunSchema),
  profile_ready: z.boolean(),
  onboarding: LocalOnboardingStatusSchema,
}).strict();

export type LocalSetupStatus = z.infer<typeof LocalSetupStatusSchema>;

export const LocalGithubDeviceStartResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
}).strict();

export type LocalGithubDeviceStartResponse = z.infer<typeof LocalGithubDeviceStartResponseSchema>;

export const LocalGithubDeviceStatusResponseSchema = z.object({
  status: z.enum(['pending', 'authorized', 'expired', 'error']),
  message: z.string().nullable(),
  identity: LocalGithubIdentitySchema.nullable(),
  poll_interval_seconds: z.number().int().positive().optional(),
  next_poll_at: IsoDateTimeSchema.nullable().optional(),
}).strict();

export type LocalGithubDeviceStatusResponse = z.infer<typeof LocalGithubDeviceStatusResponseSchema>;

export const LocalRepoSelectionRequestSchema = z.object({
  repos: z.array(z.object({
    id: z.string().min(1),
    selected: z.boolean(),
    prod_branch: z.string().min(1).nullable(),
  }).strict()),
}).strict();

export type LocalRepoSelectionRequest = z.infer<typeof LocalRepoSelectionRequestSchema>;

export const LocalOnboardingCompleteRequestSchema = z.object({
  completed_version: z.string().min(1).optional(),
  last_completed_step: z.string().min(1).optional(),
}).strict().default({});

export type LocalOnboardingCompleteRequest = z.infer<typeof LocalOnboardingCompleteRequestSchema>;

export const LocalProfileResponseSchema = z.object({
  data: ProfileResponseSchema,
}).strict();

export type LocalProfileResponse = z.infer<typeof LocalProfileResponseSchema>;
