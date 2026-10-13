import { describe, expect, it } from 'vitest';

import { parseClaudeJsonl } from './claude.js';
import {
  SESSION_PAYLOAD_ALLOWLIST,
  assertNoForbiddenKeys,
  assertNoForbiddenStringValues,
} from '../privacy/allowlist.js';

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

describe('Claude extractor privacy boundary', () => {
  it('emits only allowlisted session payload fields and strips private transcript fields', () => {
    const jsonl = [
      JSON.stringify({
        sessionId: 'claude-qc3-session',
        timestamp: '2026-04-27T10:00:00.000Z',
        path: '/Users/alice/private-project/transcript.jsonl',
        prompt: 'Summarize my private source file',
        response: 'Private answer text',
        hostname: 'alice-workstation.local',
        tool_name: 'bash',
        message: {
          model: 'claude-3-5-sonnet-20241022',
          content: [{ type: 'text', text: 'private prompt body' }],
          usage: {
            input_tokens: 120,
            output_tokens: 30,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 5,
          },
        },
      }),
      JSON.stringify({
        sessionId: 'claude-qc3-session',
        timestamp: '2026-04-27T10:05:00.000Z',
        cwd: '/Users/alice/private-project',
        response: 'More private answer text',
        message: {
          model: 'claude-3-5-sonnet-20241022',
          usage: {
            input_tokens: 80,
            output_tokens: 20,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 1,
          },
        },
      }),
    ].join('\n');

    const result = parseClaudeJsonl(jsonl);

    expect(result.warnings).toEqual([]);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toEqual({
      session_id: 'claude-qc3-session',
      source: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      first_event_at: '2026-04-27T10:00:00.000Z',
      last_event_at: '2026-04-27T10:05:00.000Z',
      input_tokens: 200,
      output_tokens: 50,
      cache_read_input_tokens: 14,
      cache_creation_input_tokens: 6,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0,
      turns: 2,
      active_seconds: 300,
      longest_active_seconds: 300,
      file_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    expectOnlyAllowlistedSessionFields(result.sessions[0] as Record<string, unknown>);
  });
});
