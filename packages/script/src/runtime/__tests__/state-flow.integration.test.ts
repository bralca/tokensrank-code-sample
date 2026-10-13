import { mkdtemp, rm } from 'node:fs/promises';
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
import { DEDUP_STATE_CAP, createEmptyState, type State } from '../state.js';

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

describe('runtime state flow integration', () => {
  it('scenario 1: first run initializes empty state and persists last_run_at', async () => {
    const statePath = await stateFile();
    const state = await readState(statePath, logger);

    checkLastRunGuard(state, false, true, { logger });
    initializeDedupState(state);
    initializeOfflineQueue(state);
    state.last_run_at = '2026-04-28T10:00:00.000Z';
    state.shipped_session_ids = getDedupState();
    state.pending_payloads = getOfflineQueue();
    await writeState(statePath, state);

    await expect(readState(statePath, logger)).resolves.toEqual({
      install_id: null,
      access_key_invalid: false,
      last_run_at: '2026-04-28T10:00:00.000Z',
      shipped_session_ids: [],
      pending_payloads: [],
    });
  });

  it('scenario 2: guard blocks a second run inside 30 minutes before mutating state', async () => {
    const statePath = await stateFile();
    const state = createEmptyState();
    state.last_run_at = '2026-04-28T10:00:00.000Z';
    await writeState(statePath, state);
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });

    const persisted = await readState(statePath, logger);

    expect(() => checkLastRunGuard(persisted, false, false, {
      nowMs: Date.parse('2026-04-28T10:05:00.000Z'),
      logger,
      exit,
    })).toThrow('exit:0');
    await expect(readState(statePath, logger)).resolves.toEqual(state);
  });

  it('scenario 3: guard passes and dedup filters already-shipped sessions before persistence', async () => {
    const statePath = await stateFile();
    const state = createEmptyState();
    state.last_run_at = '2026-04-28T09:00:00.000Z';
    state.shipped_session_ids = [shippedEntry(1)];
    await writeState(statePath, state);

    const persisted = await readState(statePath, logger);
    checkLastRunGuard(persisted, false, false, {
      nowMs: Date.parse('2026-04-28T10:00:00.000Z'),
      logger,
    });
    initializeDedupState(persisted);
    const extracted = [session(1), session(2)];
    const toShip = extracted.filter((candidate) =>
      !checkDedupState(candidate.source, candidate.session_id, candidate.file_sha256));

    addToDedupState(toShip, '2026-04-28T10:00:01.000Z', logger);
    persisted.last_run_at = '2026-04-28T10:00:00.000Z';
    persisted.shipped_session_ids = getDedupState();
    await writeState(statePath, persisted);

    const stored = await readState(statePath, logger);
    expect(toShip.map((candidate) => candidate.session_id)).toEqual(['session-2']);
    expect(stored.shipped_session_ids.map((entry) => entry.session_id)).toEqual(['session-1', 'session-2']);
  });

  it('scenario 4: offline queue survives a failed drain and is removed after a later success', async () => {
    const statePath = await stateFile();
    const state = createEmptyState();
    state.pending_payloads = [{
      payload: payload(1),
      attempted_at: '2026-04-28T10:00:00.000Z',
      retry_count: 0,
    }];
    await writeState(statePath, state);

    const first = await readState(statePath, logger);
    initializeOfflineQueue(first);
    const failedFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    await drainOfflineQueue('https://api.example.test', 'tr_script_key', {
      fetch: failedFetch,
      now: () => '2026-04-28T10:01:00.000Z',
      logger,
    });
    first.pending_payloads = getOfflineQueue();
    await writeState(statePath, first);

    const queued = await readState(statePath, logger);
    expect(queued.pending_payloads).toHaveLength(1);
    expect(queued.pending_payloads[0]?.retry_count).toBe(1);

    initializeDedupState(queued);
    initializeOfflineQueue(queued);
    const successFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    await drainOfflineQueue('https://api.example.test', 'tr_script_key', {
      fetch: successFetch,
      now: () => '2026-04-28T10:31:00.000Z',
      logger,
    });
    queued.shipped_session_ids = getDedupState();
    queued.pending_payloads = getOfflineQueue();
    await writeState(statePath, queued);

    const drained = await readState(statePath, logger);
    expect(drained.pending_payloads).toEqual([]);
    expect(drained.shipped_session_ids.map((entry) => entry.session_id)).toEqual(['session-1']);
  });

  it('scenario 5: 50k dedup cap eviction persists FIFO state after atomic write', async () => {
    const statePath = await stateFile();
    const state = createEmptyState();
    state.shipped_session_ids = Array.from({ length: DEDUP_STATE_CAP }, (_, index) => shippedEntry(index));
    await writeState(statePath, state);

    const persisted = await readState(statePath, logger);
    initializeDedupState(persisted);
    addToDedupState(session(DEDUP_STATE_CAP), '2026-04-28T12:00:00.000Z', logger);
    persisted.shipped_session_ids = getDedupState();
    await writeState(statePath, persisted);

    const stored = await readState(statePath, logger);
    expect(stored.shipped_session_ids).toHaveLength(DEDUP_STATE_CAP - 1_000 + 1);
    expect(stored.shipped_session_ids[0]?.session_id).toBe('session-1000');
    expect(stored.shipped_session_ids.at(-1)?.session_id).toBe(`session-${DEDUP_STATE_CAP}`);
  });
});

async function stateFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tokensrank-state-flow-'));
  tempRoots.push(root);
  return join(root, 'state.json');
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

function shippedEntry(index: number): State['shipped_session_ids'][number] {
  return {
    session_id: `session-${index}`,
    source: 'claude',
    file_sha256: hash(index),
    shipped_at: '2026-04-28T10:00:00.000Z',
  };
}

function hash(index: number): string {
  return index.toString(16).padStart(64, '0').slice(-64);
}
