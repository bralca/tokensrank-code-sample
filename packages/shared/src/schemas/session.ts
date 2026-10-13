import { z } from "zod";

// Session data (one entry in the ingestion request)
export const SessionDataSchema = z.object({
  source: z.enum(["claude", "codex", "opencode"]),
  session_id: z.string(),
  model: z.string().optional(),
  file_sha256: z.string(),
  file_size: z.number().int().optional(),
  first_event_at: z.string().datetime(),
  last_event_at: z.string().datetime(),
  input_tokens: z.bigint().default(BigInt(0)),
  output_tokens: z.bigint().default(BigInt(0)),
  cache_read_tokens: z.bigint().default(BigInt(0)),
  cache_create_tokens: z.bigint().default(BigInt(0)),
  cached_tokens: z.bigint().default(BigInt(0)),
  reasoning_tokens: z.bigint().default(BigInt(0)),
  turns: z.number().int().default(0),
  platform: z.string().optional(),
}).strict();

export type SessionData = z.infer<typeof SessionDataSchema>;

// Client info for ingestion
export const ClientInfoSchema = z.object({
  version: z.string(),
  install_id: z.string().uuid().optional(),
  platform: z.enum(["darwin", "linux", "win32"]).optional(),
  arch: z.string().optional(),
}).strict();

export type ClientInfo = z.infer<typeof ClientInfoSchema>;

// Run info for ingestion
export const RunInfoSchema = z.object({
  run_id: z.string(),
  started_at: z.string().datetime(),
  finished_at: z.string().datetime().optional(),
}).strict();

export type RunInfo = z.infer<typeof RunInfoSchema>;

// Ingestion request (sent to both script and self-reported endpoints)
export const IngestRequestSchema = z.object({
  client: ClientInfoSchema,
  run: RunInfoSchema,
  sessions: z.array(SessionDataSchema).max(200, "Maximum 200 sessions per request"),
}).strict();

export type IngestRequest = z.infer<typeof IngestRequestSchema>;

// Rejection detail
export const RejectionDetailSchema = z.object({
  session_id: z.string(),
  reason: z.string(),
  severity: z.enum(["info", "warn", "critical"]).optional(),
}).strict();

export type RejectionDetail = z.infer<typeof RejectionDetailSchema>;

// Ingestion response
export const IngestResponseSchema = z.object({
  ingestion_run_id: z.string().uuid(),
  accepted: z.number().int(),
  deduped: z.number().int(),
  rejected: z.number().int(),
  rejected_details: z.array(RejectionDetailSchema).optional(),
}).strict();

export type IngestResponse = z.infer<typeof IngestResponseSchema>;

// Session response (from database)
export const SessionResponseSchema = z.object({
  id: z.string().uuid(),
  profile_id: z.string().uuid(),
  source: z.enum(["claude", "codex", "opencode"]),
  model: z.string().nullable(),
  session_id: z.string(),
  file_sha256: z.string(),
  file_size: z.number().int().nullable(),
  first_event_at: z.string().datetime(),
  last_event_at: z.string().datetime(),
  input_tokens: z.bigint(),
  output_tokens: z.bigint(),
  cache_read_tokens: z.bigint(),
  cache_create_tokens: z.bigint(),
  cached_tokens: z.bigint(),
  reasoning_tokens: z.bigint(),
  total_tokens: z.bigint(),
  turns: z.number().int(),
  platform: z.string().nullable(),
  ingestion_mode: z.enum(["script_verified", "self_reported"]),
  ingested_at: z.string().datetime(),
  ingestion_run_id: z.string().uuid().nullable(),
  // Fingerprints are fraud-engine JSON snapshots with versioned, extensible keys.
  fingerprint: z.record(z.unknown()).nullable(),
  updated_at: z.string().datetime(),
}).strict();

export type SessionResponse = z.infer<typeof SessionResponseSchema>;
