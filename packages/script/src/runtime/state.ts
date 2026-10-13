import type { IngestRequest, IngestionSource } from '@tokensrank/shared';

export const DEDUP_STATE_CAP = 50_000;
export const DEDUP_EVICTION_BATCH = 1_000;
export const OFFLINE_QUEUE_CAP = 24;
export const OFFLINE_QUEUE_MAX_RETRIES = 3;
export const LAST_RUN_MIN_INTERVAL_MS = 30 * 60 * 1_000;

export interface ShippedSessionId {
  session_id: string;
  source: IngestionSource;
  file_sha256: string;
  shipped_at: string;
}

export interface PendingPayload {
  payload: IngestRequest;
  attempted_at: string;
  retry_count: number;
}

/**
 * Runtime state persisted at `~/.tokensrank/state.json`.
 *
 * SL-14 owns the state file lifecycle: it is created on first install/run, never
 * deleted during normal operation, and written atomically so restarts keep a
 * coherent snapshot.
 *
 * SL-15 stores shipped session identifiers for client-side deduplication. The
 * FIFO list is capped at 50k entries and older entries are trimmed in batches.
 *
 * SL-16 stores offline ingestion payloads. Failed network/server attempts are
 * queued FIFO, capped at 24 entries, retried before new extraction work, and
 * dropped after the retry budget is exhausted.
 *
 * SL-17 stores `last_run_at`, the persistent timer that enforces the 30-minute
 * minimum interval across process and machine restarts unless `--force` or
 * `--first-run` is supplied.
 */
export interface State {
  install_id?: string | null;
  access_key_invalid?: boolean;
  last_run_at: string | null;
  shipped_session_ids: ShippedSessionId[];
  pending_payloads: PendingPayload[];
}

export function createEmptyState(): State {
  return {
    install_id: null,
    access_key_invalid: false,
    last_run_at: null,
    shipped_session_ids: [],
    pending_payloads: [],
  };
}
