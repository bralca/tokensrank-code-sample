import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { parseUsageFile } from './parser.js';

async function writeJsonl(filePath: string, records: unknown[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n'), 'utf8');
}

describe('parseUsageFile tool evidence', () => {
  it('extracts Codex direct commit evidence without storing raw commands or output', async () => {
    const root = await mkdir(path.join(os.tmpdir(), `tokensrank-codex-${Date.now()}`), { recursive: true });
    const filePath = path.join(root!, '.codex', 'sessions', 'rollout.jsonl');
    const commitSha = 'abcdef1234567890abcdef1234567890abcdef12';
    await writeJsonl(filePath, [
      {
        type: 'session_meta',
        timestamp: '2026-06-01T10:00:00.000Z',
        payload: {
          type: 'session_meta',
          id: 'codex-session-1',
          cwd: '/Users/example/project',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-01T10:01:00.000Z',
        payload: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'git commit -m private-message' }),
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-01T10:02:00.000Z',
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: `[main ${commitSha}] private output`,
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-06-01T10:03:00.000Z',
        payload: {
          info: {
            model: 'gpt-5.5',
            last_token_usage: {
              input_tokens: 10,
              output_tokens: 5,
            },
          },
        },
      },
    ]);

    const parsed = await parseUsageFile(filePath);

    expect(parsed?.events).toHaveLength(1);
    expect(parsed?.events[0]?.model).toBe('gpt-5.5');
    const commitEvent = parsed?.tool_events.find((event) => event.commit_sha === commitSha);
    expect(commitEvent).toMatchObject({
      source: 'codex',
      session_id: 'codex-session-1',
      tool_name: 'exec_command',
      confidence: 0.9,
    });
    const storedMetadata = JSON.stringify(parsed?.tool_events.map((event) => event.metadata));
    expect(storedMetadata).not.toContain('private-message');
    expect(storedMetadata).not.toContain('private output');
    expect(storedMetadata).toContain('cwd_hash');
  });

  it('extracts Claude direct commit evidence from tool results without storing raw content', async () => {
    const root = await mkdir(path.join(os.tmpdir(), `tokensrank-claude-${Date.now()}`), { recursive: true });
    const filePath = path.join(root!, '.claude', 'projects', 'project', 'session.jsonl');
    const commitSha = 'fedcba9876543210fedcba9876543210fedcba98';
    await writeJsonl(filePath, [
      {
        type: 'assistant',
        sessionId: 'claude-session-1',
        timestamp: '2026-06-01T10:00:00.000Z',
        cwd: '/Users/example/project',
        message: {
          model: 'claude-opus-4-7',
          usage: {
            input_tokens: 12,
            output_tokens: 8,
          },
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'git commit -m private-message' },
            },
          ],
        },
      },
      {
        type: 'user',
        sessionId: 'claude-session-1',
        timestamp: '2026-06-01T10:01:00.000Z',
        cwd: '/Users/example/project',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: `created commit ${commitSha} with private output`,
            },
          ],
        },
      },
    ]);

    const parsed = await parseUsageFile(filePath);

    expect(parsed?.events).toHaveLength(1);
    expect(parsed?.events[0]?.model).toBe('claude-opus-4-7');
    const commitEvent = parsed?.tool_events.find((event) => event.commit_sha === commitSha);
    expect(commitEvent).toMatchObject({
      source: 'claude',
      session_id: 'claude-session-1',
      tool_name: 'Bash',
      confidence: 0.9,
    });
    const storedMetadata = JSON.stringify(parsed?.tool_events.map((event) => event.metadata));
    expect(storedMetadata).not.toContain('private-message');
    expect(storedMetadata).not.toContain('private output');
    expect(storedMetadata).toContain('cwd_hash');
  });

  it.each(['git log --oneline -1', 'git show --stat HEAD', 'git diff HEAD~1 HEAD'])(
    'does not treat %s output as commit evidence',
    async (command) => {
      const root = await mkdir(path.join(os.tmpdir(), `tokensrank-codex-inspect-${Date.now()}`), { recursive: true });
      const filePath = path.join(root!, '.codex', 'sessions', 'rollout.jsonl');
      const commitSha = '1234567abcdef1234567890abcdef1234567890';
      await writeJsonl(filePath, [
        {
          type: 'session_meta',
          timestamp: '2026-06-01T10:00:00.000Z',
          payload: {
            type: 'session_meta',
            id: 'codex-session-2',
            cwd: '/Users/example/project',
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-06-01T10:01:00.000Z',
          payload: {
            type: 'function_call',
            call_id: 'call-1',
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: command }),
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-06-01T10:02:00.000Z',
          payload: {
            type: 'function_call_output',
            call_id: 'call-1',
            output: `${commitSha} not a newly-created commit`,
          },
        },
      ]);

      const parsed = await parseUsageFile(filePath);

      expect(parsed?.tool_events.some((event) => event.commit_sha)).toBe(false);
      expect(parsed?.tool_events.some((event) => event.command_kind === 'git_inspection')).toBe(true);
    }
  );

  it('does not classify non-shell tool payload text as git commit evidence', async () => {
    const root = await mkdir(path.join(os.tmpdir(), `tokensrank-codex-nonshell-${Date.now()}`), { recursive: true });
    const filePath = path.join(root!, '.codex', 'sessions', 'rollout.jsonl');
    const commitSha = 'abcdef1234567890abcdef1234567890abcdef12';
    await writeJsonl(filePath, [
      {
        type: 'session_meta',
        timestamp: '2026-06-01T10:00:00.000Z',
        payload: {
          type: 'session_meta',
          id: 'codex-session-nonshell',
          cwd: '/Users/example/project',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-01T10:01:00.000Z',
        payload: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'apply_patch',
          arguments: JSON.stringify({ patch: 'Add copy mentioning git commit hash.' }),
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-01T10:02:00.000Z',
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: `Done ${commitSha}`,
        },
      },
    ]);

    const parsed = await parseUsageFile(filePath);

    expect(parsed?.tool_events.some((event) => event.command_kind === 'git_commit')).toBe(false);
    expect(parsed?.tool_events.some((event) => event.commit_sha)).toBe(false);
  });

  it('extracts OpenCode git commit evidence from the local SQLite database', async () => {
    const root = await mkdir(path.join(os.tmpdir(), `tokensrank-opencode-${Date.now()}`), { recursive: true });
    const dbPath = path.join(root!, '.local', 'share', 'opencode', 'opencode.db');
    await mkdir(path.dirname(dbPath), { recursive: true });
    const commitSha = 'abcdef1234567890abcdef1234567890abcdef12';
    const sqlite = new Database(dbPath);
    try {
      sqlite.exec(`
        CREATE TABLE session (
          id TEXT PRIMARY KEY,
          directory TEXT,
          time_created INTEGER,
          time_updated INTEGER
        );
        CREATE TABLE message (
          id TEXT,
          session_id TEXT,
          data TEXT
        );
        CREATE TABLE part (
          id TEXT,
          message_id TEXT,
          session_id TEXT,
          data TEXT,
          time_updated INTEGER
        );
      `);
      sqlite.prepare(`
        INSERT INTO session (id, directory, time_created, time_updated)
        VALUES ('open-session-1', '/Users/example/opencode-project', ?, ?)
      `).run(Date.parse('2026-06-01T09:00:00.000Z'), Date.parse('2026-06-01T10:00:00.000Z'));
      sqlite.prepare(`
        INSERT INTO message (id, session_id, data)
        VALUES ('message-1', 'open-session-1', ?)
      `).run(JSON.stringify({
        modelID: 'deepseek-chat-v3',
        providerID: 'opencode',
      }));
      sqlite.prepare(`
        INSERT INTO part (id, message_id, session_id, data, time_updated)
        VALUES ('part-1', 'message-1', 'open-session-1', ?, ?)
      `).run(JSON.stringify({
        type: 'tool',
        tool: 'bash',
        callID: 'call-1',
        state: {
          status: 'completed',
          input: {
            command: 'git commit -m private-message',
            workdir: '/Users/example/opencode-project',
          },
          output: `[main ${commitSha}] private output`,
        },
      }), Date.parse('2026-06-01T10:00:00.000Z'));
    } finally {
      sqlite.close();
    }

    const parsed = await parseUsageFile(dbPath);

    const commitEvent = parsed?.tool_events.find((event) => event.commit_sha === commitSha);
    expect(commitEvent).toMatchObject({
      source: 'opencode',
      session_id: 'open-session-1',
      tool_name: 'bash',
      provider: 'unknown',
      model: 'deepseek-chat-v3',
      command_kind: 'git_commit',
      confidence: 0.9,
    });
    const storedMetadata = JSON.stringify(parsed?.tool_events.map((event) => event.metadata));
    expect(storedMetadata).not.toContain('private-message');
    expect(storedMetadata).not.toContain('private output');
    expect(storedMetadata).toContain('command_hash');
    expect(storedMetadata).toContain('cwd_hash');
    expect(storedMetadata).not.toContain('/Users/example/opencode-project');
  });
});
