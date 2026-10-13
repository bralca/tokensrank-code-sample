import { describe, expect, it } from 'vitest';

import {
  INGEST_SESSIONS_MAX,
  IngestRequestSchema,
  IngestResponseSchema,
  IngestionRejectionReasonSchema,
  RejectionDetailSchema,
  RunInfoSchema,
  SessionPayloadSchema,
} from '../src/schemas/ingestion.js';

const fileSha256 = 'a'.repeat(64);
const ingestionRunId = '550e8400-e29b-41d4-a716-446655440000';

const validSession = {
  session_id: 'session-xyz',
  model: 'claude-3-5-sonnet-20241022',
  source: 'claude',
  first_event_at: '2026-04-27T10:00:00.000Z',
  last_event_at: '2026-04-27T10:15:00.000Z',
  input_tokens: 12500,
  output_tokens: 3200,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cached_input_tokens: 0,
  reasoning_output_tokens: 0,
  turns: 1,
  file_sha256: fileSha256,
} as const;

const validRequest = {
  client: {
    version: '1.0.0',
    install_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    platform: 'darwin',
    arch: 'arm64',
  },
  run: {
    run_id: 'run-20260427-001',
    started_at: '2026-04-27T14:23:45.000Z',
    finished_at: '2026-04-27T14:23:48.000Z',
  },
  sessions: [validSession],
} as const;

const sessionFieldNames = [
  'session_id',
  'model',
  'source',
  'first_event_at',
  'last_event_at',
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'cached_input_tokens',
  'reasoning_output_tokens',
  'turns',
  'file_sha256',
];

describe('SessionPayloadSchema', () => {
  it('accepts the Blueprint ingestion session field names exactly', () => {
    expect(Object.keys(validSession)).toEqual(sessionFieldNames);
    expect(SessionPayloadSchema.parse(validSession)).toEqual(validSession);
  });

  it('rejects extra fields, generated totals, invalid source, and invalid SHA-256 values', () => {
    expect(() => SessionPayloadSchema.parse({ ...validSession, total_tokens: 15700 })).toThrow();
    expect(() => SessionPayloadSchema.parse({ ...validSession, ingestion_mode: 'script_verified' })).toThrow();
    expect(() => SessionPayloadSchema.parse({ ...validSession, source: 'claude_code' })).toThrow();
    expect(() => SessionPayloadSchema.parse({ ...validSession, file_sha256: 'abc123' })).toThrow();
  });

  it('enforces nonnegative integer token and turn fields', () => {
    expect(() => SessionPayloadSchema.parse({ ...validSession, input_tokens: -1 })).toThrow();
    expect(() => SessionPayloadSchema.parse({ ...validSession, output_tokens: 1.5 })).toThrow();
    expect(() => SessionPayloadSchema.parse({ ...validSession, turns: -1 })).toThrow();
    expect(() => SessionPayloadSchema.parse({ ...validSession, turns: 1.5 })).toThrow();
  });

  it('validates datetime strings and requires first_event_at <= last_event_at', () => {
    expect(() => SessionPayloadSchema.parse({ ...validSession, first_event_at: 'not-a-date' })).toThrow();
    expect(() => SessionPayloadSchema.parse({
      ...validSession,
      first_event_at: '2026-04-27T10:16:00.000Z',
      last_event_at: '2026-04-27T10:15:00.000Z',
    })).toThrow();
  });
});

describe('ClientInfoSchema and RunInfoSchema through IngestRequestSchema', () => {
  it('accepts optional client and run fields when omitted', () => {
    expect(IngestRequestSchema.parse({
      client: {
        version: '1.0.0',
      },
      run: {
        run_id: 'run-20260427-001',
        started_at: '2026-04-27T14:23:45.000Z',
      },
      sessions: [validSession],
    }).sessions).toHaveLength(1);
  });

  it('rejects extra fields in client and run objects', () => {
    expect(() => IngestRequestSchema.parse({
      ...validRequest,
      client: { ...validRequest.client, hostname: 'builder-machine' },
    })).toThrow();

    expect(() => IngestRequestSchema.parse({
      ...validRequest,
      run: { ...validRequest.run, project_name: 'private-repo' },
    })).toThrow();
  });

  it('requires run started_at <= finished_at when finished_at is provided', () => {
    expect(() => RunInfoSchema.parse({
      run_id: 'run-20260427-001',
      started_at: '2026-04-27T14:23:48.000Z',
      finished_at: '2026-04-27T14:23:45.000Z',
    })).toThrow();
  });
});

describe('IngestRequestSchema', () => {
  it('accepts batches of exactly 100 sessions and rejects 101 sessions', () => {
    expect(INGEST_SESSIONS_MAX).toBe(100);

    expect(IngestRequestSchema.parse({
      ...validRequest,
      sessions: Array.from({ length: 100 }, (_, index) => ({
        ...validSession,
        session_id: `session-${index}`,
      })),
    }).sessions).toHaveLength(100);

    expect(() => IngestRequestSchema.parse({
      ...validRequest,
      sessions: Array.from({ length: 101 }, (_, index) => ({
        ...validSession,
        session_id: `session-${index}`,
      })),
    })).toThrow();
  });

  it('rejects extra root fields', () => {
    expect(() => IngestRequestSchema.parse({
      ...validRequest,
      debug: true,
    })).toThrow();
  });
});

describe('ingestion response schemas', () => {
  it('accepts zero or more rejection details with allowed reason codes', () => {
    expect(IngestResponseSchema.parse({
      ingestion_run_id: ingestionRunId,
      accepted_count: 12,
      deduped_count: 3,
      rejected_count: 0,
      rejected_details: [],
    }).rejected_details).toEqual([]);

    for (const reason of IngestionRejectionReasonSchema.options) {
      expect(RejectionDetailSchema.parse({
        session_id: `session-${reason}`,
        reason_code: reason,
        details: { reason },
      }).reason_code).toBe(reason);
    }
  });

  it('rejects unknown rejection codes and mismatched rejection counts', () => {
    expect(() => RejectionDetailSchema.parse({
      session_id: 'session-bad',
      reason_code: 'unknown_reason',
    })).toThrow();

    expect(() => IngestResponseSchema.parse({
      ingestion_run_id: ingestionRunId,
      accepted_count: 12,
      deduped_count: 3,
      rejected_count: 2,
      rejected_details: [
        { session_id: 'session-bad', reason_code: 'future_timestamp' },
      ],
    })).toThrow();
  });
});
