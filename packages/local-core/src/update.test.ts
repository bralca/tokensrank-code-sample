import { describe, expect, it } from 'vitest';

import { checkLocalVersionStatus, compareSemverLike } from './update.js';

describe('compareSemverLike', () => {
  it('orders semantic versions numerically', () => {
    expect(compareSemverLike('1.10.0', '1.9.9')).toBe(1);
    expect(compareSemverLike('1.0.0', '1.0.1')).toBe(-1);
    expect(compareSemverLike('v2.0.0', '2.0.0')).toBe(0);
  });
});

describe('checkLocalVersionStatus', () => {
  it('reports updates from npm metadata', async () => {
    const status = await checkLocalVersionStatus({
      packageName: 'tokensrank-local',
      currentVersion: '0.1.0',
      fetchImpl: async () => new Response(JSON.stringify({
        'dist-tags': {
          latest: '0.2.0',
        },
      }), { status: 200 }),
    });

    expect(status).toMatchObject({
      package_name: 'tokensrank-local',
      current_version: '0.1.0',
      latest_version: '0.2.0',
      update_available: true,
      source: 'npm',
      last_error: null,
    });
  });

  it('returns a non-blocking error status when the registry is unavailable', async () => {
    const status = await checkLocalVersionStatus({
      packageName: 'tokensrank-local',
      currentVersion: '0.1.0',
      fetchImpl: async () => new Response('not found', { status: 404, statusText: 'Not Found' }),
    });

    expect(status).toMatchObject({
      update_available: false,
      latest_version: null,
      source: 'unknown',
    });
    expect(status.last_error).toContain('registry returned 404');
  });
});
