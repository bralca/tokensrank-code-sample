import { describe, expect, it } from 'vitest';

import { LocalPublishPayloadSchema } from '../publish.js';

const usageRow = {
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
};

describe('LocalPublishPayloadSchema', () => {
  it('limits evidence to the reviewed sources and requires opting in to code coverage', () => {
    const payload = {
      schema_version: 2, client_version: 'test', generated_at: '2026-06-04T12:00:00.000Z',
      github_user_id: 123, selected_repos: [], usage_daily: [usageRow], model_daily: [usageRow], pricing_snapshot: [],
      summary: { total_tokens: 100, total_cost_usd: 1, sessions_count: 1, produced_loc_total: 0,
        github_shipped_loc_total: 0, ai_linked_shipped_loc_total: 0 },
      privacy_report: { prompts_sent: 0, raw_commands_sent: 0, file_contents_sent: 0, absolute_paths_sent: 0, raw_transcripts_sent: 0 },
      usage_evidence: { version: 1, sources: [{source: 'codex', daily_basis: 'event_dates', read_at: null, unpriced_models: [] as string[]}], attribution: null },
    };
    expect(LocalPublishPayloadSchema.safeParse(payload).success).toBe(true);
    expect(LocalPublishPayloadSchema.safeParse({...payload, usage_evidence: {...payload.usage_evidence, sources: []}}).success).toBe(false);
    expect(LocalPublishPayloadSchema.safeParse({...payload, usage_evidence: {...payload.usage_evidence, attribution: {sessions:1,linked_sessions:1}}}).success).toBe(false);
    payload.usage_evidence.sources[0]!.unpriced_models = ['invented-model'];
    expect(LocalPublishPayloadSchema.safeParse(payload).success).toBe(false);
    payload.usage_evidence.sources[0]!.unpriced_models = ['gpt-5.5'];
    expect(LocalPublishPayloadSchema.safeParse(payload).success).toBe(true);
  });
  it('defaults model_daily for older local clients', () => {
    const parsed = LocalPublishPayloadSchema.parse({
      schema_version: 1,
      client_version: 'test',
      generated_at: '2026-06-04T12:00:00.000Z',
      github_user_id: 123,
      selected_repos: [],
      usage_daily: [usageRow],
      pricing_snapshot: [
        {
          provider: 'openai',
          model_id: 'gpt-5.5',
          content_hash: '0123456789abcdef0123456789abcdef',
        },
      ],
      summary: {
        total_tokens: 100,
        total_cost_usd: 1,
        sessions_count: 1,
        produced_loc_total: 0,
        github_shipped_loc_total: 0,
        ai_linked_shipped_loc_total: 0,
      },
      privacy_report: {
        prompts_sent: 0,
        raw_commands_sent: 0,
        file_contents_sent: 0,
        absolute_paths_sent: 0,
        raw_transcripts_sent: 0,
      },
    });

    expect(parsed.model_daily).toEqual([]);
  });

  it('accepts first-class model_daily aggregates', () => {
    const parsed = LocalPublishPayloadSchema.parse({
      schema_version: 1,
      client_version: 'test',
      generated_at: '2026-06-04T12:00:00.000Z',
      github_user_id: 123,
      selected_repos: [],
      usage_daily: [usageRow],
      model_daily: [usageRow],
      pricing_snapshot: [
        {
          provider: 'openai',
          model_id: 'gpt-5.5',
          content_hash: '0123456789abcdef0123456789abcdef',
        },
      ],
      summary: {
        total_tokens: 100,
        total_cost_usd: 1,
        sessions_count: 1,
        produced_loc_total: 0,
        github_shipped_loc_total: 0,
        ai_linked_shipped_loc_total: 0,
      },
      privacy_report: {
        prompts_sent: 0,
        raw_commands_sent: 0,
        file_contents_sent: 0,
        absolute_paths_sent: 0,
        raw_transcripts_sent: 0,
      },
    });

    expect(parsed.model_daily).toEqual([usageRow]);
  });
});
