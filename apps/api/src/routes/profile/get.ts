import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ProfileResponseSchema, ProfileWindowSchema, type ProfileWindow } from '@tokensrank/shared';

import { adminClient } from '../../clients/supabase';
import { verifySessionToken } from '../../middleware/auth';
import { buildProfileResponse, type ProfileResponseProfile } from '../../services/profile';
import {
  buildProfileCacheKey,
  getCacheConfig,
  withCache,
} from '../../services/cache';

const HANDLE_PATTERN = /^[a-z0-9_-]{3,30}$/;
const CACHE_STATUS_HEADER = 'X-TokensRank-Cache';

type ProfileGetParams = {
  handle: string;
};

type ProfileGetQuery = {
  window?: string;
};

type ViewerProfileRow = {
  id: string;
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

function extractBearerToken(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) {
    return '';
  }

  return header.slice(7);
}

function extractCookieValue(cookieHeader: string | undefined, name: string): string {
  if (!cookieHeader) {
    return '';
  }

  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');

    if (rawKey === name) {
      return decodeURIComponent(rawValue.join('='));
    }
  }

  return '';
}

function extractOptionalSessionToken(request: FastifyRequest): string {
  return extractBearerToken(request.headers.authorization)
    || extractCookieValue(request.headers.cookie, 'tr_at');
}

function parseWindow(rawWindow: string | undefined): ProfileWindow | null {
  const normalizedWindow = rawWindow ?? 'all';
  const parsed = ProfileWindowSchema.safeParse(normalizedWindow);

  return parsed.success ? parsed.data : null;
}

async function resolveViewerProfileId(request: FastifyRequest): Promise<string | null> {
  const token = extractOptionalSessionToken(request);

  if (!token) {
    return null;
  }

  const session = await verifySessionToken(token);

  if (!session) {
    return null;
  }

  const { data, error } = await adminClient
    .from('profiles')
    .select('id')
    .eq('user_id', session.user_id)
    .maybeSingle<ViewerProfileRow>();

  if (error) {
    throw new Error(`[profile] Viewer profile lookup failed: ${error.message}`);
  }

  return data?.id ?? null;
}

async function loadProfileByHandle(handle: string): Promise<ProfileResponseProfile | null> {
  const { data, error } = await adminClient
    .from('profiles')
    .select([
      'id',
      'user_id',
      'handle',
      'display_name',
      'avatar_url',
      'bio',
      'x_handle',
      'mode',
      'verified',
      'share_projects',
      'created_at',
    ].join(','))
    .ilike('handle', handle)
    .maybeSingle<ProfileResponseProfile>();

  if (error) {
    throw new Error(`[profile] Profile lookup failed: ${error.message}`);
  }

  return data;
}

export async function registerGetProfileRoute(fastify: FastifyInstance) {
  fastify.get<{ Params: ProfileGetParams; Querystring: ProfileGetQuery }>(
    '/api/profile/:handle',
    async (request: FastifyRequest<{ Params: ProfileGetParams; Querystring: ProfileGetQuery }>, reply: FastifyReply) => {
      const handle = request.params.handle.trim().toLowerCase();
      const sessionToken = extractOptionalSessionToken(request);

      if (!HANDLE_PATTERN.test(handle)) {
        return reply
          .code(400)
          .send(errorEnvelope('invalid_handle', 'Handle must be 3-30 lowercase characters'));
      }

      const normalizedWindow = parseWindow(request.query.window);

      if (!normalizedWindow) {
        return reply
          .code(400)
          .send(errorEnvelope('invalid_window', 'Window must be one of 24h, 7d, 30d, or all'));
      }

      let viewerProfileId: string | null = null;
      let profileForOwnerCheck: ProfileResponseProfile | null = null;

      if (sessionToken) {
        try {
          viewerProfileId = await resolveViewerProfileId(request);
          profileForOwnerCheck = await loadProfileByHandle(handle);
        } catch (error) {
          request.log.warn({
            err: error,
            event: 'profile.viewer_lookup_failed',
            handle,
          }, '[profile] Optional viewer lookup failed');
        }
      }

      const cacheKey = buildProfileCacheKey(handle, normalizedWindow);
      const ttlSeconds = Math.min(60, getCacheConfig().ttlSeconds);
      const isOwner = viewerProfileId !== null
        && profileForOwnerCheck !== null
        && viewerProfileId === profileForOwnerCheck.id;

      try {
        if (isOwner) {
          if (!profileForOwnerCheck) {
            throw new Error('[profile] Missing owner profile after owner check');
          }

          const response = ProfileResponseSchema.parse(
            await buildProfileResponse(profileForOwnerCheck, normalizedWindow, true),
          );

          return reply
            .code(200)
            .header(CACHE_STATUS_HEADER, 'BYPASS')
            .header('Cache-Control', 'private, no-store')
            .send(response);
        }

        const response = await withCache(
          cacheKey,
          ttlSeconds,
          async () => {
            const profile = profileForOwnerCheck ?? await loadProfileByHandle(handle);

            if (!profile) {
              return null;
            }

            return ProfileResponseSchema.parse(
              await buildProfileResponse(profile, normalizedWindow, false),
            );
          },
          {
            logger: request.log,
            reply,
            request,
          },
        );

        if (!response) {
          return reply
            .code(404)
            .header(CACHE_STATUS_HEADER, reply.getHeader(CACHE_STATUS_HEADER) ?? 'MISS')
            .send(errorEnvelope('profile_not_found', 'Profile not found', { handle }));
        }

        return reply
          .code(200)
          .header('Cache-Control', 'no-cache')
          .send(response);
      } catch (error) {
        request.log.error({
          err: error,
          event: 'profile.response_failed',
          handle,
          window: normalizedWindow,
        }, '[profile] Failed to build profile response');

        return reply
          .code(503)
          .header(CACHE_STATUS_HEADER, reply.getHeader(CACHE_STATUS_HEADER) ?? 'BYPASS')
          .header('Cache-Control', 'no-store')
          .send(errorEnvelope(
            'profile_unavailable',
            'Profile is temporarily unavailable',
            process.env.NODE_ENV === 'test'
              ? { reason: error instanceof Error ? error.message : String(error) }
              : undefined,
          ));
      }
    },
  );
}
