import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readCcusageUsage, SUPPORTED_CCUSAGE_SOURCES, type CcusageRunner } from './ccusage.js';

describe('readCcusageUsage', () => {
  it('reads only supported focused sources and preserves model/session identity', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-ccusage-'));
    const calls: string[] = [];
    const runner: CcusageRunner = async (source, args) => {
      calls.push(`${source}:${args.join(' ')}`);
      if (source === 'claude') {
        return {
          sessions: [{
            sessionId: 'claude-session-1',
            firstActivity: '2026-06-01T09:00:00.000Z',
            lastActivity: '2026-06-01T10:00:00.000Z',
            totalCost: 1.25,
            modelBreakdowns: [{
              modelName: 'claude-opus-4-8',
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
              cost: 1.25,
            }],
          }],
        };
      }
      if (source === 'codex') {
        return {
          data: [{
            sessionFile: '/Users/example/.codex/sessions/2026/06/01/rollout-2026-06-01T00-00-00-0199dd25-41f6-7c41-9ff3-0b4fbb2cc90e.jsonl',
            lastActivity: '2026-06-01',
            totalCost: 2,
            models: {
              'gpt-5.5': {
                inputTokens: 200,
                outputTokens: 80,
                totalTokens: 280,
                cost: 2,
              },
            },
          }],
        };
      }
      return {
        sessions: [{
          sessionId: 'opencode-session-1',
          createdAt: '2026-06-01T11:00:00.000Z',
          updatedAt: '2026-06-01T12:00:00.000Z',
          totalTokens: 300,
          totalCost: 3,
          modelsUsed: ['deepseek-chat-v3'],
        }],
      };
    };

    const result = await readCcusageUsage({ homeDir, runner });

    expect(calls).toEqual(SUPPORTED_CCUSAGE_SOURCES.flatMap((source) => [`${source}:session --json`,`${source}:daily --json --timezone UTC`]));
    expect(result.sessions.map((session) => session.source)).toEqual(['claude', 'codex', 'opencode']);
    expect(result.modelSessions.map((session) => session.model)).toEqual([
      'claude-opus-4-8',
      'gpt-5.5',
      'deepseek-chat-v3',
    ]);
    expect(result.sessions.find((session) => session.source === 'codex')?.session_id).toBe('0199dd25-41f6-7c41-9ff3-0b4fbb2cc90e');
    expect(result.sessions.find((session) => session.source === 'opencode')?.provider).toBe('unknown');
  });

  it('warns when OpenCode sessions have multiple models without token splits', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-ccusage-'));
    const runner: CcusageRunner = async (source) => {
      if (source !== 'opencode') return { sessions: [] };
      return {
        sessions: [{
          sessionId: 'mixed-open-session',
          totalTokens: 300,
          totalCost: 3,
          modelsUsed: ['deepseek-chat-v3', 'qwen3-coder'],
        }],
      };
    };

    const result = await readCcusageUsage({ homeDir, runner });

    expect(result.modelSessions).toHaveLength(1);
    expect(result.modelSessions[0]).toMatchObject({
      source: 'opencode',
      session_id: 'mixed-open-session',
      model: 'unknown',
      total_tokens: 300,
    });
    expect(result.warnings[0]).toContain('multiple models');
  });
});

it('preserves a failed source while refreshing another source without double counting', async () => {
  const { openLocalStore } = await import('./db.js');
  const { writeCcusageRollups } = await import('./ccusage.js');
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-reader-recovery-'));
  const store = openLocalStore({ dataDir: homeDir });
  try {
    const runner: CcusageRunner = async source => ({ sessions: [{ sessionId: `${source}-1`, lastActivity: '2026-09-14', totalTokens: 100, modelsUsed: ['test-model'] }] });
    writeCcusageRollups(store.db, await readCcusageUsage({ homeDir, runner }));
    const recovered: CcusageRunner = async source => {
      if (source === 'codex') throw new Error('temporarily unavailable');
      return { sessions: [{ sessionId: `${source}-1`, lastActivity: '2026-09-14', totalTokens: 200, modelsUsed: ['test-model'] }] };
    };
    for (let i = 0; i < 2; i++) writeCcusageRollups(store.db, await readCcusageUsage({ homeDir, runner: recovered }));
    const rows = store.db.prepare('SELECT source, SUM(total_tokens) AS tokens FROM usage_daily_aggregates GROUP BY source ORDER BY source').all();
    expect(rows).toEqual([{ source: 'claude', tokens: 200 }, { source: 'codex', tokens: 100 }, { source: 'opencode', tokens: 200 }]);
  } finally { store.close(); }
});

it('does not apportion a combined session price across models in older reader reports', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'tokensrank-session-cost-'));
  const runner: CcusageRunner = async source => source === 'codex' ? { sessions: [{
    sessionId: 'session-without-model-prices', lastActivity: '2026-06-01', totalCost: 999,
    models: { first: {totalTokens: 50}, second: {totalTokens: 100} },
  }] } : {sessions: []};
  const result = await readCcusageUsage({homeDir,runner});
  expect(result.modelSessions.map(row=>({cost:row.cost_usd_total,missing:row.missing_price})))
    .toEqual([{cost:0,missing:true},{cost:0,missing:true}]);
});
