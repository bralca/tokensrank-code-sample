import { execFile } from 'node:child_process';
import { readFile, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseCodexJsonl } from './codex.js';
import {
  SESSION_PAYLOAD_ALLOWLIST,
  assertNoForbiddenKeys,
  assertNoForbiddenStringValues,
} from '../privacy/allowlist.js';
import { validatePayloadPrivacy } from '../runtime/dry-run.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const agentPath = path.join(repoRoot, 'packages/script/bin/agent.mjs');
const allowedSessionKeys = [...SESSION_PAYLOAD_ALLOWLIST].sort();
const forbiddenFieldNames = [
  'path',
  'prompt',
  'response',
  'hostname',
  'tool_name',
];

function expectOnlyAllowlistedSessionFields(session: Record<string, unknown>): void {
  expect(Object.keys(session).sort()).toEqual(allowedSessionKeys);
  assertNoForbiddenKeys(session);
  assertNoForbiddenStringValues(session);

  const serialized = JSON.stringify(session);
  for (const fieldName of forbiddenFieldNames) {
    expect(serialized).not.toContain(`"${fieldName}"`);
  }
}

function parseDryRunPayload(stdout: string): unknown {
  const jsonStart = stdout.indexOf('{\n');

  if (jsonStart === -1) {
    throw new Error('Dry-run output did not contain a JSON payload');
  }

  return JSON.parse(stdout.slice(jsonStart));
}

describe('Codex extractor privacy boundary', () => {
  it('emits only allowlisted session payload fields and strips private rollout fields', () => {
    const jsonl = [
      JSON.stringify({
        timestamp: '2026-04-27T12:01:00.000Z',
        type: 'token_count',
        path: '/Users/alice/.codex/sessions/private.jsonl',
        prompt: 'Refactor my private project',
        response: 'Private response body',
        hostname: 'alice-workstation.local',
        tool_name: 'shell',
        payload: {
          type: 'token_count',
          model: 'gpt-5.2-codex',
          tool_name: 'shell',
          info: {
            last_token_usage: {
              input_tokens: 20,
              output_tokens: 6,
              cached_input_tokens: 3,
              reasoning_output_tokens: 2,
            },
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-27T12:03:00.000Z',
        type: 'token_count',
        cwd: '/Users/alice/private-project',
        payload: {
          type: 'token_count',
          model: 'gpt-5.2-codex',
          response: 'internal transcript text',
          info: {
            last_token_usage: {
              input_tokens: 45,
              output_tokens: 12,
              cached_input_tokens: 8,
              reasoning_output_tokens: 6,
            },
          },
        },
      }),
    ].join('\n');

    const result = parseCodexJsonl(jsonl, { sessionId: 'codex-qc3-session' });

    expect(result.warnings).toEqual([]);
    expect(result.sessions).toEqual([
      {
        session_id: 'codex-qc3-session',
        source: 'codex',
        model: 'gpt-5.2-codex',
        first_event_at: '2026-04-27T12:01:00.000Z',
        last_event_at: '2026-04-27T12:03:00.000Z',
        input_tokens: 65,
        output_tokens: 18,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cached_input_tokens: 11,
        reasoning_output_tokens: 8,
        turns: 2,
        active_seconds: 120,
        longest_active_seconds: 120,
        file_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    ]);

    expectOnlyAllowlistedSessionFields(result.sessions[0] as Record<string, unknown>);
  });

  it('passes the forbidden-keys pre-commit source scan used by the script package', async () => {
    const source = await readFile(agentPath, 'utf8');
    const forbiddenPatterns = [
      /\.(content|prompt|response|thinking|hostname|cwd|git|diff|command)\b/u,
      /\.(tool|tools|tool_name|toolName)\b/u,
      /\.(project_name|projectName|workspace|repository|repo|branch|commit)\b/u,
      /file[_-]?path/u,
      /request\.body/u,
      /readFileSync/u,
    ];

    const violations = forbiddenPatterns.flatMap((pattern) => (
      source
        .split(/\r?\n/u)
        .map((line, index) => ({ line, lineNumber: index + 1, pattern }))
        .filter((candidate) => candidate.pattern.test(candidate.line))
    ));

    expect(violations).toEqual([]);
  });

  it('prints dry-run output with zero forbidden private fields', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'tokensrank-qc3-dry-run-'));
    const inputPath = path.join(tempRoot, 'input.json');
    const inputPayload = {
      sessions: [
        {
          session_id: 'dry-run-qc3-session',
          source: 'claude',
          model: 'claude-3-5-sonnet-20241022',
          first_event_at: '2026-04-27T10:00:00.000Z',
          last_event_at: '2026-04-27T10:00:00.000Z',
          input_tokens: 1,
          output_tokens: 2,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
          turns: 1,
          file_sha256: 'a'.repeat(64),
          path: '/Users/alice/private-project/transcript.jsonl',
          prompt: 'private prompt',
          response: 'private response',
          hostname: 'workstation.local',
          tool_name: 'shell',
        },
      ],
    };

    try {
      await writeFile(inputPath, JSON.stringify(inputPayload), 'utf8');

      const { stdout } = await execFileAsync(process.execPath, [
        agentPath,
        '--dry-run',
        '--input',
        inputPath,
      ], {
        env: {
          ...process.env,
          TOKENSRANK_HOME: tempRoot,
        },
      });

      expect(stdout).toContain('"session_id": "dry-run-qc3-session"');

      for (const fieldName of forbiddenFieldNames) {
        expect(stdout).not.toContain(`"${fieldName}"`);
      }

      const dryRunPayload = parseDryRunPayload(stdout);
      expect(validatePayloadPrivacy(dryRunPayload)).toEqual({ isClean: true, issues: [] });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
