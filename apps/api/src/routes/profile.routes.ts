import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  GetMeResponseSchema,
  HandleCheckResponseSchema,
  HandleCheckSchema,
  ProfileUpdateSchema,
  isReservedSystemHandle,
  type GetMeResponse,
} from '@tokensrank/shared';

import { requireAuth, type AuthContext } from '../middleware/auth';
import { writeAuditEvent } from '../services/audit';
import {
  profileService,
  type ProfileHydrationAccessKey,
  type ProfileHydrationIngestionRun,
  type ProfileHydrationProfile,
} from '../services/profile.service';
import { isHandleAvailableInDb } from '../services/profile';
import { registerGetProfileRoute } from './profile/get';
import { validateHandleFormat } from '../services/validators';

const ME_CACHE_TTL_SECONDS = 600;

type CachedMeData = {
  profile: ProfileHydrationProfile;
  accessKeys: ProfileHydrationAccessKey[];
  recentIngestionRuns: ProfileHydrationIngestionRun[];
};

function errorEnvelope(code: string, message: string) {
  return {
    error: {
      code,
      message,
    },
  };
}

function validationErrorEnvelope() {
  return errorEnvelope('invalid_request', 'Request body failed schema validation');
}

function getAuthContext(request: FastifyRequest): AuthContext {
  const auth = (request as typeof request & { auth?: AuthContext }).auth;

  if (!auth) {
    throw new Error('[profile] Missing auth context after requireAuth');
  }

  return auth;
}

function getOnboardingStep(profile: ProfileHydrationProfile): GetMeResponse['data']['onboarding']['step'] {
  if (profile.onboarded_at) {
    return 'complete';
  }

  if (profile.mode) {
    return 'mode_chosen';
  }

  return 'not_started';
}

function maskAccessKey(keyPrefix: string): string {
  return `${keyPrefix}...****`;
}

function buildMeResponse(cachedData: CachedMeData, email: string | null): GetMeResponse {
  const { profile } = cachedData;

  return GetMeResponseSchema.parse({
    data: {
      userId: profile.user_id,
      email,
      handle: profile.handle,
      displayName: profile.display_name,
      avatarUrl: profile.avatar_url,
      bio: profile.bio,
      xHandle: profile.x_handle,
      mode: profile.mode,
      onboardedAt: profile.onboarded_at,
      shareProjects: profile.share_projects ?? false,
      onboarding: {
        step: getOnboardingStep(profile),
      },
      accessKeys: cachedData.accessKeys.map((key) => ({
        keyId: key.id,
        keyPrefix: key.key_prefix,
        maskedKey: maskAccessKey(key.key_prefix),
        scope: key.scope,
        createdAt: key.created_at,
        revokedAt: key.revoked_at,
        lastUsedAt: key.last_used_at,
      })),
      recentIngestionRuns: cachedData.recentIngestionRuns.map((run) => ({
        ingestionRunId: run.id,
        ingestionMode: run.ingestion_mode,
        status: run.status,
        acceptedCount: run.session_count,
        rejectedCount: run.rejected_count,
        dedupedCount: run.duplicate_count,
        startedAt: run.started_at,
        completedAt: run.finished_at,
      })),
    },
  });
}

function buildHandleCheckResponse(available: boolean, reason?: 'invalid_format' | 'reserved' | 'already_taken') {
  return HandleCheckResponseSchema.parse({
    data: {
      available,
      ...(reason ? { reason } : {}),
    },
  });
}

async function loadMeData(userId: string): Promise<CachedMeData> {
  const profile = await profileService.getProfileByUserId(userId);

  if (!profile) {
    throw new Error(`[profile] Profile not found for user ${userId}`);
  }

  const [accessKeys, recentIngestionRuns] = await Promise.all([
    profileService.getAccessKeysByProfileId(profile.id),
    profileService.getRecentIngestionRuns(profile.id, 5),
  ]);

  return {
    profile,
    accessKeys,
    recentIngestionRuns,
  };
}

export async function profileRoutes(fastify: FastifyInstance) {
  const handleCheckHandler = async (request: FastifyRequest<{ Querystring: unknown }>, reply: FastifyReply) => {
    const query = HandleCheckSchema.safeParse(request.query);

    if (!query.success) {
      return reply
        .code(400)
        .send(errorEnvelope('invalid_handle_check_query', 'Missing required handle query parameter'));
    }

    const handle = query.data.h;
    const formatResult = validateHandleFormat(handle);

    if (!formatResult.valid) {
      return reply.code(200).send(buildHandleCheckResponse(false, 'invalid_format'));
    }

    if (isReservedSystemHandle(handle)) {
      return reply.code(200).send(buildHandleCheckResponse(false, 'reserved'));
    }

    try {
      const available = await isHandleAvailableInDb(handle);

      return reply
        .code(200)
        .send(available
          ? buildHandleCheckResponse(true)
          : buildHandleCheckResponse(false, 'already_taken'));
    } catch (error) {
      request.log.error({
        err: error,
        event: 'profile.handle_check.lookup_failed',
        handle,
      }, '[profile] Failed to check handle availability');

      return reply
        .code(500)
        .send(errorEnvelope('handle_check_failed', 'Could not check handle availability'));
    }
  };

  fastify.get('/api/handle/check', handleCheckHandler);
  fastify.get('/api/handles/check', handleCheckHandler);

  fastify.patch('/api/me/profile', { preHandler: requireAuth }, async (request, reply) => {
    const auth = getAuthContext(request);
    const parsed = ProfileUpdateSchema.safeParse(request.body);

    if (!parsed.success) {
      request.log.warn({
        event: 'profile.update.validation_failed',
        user_id: auth.userId,
      }, '[profile] Profile update validation failed');

      return reply
        .code(400)
        .send(validationErrorEnvelope());
    }

    try {
      const result = await profileService.updateProfile(auth.userId, parsed.data);

      await writeAuditEvent({
        event_type: 'profile.updated',
        severity: 'info',
        profile_id: auth.profileId,
        payload: {
          updated_fields: Object.keys(parsed.data),
        },
        requestLog: request.log,
      });

      return reply
        .header('x-cache-tags', 'profile,leaderboard,me')
        .code(200)
        .send({ data: result });
    } catch (error) {
      request.log.error({
        err: error,
        event: 'profile.update.failed',
        user_id: auth.userId,
      }, '[profile] Failed to update profile');

      return reply
        .code(500)
        .send(errorEnvelope('profile_update_failed', 'Could not update profile'));
    }
  });

  fastify.get('/api/me', { preHandler: requireAuth }, async (request, reply) => {
    const auth = getAuthContext(request);
    const cacheKey = `me:v1:${auth.userId}`;

    try {
      const cachedData = await fastify.cache.withCache(
        cacheKey,
        ME_CACHE_TTL_SECONDS,
        async () => await loadMeData(auth.userId),
        {
          onStatus: (status) => {
            reply.header('X-TokensRank-Cache', status);
          },
        },
      );

      return reply.code(200).send(buildMeResponse(cachedData, auth.email));
    } catch (error) {
      request.log.error({
        err: error,
        event: 'profile.me.load_failed',
        user_id: auth.userId,
      }, '[profile] Failed to load /api/me hydration data');

      return reply
        .code(500)
        .send(errorEnvelope('profile_load_failed', 'Could not load profile hydration data'));
    }
  });

  await registerGetProfileRoute(fastify);
}
