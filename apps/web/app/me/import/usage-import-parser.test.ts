import { describe, expect, it } from 'vitest';

import { parseUsageFiles } from './usage-import-parser';

function makeFile(name: string, path: string, text: string): File {
  const file = new File([text], name, {
    lastModified: new Date('2026-06-01T00:00:00.000Z').getTime(),
    type: 'application/jsonl',
  });

  Object.defineProperty(file, 'webkitRelativePath', {
    value: path,
  });

  return file;
}

function makeUnreadableFile(name: string, path: string): File {
  const file = makeFile(name, path, '');

  Object.defineProperty(file, 'text', {
    value: async () => {
      throw new DOMException('The requested file could not be read', 'NotReadableError');
    },
  });

  return file;
}

describe('usage import parser', () => {
  it('maps Claude message usage without adding subset token fields', async () => {
    const file = makeFile(
      'session.jsonl',
      '.claude/projects/session.jsonl',
      `${JSON.stringify({
        timestamp: '2026-06-01T10:00:00.000Z',
        sessionId: 'claude-session-1',
        message: {
          id: 'msg-1',
          model: 'claude-opus-4-7',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 3,
          },
        },
      })}\n`,
    );

    const result = await parseUsageFiles([file]);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      source: 'claude',
      provider: 'anthropic',
      event_kind: 'claude_message_usage',
      session_id: 'claude-session-1',
      model: 'claude-opus-4-7',
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 2,
      cache_create_tokens: 3,
      cached_tokens: 0,
      reasoning_tokens: 0,
    });
  });

  it('maps Codex cumulative token counts to deltas and preserves model ids', async () => {
    const file = makeFile(
      'codex.jsonl',
      '.codex/sessions/codex.jsonl',
      [
        JSON.stringify({ timestamp: '2026-06-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'codex-session-1' } }),
        JSON.stringify({ timestamp: '2026-06-01T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.5' } }),
        JSON.stringify({
          timestamp: '2026-06-01T10:00:02.000Z',
          type: 'token_count',
          payload: {
            info: {
              total_token_usage: {
                input_tokens: 10,
                output_tokens: 4,
                cached_input_tokens: 1,
                reasoning_output_tokens: 2,
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-01T10:00:03.000Z',
          type: 'token_count',
          payload: {
            info: {
              total_token_usage: {
                input_tokens: 10,
                output_tokens: 4,
                cached_input_tokens: 1,
                reasoning_output_tokens: 2,
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-01T10:00:04.000Z',
          type: 'token_count',
          payload: {
            info: {
              total_token_usage: {
                input_tokens: 15,
                output_tokens: 7,
                cached_input_tokens: 1,
                reasoning_output_tokens: 3,
              },
            },
          },
        }),
      ].join('\n'),
    );

    const result = await parseUsageFiles([file]);

    expect(result.events).toHaveLength(2);
    expect(result.events.map((event) => event.model)).toEqual(['gpt-5.5', 'gpt-5.5']);
    expect(result.events.map((event) => ({
      input: event.input_tokens,
      output: event.output_tokens,
      cached: event.cached_tokens,
      reasoning: event.reasoning_tokens,
    }))).toEqual([
      { input: 10, output: 4, cached: 1, reasoning: 2 },
      { input: 5, output: 3, cached: 0, reasoning: 1 },
    ]);
  });

  it('skips unreadable selected files without aborting the import', async () => {
    const unreadable = makeUnreadableFile('locked.jsonl', '.codex/sessions/locked.jsonl');
    const readable = makeFile(
      'codex.jsonl',
      '.codex/sessions/codex.jsonl',
      [
        JSON.stringify({ timestamp: '2026-06-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'codex-session-1' } }),
        JSON.stringify({ timestamp: '2026-06-01T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.5' } }),
        JSON.stringify({
          timestamp: '2026-06-01T10:00:02.000Z',
          type: 'token_count',
          payload: {
            info: {
              total_token_usage: {
                input_tokens: 10,
                output_tokens: 4,
              },
            },
          },
        }),
      ].join('\n'),
    );

    const result = await parseUsageFiles([unreadable, readable]);

    expect(result.events).toHaveLength(1);
    expect(result.skippedFiles).toBe(1);
    expect(result.warnings).toContain(
      'Skipped an unreadable JSON/JSONL file because the browser could not read it after folder selection.',
    );
  });
});
