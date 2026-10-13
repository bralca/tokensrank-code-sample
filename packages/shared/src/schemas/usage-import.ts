import { z } from 'zod';

const isoDateTimeSchema = z.string().datetime({ offset: true });
const tokenCountSchema = z.number().int().nonnegative();

export const UsageImportSourceSchema = z.enum(['claude', 'codex', 'opencode']);
export const UsageImportProviderSchema = z.enum(['anthropic', 'openai', 'unknown']);

export const UsageEventSchema = z.object({
  event_id: z.string().trim().min(16).max(128),
  source: UsageImportSourceSchema,
  provider: UsageImportProviderSchema,
  event_kind: z.string().trim().min(1).max(80),
  session_id: z.string().trim().min(1).max(256),
  source_event_id: z.string().trim().min(1).max(256).optional(),
  event_at: isoDateTimeSchema,
  model: z.string().trim().min(1).max(256),
  model_source: z.enum(['explicit', 'session_context', 'unknown']),
  input_tokens: tokenCountSchema,
  output_tokens: tokenCountSchema,
  cache_read_tokens: tokenCountSchema,
  cache_create_tokens: tokenCountSchema,
  cached_tokens: tokenCountSchema,
  reasoning_tokens: tokenCountSchema,
  source_file_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u, 'source_file_hash must be a lowercase SHA-256 hex digest'),
  source_file_size: z.number().int().nonnegative().optional(),
  line_number: z.number().int().positive().optional(),
  parser_version: z.string().trim().min(1).max(80),
  metadata: z.record(z.unknown()).optional(),
}).strict().refine(
  (event) => (
    event.input_tokens
    + event.output_tokens
    + event.cache_read_tokens
    + event.cache_create_tokens
  ) > 0,
  {
    message: 'event must contain additive token usage',
    path: ['input_tokens'],
  },
);

export type UsageImportSource = z.infer<typeof UsageImportSourceSchema>;
export type UsageImportProvider = z.infer<typeof UsageImportProviderSchema>;
export type UsageEvent = z.infer<typeof UsageEventSchema>;

export const UsageSourceFileSchema = z.object({
  source: UsageImportSourceSchema,
  source_file_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u, 'source_file_hash must be a lowercase SHA-256 hex digest'),
  source_file_size: z.number().int().nonnegative(),
  line_count: z.number().int().nonnegative(),
  parsed_event_count: z.number().int().nonnegative(),
  ignored_line_count: z.number().int().nonnegative(),
  warning_count: z.number().int().nonnegative(),
  parser_version: z.string().trim().min(1).max(80),
  metadata: z.record(z.unknown()).optional(),
}).strict();

export type UsageSourceFile = z.infer<typeof UsageSourceFileSchema>;

export const USAGE_IMPORT_EVENTS_MAX = 1000;
export const USAGE_IMPORT_FILES_MAX = 200;
export const USAGE_IMPORT_WARNINGS_MAX = 200;

export const UsageImportRequestSchema = z.object({
  client: z.object({
    version: z.string().trim().min(1).max(80),
    import_surface: z.enum(['browser_folder']),
    timezone: z.string().trim().min(1).max(80).optional(),
  }).strict(),
  run: z.object({
    run_id: z.string().trim().min(1).max(128),
    started_at: isoDateTimeSchema,
    finished_at: isoDateTimeSchema.optional(),
  }).strict(),
  files: z.array(UsageSourceFileSchema).max(USAGE_IMPORT_FILES_MAX),
  events: z.array(UsageEventSchema).max(USAGE_IMPORT_EVENTS_MAX),
  warnings: z.array(z.string().trim().min(1).max(500)).max(USAGE_IMPORT_WARNINGS_MAX).optional(),
}).strict().refine(
  (request) => request.run.finished_at === undefined
    || new Date(request.run.started_at).getTime() <= new Date(request.run.finished_at).getTime(),
  {
    message: 'started_at must be before or equal to finished_at',
    path: ['run', 'finished_at'],
  },
);

export type UsageImportRequest = z.infer<typeof UsageImportRequestSchema>;

export const UsageImportRejectedReasonSchema = z.enum([
  'schema_invalid',
  'future_timestamp',
  'bounds_violation',
  'privacy_violation',
]);

export const UsageImportRejectedDetailSchema = z.object({
  event_id: z.string().trim().min(1),
  reason_code: UsageImportRejectedReasonSchema,
  details: z.record(z.unknown()).optional(),
}).strict();

export type UsageImportRejectedReason = z.infer<typeof UsageImportRejectedReasonSchema>;
export type UsageImportRejectedDetail = z.infer<typeof UsageImportRejectedDetailSchema>;

export const UsageImportResponseSchema = z.object({
  data: z.object({
    ingestion_run_id: z.string().uuid(),
    accepted_count: z.number().int().nonnegative(),
    deduped_count: z.number().int().nonnegative(),
    rejected_count: z.number().int().nonnegative(),
    projected: z.boolean(),
    rejected_details: z.array(UsageImportRejectedDetailSchema),
  }).strict(),
}).strict();

export type UsageImportResponse = z.infer<typeof UsageImportResponseSchema>;

export const UsageImportFinalizeRequestSchema = z.object({
  run: z.object({
    run_id: z.string().trim().min(1).max(128),
    started_at: isoDateTimeSchema,
    finished_at: isoDateTimeSchema,
  }).strict(),
}).strict().refine(
  (request) => new Date(request.run.started_at).getTime() <= new Date(request.run.finished_at).getTime(),
  {
    message: 'started_at must be before or equal to finished_at',
    path: ['run', 'finished_at'],
  },
);

export type UsageImportFinalizeRequest = z.infer<typeof UsageImportFinalizeRequestSchema>;

export const UsageImportFinalizeResponseSchema = z.object({
  data: z.object({
    projected: z.boolean(),
  }).strict(),
}).strict();

export type UsageImportFinalizeResponse = z.infer<typeof UsageImportFinalizeResponseSchema>;
