import type { IngestRequest } from '@tokensrank/shared';

export const PENDING_PAYLOAD_CAP = 24;
export const PENDING_PAYLOAD_MAX_RETRIES = 3;

export type PendingPayload = {
  payload: IngestRequest;
  attempted_at: string;
  retry_count: number;
};

export type OfflineQueueState = {
  pending_payloads: PendingPayload[];
  access_key_invalid?: boolean;
};

export type QueueLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type DrainPendingPayloadsOptions = {
  apiBase: string;
  accessKey: string;
  fetch?: typeof fetch;
  logger?: QueueLogger;
  now?: () => string;
};

export type DrainPendingPayloadsResult = {
  drained: number;
  failed: number;
  unauthorized: boolean;
};

export function appendPendingPayload(
  state: OfflineQueueState,
  payload: IngestRequest,
  options: {
    attemptedAt?: string;
    logger?: QueueLogger;
    retryCount?: number;
  } = {},
): OfflineQueueState {
  const nextPayloads = [
    ...state.pending_payloads,
    {
      payload,
      attempted_at: options.attemptedAt ?? new Date().toISOString(),
      retry_count: normalizeRetryCount(options.retryCount ?? 0),
    },
  ];
  const overflow = Math.max(0, nextPayloads.length - PENDING_PAYLOAD_CAP);

  if (overflow > 0) {
    options.logger?.warn?.(`[tokensrank-script] Queue overflow, dropping oldest ${overflow} payload(s)`);
  }

  state.pending_payloads = nextPayloads.slice(-PENDING_PAYLOAD_CAP);
  return state;
}

export async function drainPendingPayloads(
  state: OfflineQueueState,
  options: DrainPendingPayloadsOptions,
): Promise<DrainPendingPayloadsResult> {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date().toISOString());
  const logger = options.logger ?? {};
  const remaining: PendingPayload[] = [];
  const result: DrainPendingPayloadsResult = {
    drained: 0,
    failed: 0,
    unauthorized: false,
  };

  for (let index = 0; index < state.pending_payloads.length; index += 1) {
    const pending = state.pending_payloads[index];

    if (!pending) {
      continue;
    }

    const outcome = await drainOnePayload(pending, {
      apiBase: options.apiBase,
      accessKey: options.accessKey,
      fetch: fetchImpl,
      logger,
      now,
    });

    if (outcome === 'drained') {
      result.drained += 1;
      continue;
    }

    if (outcome === 'unauthorized') {
      result.unauthorized = true;
      state.access_key_invalid = true;
      remaining.push(pending, ...state.pending_payloads.slice(index + 1));
      break;
    }

    if (outcome.retry_count >= PENDING_PAYLOAD_MAX_RETRIES) {
      result.drained += 1;
      logger.warn?.(`[tokensrank-script] Dropping payload after ${PENDING_PAYLOAD_MAX_RETRIES} retries`);
      continue;
    }

    result.failed += 1;
    remaining.push(outcome);
  }

  state.pending_payloads = remaining.slice(-PENDING_PAYLOAD_CAP);

  if (result.drained > 0) {
    logger.info?.(`[tokensrank-script] Drained ${result.drained} queued payload(s)`);
  }

  return result;
}

async function drainOnePayload(
  pending: PendingPayload,
  options: Required<Pick<DrainPendingPayloadsOptions, 'apiBase' | 'accessKey' | 'fetch' | 'now'>> & {
    logger: QueueLogger;
  },
): Promise<'drained' | 'unauthorized' | PendingPayload> {
  let retryCount = normalizeRetryCount(pending.retry_count);

  while (retryCount < PENDING_PAYLOAD_MAX_RETRIES) {
    try {
      const response = await options.fetch(`${options.apiBase.replace(/\/+$/u, '')}/api/script/sessions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.accessKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(pending.payload),
      });

      if (response.ok) {
        return 'drained';
      }

      if (response.status === 401) {
        options.logger.warn?.('[tokensrank-script] Access key rejected while draining queue');
        return 'unauthorized';
      }

      if (response.status < 500) {
        options.logger.warn?.(`[tokensrank-script] Dropping queued payload after non-retryable HTTP ${response.status}`);
        return 'drained';
      }

      retryCount += 1;
    } catch (error) {
      retryCount += 1;
      options.logger.warn?.(`[tokensrank-script] Queue drain network error: ${formatError(error)}`);
    }
  }

  return {
    payload: pending.payload,
    attempted_at: options.now(),
    retry_count: retryCount,
  };
}

function normalizeRetryCount(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
