import type { IngestRequest } from '@tokensrank/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  PENDING_PAYLOAD_CAP,
  appendPendingPayload,
  drainPendingPayloads,
  type OfflineQueueState,
} from '../../../../packages/script/src/state';

describe('offline queue integration contract', () => {
  it('drains queued payloads on 202 and preserves POST body', async () => {
    const state: OfflineQueueState = {
      pending_payloads: [{ payload: payload(1), attempted_at: '2026-04-28T10:00:00.000Z', retry_count: 0 }],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));

    const result = await drainPendingPayloads(state, {
      apiBase: 'https://api.tokensrank.test',
      accessKey: 'tr_script_key',
      fetch: fetchMock,
    });

    expect(result).toEqual({ drained: 1, failed: 0, unauthorized: false });
    expect(state.pending_payloads).toEqual([]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify(payload(1)),
    });
  });

  it('retries 5xx responses three times before dropping', async () => {
    const state: OfflineQueueState = {
      pending_payloads: [{ payload: payload(1), attempted_at: '2026-04-28T10:00:00.000Z', retry_count: 0 }],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 502 }));

    const result = await drainPendingPayloads(state, {
      apiBase: 'https://api.tokensrank.test',
      accessKey: 'tr_script_key',
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ drained: 1, failed: 0, unauthorized: false });
    expect(state.pending_payloads).toEqual([]);
  });

  it('evicts FIFO at the 24-payload cap', () => {
    const state: OfflineQueueState = { pending_payloads: [] };
    const logger = { warn: vi.fn() };

    for (let index = 0; index < PENDING_PAYLOAD_CAP + 1; index += 1) {
      appendPendingPayload(state, payload(index), { logger });
    }

    expect(state.pending_payloads).toHaveLength(PENDING_PAYLOAD_CAP);
    expect(state.pending_payloads[0]?.payload.sessions[0]?.session_id).toBe('session-1');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Queue overflow'));
  });

  it('stops on 401 and leaves remaining payloads queued', async () => {
    const state: OfflineQueueState = {
      pending_payloads: [
        { payload: payload(1), attempted_at: '2026-04-28T10:00:00.000Z', retry_count: 0 },
        { payload: payload(2), attempted_at: '2026-04-28T10:01:00.000Z', retry_count: 0 },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));

    const result = await drainPendingPayloads(state, {
      apiBase: 'https://api.tokensrank.test',
      accessKey: 'tr_script_key',
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ drained: 0, failed: 0, unauthorized: true });
    expect(state.access_key_invalid).toBe(true);
    expect(state.pending_payloads.map((entry) => entry.payload.sessions[0]?.session_id)).toEqual([
      'session-1',
      'session-2',
    ]);
  });
});

function payload(index: number): IngestRequest {
  return {
    client: {
      version: '0.0.1',
      install_id: '11111111-1111-4111-8111-111111111111',
      platform: 'darwin',
      arch: 'arm64',
    },
    run: {
      run_id: `run-${index}`,
      started_at: '2026-04-28T10:00:00.000Z',
      finished_at: '2026-04-28T10:01:00.000Z',
    },
    sessions: [{
      session_id: `session-${index}`,
      source: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      first_event_at: '2026-04-28T10:00:00.000Z',
      last_event_at: '2026-04-28T10:01:00.000Z',
      input_tokens: index + 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0,
      turns: 1,
      file_sha256: index.toString(16).padStart(64, '0').slice(-64),
    }],
  };
}
