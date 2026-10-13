import { describe, expect, it } from 'vitest';

import { costForSession, pricingKey, type PricingMap } from './cost.js';

function pricing(): PricingMap {
  return new Map([
    [pricingKey('anthropic', 'claude-opus-4-7'), {
      input: 5,
      output: 25,
      cache_read: 0.5,
      cache_write: 6.25,
    }],
    [pricingKey('openai', 'gpt-5.5'), {
      input: 2,
      output: 10,
      cache_read: 0.2,
      cache_write: 2,
    }],
  ]);
}

describe('costForSession', () => {
  it('prices Anthropic input, cache read, cache create, and output separately', () => {
    const result = costForSession({
      source: 'claude',
      model: 'claude-opus-4-7',
      input_tokens: 1_000_000,
      output_tokens: 2_000_000,
      cache_read_tokens: 3_000_000,
      cache_create_tokens: 4_000_000,
      cached_tokens: 0,
      reasoning_tokens: 999_999,
    }, pricing());

    expect(result).toEqual({
      matched: true,
      costUsd: 5 + 50 + 1.5 + 25,
    });
  });

  it('prices OpenAI cached input at cache-read rate and does not double-count reasoning tokens', () => {
    const result = costForSession({
      source: 'codex',
      model: 'gpt-5.5',
      input_tokens: 3_000_000,
      output_tokens: 2_000_000,
      cache_read_tokens: 0,
      cache_create_tokens: 0,
      cached_tokens: 1_000_000,
      reasoning_tokens: 1_500_000,
    }, pricing());

    expect(result).toEqual({
      matched: true,
      costUsd: 4 + 0.2 + 20,
    });
  });

  it('returns zero and unmatched when models.dev has no rate', () => {
    const result = costForSession({
      source: 'codex',
      model: 'unknown-model',
      input_tokens: 3_000_000,
      output_tokens: 2_000_000,
      cache_read_tokens: 1_000_000,
      cache_create_tokens: 1_000_000,
      cached_tokens: 1_000_000,
      reasoning_tokens: 1_000_000,
    }, pricing());

    expect(result).toEqual({
      matched: false,
      costUsd: 0,
    });
  });

  it('matches dated and alias model ids without mutating the stored model id', () => {
    const result = costForSession({
      source: 'claude',
      model: 'claude-opus-4-7-20260416',
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_create_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
    }, pricing());

    expect(result).toEqual({
      matched: true,
      costUsd: 5,
    });
  });
});
