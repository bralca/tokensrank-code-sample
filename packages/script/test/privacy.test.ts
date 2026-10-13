import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IngestRequestSchema, type IngestRequest, type SessionPayload } from '@tokensrank/shared';
import { describe, expect, it } from 'vitest';

import { extractSessionsFromFiles, parseClaudeJsonl, parseCodexJsonl } from '../src/extractors/index.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const fixturesRoot = path.join(repoRoot, 'packages/script/test/fixtures');
const claudeFixture = path.join(fixturesRoot, 'claude-with-prompts.jsonl');
const codexFixture = path.join(fixturesRoot, 'codex-with-paths.jsonl');

const allowedSessionKeys = new Set([
  'session_id',
  'source',
  'model',
  'first_event_at',
  'last_event_at',
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'cached_input_tokens',
  'reasoning_output_tokens',
  'turns',
  'active_seconds',
  'longest_active_seconds',
  'file_sha256',
]);

const forbiddenKeys = [
  'content',
  'response_text',
  'file_path',
  'file_paths',
  'hostname',
  'hostnames',
  'command',
  'commands',
  'tool_calls',
  'project_name',
  'prompt',
  'git_diff',
  'password',
];

async function extractFixtureSessions(): Promise<SessionPayload[]> {
  const result = await extractSessionsFromFiles([
    { source: 'claude', path: claudeFixture },
    { source: 'codex', path: codexFixture, sessionId: 'codex-privacy-session-1' },
  ]);

  expect(result.warnings).toEqual([]);
  return result.sessions;
}

function makePayload(sessions: SessionPayload[]): IngestRequest {
  return {
    client: {
      version: '0.0.1',
      install_id: '11111111-1111-4111-8111-111111111111',
      platform: 'darwin',
      arch: 'arm64',
    },
    run: {
      run_id: 'privacy-runtime-test',
      started_at: '2026-04-27T10:00:00.000Z',
      finished_at: '2026-04-27T13:13:00.000Z',
    },
    sessions,
  };
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, keys);
    }
    return keys;
  }

  if (typeof value !== 'object' || value === null) {
    return keys;
  }

  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectKeys(child, keys);
  }

  return keys;
}

describe('script runtime privacy allowlist', () => {
  it('extracts allowlisted Claude and Codex fields from one mixed batch', async () => {
    const sessions = await extractFixtureSessions();

    expect(sessions).toHaveLength(4);
    expect(sessions.map((session) => session.source).sort()).toEqual(['claude', 'claude', 'claude', 'codex']);
    expect(sessions.every((session) => session.session_id.length > 0)).toBe(true);
    expect(sessions.every((session) => session.model.length > 0)).toBe(true);
    expect(sessions.every((session) => session.input_tokens > 0)).toBe(true);
    expect(sessions.every((session) => session.output_tokens > 0)).toBe(true);
    expect(sessions.every((session) => session.first_event_at.endsWith('Z'))).toBe(true);
    expect(sessions.every((session) => session.last_event_at.endsWith('Z'))).toBe(true);
    expect(sessions.every((session) => typeof session.cache_read_input_tokens === 'number')).toBe(true);
    expect(sessions.every((session) => typeof session.cache_creation_input_tokens === 'number')).toBe(true);
    expect(sessions.every((session) => typeof session.cached_input_tokens === 'number')).toBe(true);
  });

  it('omits forbidden fields from every extracted session object', async () => {
    const sessions = await extractFixtureSessions();

    for (const session of sessions) {
      expect(Object.keys(session).sort()).toEqual([...allowedSessionKeys].sort());
      const keys = collectKeys(session);
      for (const forbiddenKey of forbiddenKeys) {
        expect(keys.has(forbiddenKey)).toBe(false);
      }
    }
  });

  it('contains zero forbidden fixture keywords in the outgoing JSON payload', async () => {
    const payload = makePayload(await extractFixtureSessions());
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toMatch(/password/iu);
    expect(serialized).not.toMatch(/project-name/iu);
    expect(serialized).not.toMatch(/\b(?:127\.0\.0\.1|10\.0\.0\.5)\b/u);
    expect(serialized).not.toMatch(/git diff/iu);
    expect(serialized).not.toMatch(/\/Users\/|\/home\/|C:\\Users\\/u);
    expect(serialized).not.toMatch(/message\.content|response_text|tool_calls/iu);
  });

  it('validates the extracted payload against IngestRequestSchema', async () => {
    const payload = makePayload(await extractFixtureSessions());
    const result = IngestRequestSchema.safeParse(payload);

    expect(result.success).toBe(true);
  });

  it('fixtures still contain private fields that the extractor must strip', async () => {
    const fixtureText = [
      await readFile(claudeFixture, 'utf8'),
      await readFile(codexFixture, 'utf8'),
    ].join('\n');

    expect(fixtureText).toMatch(/message.*content|response_text|file_paths|hostnames|commands|tool_calls/su);
    expect(fixtureText).toMatch(/password|project-name|127\.0\.0\.1|git diff/iu);
  });

  it('covers Claude parser warning and timestamp ordering branches without leaking private fields', () => {
    const jsonl = [
      '',
      '"not an object"',
      '{bad json',
      JSON.stringify({
        sessionId: 'claude-invalid-time',
        timestamp: 'not-a-date',
        message: {
          model: 'claude-3-5-sonnet-20241022',
          usage: { input_tokens: 1, output_tokens: 1 },
          content: 'private prompt',
        },
      }),
      JSON.stringify({
        sessionId: 'claude-missing-usage',
        timestamp: '2026-04-27T10:00:00.000Z',
        message: { model: 'claude-3-5-sonnet-20241022' },
      }),
      JSON.stringify({
        sessionId: 'claude-out-of-order',
        timestamp: '2026-04-27T10:10:00.000Z',
        message: {
          model: 'claude-3-5-sonnet-20241022',
          usage: { input_tokens: 7, output_tokens: 3 },
          response_text: 'private response',
        },
      }),
      JSON.stringify({
        sessionId: 'claude-out-of-order',
        timestamp: '2026-04-27T10:05:00.000Z',
        message: {
          model: 'claude-3-5-haiku-20241022',
          usage: { input_tokens: 5, output_tokens: 2 },
          content: 'private prompt',
        },
      }),
    ].join('\n');

    const result = parseClaudeJsonl(jsonl);

    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'invalid_shape',
      'invalid_json',
      'invalid_timestamp',
      'missing_required_fields',
    ]);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      session_id: 'claude-out-of-order',
      first_event_at: '2026-04-27T10:05:00.000Z',
      last_event_at: '2026-04-27T10:10:00.000Z',
      input_tokens: 12,
      output_tokens: 5,
      turns: 2,
    });
    expect(JSON.stringify(result.sessions)).not.toMatch(/private prompt|private response/iu);
  });

  it('covers Codex parser ignored-event, warning, default-id, and tie-break branches', () => {
    const jsonl = [
      '',
      '"not an object"',
      '{bad json',
      JSON.stringify({
        timestamp: '2026-04-27T13:00:00.000Z',
        type: 'session_configured',
        payload: { type: 'session_configured', model: 'gpt-5.2-codex' },
      }),
      JSON.stringify({
        timestamp: 'not-a-date',
        type: 'token_count',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 1, output_tokens: 1 } },
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-27T13:01:00.000Z',
        type: 'non_token_event',
        payload: {
          type: 'ignored_event',
          info: { last_token_usage: { input_tokens: 50, output_tokens: 20 } },
          prompt: 'private prompt',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-27T13:02:00.000Z',
        type: 'token_count',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 0, output_tokens: 0 } },
          response_text: 'private response',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-27T13:03:00.000Z',
        type: 'token_count',
        payload: {
          type: 'token_count',
          model: 'gpt-5.2-codex',
          info: {
            last_token_usage: {
              input_tokens: 10,
              output_tokens: 4,
              cached_input_tokens: 3,
              reasoning_output_tokens: 2,
            },
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-27T13:03:00.000Z',
        type: 'token_count',
        payload: {
          type: 'token_count',
          model: 'gpt-5.3-codex',
          info: {
            last_token_usage: {
              input_tokens: 6,
              output_tokens: 2,
              cached_input_tokens: 1,
              reasoning_output_tokens: 1,
            },
          },
        },
      }),
    ].join('\n');

    const result = parseCodexJsonl(jsonl);

    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'invalid_shape',
      'invalid_json',
      'invalid_timestamp',
    ]);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      source: 'codex',
      model: 'gpt-5.3-codex',
      first_event_at: '2026-04-27T13:03:00.000Z',
      last_event_at: '2026-04-27T13:03:00.000Z',
      input_tokens: 16,
      output_tokens: 6,
      cached_input_tokens: 4,
      reasoning_output_tokens: 3,
      turns: 2,
    });
    expect(result.sessions[0]?.session_id).toMatch(/^codex-[a-f0-9]{32}$/u);
    expect(JSON.stringify(result.sessions)).not.toMatch(/private prompt|private response/iu);
  });

  it('derives an opaque Codex session id when file extraction gets no explicit id', async () => {
    const result = await extractSessionsFromFiles([{ source: 'codex', path: codexFixture }]);

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.session_id).toMatch(/^codex-[a-f0-9]{32}$/u);
  });
});
