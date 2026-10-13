import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LocalStore } from './db.js';
import { openLocalStore, readSyncState, writeSyncState } from './db.js';
import { pollGithubDeviceFlow, startGithubDeviceFlow } from './github-device.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GitHub Device Flow', () => {
  let store: LocalStore | null = null;

  afterEach(() => {
    store?.close();
    store = null;
    vi.unstubAllEnvs();
  });

  it('backs off locally after GitHub asks polling to slow down', async () => {
    vi.stubEnv('GITHUB_DEVICE_CLIENT_ID', 'client-id');
    store = openLocalStore({ dataDir: await mkdtemp(path.join(os.tmpdir(), 'tokensrank-device-')) });
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      if (String(url).endsWith('/login/device/code')) {
        return jsonResponse({
          device_code: 'device-code',
          user_code: 'USER-CODE',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        });
      }
      return jsonResponse({
        error: 'slow_down',
        error_description: 'Too many requests have been made in the same timeframe.',
      });
    }) as unknown as typeof fetch;

    await startGithubDeviceFlow(store.db, { fetchImpl });
    const first = await pollGithubDeviceFlow(store.db, { fetchImpl });
    const second = await pollGithubDeviceFlow(store.db, { fetchImpl });

    expect(first).toMatchObject({
      status: 'pending',
      message: 'Too many requests have been made in the same timeframe.',
      poll_interval_seconds: 10,
    });
    expect(second.status).toBe('pending');
    expect(second.message).toContain('Waiting before the next GitHub status check');
    expect(calls.filter((url) => url.endsWith('/login/oauth/access_token'))).toHaveLength(1);
  });

  it('stores identity and clears active device flow after authorization', async () => {
    vi.stubEnv('GITHUB_DEVICE_CLIENT_ID', 'client-id');
    vi.stubEnv('GITHUB_TOKEN', 'gho_test');
    store = openLocalStore({ dataDir: await mkdtemp(path.join(os.tmpdir(), 'tokensrank-device-')) });
    writeSyncState(store.db, 'github_device_flow', {
      client_id: 'client-id',
      device_code: 'device-code',
      user_code: 'USER-CODE',
      verification_uri: 'https://github.com/login/device',
      expires_at: new Date(Date.now() + 900_000).toISOString(),
      interval: 5,
      next_poll_at: new Date(Date.now() - 1_000).toISOString(),
    });
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith('/login/oauth/access_token')) {
        return jsonResponse({ access_token: 'gho_test', token_type: 'bearer', scope: 'repo,user:email' });
      }
      if (value.endsWith('/user')) {
        return jsonResponse({ id: 123, login: 'bralca', avatar_url: null });
      }
      if (value.endsWith('/user/emails')) {
        return jsonResponse([{ email: 'a@example.com', verified: true }]);
      }
      return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;

    const result = await pollGithubDeviceFlow(store.db, { fetchImpl });

    expect(result).toMatchObject({
      status: 'authorized',
      identity: { github_user_id: 123, login: 'bralca' },
    });
    expect(readSyncState(store.db, 'github_device_flow', null)).toBeNull();
  });
});
