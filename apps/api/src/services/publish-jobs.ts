import { purgeIngestionCaches } from './cache';
import type { FastifyInstance } from 'fastify';
import type { LocalPublishPayload } from '@tokensrank/shared';
import { adminClient } from '../clients/supabase';
import { rebuildProfileSummaries } from './scoring';

export type PublishJob = {
  run_id: string;
  profile_id: string;
  payload: LocalPublishPayload;
  phase: 'verify' | 'summary';
  attempts: number;
  lease_token: string;
};

export async function finishPublishJob(
  job: PublishJob,
  status: 'passed' | 'failed' | 'unavailable',
  result: Record<string, unknown>,
  tables: Record<string, Record<string, unknown>[]> = {},
): Promise<void> {
  const { error } = await adminClient.rpc('finish_local_publish', {
    p_run_id: job.run_id, p_lease_token: job.lease_token,
    p_status: status, p_tables: tables, p_result: result,
  });
  if (error) throw new Error(`[publish] Atomic completion failed: ${error.message}`);
}

/** Durable leases make an interrupted API process safe to restart. */
export function registerPublishWorker(
  server: FastifyInstance,
  verify: (job: PublishJob) => Promise<'passed' | 'failed'>,
) {
  const enabled = process.env.TOKENSRANK_PUBLISH_WORKER === 'true'
    || (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true' && process.env.TOKENSRANK_PUBLISH_WORKER !== 'false');
  let active: Promise<void> | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function processNext(): Promise<void> {
    const { data, error } = await adminClient.rpc('claim_local_publish');
    if (error) throw new Error(`[publish] Queue claim failed: ${error.message}`);
    const job = (data as PublishJob[] | null)?.[0];
    if (!job) return;
    const heartbeat = setInterval(() => {
      void Promise.resolve(adminClient.from('local_publish_jobs')
        .update({ lease_until: new Date(Date.now() + 120_000).toISOString() })
        .eq('run_id', job.run_id).eq('lease_token', job.lease_token)
        ).then(({ error: heartbeatError }) => {
          if (heartbeatError) server.log.warn({ err: heartbeatError, run_id: job.run_id }, 'Publish lease renewal failed');
        }).catch((error) => server.log.warn({ err: error, run_id: job.run_id }, 'Publish lease renewal failed'));
    }, 30_000);
    heartbeat.unref();
    let summaryPhase = job.phase === 'summary';
    try {
      if (!summaryPhase) {
        const outcome = await verify(job);
        server.cache.purgeByPrefix('leaderboard:');
        purgeIngestionCaches();
        if (outcome === 'failed') return;
        summaryPhase = true;
      }
      await rebuildProfileSummaries({});
      server.cache.purgeByPrefix('profile:');
      server.cache.purgeByPrefix('leaderboard:');
        purgeIngestionCaches();
      const { error: deleteError } = await adminClient.from('local_publish_jobs').delete()
        .eq('run_id', job.run_id).eq('lease_token', job.lease_token);
      if (deleteError) throw new Error(deleteError.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!summaryPhase && job.attempts >= 5) {
        await finishPublishJob(job, 'unavailable', { error: message });
      } else {
        const retryMs = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(job.attempts, 8));
        const { error: retryError } = await adminClient.from('local_publish_jobs').update({
          available_at: new Date(Date.now() + retryMs).toISOString(), lease_token: null, lease_until: null,
        }).eq('run_id', job.run_id).eq('lease_token', job.lease_token);
        if (retryError) throw new Error(retryError.message);
      }
      server.log.warn({ run_id: job.run_id, error: message, summary: summaryPhase }, 'Publish work will retry or requires a new publish');
    } finally {
      clearInterval(heartbeat);
    }
  }

  function wake() {
    if (!enabled || stopped || active) return;
    active = processNext().catch((error) => server.log.error({ err: error }, 'Publish worker failed'))
      .finally(() => { active = null; });
  }
  server.addHook('onReady', async () => {
    if (enabled) { timer = setInterval(wake, 15_000); timer.unref(); wake(); }
  });
  server.addHook('onClose', async () => {
    stopped = true;
    if (timer) clearInterval(timer);
    // Outstanding leases expire automatically if shutdown interrupts a job.
  });
  return { wake, processNext };
}
