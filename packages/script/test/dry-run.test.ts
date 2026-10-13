import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IngestRequestSchema, type IngestRequest, type SessionPayload } from '@tokensrank/shared';
import { describe, expect, it } from 'vitest';

import { parseClaudeJsonl } from '../src/extractors/claude.js';
import { parseCodexJsonl } from '../src/extractors/codex.js';
import {
  formatBatchPayload,
  formatDryRunHeader,
  formatSessionsSummary,
  validatePayloadPrivacy,
} from '../src/runtime/dry-run.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const fixturesRoot = path.join(repoRoot, 'packages/script/test/fixtures');

function makeSession(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    session_id: 'session-1',
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

function makePayload(sessions: SessionPayload[] = [makeSession()]): IngestRequest {
  return {
    client: {
      version: '0.0.1',
      install_id: '11111111-1111-4111-8111-111111111111',
      platform: 'darwin',
      arch: 'arm64',
    },
    run: {
      run_id: 'dry-run-test',
      started_at: '2026-04-27T10:00:00.000Z',
      finished_at: '2026-04-27T10:06:00.000Z',
    },
    sessions,
  };
}

describe('formatDryRunHeader', () => {
  it('prints the required dry-run banner with plural batch text', () => {
    expect(formatDryRunHeader({ sessionCount: 3, batchCount: 2 })).toBe(
      'Dry-run mode: would send 3 sessions in 2 batch(es)',
    );
  });

  it('prints zero-session dry-run details', () => {
    expect(formatDryRunHeader({ sessionCount: 0, batchCount: 0 })).toContain('0 sessions in 0 batch(es)');
  });

  it('does not include network or state side-effect language', () => {
    expect(formatDryRunHeader({ sessionCount: 1, batchCount: 1 })).not.toMatch(/POST|state\.json|lock/iu);
  });
});

describe('formatBatchPayload', () => {
  it('returns valid JSON when called without batch labels', () => {
    const payload = makePayload();
    const formatted = formatBatchPayload(payload);

    expect(JSON.parse(formatted)).toEqual(payload);
  });

  it('uses two-space indentation for nested payloads', () => {
    const formatted = formatBatchPayload(makePayload());

    expect(formatted).toContain('\n  "client": {');
    expect(formatted).toContain('\n    "version": "0.0.1"');
  });

  it('preserves shared ingest schema validity', () => {
    const parsed = JSON.parse(formatBatchPayload(makePayload())) as unknown;

    expect(IngestRequestSchema.safeParse(parsed).success).toBe(true);
  });

  it('adds a batch label when batch position is provided', () => {
    const formatted = formatBatchPayload(makePayload(), { batchIndex: 1, batchCount: 3 });

    expect(formatted.startsWith('Dry-run batch 1/3\n{')).toBe(true);
  });

  it('keeps labeled payload JSON parseable after the first line', () => {
    const formatted = formatBatchPayload(makePayload(), { batchIndex: 2, batchCount: 3 });
    const json = formatted.split('\n').slice(1).join('\n');

    expect(JSON.parse(json)).toEqual(makePayload());
  });
});

describe('formatSessionsSummary', () => {
  it('summarizes total session count', () => {
    expect(formatSessionsSummary([makeSession(), makeSession({ session_id: 'session-2' })])).toContain('total: 2');
  });

  it('counts sessions by source', () => {
    const summary = formatSessionsSummary([
      makeSession({ source: 'claude', session_id: 'claude-1' }),
      makeSession({ source: 'codex', session_id: 'codex-1' }),
      makeSession({ source: 'codex', session_id: 'codex-2' }),
    ]);

    expect(summary).toContain('- claude: 1');
    expect(summary).toContain('- codex: 2');
  });

  it('counts sessions by model', () => {
    const summary = formatSessionsSummary([
      makeSession({ model: 'claude-3-5-sonnet-20241022', session_id: 'claude-1' }),
      makeSession({ model: 'gpt-5.2-codex', session_id: 'codex-1', source: 'codex' }),
    ]);

    expect(summary).toContain('- claude-3-5-sonnet-20241022: 1');
    expect(summary).toContain('- gpt-5.2-codex: 1');
  });

  it('renders an empty summary without throwing', () => {
    const summary = formatSessionsSummary([]);

    expect(summary).toContain('total: 0');
    expect(summary).toContain('- none: 0');
  });
});

describe('validatePayloadPrivacy', () => {
  it('accepts a clean ingest payload', () => {
    expect(validatePayloadPrivacy(makePayload())).toEqual({ isClean: true, issues: [] });
  });

  it('rejects a forbidden prompt field', () => {
    const payload = makePayload([{ ...makeSession(), prompt: 'private request' } as SessionPayload]);

    expect(validatePayloadPrivacy(payload).issues.join('\n')).toMatch(/prompt/u);
  });

  it('rejects a forbidden response field', () => {
    const payload = makePayload([{ ...makeSession(), response: 'private answer' } as SessionPayload]);

    expect(validatePayloadPrivacy(payload).isClean).toBe(false);
  });

  it('rejects a project name field', () => {
    const payload = makePayload([{ ...makeSession(), project_name: 'secret' } as SessionPayload]);

    expect(validatePayloadPrivacy(payload).issues.join('\n')).toMatch(/project_name/u);
  });

  it('rejects private-looking path values', () => {
    const payload = makePayload([makeSession({ session_id: '/Users/alice/private' })]);

    expect(validatePayloadPrivacy(payload).issues.join('\n')).toMatch(/forbidden private-looking value/u);
  });

  it('rejects private-looking IP values', () => {
    const payload = makePayload([makeSession({ model: '127.0.0.1' })]);

    expect(validatePayloadPrivacy(payload).isClean).toBe(false);
  });

  it('rejects schema-invalid payloads', () => {
    const payload = makePayload([makeSession({ file_sha256: 'bad-sha' })]);

    expect(validatePayloadPrivacy(payload).issues.join('\n')).toMatch(/file_sha256/u);
  });
});

describe('dry-run formatting integration', () => {
  it('formats fixture-derived sessions as valid inspectable output', async () => {
    const claudeJsonl = await readFile(path.join(fixturesRoot, 'claude/privacy-sample.jsonl'), 'utf8');
    const codexJsonl = await readFile(path.join(fixturesRoot, 'codex/privacy-sample.jsonl'), 'utf8');
    const sessions = [
      ...parseClaudeJsonl(claudeJsonl).sessions,
      ...parseCodexJsonl(codexJsonl, { sessionId: 'codex-session-opaque' }).sessions,
    ];
    const payload = makePayload(sessions);
    const output = [
      formatDryRunHeader({ sessionCount: sessions.length, batchCount: 1 }),
      formatSessionsSummary(sessions),
      formatBatchPayload(payload),
    ].join('\n\n');

    expect(output).toContain('Dry-run mode: would send 3 sessions in 1 batch(es)');
    expect(output).toContain('- claude: 2');
    expect(output).toContain('- codex: 1');
    expect(validatePayloadPrivacy(payload).isClean).toBe(true);
    expect(IngestRequestSchema.safeParse(JSON.parse(formatBatchPayload(payload))).success).toBe(true);
  });
});
