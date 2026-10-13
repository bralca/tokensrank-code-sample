import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.SUPABASE_URL ??= 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';
});

import {
  computeScore,
  computeSessionMetrics,
  computeStreaksFromDates,
  computeWindowRichMetrics,
  type DaySeries,
  type ProfileWindow,
} from './scoring';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

function dayStr(offset: number): string {
  return new Date(NOW - offset * DAY_MS).toISOString().slice(0, 10);
}

function series(entries: Array<[number, number]>): DaySeries {
  const map: DaySeries = new Map();
  for (const [offset, value] of entries) {
    map.set(dayStr(offset), (map.get(dayStr(offset)) ?? 0) + value);
  }
  return map;
}

function score(window: ProfileWindow, tokens: DaySeries, shipped: DaySeries): number {
  return computeScore({ window, nowMs: NOW, tokensByDay: tokens, shippedByDay: shipped }).score;
}

describe('computeScore — anti-fake properties', () => {
  it('a token-only faker (no shipped code) scores ~0', () => {
    const faker = score('30d', series([[0, 50_000_000]]), series([]));
    expect(faker).toBe(0);
  });

  it('a real builder (tokens + shipped) outranks a huge-token faker', () => {
    const faker = score('30d', series([[0, 50_000_000]]), series([]));
    const real = score('30d',
      series(Array.from({ length: 20 }, (_, i): [number, number] => [i, 250_000])),
      series(Array.from({ length: 20 }, (_, i): [number, number] => [i, 30])),
    );
    expect(real).toBeGreaterThan(faker);
    expect(real).toBeGreaterThan(0);
  });

  it('token inflation has steeply diminishing returns (geometric mean + log)', () => {
    const base = score('all', series([[1, 1_000_000]]), series([[1, 100]]));
    const inflated = score('all', series([[1, 10_000_000]]), series([[1, 100]])); // 10x tokens, same shipped
    expect(inflated).toBeGreaterThan(base);
    expect(inflated).toBeLessThan(base * 1.2); // 10x tokens -> <20% score gain
  });

  it('consistency rewards steady activity over a one-day dump', () => {
    const steady = score('7d',
      series(Array.from({ length: 6 }, (_, i): [number, number] => [i, 1_000_000])),
      series(Array.from({ length: 6 }, (_, i): [number, number] => [i, 100])),
    );
    const spike = score('7d', series([[0, 6_000_000]]), series([[0, 600]]));
    expect(steady).toBeGreaterThan(spike);
  });

  it('reports window totals and active days', () => {
    const r = computeScore({
      window: '7d',
      nowMs: NOW,
      tokensByDay: series([[0, 100], [1, 200], [40, 999]]), // day 40 is outside 7d
      shippedByDay: series([[0, 10]]),
    });
    expect(r.tokensTotal).toBe(300); // day-40 excluded
    expect(r.daysActive).toBe(2);
  });
});

describe('computeStreaksFromDates', () => {
  it('counts consecutive active days ending today', () => {
    const dates = [dayStr(2), dayStr(1), dayStr(0)].sort();
    expect(computeStreaksFromDates(dates, NOW)).toEqual({ current: 3, longest: 3 });
  });

  it('breaks the current streak on a gap but reports the longest run', () => {
    const dates = [dayStr(10), dayStr(9), dayStr(8), dayStr(3), dayStr(2), dayStr(1), dayStr(0)].sort();
    const r = computeStreaksFromDates(dates, NOW);
    expect(r.current).toBe(4); // offsets 3,2,1,0
    expect(r.longest).toBe(4);
  });
});

describe('computeWindowRichMetrics', () => {
  it('breaks down models + sources, counts distinct models, and finds streaks', () => {
    const rows = [
      { profile_id: 'p', date: dayStr(0), total_tokens: 100, total_sessions: 1, source: 'claude', model: 'sonnet' },
      { profile_id: 'p', date: dayStr(0), total_tokens: 50, total_sessions: 1, source: 'codex', model: 'gpt' },
      { profile_id: 'p', date: dayStr(1), total_tokens: 200, total_sessions: 1, source: 'claude', model: 'sonnet' },
    ] as Parameters<typeof computeWindowRichMetrics>[0];

    const m = computeWindowRichMetrics(rows, 'all', NOW);

    expect(m.distinctModels).toBe(2);
    expect(m.models[0]).toMatchObject({ model: 'sonnet', tokens: 300 });
    expect(m.models[0]).toHaveProperty('tokens14dCurr');
    expect(m.tools).toEqual({ claude: 300, codex: 50, opencode: 0 });
    expect(m.longestStreak).toBe(2);
    expect(m.firstModel?.name).toBe('sonnet');
  });
});

describe('computeSessionMetrics', () => {
  it('computes hourly histogram, after-midnight, and duration stats', () => {
    const sessions = [
      { profile_id: 'p', first_event_at: `${dayStr(0)}T10:00:00Z`, last_event_at: `${dayStr(0)}T10:30:00Z`, total_tokens: 100000 },
      { profile_id: 'p', first_event_at: `${dayStr(0)}T02:00:00Z`, last_event_at: `${dayStr(0)}T04:00:00Z`, total_tokens: 200000 },
    ] as Parameters<typeof computeSessionMetrics>[0];

    const m = computeSessionMetrics(sessions, 'all', NOW);

    expect(m.longest_session_seconds).toBe(7200);
    expect(m.sessions_over_1h).toBe(1);
    expect(m.total_session_time_seconds).toBe(9000);
    expect(m.after_midnight.count).toBe(1); // hour 04:00 UTC
    expect(m.hourly[10]).toBe(1);
    expect(m.hourly[4]).toBe(1);
    expect(m.largest_tokens_session_tokens).toBe(200000);
  });
});
