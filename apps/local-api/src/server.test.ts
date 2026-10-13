import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

async function buildTempServer(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.stubEnv('TOKENSRANK_DATA_DIR', await mkdtemp(path.join(os.tmpdir(), 'tokensrank-local-api-')));
  vi.stubEnv('TOKENSRANK_LOCAL_STARTUP_REFRESH', 'false');
  vi.stubEnv('TOKENSRANK_LOCAL_ALLOW_TOKEN_AUTH', env.TOKENSRANK_LOCAL_ALLOW_TOKEN_AUTH);
  vi.stubEnv('GITHUB_DEV_TOKEN', env.GITHUB_DEV_TOKEN);

  const { buildServer } = await import('./server.js');
  return await buildServer();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('local API GitHub auth', () => {
  it('does not accept raw GitHub tokens unless explicitly enabled', async () => {
    const app = await buildTempServer();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/local/github/token',
        payload: { token: 'gho_should_not_be_accepted_by_default' },
      });

      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({
        error: {
          code: 'github_token_auth_disabled',
        },
      });
    } finally {
      await app.close();
    }
  });
});

describe('local API version status', () => {
  it('uses cached local version status for unpublished dev package builds', async () => {
    const app = await buildTempServer();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/local/version/check',
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          version: {
            package_name: 'tokensrank-local',
            current_version: '0.0.1',
            latest_version: '0.0.1',
            update_available: false,
            source: 'cached',
            last_error: null,
          },
          operation: {
            type: 'version_check',
            status: 'completed',
            progress_percent: 100,
          },
        },
      });
    } finally {
      await app.close();
    }
  });
});
