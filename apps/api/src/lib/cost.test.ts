import { describe, it, expect } from 'vitest';

import { providerForSource, lookupRate, costForSession, pricingKey, type PricingMap } from './cost';

const pricing: PricingMap = new Map([
  [pricingKey('anthropic', 'claude-sonnet-4-6'), { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 }],
  [pricingKey('openai', 'gpt-5-codex'), { input: 1.25, output: 10, cache_read: 0.125, cache_write: null }],
  [pricingKey('anthropic', 'claude-haiku-4-5'), { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 }],
]);

const zero = { cache_read_tokens: 0, cache_create_tokens: 0, cached_tokens: 0, reasoning_tokens: 0 };

describe('providerForSource', () => {
  it('maps source first, then model prefix', () => {
    expect(providerForSource('claude', 'anything')).toBe('anthropic');
    expect(providerForSource('codex', 'anything')).toBe('openai');
    expect(providerForSource('', 'claude-opus-4-7')).toBe('anthropic');
    expect(providerForSource('', 'gpt-5.4')).toBe('openai');
    expect(providerForSource('', 'o3-mini')).toBe('openai');
    expect(providerForSource('', 'mystery')).toBeNull();
  });
});

describe('lookupRate fallback chain', () => {
  it('exact match', () => {
    expect(lookupRate(pricing, 'anthropic', 'claude-sonnet-4-6')?.input).toBe(3);
  });
  it('strips a trailing -YYYYMMDD date suffix', () => {
    expect(lookupRate(pricing, 'anthropic', 'claude-haiku-4-5-20251001')?.input).toBe(1);
  });
  it('returns null when unknown', () => {
    expect(lookupRate(pricing, 'anthropic', '<synthetic>')).toBeNull();
  });
});

describe('costForSession — source-aware accounting', () => {
  it('Anthropic: input is uncached, cache read/create separate', () => {
    const { costUsd, matched } = costForSession(
      { source: 'claude', model: 'claude-sonnet-4-6', input_tokens: 12000, output_tokens: 500, ...zero },
      pricing,
    );
    // 12000*3/1e6 + 500*15/1e6 = 0.036 + 0.0075
    expect(matched).toBe(true);
    expect(costUsd).toBeCloseTo(0.0435, 6);
  });

  it('Codex: input_tokens includes cached → subtract, no double-count', () => {
    const { costUsd, matched } = costForSession(
      { source: 'codex', model: 'gpt-5-codex', input_tokens: 741745, output_tokens: 22120, cached_tokens: 648960, cache_read_tokens: 0, cache_create_tokens: 0, reasoning_tokens: 17792 },
      pricing,
    );
    // (741745-648960)*1.25/1e6 + 648960*0.125/1e6 + 22120*10/1e6  (reasoning NOT added — subset of output)
    const expected = (741745 - 648960) * 1.25 / 1e6 + 648960 * 0.125 / 1e6 + 22120 * 10 / 1e6;
    expect(matched).toBe(true);
    expect(costUsd).toBeCloseTo(expected, 6);
  });

  it('unknown model contributes $0 + matched=false (no fabricated cost)', () => {
    const { costUsd, matched } = costForSession(
      { source: 'claude', model: '<synthetic>', input_tokens: 1000, output_tokens: 0, ...zero },
      pricing,
    );
    expect(matched).toBe(false);
    expect(costUsd).toBe(0);
  });
});
