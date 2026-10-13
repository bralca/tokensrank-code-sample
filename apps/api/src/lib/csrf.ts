import type { FastifyRequest } from 'fastify';

const CANONICAL_ALLOWED_ORIGINS = [
  'https://tokensrank.ai',
  'https://www.tokensrank.ai',
  'http://localhost:3000',
] as const;

function parseEnvOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function getAllowedOrigins(): Set<string> {
  return new Set([
    ...CANONICAL_ALLOWED_ORIGINS,
    ...parseEnvOrigins(),
  ]);
}

export function getRequestOrigin(request: FastifyRequest): string | null {
  const origin = request.headers.origin;

  if (typeof origin === 'string' && origin.length > 0) {
    return origin;
  }

  const referer = request.headers.referer;

  if (typeof referer !== 'string' || referer.length === 0) {
    return null;
  }

  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

export function isAllowedBrowserOrigin(request: FastifyRequest): boolean {
  const origin = getRequestOrigin(request);

  return origin === null || getAllowedOrigins().has(origin);
}
