import { describe, expect, it } from 'vitest';

import {
  BadgeDefinitionSchema,
  BadgeEvidenceSchema,
  BadgeResponseSchema,
  LeaderboardBadgesSchema,
  ProfileBadgeSchema,
  type BadgeDefinition,
  type BadgeEvidence,
  type BadgeResponse,
  type ProfileBadge,
} from '../../../../packages/shared/src/schemas/badges.js';
import {
  LEADERBOARD_LIMIT_MAX,
  LeaderboardQuerySchema,
  LeaderboardResponseSchema,
  LeaderboardRowSchema,
  type LeaderboardQuery,
  type LeaderboardResponse,
  type LeaderboardRow,
} from '../../../../packages/shared/src/schemas/leaderboard.js';

const badgeDefinition = {
  badge_id: '10000000-0000-0000-0000-000000000001',
  slug: 'iron_streak',
  name: 'Iron Streak',
  description: '30+ days of consistent use',
  icon_url: 'https://cdn.tokensrank.ai/badges/iron-streak.png',
  color_hex: '#B6FF3C',
  requires_verification: true,
  criteria_json: {
    consecutive_days_with_sessions: 30,
    gate: {
      mode: 'script_verified',
    },
  },
  created_at: '2026-04-27T10:00:00.000Z',
  updated_at: '2026-04-27T10:00:00.000Z',
} as const;

const badgeResponse = {
  slug: 'iron_streak',
  name: 'Iron Streak',
  icon: 'iron-streak',
  color: '#B6FF3C',
} as const;

const leaderboardRow = {
  rank: 1,
  rank_delta: 2,
  handle: 'builder_1',
  display_name: 'Builder One',
  avatar_url: 'https://cdn.tokensrank.ai/avatars/builder-1.png',
  mode: 'script_verified',
  tokens_total: 50000000,
  cost_usd_total: 123.45,
  badges: [badgeResponse],
} as const;

describe('LeaderboardQuerySchema', () => {
  it('accepts FR-49 defaults and query-string numeric parameters', () => {
    const parsedDefaults: LeaderboardQuery = LeaderboardQuerySchema.parse({});

    expect(parsedDefaults).toEqual({
      period: 'all',
      scope: 'all',
      limit: LEADERBOARD_LIMIT_MAX,
      offset: 0,
      sort: 'cost',
      order: 'desc',
    });

    expect(LeaderboardQuerySchema.parse({
      period: '7d',
      scope: 'claude',
      limit: '20',
      offset: '10',
    })).toEqual({
      period: '7d',
      scope: 'claude',
      limit: 20,
      offset: 10,
      sort: 'cost',
      order: 'desc',
    });
  });

  it('rejects invalid period, invalid scope, out-of-bound pagination, and extra fields', () => {
    expect(() => LeaderboardQuerySchema.parse({ period: 'lifetime' })).toThrow();
    expect(() => LeaderboardQuerySchema.parse({ scope: 'cursor' })).toThrow();
    expect(() => LeaderboardQuerySchema.parse({ limit: '51' })).toThrow();
    expect(() => LeaderboardQuerySchema.parse({ offset: '-1' })).toThrow();
    expect(() => LeaderboardQuerySchema.parse({ period: 'all', debug: true })).toThrow();
  });
});

describe('leaderboard response schemas', () => {
  it('accepts FR-50 leaderboard rows and response arrays', () => {
    const parsedRow: LeaderboardRow = LeaderboardRowSchema.parse(leaderboardRow);
    const parsedResponse: LeaderboardResponse = LeaderboardResponseSchema.parse([leaderboardRow]);

    expect(parsedRow.rank).toBe(1);
    expect(parsedResponse).toHaveLength(1);
  });

  it('rejects missing required row fields and invalid display values', () => {
    const { handle: _handle, ...missingHandle } = leaderboardRow;

    expect(() => LeaderboardRowSchema.parse(missingHandle)).toThrow();
    expect(() => LeaderboardRowSchema.parse({ ...leaderboardRow, rank: 0 })).toThrow();
    expect(() => LeaderboardRowSchema.parse({ ...leaderboardRow, rank_delta: 1.5 })).toThrow();
    expect(() => LeaderboardRowSchema.parse({ ...leaderboardRow, mode: 'A' })).toThrow();
    expect(() => LeaderboardRowSchema.parse({ ...leaderboardRow, total_tokens: 50000000 })).toThrow();
  });
});

describe('badge definition schemas', () => {
  it('accepts flexible FR-57 criteria structures and type-checks inferred definitions', () => {
    const definitions: BadgeDefinition[] = [
      BadgeDefinitionSchema.parse(badgeDefinition),
      BadgeDefinitionSchema.parse({
        ...badgeDefinition,
        badge_id: '10000000-0000-0000-0000-000000000002',
        slug: 'multi_provider',
        requires_verification: false,
        criteria_json: {
          providers: ['claude', 'codex'],
          has_claude: true,
          has_codex: true,
        },
      }),
      BadgeDefinitionSchema.parse({
        ...badgeDefinition,
        badge_id: '10000000-0000-0000-0000-000000000003',
        slug: 'operator',
        criteria_json: {
          sessions_per_day_avg: 10,
        },
      }),
    ];

    expect(definitions.map((definition) => definition.slug)).toEqual([
      'iron_streak',
      'multi_provider',
      'operator',
    ]);
  });

  it('rejects invalid colors, invalid URLs, missing criteria, and extra fields', () => {
    expect(() => BadgeDefinitionSchema.parse({ ...badgeDefinition, color_hex: 'B6FF3C' })).toThrow();
    expect(() => BadgeDefinitionSchema.parse({ ...badgeDefinition, icon_url: 'badge.png' })).toThrow();
    expect(() => BadgeDefinitionSchema.parse({
      ...badgeDefinition,
      criteria_json: undefined,
    })).toThrow();
    expect(() => BadgeDefinitionSchema.parse({ ...badgeDefinition, internal_rank: 1 })).toThrow();
  });
});

describe('badge evidence and profile badge schemas', () => {
  it('accepts flexible FR-56 evidence payloads', () => {
    const evidencePayloads: BadgeEvidence[] = [
      BadgeEvidenceSchema.parse({ tokens_total: 50000000 }),
      BadgeEvidenceSchema.parse({ consecutive_days: 45, generated_at: '2026-04-27T10:00:00.000Z' }),
      BadgeEvidenceSchema.parse({ cache_hit_pct: 31.4, sample: { sessions: 120 } }),
    ];

    expect(evidencePayloads).toHaveLength(3);
  });

  it('accepts profile badge awards with nested definitions', () => {
    const profileBadge: ProfileBadge = ProfileBadgeSchema.parse({
      profile_id: '20000000-0000-0000-0000-000000000001',
      badge_id: badgeDefinition.badge_id,
      awarded_at: '2026-04-27T11:00:00.000Z',
      evidence_json: {
        consecutive_days: 45,
      },
      badge: badgeDefinition,
    });

    expect(profileBadge.badge.slug).toBe('iron_streak');
  });

  it('rejects malformed profile badge rows', () => {
    expect(() => ProfileBadgeSchema.parse({
      profile_id: 'not-a-uuid',
      badge_id: badgeDefinition.badge_id,
      awarded_at: '2026-04-27T11:00:00.000Z',
      evidence_json: {},
      badge: badgeDefinition,
    })).toThrow();

    expect(() => ProfileBadgeSchema.parse({
      profile_id: '20000000-0000-0000-0000-000000000001',
      badge_id: badgeDefinition.badge_id,
      awarded_at: 'not-a-date',
      evidence_json: {},
      badge: badgeDefinition,
    })).toThrow();
  });
});

describe('leaderboard badge display schemas', () => {
  it('accepts lean inline badge responses', () => {
    const parsed: BadgeResponse = BadgeResponseSchema.parse(badgeResponse);

    expect(parsed.slug).toBe('iron_streak');
  });

  it('enforces the FR-50 five-badge leaderboard cap and strict fields', () => {
    expect(LeaderboardBadgesSchema.parse(
      Array.from({ length: 5 }, (_, index) => ({
        ...badgeResponse,
        slug: `badge_${index}`,
      })),
    )).toHaveLength(5);

    expect(() => LeaderboardBadgesSchema.parse(
      Array.from({ length: 6 }, (_, index) => ({
        ...badgeResponse,
        slug: `badge_${index}`,
      })),
    )).toThrow();

    expect(() => BadgeResponseSchema.parse({ ...badgeResponse, description: 'hidden' })).toThrow();
    expect(() => BadgeResponseSchema.parse({ ...badgeResponse, color: '#XYZXYZ' })).toThrow();
  });
});
