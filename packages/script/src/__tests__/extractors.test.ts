import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { IngestRequestSchema } from '@tokensrank/shared';
import { describe, expect, it } from 'vitest';

import { parseClaudeJsonl } from '../extractors/claude.js';
import { parseCodexJsonl } from '../extractors/codex.js';
import {
  SESSION_PAYLOAD_ALLOWLIST,
  assertNoForbiddenKeys,
  assertNoForbiddenStringValues,
} from '../privacy/allowlist.js';
import { validateScriptPayload } from '../privacy/validator.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const fixturesRoot = path.join(repoRoot, 'packages/script/test/fixtures');
const allowedSessionKeys = new Set<string>(SESSION_PAYLOAD_ALLOWLIST);

describe('script extractors privacy allowlist', () => {
  it('extracts Claude aggregates and strips private transcript fields', async () => {
    const jsonl = await readFile(path.join(fixturesRoot, 'claude/privacy-sample.jsonl'), 'utf8');

    const result = parseClaudeJsonl(jsonl);

    expect(result.warnings).toEqual([]);
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0]).toMatchObject({
      session_id: 'claude-session-1',
      source: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      first_event_at: '2026-04-27T10:00:00.000Z',
      last_event_at: '2026-04-27T10:05:00.000Z',
      input_tokens: 150,
      output_tokens: 30,
      cache_read_input_tokens: 9,
      cache_creation_input_tokens: 4,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0,
      turns: 2,
    });

    for (const session of result.sessions) {
      expect(Object.keys(session).every((key) => allowedSessionKeys.has(key))).toBe(true);
      assertNoForbiddenKeys(session);
      assertNoForbiddenStringValues(session);
    }
  });

  it('extracts Codex aggregate usage without private rollout fields', async () => {
    const jsonl = await readFile(path.join(fixturesRoot, 'codex/privacy-sample.jsonl'), 'utf8');

    const result = parseCodexJsonl(jsonl, { sessionId: 'codex-session-opaque' });

    expect(result.warnings).toEqual([]);
    expect(result.sessions).toEqual([
      expect.objectContaining({
        session_id: 'codex-session-opaque',
        source: 'codex',
        model: 'gpt-5.2-codex',
        first_event_at: '2026-04-27T12:01:00.000Z',
        last_event_at: '2026-04-27T12:03:00.000Z',
        input_tokens: 65,
        output_tokens: 17,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cached_input_tokens: 10,
        reasoning_output_tokens: 7,
        turns: 2,
      }),
    ]);

    const [session] = result.sessions;
    expect(session).toBeDefined();
    if (!session) {
      throw new Error('Expected Codex fixture to produce one session.');
    }
    expect(Object.keys(session).every((key) => allowedSessionKeys.has(key))).toBe(true);
    assertNoForbiddenKeys(session);
    assertNoForbiddenStringValues(session);
  });

  it('validates assembled script payloads against the shared ingest schema', async () => {
    const claudeJsonl = await readFile(path.join(fixturesRoot, 'claude/privacy-sample.jsonl'), 'utf8');
    const codexJsonl = await readFile(path.join(fixturesRoot, 'codex/privacy-sample.jsonl'), 'utf8');
    const sessions = [
      ...parseClaudeJsonl(claudeJsonl).sessions,
      ...parseCodexJsonl(codexJsonl, { sessionId: 'codex-session-opaque' }).sessions,
    ];
    const payload = {
      client: {
        version: '0.0.1',
        install_id: '11111111-1111-4111-8111-111111111111',
        platform: 'darwin' as const,
        arch: 'arm64',
      },
      run: {
        run_id: 'script-test-run',
        started_at: '2026-04-27T12:00:00.000Z',
        finished_at: '2026-04-27T12:04:00.000Z',
      },
      sessions,
    };

    expect(IngestRequestSchema.safeParse(payload).success).toBe(true);
    expect(validateScriptPayload(payload).ok).toBe(true);
  });

  it('rejects payloads with forbidden keys or private-looking values', () => {
    const session = {
      session_id: 'claude-session-1',
      source: 'claude' as const,
      model: 'claude-3-5-sonnet-20241022',
      first_event_at: '2026-04-27T10:00:00.000Z',
      last_event_at: '2026-04-27T10:00:00.000Z',
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0,
      turns: 1,
      file_sha256: 'a'.repeat(64),
      prompt: 'private',
    };

    expect(() => assertNoForbiddenKeys(session)).toThrow(/Forbidden key/u);

    expect(() => assertNoForbiddenStringValues({
      session_id: '/Users/alice/secret-project',
    })).toThrow(/Forbidden private value/u);
  });
});
