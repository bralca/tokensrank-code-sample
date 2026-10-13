import { z } from 'zod';

const isoDateTimeSchema = z.string().datetime({ offset: true });
const tokenCountSchema = z.number().int().nonnegative();

export const IngestionSourceSchema = z.enum(['claude', 'codex', 'opencode']);
export const ClientPlatformSchema = z.enum(['darwin', 'linux', 'win32']);

export const ClientInfoSchema = z.object({
  version: z.string().trim().min(1, 'version is required'),
  install_id: z.string().uuid().optional(),
  platform: ClientPlatformSchema.optional(),
  arch: z.string().trim().min(1, 'arch is required when provided').optional(),
}).strict();

export const RunInfoSchema = z.object({
  run_id: z.string().trim().min(1, 'run_id is required'),
  started_at: isoDateTimeSchema,
  finished_at: isoDateTimeSchema.optional(),
}).strict().refine(
  (run) => run.finished_at === undefined
    || new Date(run.started_at).getTime() <= new Date(run.finished_at).getTime(),
  {
    message: 'started_at must be before or equal to finished_at',
    path: ['finished_at'],
  },
);

export const SessionPayloadSchema = z.object({
  session_id: z.string().trim().min(1, 'session_id is required'),
  model: z.string().trim().min(1, 'model is required'),
  source: IngestionSourceSchema,
  first_event_at: isoDateTimeSchema,
  last_event_at: isoDateTimeSchema,
  input_tokens: tokenCountSchema,
  output_tokens: tokenCountSchema,
  cache_read_input_tokens: tokenCountSchema,
  cache_creation_input_tokens: tokenCountSchema,
  cached_input_tokens: tokenCountSchema,
  reasoning_output_tokens: tokenCountSchema,
  turns: z.number().int().nonnegative(),
  // Active wall-clock time within the session: total active seconds and the
  // single longest uninterrupted stretch (a gap > 30m ends a stretch).
  // Optional for backward-compat with clients that don't compute them.
  active_seconds: z.number().int().nonnegative().optional(),
  longest_active_seconds: z.number().int().nonnegative().optional(),
  file_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'file_sha256 must be a lowercase SHA-256 hex digest'),
}).strict().refine(
  (session) => new Date(session.first_event_at).getTime() <= new Date(session.last_event_at).getTime(),
  {
    message: 'first_event_at must be before or equal to last_event_at',
    path: ['last_event_at'],
  },
);

export type IngestionSource = z.infer<typeof IngestionSourceSchema>;
export type ClientPlatform = z.infer<typeof ClientPlatformSchema>;
export type ClientInfo = z.infer<typeof ClientInfoSchema>;
export type RunInfo = z.infer<typeof RunInfoSchema>;
export type SessionPayload = z.infer<typeof SessionPayloadSchema>;

export const INGEST_SESSIONS_MAX = 100;

export const IngestRequestSchema = z.object({
  client: ClientInfoSchema,
  run: RunInfoSchema,
  sessions: z.array(SessionPayloadSchema).max(
    INGEST_SESSIONS_MAX,
    `Batch size exceeds ${INGEST_SESSIONS_MAX} sessions`,
  ),
}).strict();

export type IngestRequest = z.infer<typeof IngestRequestSchema>;

export const IngestionRejectionReasonSchema = z.enum([
  'rate_limited',
  'schema_invalid',
  'future_timestamp',
  'timestamp_too_old',
  'ratchet_violation',
  'bounds_violation',
  'fingerprint_critical',
]);

export const RejectionDetailSchema = z.object({
  session_id: z.string().trim().min(1, 'session_id is required'),
  reason_code: IngestionRejectionReasonSchema,
  details: z.record(z.unknown()).optional(),
}).strict();

export const IngestResponseSchema = z.object({
  ingestion_run_id: z.string().uuid(),
  accepted_count: z.number().int().nonnegative(),
  deduped_count: z.number().int().nonnegative(),
  rejected_count: z.number().int().nonnegative(),
  rejected_details: z.array(RejectionDetailSchema),
}).strict().refine(
  (response) => response.rejected_count === response.rejected_details.length,
  {
    message: 'rejected_count must match rejected_details length',
    path: ['rejected_count'],
  },
);

export type IngestionRejectionReason = z.infer<typeof IngestionRejectionReasonSchema>;
export type RejectionDetail = z.infer<typeof RejectionDetailSchema>;
export type IngestResponse = z.infer<typeof IngestResponseSchema>;
