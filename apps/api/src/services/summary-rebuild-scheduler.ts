import type { FastifyBaseLogger } from 'fastify';

import { rebuildProfileSummaries } from './scoring';

const REBUILD_DEBOUNCE_MS = 4000;

let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
let rebuildRunning = false;

export function scheduleSummaryRebuild(log: Pick<FastifyBaseLogger, 'info' | 'warn'>): void {
  if (rebuildTimer) {
    clearTimeout(rebuildTimer);
  }

  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;

    if (rebuildRunning) {
      scheduleSummaryRebuild(log);
      return;
    }

    rebuildRunning = true;

    void rebuildProfileSummaries({})
      .then((result) => {
        log.info({
          event: 'ingestion.summary_rebuilt',
          ...result,
        }, 'Post-ingestion profile summary rebuild complete');
      })
      .catch((error) => {
        log.warn({
          event: 'ingestion.summary_rebuild_failed',
          error: error instanceof Error ? error.message : String(error),
        }, 'Post-ingestion rebuild failed');
      })
      .finally(() => {
        rebuildRunning = false;
      });
  }, REBUILD_DEBOUNCE_MS);
}
