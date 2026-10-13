import { z } from 'zod';
import { UsageEvidenceSchema } from './evidence.js';

import {
  UsageImportProviderSchema,
  UsageImportSourceSchema,
} from './usage-import.js';

const IsoDateTimeSchema = z.string().datetime({ offset: true });
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

/** Bounded full-history upload size, shared by the sender and hosted route. */
export const LOCAL_PUBLISH_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

export const PublishUsageDailyRowSchema = z.object({
  date: IsoDateSchema,
  source: UsageImportSourceSchema,
  provider: UsageImportProviderSchema,
  model: z.string().min(1).max(256),
  total_tokens: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative(),
  cache_create_tokens: z.number().int().nonnegative(),
  cached_tokens: z.number().int().nonnegative(),
  reasoning_tokens: z.number().int().nonnegative(),
  total_sessions: z.number().int().nonnegative(),
  event_count: z.number().int().nonnegative(),
  cost_usd_total: z.number().nonnegative(),
}).strict();

export type PublishUsageDailyRow = z.infer<typeof PublishUsageDailyRowSchema>;

export const PublishModelDailyRowSchema = PublishUsageDailyRowSchema;

export type PublishModelDailyRow = z.infer<typeof PublishModelDailyRowSchema>;

export const PublishSessionRollupRowSchema = z.object({
  source: UsageImportSourceSchema,
  provider: UsageImportProviderSchema,
  session_id: z.string().min(1).max(256),
  model: z.string().min(1).max(256),
  first_event_at: IsoDateTimeSchema,
  last_event_at: IsoDateTimeSchema,
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative(),
  cache_create_tokens: z.number().int().nonnegative(),
  cached_tokens: z.number().int().nonnegative(),
  reasoning_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  cost_usd_total: z.number().nonnegative(),
  source_file_hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(50),
}).strict();

export type PublishSessionRollupRow = z.infer<typeof PublishSessionRollupRowSchema>;

export const PublishProducedCodeDailyRowSchema = z.object({
  date: IsoDateSchema,
  produced_loc: z.number().int().nonnegative(),
  produced_loc_score: z.number().int().nonnegative().default(0),
  shipped_loc: z.number().int().nonnegative().default(0),
  shipped_loc_score: z.number().int().nonnegative().default(0),
  ai_linked_commit_count: z.number().int().nonnegative(),
  high_confidence_commit_count: z.number().int().nonnegative(),
  median_link_confidence: z.number().min(0).max(1),
}).strict();

export type PublishProducedCodeDailyRow = z.infer<typeof PublishProducedCodeDailyRowSchema>;

export const PublishGithubCodeDailyRowSchema = z.object({
  date: IsoDateSchema,
  repo_id: z.number().int().positive(),
  full_name: z.string().min(1),
  prod_branch: z.string().min(1),
  github_shipped_loc: z.number().int().nonnegative(),
  github_shipped_loc_score: z.number().int().nonnegative().default(0),
  github_commit_count: z.number().int().nonnegative(),
  verified_at: IsoDateTimeSchema,
  verification_source: z.literal('github_remote_prod'),
}).strict();

export type PublishGithubCodeDailyRow = z.infer<typeof PublishGithubCodeDailyRowSchema>;

export const PublishAiLinkedCodeDailyRowSchema = z.object({
  date: IsoDateSchema,
  repo_id: z.number().int().positive(),
  full_name: z.string().min(1),
  linked_shipped_loc: z.number().int().nonnegative(),
  linked_shipped_loc_score: z.number().int().nonnegative().default(0),
  linked_commit_count: z.number().int().nonnegative(),
  linked_tokens: z.number().int().nonnegative(),
  linked_cost_usd: z.number().nonnegative().default(0),
  high_confidence_commit_count: z.number().int().nonnegative(),
  median_link_confidence: z.number().min(0).max(1),
}).strict();

export type PublishAiLinkedCodeDailyRow = z.infer<typeof PublishAiLinkedCodeDailyRowSchema>;

export const PublishModelCodeDailyRowSchema = z.object({
  date: IsoDateSchema,
  source: UsageImportSourceSchema,
  provider: UsageImportProviderSchema,
  model: z.string().min(1).max(256),
  produced_loc: z.number().int().nonnegative(),
  produced_loc_score: z.number().int().nonnegative().default(0),
  shipped_loc: z.number().int().nonnegative().default(0),
  shipped_loc_score: z.number().int().nonnegative().default(0),
  linked_commit_count: z.number().int().nonnegative(),
  linked_tokens: z.number().int().nonnegative(),
  linked_cost_usd: z.number().nonnegative(),
}).strict();

export type PublishModelCodeDailyRow = z.infer<typeof PublishModelCodeDailyRowSchema>;

export const PublishPricingSnapshotRowSchema = z.object({
  provider: z.string().min(1),
  model_id: z.string().min(1),
  content_hash: z.string().min(32),
}).strict();

export type PublishPricingSnapshotRow = z.infer<typeof PublishPricingSnapshotRowSchema>;

export const PublishSelectedRepoSchema = z.object({
  repo_id: z.number().int().positive(),
  full_name: z.string().min(1),
  prod_branch: z.string().min(1),
}).strict();

export type PublishSelectedRepo = z.infer<typeof PublishSelectedRepoSchema>;

export const LocalPublishPayloadSchema = z.object({
  usage_evidence: UsageEvidenceSchema.optional(),
  schema_version: z.union([z.literal(1), z.literal(2)]),
  client_version: z.string().min(1).max(80),
  generated_at: IsoDateTimeSchema,
  github_user_id: z.number().int().positive(),
  selected_repos: z.array(PublishSelectedRepoSchema).max(500),
  usage_daily: z.array(PublishUsageDailyRowSchema).max(20000),
  model_daily: z.array(PublishModelDailyRowSchema).max(20000).default([]),
  usage_session_rollups: z.array(PublishSessionRollupRowSchema).max(20000).default([]),
  // A session is counted once on its last active UTC day. No session identifiers.
  session_counts_daily: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    source: z.enum(['claude', 'codex', 'opencode']),
    total_sessions: z.number().int().nonnegative(),
  }).strict()).max(20000).optional(),
  produced_code_daily: z.array(PublishProducedCodeDailyRowSchema).max(20000).default([]),
  github_code_daily: z.array(PublishGithubCodeDailyRowSchema).max(50000).default([]),
  ai_linked_code_daily: z.array(PublishAiLinkedCodeDailyRowSchema).max(50000).default([]),
  model_code_daily: z.array(PublishModelCodeDailyRowSchema).max(50000).default([]),
  pricing_snapshot: z.array(PublishPricingSnapshotRowSchema).max(2000),
  summary: z.object({
    total_tokens: z.number().int().nonnegative(),
    total_cost_usd: z.number().nonnegative(),
    sessions_count: z.number().int().nonnegative(),
    produced_loc_total: z.number().int().nonnegative(),
    produced_loc_score_total: z.number().int().nonnegative().default(0),
    github_shipped_loc_total: z.number().int().nonnegative(),
    github_shipped_loc_score_total: z.number().int().nonnegative().default(0),
    ai_linked_shipped_loc_total: z.number().int().nonnegative(),
    ai_linked_shipped_loc_score_total: z.number().int().nonnegative().default(0),
  }).strict(),
  privacy_report: z.object({
    prompts_sent: z.literal(0),
    raw_commands_sent: z.literal(0),
    file_contents_sent: z.literal(0),
    absolute_paths_sent: z.literal(0),
    raw_transcripts_sent: z.literal(0),
  }).strict(),
}).strict().superRefine((payload, ctx) => {
  if (payload.usage_evidence) {
    const expected = new Set((payload.model_daily.length ? payload.model_daily : payload.usage_daily).filter(r=>r.total_tokens>0).map(r=>r.source));
    if (payload.usage_evidence.sources.length !== expected.size || payload.usage_evidence.sources.some(s=>!expected.has(s.source))) {
      ctx.addIssue({code:z.ZodIssueCode.custom,path:['usage_evidence','sources'],message:'Evidence must describe exactly the published sources.'});
    }
    for (const source of payload.usage_evidence.sources) {
      const models = new Set((payload.model_daily.length ? payload.model_daily : payload.usage_daily)
        .filter(row=>row.source===source.source && row.total_tokens>0).map(row=>row.model));
      if (source.unpriced_models.some(model=>!models.has(model))) {
        ctx.addIssue({code:z.ZodIssueCode.custom,path:['usage_evidence','sources'],message:'Missing prices must refer to models in the published source.'});
      }
    }
    if (payload.usage_evidence.attribution && (payload.selected_repos.length===0 || payload.usage_evidence.attribution.sessions!==payload.summary.sessions_count)) {
      ctx.addIssue({code:z.ZodIssueCode.custom,path:['usage_evidence','attribution'],message:'Attribution coverage requires opted-in repositories and must match the session count.'});
    }
  }
  if (payload.session_counts_daily && payload.session_counts_daily.reduce((sum, row) => sum + row.total_sessions, 0) !== payload.summary.sessions_count) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['session_counts_daily'], message: 'Daily session counts must match the reviewed total.' });
  }
  if (payload.schema_version === 2 && payload.usage_session_rollups.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['usage_session_rollups'], message: 'Aggregate publishing must not contain session records.' });
  }
});

export type LocalPublishPayload = z.infer<typeof LocalPublishPayloadSchema>;

export const PublishLinkStartResponseSchema = z.object({
  data: z.object({
    code: z.string().min(16),
    expires_at: IsoDateTimeSchema,
  }).strict(),
}).strict();

export type PublishLinkStartResponse = z.infer<typeof PublishLinkStartResponseSchema>;

export const PublishLinkExchangeRequestSchema = z.object({
  code: z.string().min(16),
  github_user_id: z.number().int().positive().optional(),
}).strict();

export type PublishLinkExchangeRequest = z.infer<typeof PublishLinkExchangeRequestSchema>;

export const PublishLinkExchangeResponseSchema = z.object({
  data: z.object({
    public_profile_url: z.string().url().nullable().optional(),
    publish_token: z.string().min(32),
    github_user_id: z.number().int().positive(),
    expires_at: IsoDateTimeSchema,
  }).strict(),
}).strict();

export type PublishLinkExchangeResponse = z.infer<typeof PublishLinkExchangeResponseSchema>;

export const PublishLocalResponseSchema = z.object({
  data: z.object({
    publish_run_id: z.string().uuid(),
    verification_status: z.enum(['pending', 'processing', 'passed', 'failed', 'unavailable']),
    accepted_usage_days: z.number().int().nonnegative(),
    accepted_sessions: z.number().int().nonnegative(),
    accepted_code_days: z.number().int().nonnegative(),
    remote_github_shipped_loc_total: z.number().int().nonnegative(),
    remote_github_commit_total: z.number().int().nonnegative(),
    remote_github_day_count: z.number().int().nonnegative(),
    pricing_mismatches: z.array(z.string()),
  }).strict(),
}).strict();

export type PublishLocalResponse = z.infer<typeof PublishLocalResponseSchema>;
