import { describe, expect, it } from 'vitest';

import { INGEST_SESSIONS_MAX, IngestRequestSchema } from '@tokensrank/shared';

const validSession = {
  session_id: 'session-0',
  model: 'claude-3-5-sonnet-20241022',
  source: 'claude',
  first_event_at: '2026-04-27T10:00:00.000Z',
  last_event_at: '2026-04-27T10:05:00.000Z',
  input_tokens: 12000,
  output_tokens: 3200,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cached_input_tokens: 0,
  reasoning_output_tokens: 0,
  turns: 2,
  file_sha256: 'a'.repeat(64),
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
    started_at: '2026-04-27T10:00:00.000Z',
    finished_at: '2026-04-27T10:05:00.000Z',
  },
  sessions: [validSession],
} as const;

function buildRequestWithSessionCount(count: number) {
  return {
    ...validRequest,
    sessions: Array.from({ length: count }, (_, index) => ({
      ...validSession,
      session_id: `session-${index}`,
    })),
  };
}

describe('IngestRequestSchema batch size validation', () => {
  it('documents the FR-30 maximum batch size', () => {
    expect(INGEST_SESSIONS_MAX).toBe(100);
  });

  it('accepts a batch of exactly 100 sessions', () => {
    const result = IngestRequestSchema.safeParse(buildRequestWithSessionCount(100));

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.sessions).toHaveLength(100);
    }
  });

  it.each([101, 200, 201])('rejects a batch of %i sessions', (count) => {
    const result = IngestRequestSchema.safeParse(buildRequestWithSessionCount(count));

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['sessions'],
            message: 'Batch size exceeds 100 sessions',
          }),
        ]),
      );
    }
  });
});
