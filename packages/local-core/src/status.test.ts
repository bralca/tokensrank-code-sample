import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { openLocalStore } from './db.js';
import { completeLocalOnboarding, readLocalOnboardingStatus, resetLocalOnboarding } from './status.js';

describe('local onboarding status', () => {
  it('persists completion metadata and can reset to the first-run state', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-status-'));
    const store = openLocalStore({ dataDir });

    try {
      expect(readLocalOnboardingStatus(store)).toEqual({
        completed_at: null,
        completed_version: null,
        last_completed_step: null,
      });

      const completed = completeLocalOnboarding(store, {
        completedVersion: 'local-v2-test',
        lastCompletedStep: 'ready',
      });

      expect(completed.completed_at).not.toBeNull();
      expect(completed.completed_version).toBe('local-v2-test');
      expect(completed.last_completed_step).toBe('ready');
      expect(readLocalOnboardingStatus(store)).toEqual(completed);

      expect(resetLocalOnboarding(store)).toEqual({
        completed_at: null,
        completed_version: null,
        last_completed_step: null,
      });
    } finally {
      store.close();
    }
  });
});
