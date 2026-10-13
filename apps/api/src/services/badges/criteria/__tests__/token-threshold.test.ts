import { describe, expect, it } from 'vitest';

import { evaluateDetonation } from '../detonation';
import { evaluateLongContext } from '../long_context';
import { evaluateTier } from '../tier';
import { aggregateFixture, profileFixture, sessionFixture } from './fixtures';

describe('token threshold badge criteria', () => {
  describe('evaluateTier', () => {
    it('passes when total session tokens reach the threshold', () => {
      const result = evaluateTier(profileFixture, [
        sessionFixture({ total_tokens: 20_000_000 }),
        sessionFixture({ session_id: 'session-2', total_tokens: 5_000_000 }),
      ], [], {});

      expect(result.earned).toBe(true);
      expect(result.evidence.tokens_total).toBe(25_000_000);
    });

    it('fails cleanly for an empty snapshot', () => {
      const result = evaluateTier(profileFixture, [], [], {});

      expect(result.earned).toBe(false);
      expect(result.evidence.tokens_total).toBe(0);
    });
  });

  describe('evaluateDetonation', () => {
    it('passes when a single UTC day peaks above the daily token threshold', () => {
      const result = evaluateDetonation(profileFixture, [], [
        aggregateFixture({ date: '2026-04-01', total_tokens: 6_000_000 }),
        aggregateFixture({ date: '2026-04-01', source: 'codex', model: 'codex', total_tokens: 4_100_000 }),
      ], {});

      expect(result.earned).toBe(true);
      expect(result.evidence.peak_daily_tokens).toBe(10_100_000);
      expect(result.evidence.peak_date).toBe('2026-04-01');
    });

    it('fails when no day reaches the burst threshold', () => {
      const result = evaluateDetonation(profileFixture, [], [
        aggregateFixture({ date: '2026-04-01', total_tokens: 9_999_999 }),
      ], {});

      expect(result.earned).toBe(false);
      expect(result.evidence.peak_daily_tokens).toBe(9_999_999);
    });

    it('falls back to session timestamps when aggregate data is absent', () => {
      const result = evaluateDetonation(profileFixture, [
        sessionFixture({
          first_event_at: '2026-04-01T01:00:00.000Z',
          total_tokens: 5_000_000,
        }),
        sessionFixture({
          session_id: 'session-2',
          first_event_at: '2026-04-01T02:00:00.000Z',
          total_tokens: 5_100_000,
        }),
      ], [], {});

      expect(result.earned).toBe(true);
      expect(result.evidence.peak_daily_tokens).toBe(10_100_000);
    });
  });

  describe('evaluateLongContext', () => {
    it('passes when one session has enough input plus cache context tokens', () => {
      const result = evaluateLongContext(profileFixture, [
        sessionFixture({
          input_tokens: 70_000,
          cache_read_tokens: 20_000,
          cache_create_tokens: 10_000,
        }),
      ], [], {});

      expect(result.earned).toBe(true);
      expect(result.evidence.max_context_tokens).toBe(100_000);
    });

    it('fails when all context windows are below threshold', () => {
      const result = evaluateLongContext(profileFixture, [
        sessionFixture({ input_tokens: 99_999 }),
      ], [], {});

      expect(result.earned).toBe(false);
      expect(result.evidence.max_context_tokens).toBe(99_999);
    });
  });
});
