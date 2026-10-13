import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { extractClientIp, IpRateLimiter } from './rate-limit';

function buildRequest(headers: FastifyRequest['headers'], ip = '127.0.0.1'): FastifyRequest {
  return {
    headers,
    ip,
  } as FastifyRequest;
}

describe('IpRateLimiter', () => {
  it('allows 5 requests per IP per hour and blocks the 6th', () => {
    let now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const limiter = new IpRateLimiter(5, 60 * 60 * 1000, () => now);

    for (let i = 0; i < 5; i += 1) {
      const result = limiter.check('203.0.113.10');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4 - i);
      expect(result.resetAt.toISOString()).toBe('2026-01-01T01:00:00.000Z');
    }

    expect(limiter.check('203.0.113.10')).toEqual({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.UTC(2026, 0, 1, 1, 0, 0)),
    });

    now += 1;
  });

  it('tracks different IPs independently', () => {
    const limiter = new IpRateLimiter(5, 60 * 60 * 1000, () => 0);

    for (let i = 0; i < 5; i += 1) {
      expect(limiter.check('203.0.113.10').allowed).toBe(true);
    }

    expect(limiter.check('203.0.113.11')).toMatchObject({
      allowed: true,
      remaining: 4,
    });
    expect(limiter.check('203.0.113.10').allowed).toBe(false);
  });

  it('resets the window after one hour', () => {
    let now = 0;
    const limiter = new IpRateLimiter(5, 60 * 60 * 1000, () => now);

    for (let i = 0; i < 5; i += 1) {
      limiter.check('203.0.113.10');
    }

    expect(limiter.check('203.0.113.10').allowed).toBe(false);

    now = 60 * 60 * 1000;

    expect(limiter.check('203.0.113.10')).toMatchObject({
      allowed: true,
      remaining: 4,
    });
  });

  it('cleans expired entries when checking a new request', () => {
    let now = 0;
    const limiter = new IpRateLimiter(5, 60 * 60 * 1000, () => now);

    limiter.check('203.0.113.10');
    limiter.check('203.0.113.11');
    expect(limiter.size()).toBe(2);

    now = 60 * 60 * 1000;
    limiter.check('203.0.113.12');

    expect(limiter.size()).toBe(1);
  });
});

describe('extractClientIp', () => {
  it('prefers cf-connecting-ip over other headers', () => {
    const request = buildRequest({
      'cf-connecting-ip': '203.0.113.1',
      'x-forwarded-for': '203.0.113.2',
      'x-real-ip': '203.0.113.3',
    });

    expect(extractClientIp(request)).toBe('203.0.113.1');
  });

  it('uses the first x-forwarded-for IP when Cloudflare header is absent', () => {
    const request = buildRequest({
      'x-forwarded-for': '203.0.113.2, 203.0.113.3',
      'x-real-ip': '203.0.113.4',
    });

    expect(extractClientIp(request)).toBe('203.0.113.2');
  });

  it('falls back through x-real-ip to request.ip', () => {
    expect(extractClientIp(buildRequest({ 'x-real-ip': '203.0.113.4' }))).toBe('203.0.113.4');
    expect(extractClientIp(buildRequest({}, '198.51.100.20'))).toBe('198.51.100.20');
  });
});
