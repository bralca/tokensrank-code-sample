import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openLocalStore } from '@tokensrank/local-core';
import { normalizePublishBase } from './publish-connection.js';

const secrets = vi.hoisted(() => ({ token: null as string | null }));
vi.mock('@tokensrank/local-core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tokensrank/local-core')>(),
  readPublishToken: async () => secrets.token,
  storeSecret: async (_kind: string, value: string) => { secrets.token = value; return 'test-store'; },
  clearSecret: async () => { secrets.token = null; },
}));
const base = 'http://localhost:3201';
let dataDir: string;
let app: Awaited<ReturnType<typeof import('./server.js')['buildServer']>> | undefined;
async function start() {
  vi.resetModules();
  vi.stubEnv('TOKENSRANK_DATA_DIR', dataDir);
  vi.stubEnv('TOKENSRANK_LOCAL_STARTUP_REFRESH', 'false');
  vi.stubEnv('TOKENSRANK_LOCAL_UPDATE_CHECK', 'false');
  app = await (await import('./server.js')).buildServer();
  return app;
}
async function setup() {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-connection-test-'));
  const store = openLocalStore({ dataDir });
  store.db.exec("INSERT INTO github_identity(github_user_id,login,connected_at,updated_at) VALUES(123,'fixture',datetime('now'),datetime('now'))");
  store.close();
  secrets.token = null;
  await start();
}
function hostedFetch(expiresAt = '2099-01-01T00:00:00.000Z') {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url.startsWith(`${base}/`)).toBe(true);
    expect(init?.redirect).toBe('error');
    if (url.endsWith('/link/exchange')) return Response.json({ data: { publish_token: 'test-publishing-token', github_user_id: 123, expires_at: expiresAt, public_profile_url: 'http://localhost:3200/u/fixture' } }, { status: 201 });
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-publishing-token');
    if (url.endsWith('/token/status')) return Response.json({ data: { github_user_id: 123, expires_at: expiresAt, public_profile_url: 'http://localhost:3200/u/fixture' } });
    if (url.endsWith('/token/revoke')) return Response.json({ data: { disconnected: true } });
    return Response.json({ data: { publish_run_id: '11111111-1111-4111-8111-111111111111', verification_status: 'pending', accepted_usage_days: 0,
      accepted_sessions: 0, accepted_code_days: 0, remote_github_shipped_loc_total: 0, remote_github_commit_total: 0,
      remote_github_day_count: 0, pricing_mismatches: [] } }, { status: 202 });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}
async function connect() {
  const result = await app!.inject({ method: 'POST', url: '/local/publish/connect', payload: { code: 'test-single-use-code', hosted_api_base: base } });
  expect(result.statusCode, result.body).toBe(200);
}
afterEach(async () => {
  await app?.close(); app = undefined;
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('saved local publishing connection', () => {
  it('preserves its destination across restart and refuses to send its token to another host', async () => {
    await setup(); const fetch = hostedFetch(); await connect();
    await app!.close(); app = undefined; await start();
    const status = await app!.inject({ url: '/local/publish/status', headers: { 'x-hosted-api-base': 'https://foreign.example' } });
    expect(status.json().data).toMatchObject({ connection_status: 'connected', hosted_api_base: base, token_connected: true });
    const before = fetch.mock.calls.length;
    const refused = await app!.inject({ method: 'POST', url: '/local/publish/send', payload: { hosted_api_base: 'https://foreign.example' } });
    expect(refused.statusCode).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(before);
    const unconfirmed = await app!.inject({ method: 'POST', url: '/local/publish/send', payload: {} });
    expect(unconfirmed.statusCode).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(before);
    const receipt = await app!.inject({ method: 'POST', url: '/local/publish/receipt', payload: {} });
    expect(receipt.statusCode, receipt.body).toBe(200);
    const { receipt_id, payload } = receipt.json().data;
    expect(payload.schema_version).toBe(2);
    expect(payload.usage_session_rollups).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(before);
    const declined = await app!.inject({ method: 'POST', url: '/local/publish/send', payload: { receipt_id, confirmed: false } });
    expect(declined.statusCode).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(before);
    const accepted = await app!.inject({ method: 'POST', url: '/local/publish/send', payload: { receipt_id, confirmed: true } });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(fetch.mock.calls.at(-1)?.[0]).toBe(`${base}/api/publish/local`);
    expect(JSON.parse(fetch.mock.calls.at(-1)?.[1]?.body as string)).toEqual(payload);
    const after = fetch.mock.calls.length;
    expect((await app!.inject({ method: 'POST', url: '/local/publish/send', payload: { receipt_id, confirmed: true } })).statusCode).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(after);
  });
  it('recognizes expiry without sending credentials and removes disconnected credentials', async () => {
    await setup(); const fetch = hostedFetch('2000-01-01T00:00:00.000Z'); await connect();
    const before = fetch.mock.calls.length;
    const status = await app!.inject({ url: '/local/publish/status' });
    expect(status.json().data).toMatchObject({ connection_status: 'expired', token_connected: false });
    expect(fetch).toHaveBeenCalledTimes(before);
    expect((await app!.inject({ method: 'POST', url: '/local/publish/send', payload: {} })).statusCode).toBe(400);
    await app!.inject({ method: 'POST', url: '/local/publish/disconnect' });
    expect(secrets.token).toBeNull();
    expect((await app!.inject({ url: '/local/publish/status' })).json().data.connection_status).toBe('disconnected');
  });
  it('reports an unreachable dashboard and still lets the user disconnect locally', async () => {
    await setup(); hostedFetch(); await connect();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network unavailable')));
    const status = await app!.inject({ url: '/local/publish/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json().data).toMatchObject({ connection_status: 'unreachable', connection_error: 'Network unavailable', token_connected: false });
    const disconnected = await app!.inject({ method: 'POST', url: '/local/publish/disconnect' });
    expect(disconnected.json()).toMatchObject({ data: { disconnected: true, remote_revoked: false } });
    expect(secrets.token).toBeNull();
  });
  it('requires secure remote destinations and rejects credentials embedded in the address', () => {
    expect(normalizePublishBase(`${base}/`)).toBe(base);
    for (const url of ['http://remote.example', 'https://user:password@remote.example', 'https://remote.example?token=x']) {
      expect(() => normalizePublishBase(url)).toThrow();
    }
  });
});
