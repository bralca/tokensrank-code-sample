import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import type { IngestRequest } from '@tokensrank/shared';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const agentPath = path.join(repoRoot, 'packages/script/bin/agent.mjs');
const fixturesRoot = path.join(repoRoot, 'packages/script/test/fixtures');

const testRoots: string[] = [];

afterEach(async () => {
  await Promise.all(testRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('dry-run runner integration', () => {
  it('allows a --force normal run to succeed after a dry-run', async () => {
    const root = await makeRoot();
    const inputPath = await writeInputFixture(root);
    const statePath = path.join(root, 'state.json');
    await writeFile(statePath, JSON.stringify({
      last_run_at: '2099-01-01T00:00:00.000Z',
      shipped_session_ids: [],
      pending_payloads: [],
    }));

    const dryRun = await runAgent(['--dry-run', '--input', inputPath, '--state', statePath], root);
    expect(dryRun.stdout).toContain('Dry-run mode: would send 1 sessions in 1 batch(es)');

    const api = await startMockApi();
    try {
      const shipped = await runAgent([
        '--force',
        '--input',
        inputPath,
        '--state',
        statePath,
        '--api-base',
        api.baseUrl,
      ], root, { TOKENSRANK_ACCESS_KEY: 'tr_script_test' });

      expect(JSON.parse(shipped.stdout)).toMatchObject({ accepted: 1, deduped: 0, queued: 0 });
      expect(api.requests).toHaveLength(1);
    } finally {
      await api.close();
    }
  });

  it('respects --first-run by skipping the last-run guard without changing state', async () => {
    const root = await makeRoot();
    const inputPath = await writeInputFixture(root);
    const statePath = path.join(root, 'state.json');
    const state = '{"last_run_at":"2099-01-01T00:00:00.000Z","shipped_session_ids":[],"pending_payloads":[]}\n';
    await writeFile(statePath, state);

    const dryRun = await runAgent(['--dry-run', '--first-run', '--input', inputPath, '--state', statePath], root);

    expect(dryRun.stdout).toContain('Dry-run mode: would send 1 sessions in 1 batch(es)');
    await expect(readFile(statePath, 'utf8')).resolves.toBe(state);
  });

  it('uses identical extraction output in dry-run and normal mode', async () => {
    const root = await makeRoot();
    const dryRun = await runAgent([
      '--dry-run',
      '--claude-root',
      path.join(fixturesRoot, 'claude'),
      '--codex-root',
      path.join(fixturesRoot, 'codex'),
    ], root);
    const dryRunPayload = parseDryRunPayload(dryRun.stdout);

    const api = await startMockApi();
    try {
      await runAgent([
        '--claude-root',
        path.join(fixturesRoot, 'claude'),
        '--codex-root',
        path.join(fixturesRoot, 'codex'),
        '--api-base',
        api.baseUrl,
      ], root, { TOKENSRANK_ACCESS_KEY: 'tr_script_test' });

      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.sessions).toEqual(dryRunPayload.sessions);
    } finally {
      await api.close();
    }
  });

  it('leaves dedup state unaffected', async () => {
    const root = await makeRoot();
    const inputPath = await writeInputFixture(root);
    const statePath = path.join(root, 'state.json');
    const state = JSON.stringify({
      last_run_at: null,
      shipped_session_ids: [{
        session_id: 'already-shipped',
        source: 'claude',
        file_sha256: 'b'.repeat(64),
        shipped_at: '2026-04-27T09:00:00.000Z',
      }],
      pending_payloads: [],
    }, null, 2);
    await writeFile(statePath, `${state}\n`);

    await runAgent(['--dry-run', '--input', inputPath, '--state', statePath], root);

    await expect(readFile(statePath, 'utf8')).resolves.toBe(`${state}\n`);
  });

  it('leaves the offline queue and pending_payloads unchanged', async () => {
    const root = await makeRoot();
    const inputPath = await writeInputFixture(root);
    const statePath = path.join(root, 'state.json');
    const queuedPayload = makePayload([makeSession({ session_id: 'queued-session', file_sha256: 'c'.repeat(64) })]);
    const state = JSON.stringify({
      last_run_at: null,
      shipped_session_ids: [],
      pending_payloads: [{
        payload: queuedPayload,
        attempted_at: '2026-04-27T09:00:00.000Z',
        retry_count: 1,
      }],
    }, null, 2);
    await writeFile(statePath, `${state}\n`);

    const api = await startMockApi();
    try {
      await runAgent([
        '--dry-run',
        '--input',
        inputPath,
        '--state',
        statePath,
        '--api-base',
        api.baseUrl,
      ], root, { TOKENSRANK_ACCESS_KEY: 'tr_script_test' });

      expect(api.requests).toHaveLength(0);
      await expect(readFile(statePath, 'utf8')).resolves.toBe(`${state}\n`);
    } finally {
      await api.close();
    }
  });
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tokensrank-dry-run-'));
  testRoots.push(root);
  return root;
}

async function writeInputFixture(root: string): Promise<string> {
  const inputPath = path.join(root, 'input.json');
  await writeFile(inputPath, JSON.stringify({ sessions: [makeSession()] }, null, 2));
  return inputPath;
}

async function runAgent(
  args: string[],
  tokensrankHome: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('node', [agentPath, ...args], {
    env: {
      ...process.env,
      TOKENSRANK_HOME: tokensrankHome,
      ...env,
    },
    maxBuffer: 1024 * 1024,
  });
}

function parseDryRunPayload(stdout: string): IngestRequest {
  const start = stdout.indexOf('{');
  if (start === -1) {
    throw new Error('Dry-run stdout did not contain a JSON payload.');
  }

  return JSON.parse(stdout.slice(start)) as IngestRequest;
}

async function startMockApi(): Promise<{
  baseUrl: string;
  requests: IngestRequest[];
  close: () => Promise<void>;
}> {
  const requests: IngestRequest[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/api/script/sessions') {
      requests.push(JSON.parse(await readRequestBody(request)) as IngestRequest);
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ingestion_run_id: '11111111-1111-4111-8111-111111111111',
        accepted_count: 1,
        deduped_count: 0,
        rejected_count: 0,
        rejected_details: [],
      }));
      return;
    }

    response.writeHead(404);
    response.end();
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Mock API did not bind a TCP port.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function makePayload(sessions = [makeSession()]): IngestRequest {
  return {
    client: {
      version: '0.0.1',
      install_id: '11111111-1111-4111-8111-111111111111',
      platform: 'darwin',
      arch: 'arm64',
    },
    run: {
      run_id: 'queued-run',
      started_at: '2026-04-27T09:00:00.000Z',
      finished_at: '2026-04-27T09:01:00.000Z',
    },
    sessions,
  };
}

function makeSession(overrides: Partial<IngestRequest['sessions'][number]> = {}): IngestRequest['sessions'][number] {
  return {
    session_id: 'dry-run-integration-session',
    source: 'claude',
    model: 'claude-3-5-sonnet-20241022',
    first_event_at: '2026-04-27T10:00:00.000Z',
    last_event_at: '2026-04-27T10:05:00.000Z',
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 1,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0,
    turns: 2,
    file_sha256: 'a'.repeat(64),
    ...overrides,
  };
}
