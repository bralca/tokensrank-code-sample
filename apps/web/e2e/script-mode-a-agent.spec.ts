import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, '../../..');
const agentPath = path.join(repoRoot, 'packages/script/bin/agent.mjs');

test('Mode A script onboarding handoff ships first verified batch', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /top builders by token usage/i })).toBeVisible();

  const tokensrankHome = await mkdtemp(path.join(tmpdir(), 'tokensrank-mode-a-e2e-'));
  const inputPath = path.join(tokensrankHome, 'sessions.json');
  const api = await startMockScriptApi();

  try {
    await mkdir(tokensrankHome, { recursive: true });
    await writeFile(path.join(tokensrankHome, 'access-key'), 'tr_script_mode_a_e2e\n', 'utf8');
    await writeFile(path.join(tokensrankHome, 'config.json'), `${JSON.stringify({
      api_base: api.baseUrl,
      access_key: 'tr_script_mode_a_e2e',
      install_id: '11111111-1111-4111-8111-111111111111',
      ingestion_mode: 'script',
    })}\n`, 'utf8');
    await writeFile(inputPath, `${JSON.stringify({
      sessions: [{
        session_id: 'mode-a-onboarding-session',
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

    const result = await execFileAsync(process.execPath, [
      agentPath,
      '--first-run',
      '--input',
      inputPath,
      '--api-base',
      api.baseUrl,
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
      authorization: 'Bearer tr_script_mode_a_e2e',
      body: {
        client: {
          install_id: '11111111-1111-4111-8111-111111111111',
          platform: process.platform,
        },
        sessions: [{
          session_id: 'mode-a-onboarding-session',
          source: 'claude',
        }],
      },
    });
  } finally {
    await api.close();
    await rm(tokensrankHome, { recursive: true, force: true });
  }
});

async function startMockScriptApi(): Promise<{
  baseUrl: string;
  requests: Array<{ authorization: string | undefined; body: unknown }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ authorization: string | undefined; body: unknown }> = [];
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
