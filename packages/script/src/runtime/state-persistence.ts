import { IngestRequestSchema } from '@tokensrank/shared';

import { AtomicReadError, readJsonAtomic, writeJsonAtomic } from './atomic-write.js';
import {
  DEDUP_STATE_CAP,
  OFFLINE_QUEUE_CAP,
  createEmptyState,
  type PendingPayload,
  type ShippedSessionId,
  type State,
} from './state.js';

type Logger = Pick<Console, 'warn'>;

export async function readState(stateFilePath: string, logger: Logger = console): Promise<State> {
  let raw: unknown;

  try {
    raw = await readJsonAtomic<unknown>(stateFilePath);
  } catch (error) {
    if (error instanceof AtomicReadError && (error.code === 'ENOENT' || error.code === 'JSON_PARSE')) {
      logger.warn(`[tokensrank-script] State file missing or unreadable; using empty state (${error.code})`);
      return createEmptyState();
    }

    throw error;
  }

  return normalizeState(raw, logger);
}

export async function writeState(stateFilePath: string, state: State): Promise<void> {
  await writeJsonAtomic(stateFilePath, normalizeState(state, console), {
    mode: 0o600,
    spaces: 2,
    tempPrefix: '.state',
  });
}

function normalizeState(raw: unknown, logger: Logger): State {
  if (!isRecord(raw)) {
    return createEmptyState();
  }

  const empty = createEmptyState();
  const shippedSessionIds = Array.isArray(raw.shipped_session_ids)
    ? raw.shipped_session_ids.filter(isShippedSessionId)
    : [];
  const pendingPayloads = Array.isArray(raw.pending_payloads)
    ? raw.pending_payloads.filter(isPendingPayload)
    : [];

  if (shippedSessionIds.length > DEDUP_STATE_CAP) {
    logger.warn(`[tokensrank-script] State dedup list exceeded ${DEDUP_STATE_CAP}; trimming oldest entries`);
  }

  if (pendingPayloads.length > OFFLINE_QUEUE_CAP) {
    logger.warn(`[tokensrank-script] Offline queue exceeded ${OFFLINE_QUEUE_CAP}; trimming oldest entries`);
  }

  return {
    install_id: typeof raw.install_id === 'string' || raw.install_id === null ? raw.install_id : empty.install_id,
    access_key_invalid: typeof raw.access_key_invalid === 'boolean'
      ? raw.access_key_invalid
      : empty.access_key_invalid,
    last_run_at: typeof raw.last_run_at === 'string' || raw.last_run_at === null ? raw.last_run_at : null,
    shipped_session_ids: shippedSessionIds.slice(-DEDUP_STATE_CAP),
    pending_payloads: pendingPayloads.slice(-OFFLINE_QUEUE_CAP),
  };
}

function isShippedSessionId(value: unknown): value is ShippedSessionId {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.session_id === 'string'
    && (value.source === 'claude' || value.source === 'codex')
    && typeof value.file_sha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(value.file_sha256)
    && typeof value.shipped_at === 'string';
}

function isPendingPayload(value: unknown): value is PendingPayload {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.attempted_at === 'string'
    && typeof value.retry_count === 'number'
    && Number.isInteger(value.retry_count)
    && value.retry_count >= 0
    && IngestRequestSchema.safeParse(value.payload).success;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
