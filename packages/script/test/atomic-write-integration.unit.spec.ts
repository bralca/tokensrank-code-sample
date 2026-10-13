import { describe, expect, it } from 'vitest';

import { IngestRequestSchema } from '@tokensrank/shared';

type ScriptState = {
  install_id: string;
  last_run_at: string | null;
  shipped_session_ids: Array<{
    session_id: string;
    source: 'claude' | 'codex';
    file_sha256: string;
    shipped_at: string;
  }>;
  pending_payloads: Array<{
    payload: unknown;
    attempted_at: string;
    retry_count: number;
  }>;
  access_key_invalid: boolean;
};

function validateStateShape(candidate: unknown): candidate is ScriptState {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return false;
  }

  const state = candidate as Partial<ScriptState>;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
  const shaPattern = /^[a-f0-9]{64}$/u;

  return typeof state.install_id === 'string'
    && uuidPattern.test(state.install_id)
    && (state.last_run_at === null || (typeof state.last_run_at === 'string' && isoPattern.test(state.last_run_at)))
    && Array.isArray(state.shipped_session_ids)
    && state.shipped_session_ids.length <= 50_000
    && state.shipped_session_ids.every((entry) => (
      typeof entry.session_id === 'string'
      && (entry.source === 'claude' || entry.source === 'codex')
      && shaPattern.test(entry.file_sha256)
      && isoPattern.test(entry.shipped_at)
    ))
    && Array.isArray(state.pending_payloads)
    && state.pending_payloads.length <= 24
    && state.pending_payloads.every((entry) => (
      IngestRequestSchema.safeParse(entry.payload).success
      && isoPattern.test(entry.attempted_at)
      && Number.isInteger(entry.retry_count)
      && entry.retry_count >= 0
      && entry.retry_count <= 3
    ))
    && typeof state.access_key_invalid === 'boolean';
}

function makePayload() {
  return {
    client: {
      version: '0.0.1',
      install_id: '11111111-1111-4111-8111-111111111111',
      platform: 'darwin' as const,
      arch: 'arm64',
    },
    run: {
      run_id: 'run-1',
      started_at: '2026-04-28T01:00:00.000Z',
      finished_at: '2026-04-28T01:01:00.000Z',
    },
    sessions: [],
  };
}

describe('script state shape validation contract', () => {
  it('accepts the canonical empty state shape', () => {
    expect(validateStateShape({
      install_id: '11111111-1111-4111-8111-111111111111',
      last_run_at: null,
      shipped_session_ids: [],
      pending_payloads: [],
      access_key_invalid: false,
    })).toBe(true);
  });

  it('accepts shipped dedup entries and queued payloads within lifecycle caps', () => {
    expect(validateStateShape({
      install_id: '11111111-1111-4111-8111-111111111111',
      last_run_at: '2026-04-28T01:00:00.000Z',
      shipped_session_ids: [
        {
          session_id: 'session-1',
          source: 'claude',
          file_sha256: 'a'.repeat(64),
          shipped_at: '2026-04-28T01:00:00.000Z',
        },
      ],
      pending_payloads: [
        {
          payload: makePayload(),
          attempted_at: '2026-04-28T01:00:00.000Z',
          retry_count: 2,
        },
      ],
      access_key_invalid: false,
    })).toBe(true);
  });

  it('rejects invalid dedup entries and pending payload contracts', () => {
    expect(validateStateShape({
      install_id: '11111111-1111-4111-8111-111111111111',
      last_run_at: '2026-04-28T01:00:00.000Z',
      shipped_session_ids: [
        {
          session_id: 'session-1',
          source: 'unknown',
          file_sha256: 'not-a-sha',
          shipped_at: '2026-04-28T01:00:00.000Z',
        },
      ],
      pending_payloads: [
        {
          payload: { sessions: [] },
          attempted_at: '2026-04-28T01:00:00.000Z',
          retry_count: 4,
        },
      ],
      access_key_invalid: false,
    })).toBe(false);
  });
});
