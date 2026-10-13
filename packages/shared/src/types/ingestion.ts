import type { z } from 'zod';

import type {
  ClientInfoSchema,
  ClientPlatformSchema,
  IngestRequestSchema,
  IngestResponseSchema,
  IngestionRejectionReasonSchema,
  IngestionSourceSchema,
  RejectionDetailSchema,
  RunInfoSchema,
  SessionPayloadSchema,
} from '../schemas/ingestion.js';

export type IngestionSource = z.infer<typeof IngestionSourceSchema>;
export type ClientPlatform = z.infer<typeof ClientPlatformSchema>;
export type ClientInfo = z.infer<typeof ClientInfoSchema>;
export type RunInfo = z.infer<typeof RunInfoSchema>;
export type SessionPayload = z.infer<typeof SessionPayloadSchema>;
export type IngestRequest = z.infer<typeof IngestRequestSchema>;
export type IngestionRejectionReason = z.infer<typeof IngestionRejectionReasonSchema>;
export type RejectionDetail = z.infer<typeof RejectionDetailSchema>;
export type IngestResponse = z.infer<typeof IngestResponseSchema>;
