import { describe, expect, it } from 'vitest';
import type { LocalPublishPayload } from '@tokensrank/shared';

import { comparePricingSnapshotToHostedRows } from './local-publish-pricing';

function payload(overrides: Partial<LocalPublishPayload> = {}): LocalPublishPayload {
  return {
    schema_version: 1,
    client_version: 'test',
    generated_at: '2026-06-04T12:00:00.000Z',
    github_user_id: 123,
    selected_repos: [],
    usage_daily: [
      {
        date: '2026-06-04',
        source: 'codex',
        provider: 'openai',
        model: 'gpt-5.5',
        total_tokens: 100,
        input_tokens: 60,
        output_tokens: 40,
        cache_read_tokens: 0,
        cache_create_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
        total_sessions: 1,
        event_count: 1,
        cost_usd_total: 1,
      },
    ],
    model_daily: [
      {
        date: '2026-06-04',
        source: 'codex',
        provider: 'openai',
        model: 'gpt-5.5',
        total_tokens: 100,
        input_tokens: 60,
        output_tokens: 40,
        cache_read_tokens: 0,
        cache_create_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
        total_sessions: 1,
        event_count: 1,
        cost_usd_total: 1,
      },
    ],
    usage_session_rollups: [],
    produced_code_daily: [],
    github_code_daily: [],
    ai_linked_code_daily: [],
    model_code_daily: [],
    pricing_snapshot: [
      {
        provider: 'openai',
        model_id: 'gpt-5.5',
        content_hash: 'local-hash',
      },
    ],
    summary: {
      total_tokens: 100,
      total_cost_usd: 1,
      sessions_count: 1,
      produced_loc_total: 0,
      produced_loc_score_total: 0,
      github_shipped_loc_total: 0,
      github_shipped_loc_score_total: 0,
      ai_linked_shipped_loc_total: 0,
      ai_linked_shipped_loc_score_total: 0,
    },
    privacy_report: {
      prompts_sent: 0,
      raw_commands_sent: 0,
      file_contents_sent: 0,
      absolute_paths_sent: 0,
      raw_transcripts_sent: 0,
    },
    ...overrides,
  };
}

describe('comparePricingSnapshotToHostedRows', () => {
  it('reports hash mismatches for used local pricing rows', () => {
    const mismatches = comparePricingSnapshotToHostedRows(payload(), [
      { provider: 'openai', model_id: 'gpt-5.5', content_hash: 'hosted-hash' },
    ]);

    expect(mismatches).toEqual([
      'openai:gpt-5.5: pricing hash differs from hosted reference',
    ]);
  });

  it('reports used models missing from the local pricing snapshot', () => {
    const mismatches = comparePricingSnapshotToHostedRows(payload({ pricing_snapshot: [] }), [
      { provider: 'openai', model_id: 'gpt-5.5', content_hash: 'hosted-hash' },
    ]);

    expect(mismatches).toEqual([
      'openai:gpt-5.5: local pricing snapshot missing for used model',
    ]);
  });

  it('does not report unused local-only snapshot rows', () => {
    const mismatches = comparePricingSnapshotToHostedRows(payload({
      pricing_snapshot: [
        { provider: 'openai', model_id: 'gpt-5.5', content_hash: 'same-hash' },
        { provider: 'openai', model_id: 'unused-model', content_hash: 'local-only' },
      ],
    }), [
      { provider: 'openai', model_id: 'gpt-5.5', content_hash: 'same-hash' },
    ]);

    expect(mismatches).toEqual([]);
  });
});
