import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  OnboardingModeRequestSchema,
  OnboardingStatusResponseSchema,
  type OnboardingStatusResponse,
  type OnboardingStep,
  type PathChoice,
} from '@tokensrank/shared';

import { adminClient } from '../clients/supabase';
import { requireAuth, type AuthContext } from '../middleware/auth';

const ONBOARDING_CACHE_TTL_SECONDS = 300;
const ONBOARDING_SSE_TIMEOUT_MS = 30 * 60 * 1000;
const ONBOARDING_SSE_POLL_MS = 2000;

type OnboardingProfile = {
  handle: string | null;
  mode: PathChoice | null;
  onboarded_at: string | null;
};

function errorEnvelope(code: string, message: string) {
  return {
    error: {
      code,
      message,
    },
  };
}

function getAuthContext(request: FastifyRequest): AuthContext {
  const auth = (request as typeof request & { auth?: AuthContext }).auth;

  if (!auth) {
    throw new Error('[onboarding] Missing auth context after requireAuth');
  }

  return auth;
}

function deriveOnboardingStep(profile: OnboardingProfile): OnboardingStep {
  if (profile.onboarded_at) {
    return 'complete';
  }

  if (profile.mode) {
    return 'mode_chosen';
  }

  return 'not_started';
}

async function loadOnboardingProfile(userId: string): Promise<OnboardingProfile> {
  const { data, error } = await adminClient
    .from('profiles')
    .select('handle,mode,onboarded_at')
    .eq('user_id', userId)
    .single<OnboardingProfile>();

  if (error || !data) {
    throw new Error(`[onboarding] Profile lookup failed: ${error?.message ?? 'missing profile'}`);
  }

  return data;
}

async function updateOnboardingMode(userId: string, mode: PathChoice): Promise<OnboardingProfile> {
  const { data, error } = await adminClient
    .from('profiles')
    .update({ mode })
    .eq('user_id', userId)
    .select('handle,mode,onboarded_at')
    .single<OnboardingProfile>();

  if (error || !data) {
    throw new Error(`[onboarding] Mode update failed: ${error?.message ?? 'missing profile'}`);
  }

  return data;
}

function buildOnboardingStatusResponse(profile: OnboardingProfile): OnboardingStatusResponse {
  return OnboardingStatusResponseSchema.parse({
    data: {
      step: deriveOnboardingStep(profile),
      mode: profile.mode,
      onboarded_at: profile.onboarded_at,
      handle: profile.handle,
    },
  });
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);

  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

function writeSseEvent(reply: FastifyReply, event: string, payload: Record<string, unknown>): void {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function findCompletedIngestionRun(profileId: string) {
  const { data, error } = await adminClient
    .from('ingestion_runs')
    .select('id,status,session_count,duplicate_count,rejected_count,started_at,finished_at')
    .eq('profile_id', profileId)
    .in('status', ['completed', 'partial'])
    .order('finished_at', { ascending: true, nullsFirst: false })
    .limit(1)
    .maybeSingle<{
      id: string;
      status: 'completed' | 'partial';
      session_count: number;
      duplicate_count: number;
      rejected_count: number;
      started_at: string;
      finished_at: string | null;
    }>();

  if (error) {
    throw new Error(`[onboarding] Ingestion run polling failed: ${error.message}`);
  }

  return data;
}

export async function onboardingRoutes(fastify: FastifyInstance) {
  fastify.get('/api/me/onboarding', { preHandler: requireAuth }, async (request, reply) => {
    const auth = getAuthContext(request);
    const cacheKey = `onboarding:v1:${auth.userId}`;

    try {
      const profile = await fastify.cache.withCache(
        cacheKey,
        ONBOARDING_CACHE_TTL_SECONDS,
        async () => await loadOnboardingProfile(auth.userId),
        {
          onStatus: (status) => {
            reply.header('X-TokensRank-Cache', status);
          },
        },
      );

      return reply.code(200).send(buildOnboardingStatusResponse(profile));
    } catch (error) {
      request.log.error({
        err: error,
        event: 'onboarding.status.load_failed',
        user_id: auth.userId,
      }, '[onboarding] Failed to load onboarding status');

      return reply
        .code(500)
        .send(errorEnvelope('onboarding_status_failed', 'Could not load onboarding status'));
    }
  });

  fastify.post('/api/me/onboarding', { preHandler: requireAuth }, async (request, reply) => {
    const auth = getAuthContext(request);
    const parsed = OnboardingModeRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply
        .code(400)
        .send(errorEnvelope('invalid_onboarding_mode', 'Request body failed schema validation'));
    }

    try {
      const profile = await updateOnboardingMode(auth.userId, parsed.data.mode);

      fastify.cache.purgeKey(`onboarding:v1:${auth.userId}`);
      fastify.cache.purgeKey(`me:v1:${auth.userId}`);

      return reply
        .header('x-cache-tags', 'me,onboarding')
        .code(200)
        .send(buildOnboardingStatusResponse(profile));
    } catch (error) {
      request.log.error({
        err: error,
        event: 'onboarding.mode.update_failed',
        user_id: auth.userId,
      }, '[onboarding] Failed to update onboarding mode');

      return reply
        .code(500)
        .send(errorEnvelope('onboarding_mode_update_failed', 'Could not update onboarding mode'));
    }
  });

  fastify.get('/api/onboarding/waiting', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = getAuthContext(request);
    const pollMs = readPositiveIntegerEnv('ONBOARDING_SSE_POLL_MS', ONBOARDING_SSE_POLL_MS);
    const timeoutMs = readPositiveIntegerEnv('ONBOARDING_SSE_TIMEOUT_MS', ONBOARDING_SSE_TIMEOUT_MS);
    let closed = false;
    let interval: NodeJS.Timeout | null = null;
    let timeout: NodeJS.Timeout | null = null;

    function cleanup(): void {
      closed = true;

      if (interval) {
        clearInterval(interval);
        interval = null;
      }

      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    }

    function closeStream(): void {
      cleanup();

      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    }

    async function poll(): Promise<void> {
      if (closed) {
        return;
      }

      try {
        const run = await findCompletedIngestionRun(auth.profileId);

        if (!run) {
          return;
        }

        writeSseEvent(reply, 'detected', {
          type: 'detected',
          ingestion_run_id: run.id,
          status: run.status,
          accepted_count: run.session_count,
          deduped_count: run.duplicate_count,
          rejected_count: run.rejected_count,
          handle: auth.profile?.handle ?? null,
        });
        closeStream();
      } catch (error) {
        request.log.warn({
          err: error,
          event: 'onboarding.waiting.poll_failed',
          profile_id: auth.profileId,
        }, '[onboarding] SSE polling failed; will retry');

        if (!closed) {
          writeSseEvent(reply, 'log', {
            type: 'log',
            level: 'warn',
            message: 'Still waiting for the first completed sync.',
          });
        }
      }
    }

    reply.hijack();
    request.log.info({
      event: 'onboarding.waiting.connected',
      profile_id: auth.profileId,
    }, '[onboarding] SSE waiting stream connected');

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    writeSseEvent(reply, 'connected', {
      type: 'connected',
      message: 'Handshake complete.',
    });

    request.raw.on('close', cleanup);
    timeout = setTimeout(() => {
      if (!closed) {
        writeSseEvent(reply, 'timeout', {
          type: 'timeout',
          message: 'Timed out waiting for the first completed sync.',
        });
        closeStream();
      }
    }, timeoutMs);
    interval = setInterval(() => {
      void poll();
    }, pollMs);
    void poll();
  });
}
