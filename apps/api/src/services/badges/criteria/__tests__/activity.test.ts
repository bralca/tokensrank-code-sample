import { describe, expect, it } from 'vitest';

import { evaluateIronStreak } from '../iron_streak';
import { evaluateMarathoner } from '../marathoner';
import { evaluateOperator } from '../operator';
import { aggregateFixture, consecutiveAggregates, profileFixture, sessionFixture } from './fixtures';

describe('activity badge criteria', () => {
  describe('evaluateIronStreak', () => {
    it('passes with 30 consecutive active aggregate days', () => {
      const result = evaluateIronStreak(profileFixture, [], consecutiveAggregates(30), {});

      expect(result.earned).toBe(true);
      expect(result.evidence.consecutive_days).toBe(30);
    });

    it('fails when aggregate dates have a gap', () => {
      const result = evaluateIronStreak(profileFixture, [], [
        ...consecutiveAggregates(10),
        aggregateFixture({ date: '2026-02-15', total_sessions: 1 }),
      ], {});

      expect(result.earned).toBe(false);
      expect(result.evidence.consecutive_days).toBe(10);
    });

    it('falls back to session dates when aggregate rows are missing', () => {
      const sessions = Array.from({ length: 30 }, (_, index) => sessionFixture({
        session_id: `streak-session-${index}`,
        first_event_at: new Date(Date.UTC(2026, 0, index + 1, 12)).toISOString(),
      }));

      const result = evaluateIronStreak(profileFixture, sessions, [], {});

      expect(result.earned).toBe(true);
      expect(result.evidence.consecutive_days).toBe(30);
    });
  });

  describe('evaluateOperator', () => {
    it('passes when active-day average sessions reach the threshold', () => {
      const result = evaluateOperator(profileFixture, [], [
        aggregateFixture({ date: '2026-04-01', total_sessions: 12 }),
        aggregateFixture({ date: '2026-04-02', total_sessions: 10 }),
      ], {});

      expect(result.earned).toBe(true);
      expect(result.evidence.sessions_per_day_avg).toBe(11);
    });

    it('fails with sparse low-session aggregate data', () => {
      const result = evaluateOperator(profileFixture, [], [
        aggregateFixture({ date: '2026-04-01', total_sessions: 3 }),
        aggregateFixture({ date: '2026-04-03', total_sessions: 5 }),
      ], {});

      expect(result.earned).toBe(false);
      expect(result.evidence.sessions_per_day_avg).toBe(4);
    });

    it('falls back to session dates when aggregate rows are missing', () => {
      const sessions = Array.from({ length: 10 }, (_, index) => sessionFixture({
        session_id: `operator-session-${index}`,
        first_event_at: '2026-04-01T12:00:00.000Z',
      }));

      const result = evaluateOperator(profileFixture, sessions, [], {});

      expect(result.earned).toBe(true);
      expect(result.evidence.sessions_per_day_avg).toBe(10);
    });
  });

  describe('evaluateMarathoner', () => {
    it('passes when a session lasts at least six hours', () => {
      const result = evaluateMarathoner(profileFixture, [
        sessionFixture({
          first_event_at: '2026-04-01T00:00:00.000Z',
          last_event_at: '2026-04-01T06:00:00.000Z',
        }),
      ], [], {});

      expect(result.earned).toBe(true);
      expect(result.evidence.max_session_hours).toBe(6);
    });

    it('fails when malformed or short durations are present', () => {
      const result = evaluateMarathoner(profileFixture, [
        sessionFixture({
          first_event_at: 'invalid',
          last_event_at: '2026-04-01T06:00:00.000Z',
        }),
        sessionFixture({
          session_id: 'short',
          first_event_at: '2026-04-01T00:00:00.000Z',
          last_event_at: '2026-04-01T05:59:00.000Z',
        }),
      ], [], {});

      expect(result.earned).toBe(false);
      expect(result.evidence.session_id).toBe('short');
    });
  });
});
