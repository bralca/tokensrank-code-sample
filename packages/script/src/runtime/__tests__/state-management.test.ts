import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IngestRequest, SessionPayload } from '@tokensrank/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addToDedupState,
  checkDedupState,
  getDedupState,
  initializeDedupState,
} from '../dedup-state.js';
import { checkLastRunGuard } from '../last-run-guard.js';
import {
  drainOfflineQueue,
  enqueuePayload,
  getOfflineQueue,
  initializeOfflineQueue,
} from '../offline-queue.js';
import { readState, writeState } from '../state-persistence.js';
import {
  DEDUP_STATE_CAP,
  OFFLINE_QUEUE_CAP,
  createEmptyState,
  type ShippedSessionId,
} from '../state.js';

const tempRoots: string[] = [];
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
};

afterEach(async () => {
  vi.restoreAllMocks();
  logger.info.mockReset();
  logger.warn.mockReset();
  initializeDedupState(createEmptyState());
  initializeOfflineQueue(createEmptyState());

  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('last-run guard', () => {
  it('exits 0 when last run is inside the 30 minute window', () => {
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    const state = createEmptyState();
    state.last_run_at = '2026-04-28T10:00:00.000Z';

    expect(() => checkLastRunGuard(state, false, false, {
      nowMs: Date.parse('2026-04-28T10:29:59.000Z'),
      logger,
      exit,
    })).toThrow('exit:0');
    expect(exit).toHaveBeenCalledWith(0);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Skipping run'));
  });

  it('passes when last run is at least 30 minutes old', () => {
    const state = createEmptyState();
    state.last_run_at = '2026-04-28T10:00:00.000Z';

    expect(() => checkLastRunGuard(state, false, false, {
      nowMs: Date.parse('2026-04-28T10:30:00.000Z'),
      logger,
    })).not.toThrow();
  });

  it('bypasses when force is set', () => {
    const state = createEmptyState();
    state.last_run_at = '2026-04-28T10:00:00.000Z';

    checkLastRunGuard(state, true, false, {
      nowMs: Date.parse('2026-04-28T10:01:00.000Z'),
      logger,
    });

    expect(logger.info).not.toHaveBeenCalled();
  });

  it('bypasses when first-run is set', () => {
    const state = createEmptyState();
    state.last_run_at = '2026-04-28T10:00:00.000Z';

    checkLastRunGuard(state, false, true, {
      nowMs: Date.parse('2026-04-28T10:01:00.000Z'),
      logger,
    });

    expect(logger.info).not.toHaveBeenCalled();
  });

  it('passes on null last_run_at', () => {
    expect(() => checkLastRunGuard(createEmptyState(), false, false, { logger })).not.toThrow();
  });

  it('passes on invalid last_run_at values from older/corrupt state', () => {
    const state = createEmptyState();
    state.last_run_at = 'not-a-date';

    expect(() => checkLastRunGuard(state, false, false, { logger })).not.toThrow();
  });
});

describe('dedup state', () => {
  it('checks existing entries with O(1) Set-backed lookup', () => {
    initializeDedupState({
      shipped_session_ids: [shippedEntry(1)],
    });

    expect(checkDedupState('claude', 'session-1', hash(1))).toBe(true);
    expect(checkDedupState('claude', 'session-2', hash(2))).toBe(false);
  });

  it('adds new entries to both lookup and persistent FIFO state', () => {
    initializeDedupState(createEmptyState());

    addToDedupState(session(1), '2026-04-28T11:00:00.000Z', logger);

    expect(checkDedupState('claude', 'session-1', hash(1))).toBe(true);
    expect(getDedupState()).toEqual([shippedEntry(1, '2026-04-28T11:00:00.000Z')]);
  });

  it('does not duplicate already shipped entries', () => {
    initializeDedupState(createEmptyState());

    addToDedupState([session(1), session(1)], '2026-04-28T11:00:00.000Z', logger);

    expect(getDedupState()).toHaveLength(1);
  });

  it('evicts the oldest 1000 entries when adding beyond the 50k cap', () => {
    initializeDedupState({
      shipped_session_ids: Array.from({ length: DEDUP_STATE_CAP }, (_, index) => shippedEntry(index)),
    });

    addToDedupState(session(DEDUP_STATE_CAP), '2026-04-28T11:00:00.000Z', logger);

    expect(getDedupState()).toHaveLength(DEDUP_STATE_CAP - 1_000 + 1);
    expect(checkDedupState('claude', 'session-0', hash(0))).toBe(false);
    expect(checkDedupState('claude', 'session-999', hash(999))).toBe(false);
    expect(checkDedupState('claude', 'session-1000', hash(1000))).toBe(true);
    expect(checkDedupState('claude', `session-${DEDUP_STATE_CAP}`, hash(DEDUP_STATE_CAP))).toBe(true);
  });

  it('deduplicates duplicate persisted entries during initialization', () => {
    initializeDedupState({
      shipped_session_ids: [shippedEntry(1), shippedEntry(1), shippedEntry(2)],
    });

    expect(getDedupState()).toHaveLength(2);
  });

  it('accepts already-shaped shipped entries without rewriting shipped_at', () => {
    initializeDedupState(createEmptyState());

    addToDedupState(shippedEntry(3, '2026-04-28T12:00:00.000Z'), '2026-04-28T13:00:00.000Z', logger);

    expect(getDedupState()).toEqual([shippedEntry(3, '2026-04-28T12:00:00.000Z')]);
  });
});

describe('offline queue', () => {
  it('enqueues payloads in FIFO order', () => {
    initializeOfflineQueue(createEmptyState());

    enqueuePayload(payload(1), '2026-04-28T11:00:00.000Z', 0, logger);
    enqueuePayload(payload(2), '2026-04-28T11:01:00.000Z', 0, logger);

    expect(getOfflineQueue().map((entry) => entry.payload.sessions[0]?.session_id)).toEqual([
      'session-1',
      'session-2',
    ]);
  });

  it('evicts the oldest payloads above the 24-entry cap', () => {
    initializeOfflineQueue(createEmptyState());

    for (let index = 0; index < OFFLINE_QUEUE_CAP + 1; index += 1) {
      enqueuePayload(payload(index), `2026-04-28T11:${String(index).padStart(2, '0')}:00.000Z`, 0, logger);
    }

    const queued = getOfflineQueue();
    expect(queued).toHaveLength(OFFLINE_QUEUE_CAP);
    expect(queued[0]?.payload.sessions[0]?.session_id).toBe('session-1');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Payload queue at capacity'));
  });

  it('drains successful payloads', async () => {
    initializeOfflineQueue({ pending_payloads: [{ payload: payload(1), attempted_at: '2026-04-28T11:00:00.000Z', retry_count: 0 }] });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));

    const result = await drainOfflineQueue('https://api.example.test', 'tr_script_key', { fetch: fetchMock, logger });

    expect(result).toEqual({ drained: 1, failed: 0, errors: [] });
    expect(getOfflineQueue()).toEqual([]);
  });

  it('keeps 5xx payloads until the third retry', async () => {
    initializeOfflineQueue({ pending_payloads: [{ payload: payload(1), attempted_at: '2026-04-28T11:00:00.000Z', retry_count: 1 }] });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));

    const result = await drainOfflineQueue('https://api.example.test', 'tr_script_key', {
      fetch: fetchMock,
      now: () => '2026-04-28T11:01:00.000Z',
      logger,
    });

    expect(result.drained).toBe(0);
    expect(result.failed).toBe(1);
    expect(getOfflineQueue()[0]).toMatchObject({
      attempted_at: '2026-04-28T11:01:00.000Z',
      retry_count: 2,
    });
  });

  it('drops 5xx payloads after the third retry', async () => {
    initializeOfflineQueue({ pending_payloads: [{ payload: payload(1), attempted_at: '2026-04-28T11:00:00.000Z', retry_count: 2 }] });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));

    const result = await drainOfflineQueue('https://api.example.test', 'tr_script_key', { fetch: fetchMock, logger });

    expect(result.drained).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.errors[0]).toContain('Dropped queued payload after 3 retries');
    expect(getOfflineQueue()).toEqual([]);
  });

  it('drops 401 payloads immediately without retry', async () => {
    initializeOfflineQueue({ pending_payloads: [{ payload: payload(1), attempted_at: '2026-04-28T11:00:00.000Z', retry_count: 0 }] });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));

    const result = await drainOfflineQueue('https://api.example.test', 'tr_script_key', { fetch: fetchMock, logger });

    expect(result.drained).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.errors[0]).toContain('401');
    expect(getOfflineQueue()).toEqual([]);
  });

  it('drops non-retryable 4xx payloads immediately', async () => {
    initializeOfflineQueue({ pending_payloads: [{ payload: payload(1), attempted_at: '2026-04-28T11:00:00.000Z', retry_count: 0 }] });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 400 }));

    const result = await drainOfflineQueue('https://api.example.test', 'tr_script_key', { fetch: fetchMock, logger });

    expect(result.drained).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.errors[0]).toContain('non-retryable HTTP 400');
    expect(getOfflineQueue()).toEqual([]);
  });

  it('treats network errors as retryable failures', async () => {
    initializeOfflineQueue({ pending_payloads: [{ payload: payload(1), attempted_at: '2026-04-28T11:00:00.000Z', retry_count: 0 }] });
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await drainOfflineQueue('https://api.example.test', 'tr_script_key', { fetch: fetchMock, logger });

    expect(result.failed).toBe(1);
    expect(getOfflineQueue()[0]?.retry_count).toBe(1);
  });
});

describe('state persistence', () => {
  it('returns empty state for missing files', async () => {
    const state = await readState(join(await tempRoot(), 'missing-state.json'), logger);

    expect(state).toEqual(createEmptyState());
  });

  it('returns empty state for corrupt JSON', async () => {
    const root = await tempRoot();
    const target = join(root, 'state.json');
    await writeFile(target, '{"broken"', { mode: 0o600 });

    const state = await readState(target, logger);

    expect(state).toEqual(createEmptyState());
  });

  it('writes state atomically and leaves no temp files after success', async () => {
    const root = await tempRoot();
    const target = join(root, 'state.json');
    const state = createEmptyState();
    state.shipped_session_ids = [shippedEntry(1)];

    await writeState(target, state);

    expect(await readState(target, logger)).toEqual(state);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect((await readdir(root)).filter((entry) => entry.startsWith('.state.'))).toEqual([]);
  });

  it('keeps old state readable when a temp file is left behind', async () => {
    const root = await tempRoot();
    const target = join(root, 'state.json');
    const state = createEmptyState();
    state.shipped_session_ids = [shippedEntry(1)];
    await writeState(target, state);
    await writeFile(join(root, '.state.state.json.crashed'), '{"last_run_at":"bad"', { mode: 0o600 });

    await expect(readState(target, logger)).resolves.toEqual(state);
  });

  it('trims oversized arrays on read', async () => {
    const root = await tempRoot();
    const target = join(root, 'state.json');
    await writeFile(target, JSON.stringify({
      last_run_at: null,
      shipped_session_ids: Array.from({ length: DEDUP_STATE_CAP + 5 }, (_, index) => shippedEntry(index)),
      pending_payloads: Array.from({ length: OFFLINE_QUEUE_CAP + 5 }, (_, index) => ({
        payload: payload(index),
        attempted_at: '2026-04-28T11:00:00.000Z',
        retry_count: 0,
      })),
    }), { mode: 0o600 });

    const state = await readState(target, logger);

    expect(state.shipped_session_ids).toHaveLength(DEDUP_STATE_CAP);
    expect(state.shipped_session_ids[0]?.session_id).toBe('session-5');
    expect(state.pending_payloads).toHaveLength(OFFLINE_QUEUE_CAP);
    expect(state.pending_payloads[0]?.payload.sessions[0]?.session_id).toBe('session-5');
  });

  it('returns empty state for non-object JSON', async () => {
    const root = await tempRoot();
    const target = join(root, 'state.json');
    await writeFile(target, '[]', { mode: 0o600 });

    await expect(readState(target, logger)).resolves.toEqual(createEmptyState());
  });

  it('throws non-corruption read failures', async () => {
    const root = await tempRoot();

    await expect(readState(root, logger)).rejects.toThrow();
  });

  it('defaults missing arrays to empty arrays', async () => {
    const root = await tempRoot();
    const target = join(root, 'state.json');
    await writeFile(target, JSON.stringify({
      install_id: '11111111-1111-4111-8111-111111111111',
      access_key_invalid: true,
      last_run_at: '2026-04-28T11:00:00.000Z',
    }), { mode: 0o600 });

    const state = await readState(target, logger);

    expect(state).toMatchObject({
      install_id: '11111111-1111-4111-8111-111111111111',
      access_key_invalid: true,
      last_run_at: '2026-04-28T11:00:00.000Z',
      shipped_session_ids: [],
      pending_payloads: [],
    });
  });

  it('filters invalid persisted entries', async () => {
    const root = await tempRoot();
    const target = join(root, 'state.json');
    await writeFile(target, JSON.stringify({
      last_run_at: null,
      shipped_session_ids: [null, shippedEntry(1)],
      pending_payloads: [
        null,
        {
          payload: payload(1),
          attempted_at: '2026-04-28T11:00:00.000Z',
          retry_count: 0,
        },
      ],
    }), { mode: 0o600 });

    const state = await readState(target, logger);

    expect(state.shipped_session_ids).toEqual([shippedEntry(1)]);
    expect(state.pending_payloads).toHaveLength(1);
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tokensrank-state-'));
  tempRoots.push(root);
  return root;
}

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
    sessions: [session(index)],
  };
}

function session(index: number): SessionPayload {
  return {
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
    file_sha256: hash(index),
  };
}

function shippedEntry(index: number, shippedAt = '2026-04-28T11:00:00.000Z'): ShippedSessionId {
  return {
    session_id: `session-${index}`,
    source: 'claude',
    file_sha256: hash(index),
    shipped_at: shippedAt,
  };
}

function hash(index: number): string {
  return index.toString(16).padStart(64, '0').slice(-64);
}
