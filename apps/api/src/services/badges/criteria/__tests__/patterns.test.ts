import { describe, expect, it } from 'vitest';

import { evaluateCacheWhisperer } from '../cache_whisperer';
import { evaluateNightOwl } from '../night_owl';
import { evaluateReasoningJunkie } from '../reasoning_junkie';
import { profileFixture, sessionFixture } from './fixtures';

describe('pattern badge criteria', () => {
  describe('evaluateNightOwl', () => {
    it('passes when at least half of valid sessions start between 22:00 and 06:00 UTC', () => {
      const result = evaluateNightOwl(profileFixture, [
        sessionFixture({ first_event_at: '2026-04-01T22:00:00.000Z' }),
        sessionFixture({ first_event_at: '2026-04-02T03:00:00.000Z' }),
        sessionFixture({ first_event_at: '2026-04-02T12:00:00.000Z' }),
        sessionFixture({ first_event_at: '2026-04-02T13:00:00.000Z' }),
      ], [], {});

      expect(result.earned).toBe(true);
      expect(result.evidence.night_session_ratio).toBe(0.5);
    });

    it('fails safely when there are no valid timestamps', () => {
      const result = evaluateNightOwl(profileFixture, [
        sessionFixture({ first_event_at: 'invalid' }),
      ], [], {});

      expect(result.earned).toBe(false);
      expect(result.evidence.valid_sessions).toBe(0);
    });
  });

  describe('evaluateCacheWhisperer', () => {
    it('passes when cache-read ratio reaches 30 percent', () => {
      const result = evaluateCacheWhisperer(profileFixture, [
        sessionFixture({
          input_tokens: 70,
          cache_read_tokens: 30,
          output_tokens: 0,
        }),
      ], [], {});

      expect(result.earned).toBe(true);
      expect(result.evidence.cache_read_ratio).toBe(0.3);
    });

    it('fails at zero tokens without dividing by zero', () => {
      const result = evaluateCacheWhisperer(profileFixture, [
        sessionFixture({
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
        }),
      ], [], {});

      expect(result.earned).toBe(false);
      expect(result.evidence.cache_read_ratio).toBe(0);
    });
  });

  describe('evaluateReasoningJunkie', () => {
    it('passes with reasoning tokens over 10 percent of total usage', () => {
      const result = evaluateReasoningJunkie(profileFixture, [
        sessionFixture({
          input_tokens: 80,
          output_tokens: 10,
          reasoning_tokens: 10,
        }),
      ], [], {});

      expect(result.earned).toBe(true);
      expect(result.evidence.reasoning_ratio).toBe(0.1);
    });

    it('fails when reasoning tokens exist but ratio is too low', () => {
      const result = evaluateReasoningJunkie(profileFixture, [
        sessionFixture({
          input_tokens: 990,
          output_tokens: 0,
          reasoning_tokens: 10,
        }),
      ], [], {});

      expect(result.earned).toBe(false);
      expect(result.evidence.reasoning_ratio).toBe(0.01);
    });
  });
});
