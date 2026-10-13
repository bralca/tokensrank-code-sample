import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readJsonAtomic, writeJsonAtomic } from '../src/runtime/atomic-write.js';
import {
  acquireLock,
  acquireLockWithStaleRecovery,
  releaseLock,
  type LockHandle,
} from '../src/runtime/file-lock.js';

type DedupEntry = {
  session_id: string;
  source: 'claude' | 'codex';
  file_sha256: string;
  shipped_at: string;
};

type PendingPayload = {
  payload: {
    sessions: unknown[];
  };
  attempted_at: string;
  retry_count: number;
};

type ScriptState = {
  install_id: string;
  last_run_at: string | null;
  shipped_session_ids: DedupEntry[];
  pending_payloads: PendingPayload[];
  access_key_invalid: boolean;
};

const tempRoots: string[] = [];
const activeLocks: LockHandle[] = [];

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tokensrank-combined-'));
  tempRoots.push(root);
  return root;
}

function emptyState(): ScriptState {
  return {
    install_id: '11111111-1111-4111-8111-111111111111',
    last_run_at: null,
    shipped_session_ids: [],
    pending_payloads: [],
    access_key_invalid: false,
  };
}

async function loadState(statePath: string): Promise<ScriptState> {
  return readJsonAtomic<ScriptState>(statePath, { defaultValue: emptyState() });
}

function appendDedup(state: ScriptState, entries: DedupEntry[]): ScriptState {
  const next = [...state.shipped_session_ids, ...entries];
  const capped = next.length > 50_000 ? next.slice(next.length - 49_000) : next;
  return { ...state, shipped_session_ids: capped };
}

function enqueuePending(state: ScriptState, payload: PendingPayload): ScriptState {
  const next = [...state.pending_payloads, payload];
  return { ...state, pending_payloads: next.slice(-24) };
}

function shouldSkipForGuard(state: ScriptState, now: Date, force = false, firstRun = false): boolean {
  if (force || firstRun || state.last_run_at === null) {
    return false;
  }

  return now.getTime() - Date.parse(state.last_run_at) < 30 * 60 * 1_000;
}

function isContractSatisfied(state: ScriptState): boolean {
  return typeof state.install_id === 'string'
    && (state.last_run_at === null || !Number.isNaN(Date.parse(state.last_run_at)))
    && state.shipped_session_ids.length <= 50_000
    && state.pending_payloads.length <= 24
    && state.pending_payloads.every((entry) => entry.retry_count <= 3)
    && typeof state.access_key_invalid === 'boolean';
}

afterEach(async () => {
  while (activeLocks.length > 0) {
    const handle = activeLocks.pop();
    if (handle) {
      await releaseLock(handle);
    }
  }

  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('file lock and atomic write integration', () => {
  it('runs lock -> read state -> modify -> write state -> release sequence', async () => {
    const root = await createTempRoot();
    const lockPath = join(root, '.lock');
    const statePath = join(root, 'state.json');
    const lock = await acquireLock(lockPath);
    activeLocks.push(lock);

    const state = await loadState(statePath);
    const next = {
      ...state,
      last_run_at: '2026-04-28T01:00:00.000Z',
    };
    await writeJsonAtomic(statePath, next);
    await releaseLock(lock);
    activeLocks.pop();

    await expect(loadState(statePath)).resolves.toEqual(next);
    const reacquired = await acquireLock(lockPath);
    activeLocks.push(reacquired);
    expect(reacquired.released).toBe(false);
  });

  it('recovers from stale lock metadata before state mutation', async () => {
    const root = await createTempRoot();
    const lockPath = join(root, '.lock');
    const staleOwner = await acquireLock(lockPath);
    activeLocks.push(staleOwner);
    const old = new Date(Date.now() - (5 * 60 * 60 * 1_000));
    await writeFile(lockPath, `${JSON.stringify({ pid: 9_999_999 })}\n`, { mode: 0o600 });
    await utimes(lockPath, old, old);

    const recovered = await acquireLockWithStaleRecovery(lockPath, {
      logger: { warn: vi.fn() },
    });
    activeLocks.push(recovered);

    expect(recovered).not.toBe(staleOwner);
  });

  it('enforces guard timer state without losing the last run timestamp', async () => {
    const state: ScriptState = {
      ...emptyState(),
      last_run_at: '2026-04-28T01:00:00.000Z',
    };

    expect(shouldSkipForGuard(state, new Date('2026-04-28T01:29:59.000Z'))).toBe(true);
    expect(shouldSkipForGuard(state, new Date('2026-04-28T01:29:59.000Z'), true)).toBe(false);
    expect(shouldSkipForGuard(state, new Date('2026-04-28T01:30:00.000Z'))).toBe(false);
  });

  it('persists dedup list updates and applies the SL-15 FIFO cap', async () => {
    const root = await createTempRoot();
    const statePath = join(root, 'state.json');
    const state = {
      ...emptyState(),
      shipped_session_ids: Array.from({ length: 50_000 }, (_, index) => ({
        session_id: `old-${index}`,
        source: 'claude' as const,
        file_sha256: 'a'.repeat(64),
        shipped_at: '2026-04-28T01:00:00.000Z',
      })),
    };

    const next = appendDedup(state, [{
      session_id: 'new-session',
      source: 'codex',
      file_sha256: 'b'.repeat(64),
      shipped_at: '2026-04-28T01:10:00.000Z',
    }]);
    await writeJsonAtomic(statePath, next);
    const stored = await loadState(statePath);

    expect(stored.shipped_session_ids).toHaveLength(49_000);
    expect(stored.shipped_session_ids.at(-1)?.session_id).toBe('new-session');
  });

  it('persists pending payload queue updates and applies the SL-16 cap', async () => {
    const root = await createTempRoot();
    const statePath = join(root, 'state.json');
    let state = emptyState();

    for (let index = 0; index < 30; index += 1) {
      state = enqueuePending(state, {
        payload: { sessions: [{ id: index }] },
        attempted_at: '2026-04-28T01:00:00.000Z',
        retry_count: index % 4,
      });
    }

    await writeJsonAtomic(statePath, state);
    const stored = await loadState(statePath);

    expect(stored.pending_payloads).toHaveLength(24);
    expect(stored.pending_payloads[0]?.payload).toEqual({ sessions: [{ id: 6 }] });
  });

  it('satisfies SL-13 through SL-17 contracts after a full lifecycle write', async () => {
    const root = await createTempRoot();
    const lockPath = join(root, '.lock');
    const statePath = join(root, 'state.json');
    const lock = await acquireLock(lockPath);
    activeLocks.push(lock);

    const next = enqueuePending(appendDedup({
      ...emptyState(),
      last_run_at: '2026-04-28T01:00:00.000Z',
    }, [{
      session_id: 'session-1',
      source: 'claude',
      file_sha256: 'c'.repeat(64),
      shipped_at: '2026-04-28T01:00:00.000Z',
    }]), {
      payload: { sessions: [] },
      attempted_at: '2026-04-28T01:00:00.000Z',
      retry_count: 0,
    });

    await writeJsonAtomic(statePath, next);
    await releaseLock(lock);
    activeLocks.pop();

    const stored = await loadState(statePath);
    expect(isContractSatisfied(stored)).toBe(true);
    expect(shouldSkipForGuard(stored, new Date('2026-04-28T01:05:00.000Z'))).toBe(true);
  });
});
