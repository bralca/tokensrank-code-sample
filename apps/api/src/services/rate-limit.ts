import type { FastifyRequest } from 'fastify';

export type IpRateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
};

type IpRateLimitEntry = {
  count: number;
  resetAtMs: number;
};

export const PASSWORD_RESET_RATE_LIMIT_MAX_REQUESTS = 5;
export const PASSWORD_RESET_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function normalizeIp(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const [candidate] = value.split(',');
  const normalized = candidate?.trim();

  return normalized && normalized.length > 0 ? normalized : null;
}

export function extractClientIp(request: FastifyRequest): string {
  const headers = request.headers;

  return (
    normalizeIp(firstHeaderValue(headers['cf-connecting-ip'])) ??
    normalizeIp(firstHeaderValue(headers['x-forwarded-for'])) ??
    normalizeIp(firstHeaderValue(headers['x-real-ip'])) ??
    request.ip
  );
}

export class IpRateLimiter {
  private readonly entries = new Map<string, IpRateLimitEntry>();

  constructor(
    private readonly maxRequests = PASSWORD_RESET_RATE_LIMIT_MAX_REQUESTS,
    private readonly windowMs = PASSWORD_RESET_RATE_LIMIT_WINDOW_MS,
    private readonly now = () => Date.now(),
  ) {}

  check(ip: string): IpRateLimitResult {
    const nowMs = this.now();
    this.cleanupExpired(nowMs);

    const current = this.entries.get(ip);

    if (!current || current.resetAtMs <= nowMs) {
      const resetAtMs = nowMs + this.windowMs;
      this.entries.set(ip, {
        count: 1,
        resetAtMs,
      });

      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        resetAt: new Date(resetAtMs),
      };
    }

    if (current.count >= this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: new Date(current.resetAtMs),
      };
    }

    current.count += 1;

    return {
      allowed: true,
      remaining: this.maxRequests - current.count,
      resetAt: new Date(current.resetAtMs),
    };
  }

  reset(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }

  private cleanupExpired(nowMs: number): void {
    for (const [ip, entry] of this.entries.entries()) {
      if (entry.resetAtMs <= nowMs) {
        this.entries.delete(ip);
      }
    }
  }
}

export const passwordResetLimiter = new IpRateLimiter();
