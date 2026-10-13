import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

const DEFAULT_GLOBAL_INGESTION_RATE_LIMIT_MAX_REQUESTS = 40;
const DEFAULT_GLOBAL_INGESTION_RATE_LIMIT_WINDOW_SECONDS = 1;
const INGESTION_RATE_LIMIT_PATHS = new Set([
  '/api/script/sessions',
  '/api/self-reported/sessions',
  '/api/me/usage/import',
  '/api/me/usage/import/finalize',
]);

export type RateLimitError = Error & {
  code: 'rate_limited';
  statusCode: 429;
  details: {
    reset_at: string;
    retry_after_seconds: number;
  };
};

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (rawValue === undefined || rawValue.trim() === '') {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getGlobalIngestionRateLimitMaxRequests(): number {
  return readPositiveIntegerEnv(
    'INGESTION_GLOBAL_RATE_LIMIT_MAX_REQUESTS',
    DEFAULT_GLOBAL_INGESTION_RATE_LIMIT_MAX_REQUESTS,
  );
}

function getGlobalIngestionRateLimitWindowSeconds(): number {
  return readPositiveIntegerEnv(
    'INGESTION_GLOBAL_RATE_LIMIT_WINDOW_SECONDS',
    DEFAULT_GLOBAL_INGESTION_RATE_LIMIT_WINDOW_SECONDS,
  );
}

function getRequestPath(request: FastifyRequest): string {
  return request.url.split('?', 1)[0] ?? request.url;
}

function isIngestionRequest(request: FastifyRequest): boolean {
  return request.method === 'POST' && INGESTION_RATE_LIMIT_PATHS.has(getRequestPath(request));
}

function buildRateLimitMessage(maxRequests: number, windowSeconds: number): string {
  const windowLabel = windowSeconds === 1 ? 'sec' : `${windowSeconds}s`;

  return `Rate limit exceeded (${maxRequests} req/${windowLabel})`;
}

function buildRateLimitError(
  message: string,
  resetAtMs: number,
  retryAfterSeconds: number,
): RateLimitError {
  const error = new Error(message) as RateLimitError;

  error.code = 'rate_limited';
  error.statusCode = 429;
  error.details = {
    reset_at: new Date(resetAtMs).toISOString(),
    retry_after_seconds: retryAfterSeconds,
  };

  return error;
}

/**
 * Applies one process-local global sliding-window limiter to ingestion POSTs.
 * This protects upstream Supabase writes from bursts while allowing large
 * first-run agent imports to complete quickly under the 50 req/sec ceiling.
 */
const rateLimitPluginImpl: FastifyPluginAsync = async (fastify) => {
  const maxRequests = getGlobalIngestionRateLimitMaxRequests();
  const windowSeconds = getGlobalIngestionRateLimitWindowSeconds();
  const windowMs = windowSeconds * 1000;
  const message = buildRateLimitMessage(maxRequests, windowSeconds);
  const requestTimestamps: number[] = [];

  function prune(nowMs: number): void {
    const cutoffMs = nowMs - windowMs;

    while (requestTimestamps.length > 0 && requestTimestamps[0]! <= cutoffMs) {
      requestTimestamps.shift();
    }
  }

  function enforceGlobalIngestionLimit(reply: FastifyReply, nowMs: number): void {
    prune(nowMs);

    if (requestTimestamps.length < maxRequests) {
      requestTimestamps.push(nowMs);
      return;
    }

    const resetAtMs = requestTimestamps[0]! + windowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));

    reply.header('Retry-After', String(retryAfterSeconds));
    throw buildRateLimitError(message, resetAtMs, retryAfterSeconds);
  }

  fastify.addHook('onRequest', async (request, reply) => {
    if (!isIngestionRequest(request)) {
      return;
    }

    enforceGlobalIngestionLimit(reply, Date.now());
  });
};

export const rateLimitPlugin = fp(rateLimitPluginImpl, {
  name: 'tokensrank-rate-limit',
});
