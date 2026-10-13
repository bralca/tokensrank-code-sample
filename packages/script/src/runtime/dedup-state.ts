import type { IngestionSource, SessionPayload } from '@tokensrank/shared';

import {
  DEDUP_EVICTION_BATCH,
  DEDUP_STATE_CAP,
  type ShippedSessionId,
  type State,
} from './state.js';

type Logger = Pick<Console, 'warn'>;

let dedupSet = new Set<string>();
let dedupArray: ShippedSessionId[] = [];

export function initializeDedupState(state: Pick<State, 'shipped_session_ids'>): void {
  dedupArray = normalizeEntries(state.shipped_session_ids);
  dedupSet = new Set(dedupArray.map(makeDedupKey));
  evictOldestIfNeeded();
}

export function checkDedupState(
  source: IngestionSource,
  sessionId: string,
  fileSha256: string,
): boolean {
  return dedupSet.has(makeDedupKey({ source, session_id: sessionId, file_sha256: fileSha256 }));
}

export function addToDedupState(
  sessions: SessionPayload | SessionPayload[] | ShippedSessionId | ShippedSessionId[],
  shippedAt = new Date().toISOString(),
  logger: Logger = console,
): void {
  const entries = (Array.isArray(sessions) ? sessions : [sessions]).map((session) => toShippedSessionId(session, shippedAt));

  for (const entry of entries) {
    if (dedupSet.has(makeDedupKey(entry))) {
      continue;
    }

    evictOldestIfNeeded(logger);
    dedupArray.push(entry);
    dedupSet.add(makeDedupKey(entry));
  }
}

export function evictOldestIfNeeded(logger: Logger = console): number {
  let evicted = 0;

  while (dedupArray.length >= DEDUP_STATE_CAP) {
    const evictCount = Math.min(DEDUP_EVICTION_BATCH, dedupArray.length);
    const removed = dedupArray.splice(0, evictCount);
    for (const entry of removed) {
      dedupSet.delete(makeDedupKey(entry));
    }
    evicted += removed.length;
    logger.warn(`[tokensrank-script] Dedup state at capacity (${DEDUP_STATE_CAP}); evicted oldest ${removed.length}`);
  }

  return evicted;
}

export function getDedupState(): ShippedSessionId[] {
  return dedupArray.map((entry) => ({ ...entry }));
}

function normalizeEntries(entries: ShippedSessionId[]): ShippedSessionId[] {
  const seen = new Set<string>();
  const normalized: ShippedSessionId[] = [];

  for (const entry of entries) {
    const key = makeDedupKey(entry);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push({ ...entry });
  }

  return normalized;
}

function toShippedSessionId(session: SessionPayload | ShippedSessionId, shippedAt: string): ShippedSessionId {
  if ('shipped_at' in session) {
    return { ...session };
  }

  return {
    session_id: session.session_id,
    source: session.source,
    file_sha256: session.file_sha256,
    shipped_at: shippedAt,
  };
}

function makeDedupKey(entry: Pick<ShippedSessionId, 'source' | 'session_id' | 'file_sha256'>): string {
  return `${entry.source}\u0000${entry.session_id}\u0000${entry.file_sha256}`;
}
