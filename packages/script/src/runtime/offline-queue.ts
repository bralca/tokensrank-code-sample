import {
  OFFLINE_QUEUE_CAP,
  OFFLINE_QUEUE_MAX_RETRIES,
  type PendingPayload,
  type State,
} from './state.js';
import { addToDedupState } from './dedup-state.js';

type Logger = Pick<Console, 'warn'>;
type FetchLike = typeof fetch;

export interface DrainOfflineQueueOptions {
  now?: () => string;
  fetch?: FetchLike;
  logger?: Logger;
}

export interface DrainOfflineQueueResult {
  drained: number;
  failed: number;
  errors: string[];
}

let queue: PendingPayload[] = [];

export function initializeOfflineQueue(state: Pick<State, 'pending_payloads'>, logger: Logger = console): void {
  queue = state.pending_payloads.map((entry) => ({
    payload: entry.payload,
    attempted_at: entry.attempted_at,
    retry_count: normalizeRetryCount(entry.retry_count),
  }));
  enforceCapacity(logger);
}

export function enqueuePayload(
  payload: PendingPayload['payload'],
  attemptedAt = new Date().toISOString(),
  retryCount = 0,
  logger: Logger = console,
): void {
  queue.push({
    payload,
    attempted_at: attemptedAt,
    retry_count: normalizeRetryCount(retryCount),
  });
  enforceCapacity(logger);
}

export async function drainOfflineQueue(
  apiBase: string,
  key: string,
  options: DrainOfflineQueueOptions = {},
): Promise<DrainOfflineQueueResult> {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date().toISOString());
  const logger = options.logger ?? console;
  const remaining: PendingPayload[] = [];
  const result: DrainOfflineQueueResult = {
    drained: 0,
    failed: 0,
    errors: [],
  };

  for (const pending of queue) {
    const attemptedAt = now();

    try {
      const response = await postPayload(fetchImpl, apiBase, key, pending.payload);

      if (response.ok) {
        addToDedupState(pending.payload.sessions, attemptedAt, logger);
        result.drained += 1;
        continue;
      }

      if (response.status === 401) {
        result.drained += 1;
        result.errors.push('Dropped queued payload after 401 Unauthorized');
        logger.warn('[tokensrank-script] Dropping queued payload after 401 Unauthorized');
        continue;
      }

      if (response.status >= 500) {
        handleRetryableFailure(pending, remaining, result, attemptedAt, logger, `HTTP ${response.status}`);
        continue;
      }

      result.drained += 1;
      result.errors.push(`Dropped queued payload after non-retryable HTTP ${response.status}`);
      logger.warn(`[tokensrank-script] Dropping queued payload after non-retryable HTTP ${response.status}`);
    } catch (error) {
      handleRetryableFailure(pending, remaining, result, attemptedAt, logger, formatError(error));
    }
  }

  queue = remaining;
  enforceCapacity(logger);
  return result;
}

export function getOfflineQueue(): PendingPayload[] {
  return queue.map((entry) => ({
    payload: entry.payload,
    attempted_at: entry.attempted_at,
    retry_count: entry.retry_count,
  }));
}

function enforceCapacity(logger: Logger): number {
  if (queue.length <= OFFLINE_QUEUE_CAP) {
    return 0;
  }

  const overflow = queue.length - OFFLINE_QUEUE_CAP;
  queue = queue.slice(overflow);
  logger.warn(`[tokensrank-script] Payload queue at capacity (${OFFLINE_QUEUE_CAP}); evicted oldest ${overflow}`);
  return overflow;
}

function handleRetryableFailure(
  pending: PendingPayload,
  remaining: PendingPayload[],
  result: DrainOfflineQueueResult,
  attemptedAt: string,
  logger: Logger,
  reason: string,
): void {
  const retryCount = normalizeRetryCount(pending.retry_count) + 1;

  if (retryCount >= OFFLINE_QUEUE_MAX_RETRIES) {
    result.drained += 1;
    result.errors.push(`Dropped queued payload after ${OFFLINE_QUEUE_MAX_RETRIES} retries: ${reason}`);
    logger.warn(`[tokensrank-script] Dropping queued payload after ${OFFLINE_QUEUE_MAX_RETRIES} retries: ${reason}`);
    return;
  }

  result.failed += 1;
  result.errors.push(`Queued payload retry ${retryCount}/${OFFLINE_QUEUE_MAX_RETRIES}: ${reason}`);
  remaining.push({
    payload: pending.payload,
    attempted_at: attemptedAt,
    retry_count: retryCount,
  });
}

async function postPayload(
  fetchImpl: FetchLike,
  apiBase: string,
  key: string,
  payload: PendingPayload['payload'],
): Promise<Response> {
  return fetchImpl(`${apiBase.replace(/\/+$/u, '')}/api/script/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

function normalizeRetryCount(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
