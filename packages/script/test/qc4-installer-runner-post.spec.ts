import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, '../../..');
const scriptRoot = path.join(repoRoot, 'packages/script');

type MockScriptApi = {
  baseUrl: string;
  close: () => Promise<void>;
  requests: Array<{
    authorization: string | undefined;
    body: {
      client?: {
        install_id?: string;
        platform?: string;
      };
      sessions?: Array<{
        session_id?: string;
        source?: string;
      }>;
    };
  }>;
};

let tokensrankHome: string;

async function startMockScriptApi(): Promise<MockScriptApi> {
  const requests: MockScriptApi['requests'] = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/api/script/sessions') {
      requests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(await readRequestBody(request)),
      });
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ingestion_run_id: '11111111-1111-4111-8111-111111111111',
        accepted: 1,
        deduped: 0,
        rejected: 0,
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

async function installTokensRank(apiBase: string, accessKey: string): Promise<void> {
  await execFileAsync(path.join(scriptRoot, 'install.sh'), {
    env: {
      ...process.env,
      TOKENSRANK_ACCESS_KEY: accessKey,
      TOKENSRANK_API_BASE: apiBase,
      TOKENSRANK_HOME: tokensrankHome,
      TOKENSRANK_INSTALL_RUN_FIRST: '0',
      TOKENSRANK_INSTALL_SCHEDULER: 'none',
      TOKENSRANK_SKIP_SCHEDULER_REGISTER: '1',
    },
    maxBuffer: 1024 * 1024,
  });
}

async function writeInputFixture(): Promise<string> {
  const inputPath = path.join(tokensrankHome, 'sessions.json');
  await writeFile(inputPath, `${JSON.stringify({
    sessions: [{
      session_id: 'qc4-installer-runner-session',
      source: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      first_event_at: '2026-04-27T10:00:00.000Z',
      last_event_at: '2026-04-27T10:01:00.000Z',
      input_tokens: 11,
      output_tokens: 7,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0,
      turns: 1,
      file_sha256: 'a'.repeat(64),
    }],
  })}\n`, 'utf8');

  return inputPath;
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

beforeEach(async () => {
  tokensrankHome = await mkdtemp(path.join(tmpdir(), 'tokensrank-qc4-script-'));
  await mkdir(tokensrankHome, { recursive: true });
});

afterEach(async () => {
  await rm(tokensrankHome, { recursive: true, force: true });
});

describe('QC-4 script installer and runner POST coherence', () => {
  it('runs install.sh into an isolated home and the installed agent ships a verified batch', async () => {
    const accessKey = `tr_script_${'a'.repeat(32)}`;
    const api = await startMockScriptApi();

    try {
      await installTokensRank(api.baseUrl, accessKey);
      const inputPath = await writeInputFixture();
      const result = await execFileAsync(process.execPath, [
        path.join(tokensrankHome, 'bin/agent.mjs'),
        '--first-run',
        '--input',
        inputPath,
      ], {
        env: {
          ...process.env,
          TOKENSRANK_HOME: tokensrankHome,
        },
        maxBuffer: 1024 * 1024,
      });

      expect(JSON.parse(result.stdout)).toEqual({ accepted: 1, deduped: 0, queued: 0 });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]).toMatchObject({
        authorization: `Bearer ${accessKey}`,
        body: {
          client: {
            platform: process.platform,
          },
          sessions: [{
            session_id: 'qc4-installer-runner-session',
            source: 'claude',
          }],
        },
      });
      expect(api.requests[0]?.body.client?.install_id).toMatch(/^[0-9a-f-]{36}$/u);
    } finally {
      await api.close();
    }
  });
});
