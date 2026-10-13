import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HandleSchema } from '@tokensrank/shared';

import {
  loadProfileCardData,
  OGProfileLoadError,
  OGProfileNotFoundError,
  OGRenderError,
  renderProfileCard,
  type OGVariant,
} from '../../services/og';
import {
  buildVersionedCacheKey,
  getCacheConfig,
  withCache,
} from '../../services/cache';

const CACHE_CONTROL = 'public, max-age=3600, stale-while-revalidate=86400';

type OGProfileParams = {
  handle: string;
};

type OGProfileQuery = {
  v?: string;
};

function errorEnvelope(code: string, message: string, details?: Record<string, unknown>) {
  return {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}

function selectVariant(rawVariant: string | undefined): OGVariant {
  return rawVariant === 'b' ? 'b' : 'a';
}

function createETag(buffer: Buffer): string {
  const hash = createHash('sha256')
    .update(buffer)
    .digest('hex');

  return `"${hash}"`;
}

function requestHasMatchingETag(request: FastifyRequest, etag: string): boolean {
  const rawHeader = request.headers['if-none-match'];
  const header = Array.isArray(rawHeader) ? rawHeader.join(',') : rawHeader;

  if (!header) {
    return false;
  }

  return header
    .split(',')
    .map((value) => value.trim())
    .some((value) => value === etag || value === `W/${etag}`);
}

async function handleOGProfileRequest(
  request: FastifyRequest<{ Params: OGProfileParams; Querystring: OGProfileQuery }>,
  reply: FastifyReply,
) {
  const parsedHandle = HandleSchema.safeParse(request.params.handle);

  if (!parsedHandle.success) {
    return reply
      .code(400)
      .header('Cache-Control', 'no-store')
      .send(errorEnvelope('invalid_handle', 'Handle must be 3-30 lowercase characters'));
  }

  const handle = parsedHandle.data;
  const variant = selectVariant(request.query.v);

  try {
    const cacheKey = buildVersionedCacheKey('og', handle, variant);
    const png = await withCache(
      cacheKey,
      getCacheConfig().ttlSeconds,
      async () => {
        const profile = await loadProfileCardData(handle);
        return await renderProfileCard(profile, variant);
      },
      {
        logger: request.log,
        reply,
        request,
      },
    );
    const etag = createETag(png);

    reply
      .header('Content-Type', 'image/png')
      .header('Cache-Control', CACHE_CONTROL)
      .header('ETag', etag);

    if (requestHasMatchingETag(request, etag)) {
      return reply.code(304).send();
    }

    return reply.code(200).send(png);
  } catch (error) {
    if (error instanceof OGProfileNotFoundError) {
      return reply
        .code(404)
        .header('Cache-Control', 'no-store')
        .send(errorEnvelope('profile_not_found', 'Profile not found', { handle }));
    }

    if (error instanceof OGProfileLoadError) {
      request.log.error({
        err: error,
        event: 'og.profile.load_failed',
        handle,
        variant,
      }, '[og] Failed to load profile for OG card');

      return reply
        .code(502)
        .header('Cache-Control', 'no-store')
        .send(errorEnvelope('profile_upstream_error', 'Could not load profile for OG image'));
    }

    if (error instanceof OGRenderError) {
      request.log.error({
        err: error,
        event: 'og.profile.render_failed',
        handle,
        variant,
      }, '[og] Failed to render OG profile card');

      return reply
        .code(500)
        .header('Cache-Control', 'no-store')
        .send(errorEnvelope('og_render_failed', 'Could not render OG image'));
    }

    request.log.error({
      err: error,
      event: 'og.profile.unexpected_failed',
      handle,
      variant,
    }, '[og] Unexpected OG profile route failure');

    return reply
      .code(500)
      .header('Cache-Control', 'no-store')
      .send(errorEnvelope('og_render_failed', 'Could not render OG image'));
  }
}

export async function ogProfileRoutes(fastify: FastifyInstance) {
  // IC-5: public profile OG route reads only the public profile response shape.
  // IC-7: binary responses always carry image/png, CDN cache-control, and SHA256 ETag.
  fastify.get<{ Params: OGProfileParams; Querystring: OGProfileQuery }>(
    '/api/og/profile/:handle',
    handleOGProfileRequest,
  );
  fastify.get<{ Params: OGProfileParams; Querystring: OGProfileQuery }>(
    '/api/og/u/:handle.png',
    handleOGProfileRequest,
  );
}
