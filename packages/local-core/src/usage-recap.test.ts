import { describe, expect, it } from 'vitest';
import { UsageRecapSchema, type UsageEvidence } from '@tokensrank/shared';
import { buildUsageRecap } from './usage-recap.js';

const now = Date.parse('2026-09-14T12:00:00Z');
const evidence: UsageEvidence = { version: 1, sources: [{ source: 'codex', daily_basis: 'event_dates', read_at: '2026-09-14T08:00:00Z', unpriced_models: [] }], attribution: null };
const row = (date: string, tokens: number, model = 'model-a') => ({ date, source: 'codex', model, total_tokens: tokens, output_tokens: tokens / 4 });

describe('private recent usage recap', () => {
  it('compares equal complete UTC windows and retains today only in the all-time total', () => {
    const result = buildUsageRecap([row('2026-08-31', 40), row('2026-09-06', 60), row('2026-09-07', 100), row('2026-09-13', 100), row('2026-09-14', 500), row('2026-09-15', 1000)], evidence, now);
    expect(UsageRecapSchema.safeParse(result).success).toBe(true);
    expect(result.current).toMatchObject({ start: '2026-09-07', end: '2026-09-13', tokens: 200, output_tokens: 50, recorded_days: 2 });
    expect(result.previous).toMatchObject({ start: '2026-08-31', end: '2026-09-06', tokens: 100 });
    expect(result.current.days).toHaveLength(7);
    expect(result.current.days[1]!.tokens).toBe(0);
    expect(result.change_pct).toBe(100);
    expect(result.local_tokens_all_time).toBe(800);
  });
  it('uses the same UTC boundary regardless of an offset in the current time', () => {
    const result = buildUsageRecap([row('2026-09-13', 100), row('2026-09-14', 300)], evidence, Date.parse('2026-09-14T01:00:00+02:00'));
    expect(result.current.end).toBe('2026-09-12');
    expect(result.current.tokens).toBe(0);
    expect(result.local_tokens_all_time).toBe(100);
  });
  it('calculates model share changes as percentage points using exact recorded model IDs', () => {
    const result = buildUsageRecap([row('2026-08-31', 25, 'a'), row('2026-09-06', 75, 'b'), row('2026-09-07', 100, 'a'), row('2026-09-13', 100, 'b')], evidence, now);
    expect(result.models).toEqual(expect.arrayContaining([
      { model: 'a', tokens: 100, share: .5, previous_share: .25, change_points: 25 },
      { model: 'b', tokens: 100, share: .5, previous_share: .75, change_points: -25 },
    ]));
  });
  it('retains previously used models with zero recent tokens to make a model switch visible', () => {
    const result = buildUsageRecap([row('2026-08-31', 100, 'old-model'), row('2026-09-07', 200, 'new-model')], evidence, now);
    expect(result.models).toEqual([
      { model: 'new-model', tokens: 200, share: 1, previous_share: 0, change_points: 100 },
      { model: 'old-model', tokens: 0, share: 0, previous_share: 1, change_points: -100 },
    ]);
  });
  it('does not invent percentages for a zero baseline or a short history', () => {
    const zero = buildUsageRecap([row('2026-07-01', 1), row('2026-09-07', 10)], evidence, now);
    expect(zero.comparison).toBe('ready'); expect(zero.change_pct).toBeNull();
    expect(zero.models[0]!.change_points).toBeNull();
    const short = buildUsageRecap([row('2026-09-01', 10), row('2026-09-07', 50)], evidence, now);
    expect(short.comparison).toBe('short_history'); expect(short.change_pct).toBeNull();
    expect(short.models[0]!.previous_share).toBeNull();
  });
  it('withholds comparisons when any participating source is legacy, missing provenance, or stale', () => {
    const rows = [row('2026-08-31', 20), row('2026-09-07', 10)];
    for (const daily_basis of ['session_dates', 'event_dates'] as const) {
      const result = buildUsageRecap(rows, { ...evidence, sources: [{ ...evidence.sources[0]!, daily_basis, read_at: '2026-09-10T12:00:00Z' }] }, now);
      expect(result.comparison).toBe(daily_basis === 'session_dates' ? 'legacy_dates' : 'stale');
      expect(result.change_pct).toBeNull();
    }
    const mixed = buildUsageRecap([...rows, { ...row('2026-09-07', 5), source: 'opencode' }], evidence, now);
    expect(mixed.comparison).toBe('legacy_dates');
    expect(mixed.change_pct).toBeNull();
  });
  it('allows a recorded decrease to zero and leaves empty imports explicitly unavailable', () => {
    expect(buildUsageRecap([row('2026-08-31', 100)], evidence, now).change_pct).toBe(-100);
    const empty = buildUsageRecap([], evidence, now);
    expect(empty.comparison).toBe('no_data'); expect(empty.models).toEqual([]); expect(empty.change_pct).toBeNull();
  });
});
