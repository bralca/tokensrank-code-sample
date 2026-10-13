import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildDateFilter,
  buildSourceFilter,
  countLeaderboardProfiles,
  formatLeaderboardResponse,
  queryLeaderboardBySummary,
  queryLeaderboardMv,
  type LeaderboardBadge,
  type LeaderboardProfileData,
  type RankedProfile,
  type RankDeltaMap,
} from './leaderboard';

const fixedNow = new Date('2026-04-28T12:00:00.000Z');

describe('buildDateFilter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns no filter for all time', () => {
    expect(buildDateFilter('all')).toEqual({
      startDate: null,
      sqlFragment: '',
    });
  });

  it('builds a 30 day filter against daily_aggregates', () => {
    const filter = buildDateFilter('30d');

    expect(filter.sqlFragment).toBe('AND daily_aggregates.date >= $1');
    expect(filter.startDate?.toISOString()).toBe('2026-03-29T12:00:00.000Z');
  });

  it('builds a 7 day filter against daily_aggregates', () => {
    const filter = buildDateFilter('7d');

    expect(filter.sqlFragment).toBe('AND daily_aggregates.date >= $1');
    expect(filter.startDate?.toISOString()).toBe('2026-04-21T12:00:00.000Z');
  });

  it('builds a 24 hour filter against daily_aggregates', () => {
    const filter = buildDateFilter('24h');

    expect(filter.sqlFragment).toBe('AND daily_aggregates.date >= $1');
    expect(filter.startDate?.toISOString()).toBe('2026-04-27T12:00:00.000Z');
  });
});

describe('buildSourceFilter', () => {
  it('returns no filter for all sources', () => {
    expect(buildSourceFilter('all')).toEqual({
      sourceList: null,
      sqlFragment: '',
    });
  });

  it('builds a Claude source filter', () => {
    expect(buildSourceFilter('claude')).toEqual({
      sourceList: ['claude'],
      sqlFragment: 'AND sessions.source = $1',
    });
  });

  it('builds a Codex source filter', () => {
    expect(buildSourceFilter('codex')).toEqual({
      sourceList: ['codex'],
      sqlFragment: 'AND sessions.source = $1',
    });
  });
});


describe('formatLeaderboardResponse', () => {
  const rankedProfiles: RankedProfile[] = [
    {
      profileId: '11111111-1111-1111-1111-111111111111',
      rank: 1,
      tokensTotal: 42_000_000,
    },
    {
      profileId: '22222222-2222-2222-2222-222222222222',
      rank: 2,
      tokensTotal: 1_500,
    },
    {
      profileId: '33333333-3333-3333-3333-333333333333',
      rank: 3,
      tokensTotal: 999,
    },
  ];
  const profileData = new Map<string, LeaderboardProfileData>([
    ['11111111-1111-1111-1111-111111111111', {
      handle: 'alice',
      displayName: 'Alice A.',
      xHandle: 'alice_dev',
      avatarUrl: 'https://example.com/alice.png',
      mode: 'script_verified',
    }],
    ['22222222-2222-2222-2222-222222222222', {
      handle: 'bob',
      displayName: null,
      xHandle: null,
      avatarUrl: null,
      mode: 'self_reported',
    }],
  ]);
  const rankDeltas: RankDeltaMap = new Map([
    ['11111111-1111-1111-1111-111111111111', -1],
    ['22222222-2222-2222-2222-222222222222', null],
  ]);
  const costs = new Map([
    ['11111111-1111-1111-1111-111111111111', 420],
    ['22222222-2222-2222-2222-222222222222', 0.02],
    ['33333333-3333-3333-3333-333333333333', 0.01],
  ]);
  const manyBadges: LeaderboardBadge[] = Array.from({ length: 6 }, (_, index) => ({
    slug: `badge_${index}`,
    name: `Badge ${index}`,
    icon: '◇',
    color: '#B6FF3C',
  }));
  const badges = new Map<string, LeaderboardBadge[]>([
    ['11111111-1111-1111-1111-111111111111', manyBadges],
  ]);

  it('formats tokens, costs, rank deltas, and profile fields', () => {
    expect(formatLeaderboardResponse(
      rankedProfiles,
      profileData,
      rankDeltas,
      costs,
      badges,
    )[0]).toEqual({
      rank: 1,
      rank_delta: -1,
      handle: 'alice',
      display_name: 'Alice A.',
      x_handle: 'alice_dev',
      avatar_url: 'https://example.com/alice.png',
      mode: 'script_verified',
      tokens_total: 42_000_000,
      cost_usd_total: 420,
      badges: manyBadges.slice(0, 5),
    });
  });

  it('falls back display_name to handle and converts missing rank deltas to zero', () => {
    const row = formatLeaderboardResponse(
      rankedProfiles,
      profileData,
      rankDeltas,
      costs,
      badges,
    )[1];

    expect(row?.display_name).toBe('bob');
    expect(row?.x_handle).toBeNull();
    expect(row?.rank_delta).toBe(0);
    expect(row?.avatar_url).toBeNull();
    expect(row?.tokens_total).toBe(1_500);
    expect(row?.cost_usd_total).toBe(0.02);
  });

  it('handles missing profile data gracefully', () => {
    const row = formatLeaderboardResponse(
      rankedProfiles,
      profileData,
      rankDeltas,
      costs,
      badges,
    )[2];

    expect(row).toMatchObject({
      rank: 3,
      rank_delta: 0,
      handle: 'profile_33333333',
      display_name: 'profile_33333333',
      x_handle: null,
      avatar_url: null,
      mode: 'self_reported',
      tokens_total: 999,
      cost_usd_total: 0.01,
      badges: [],
    });
  });

  it('preserves the ranked input order', () => {
    const rows = formatLeaderboardResponse(
      rankedProfiles,
      profileData,
      rankDeltas,
      costs,
      badges,
    );

    expect(rows.map((row) => row.rank)).toEqual([1, 2, 3]);
  });
});

describe('queryLeaderboardBySummary', () => {
  function createDbMock(tables: Record<string, unknown[]>, rpcRows?: unknown[]) {
    return {
      rpc() {
        return {
          returns() {
            if (rpcRows) {
              return Promise.resolve({
                data: rpcRows,
                error: null,
              });
            }
            return Promise.resolve({
              data: null,
              error: { code: 'PGRST202', message: 'function missing in test mock' },
            });
          },
        };
      },
      from(tableName: string) {
        const state = {
          tableName,
          rows: [...(tables[tableName] ?? [])],
        };
        const builder = {
          select() {
            return builder;
          },
          eq(column: string, value: unknown) {
            state.rows = state.rows.filter((row) => (row as Record<string, unknown>)[column] === value);
            return builder;
          },
          gt(column: string, value: number) {
            state.rows = state.rows.filter((row) => Number((row as Record<string, unknown>)[column] ?? 0) > value);
            return builder;
          },
          gte(column: string, value: unknown) {
            state.rows = state.rows.filter((row) => String((row as Record<string, unknown>)[column] ?? '') >= String(value));
            return builder;
          },
          in(column: string, values: unknown[]) {
            state.rows = state.rows.filter((row) => values.includes((row as Record<string, unknown>)[column]));
            return builder;
          },
          order(column: string, options: { ascending: boolean }) {
            state.rows.sort((left, right) => {
              const leftValue = (left as Record<string, unknown>)[column];
              const rightValue = (right as Record<string, unknown>)[column];
              const comparison = String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true });

              return options.ascending ? comparison : -comparison;
            });
            return builder;
          },
          range(from: number, to: number) {
            state.rows = state.rows.slice(from, to + 1);
            return builder;
          },
          returns() {
            return Promise.resolve({ data: state.rows, error: null });
          },
        };

        return builder;
      },
    };
  }

  it('applies publish trust deboosts and hides ineligible rows', async () => {
    const rows = await queryLeaderboardBySummary(createDbMock({
      profile_summary: [
        { profile_id: 'clean', window: 'all', score: 100, rank: 1, tokens_total: 1000 },
        { profile_id: 'deboosted', window: 'all', score: 300, rank: 2, tokens_total: 3000 },
        { profile_id: 'hidden', window: 'all', score: 500, rank: 3, tokens_total: 5000 },
        { profile_id: 'legacy', window: 'all', score: 90, rank: 4, tokens_total: 900 },
      ],
      profile_verification_trust: [
        {
          profile_id: 'deboosted',
          rank_eligible: true,
          deboost_multiplier: 0.25,
          leaderboard_hidden_at: null,
        },
        {
          profile_id: 'hidden',
          rank_eligible: false,
          deboost_multiplier: 0,
          leaderboard_hidden_at: '2026-06-04T12:00:00.000Z',
        },
      ],
    }) as never, {
      period: 'all',
      scope: 'all',
      limit: 10,
      offset: 0,
    });

    expect(rows).toEqual([
      { profileId: 'clean', tokensTotal: 1000, rank: 1 },
      { profileId: 'legacy', tokensTotal: 900, rank: 2 },
      { profileId: 'deboosted', tokensTotal: 3000, rank: 3 },
    ]);
  });

  it('applies publish trust to source-scoped token fallback rankings', async () => {
    const rows = await queryLeaderboardMv(createDbMock({
      daily_aggregates: [
        { profile_id: 'clean', date: '2026-06-01', source: 'codex', total_tokens: 100 },
        { profile_id: 'deboosted', date: '2026-06-01', source: 'codex', total_tokens: 300 },
        { profile_id: 'hidden', date: '2026-06-01', source: 'codex', total_tokens: 500 },
        { profile_id: 'claude-only', date: '2026-06-01', source: 'claude', total_tokens: 1000 },
      ],
      profile_verification_trust: [
        {
          profile_id: 'deboosted',
          rank_eligible: true,
          deboost_multiplier: 0.25,
          leaderboard_hidden_at: null,
        },
        {
          profile_id: 'hidden',
          rank_eligible: false,
          deboost_multiplier: 0,
          leaderboard_hidden_at: '2026-06-04T12:00:00.000Z',
        },
      ],
    }) as never, {
      period: 'all',
      scope: 'codex',
      limit: 10,
      offset: 0,
    });

    expect(rows).toEqual([
      { profileId: 'clean', tokensTotal: 100, rank: 1 },
      { profileId: 'deboosted', tokensTotal: 300, rank: 2 },
    ]);
  });

  it('gets source-scoped counts from the same database ranking query', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 1, error: null });
    const count = await countLeaderboardProfiles({ rpc } as never, { period: 'all', scope: 'opencode', limit: 10, offset: 0 });
    expect(count).toBe(1);
    expect(rpc).toHaveBeenCalledWith('count_usage_leaderboard', { p_start_date: null, p_source: 'opencode' });
  });

  it('preserves RPC pagination rank offsets after trust filtering', async () => {
    const rows = await queryLeaderboardMv(createDbMock({
      profile_verification_trust: [],
    }, [
      { profile_id: 'third', tokens_total: 300, rank: 3 },
      { profile_id: 'fourth', tokens_total: 200, rank: 4 },
    ]) as never, {
      period: 'all',
      scope: 'codex',
      limit: 2,
      offset: 2,
    });

    expect(rows).toEqual([
      { profileId: 'third', tokensTotal: 300, rank: 3 },
      { profileId: 'fourth', tokensTotal: 200, rank: 4 },
    ]);
  });
});
