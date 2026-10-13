import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getLeaderboard } from './leaderboard';
import {
  createAccessKeyFixture,
  createSchemaServiceRoleClient,
  deleteAuthUsers,
} from '../../test/integration/ingestion-test-helpers';

type ProfileFixture = {
  profileId: string;
  userId: string;
  handle: string;
};

type SessionSeed = {
  profileId: string;
  source: 'claude' | 'codex';
  ingestionMode: 'script_verified' | 'self_reported';
  count: number;
  tokensPerSession: number;
  daysAgo: number;
  label: string;
};

const createdUserIds = new Set<string>();
const fixtures = new Map<string, ProfileFixture>();

function isoDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

function fileHash(label: string): string {
  return crypto.createHash('sha256').update(label).digest('hex');
}

async function createProfile(label: string, mode: 'script_verified' | 'self_reported'): Promise<ProfileFixture> {
  const fixture = await createAccessKeyFixture('script', label);
  const admin = createSchemaServiceRoleClient();

  createdUserIds.add(fixture.userId);

  const { error } = await admin
    .from('profiles')
    .update({
      handle: label,
      display_name: label[0]?.toUpperCase() ? `${label[0].toUpperCase()}${label.slice(1)}` : label,
      avatar_url: `https://example.com/${label}.png`,
      mode,
      verified: mode === 'script_verified',
    })
    .eq('id', fixture.profileId);

  if (error) {
    throw new Error(`[leaderboard-test] profile setup failed: ${error.message}`);
  }

  return {
    profileId: fixture.profileId,
    userId: fixture.userId,
    handle: label,
  };
}

async function seedSessions(seed: SessionSeed): Promise<void> {
  const admin = createSchemaServiceRoleClient();
  const firstEventAt = isoDaysAgo(seed.daysAgo);
  const rows = Array.from({ length: seed.count }, (_, index) => ({
    profile_id: seed.profileId,
    source: seed.source,
    model: seed.source === 'claude' ? 'claude-3-5-sonnet' : 'gpt-5-codex',
    session_id: `${seed.label}_${index}`,
    file_sha256: fileHash(`${seed.label}_${index}`),
    first_event_at: firstEventAt,
    last_event_at: firstEventAt,
    input_tokens: seed.tokensPerSession,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_create_tokens: 0,
    cached_tokens: 0,
    reasoning_tokens: 0,
    turns: 1,
    ingestion_mode: seed.ingestionMode,
  }));

  const { error } = await admin
    .from('sessions')
    .insert(rows);

  if (error) {
    throw new Error(`[leaderboard-test] session seed failed: ${error.message}`);
  }
}

async function seedBadges(profileId: string): Promise<void> {
  const admin = createSchemaServiceRoleClient();
  const badgeSlugs = ['tier', 'operator', 'night_owl', 'multi_provider', 'two_tool', 'sniper'];
  const { error } = await admin
    .from('profile_badges')
    .insert(badgeSlugs.map((badgeSlug, index) => ({
      profile_id: profileId,
      badge_slug: badgeSlug,
      awarded_at: new Date(Date.now() - index * 60_000).toISOString(),
      evidence: { test: true },
    })));

  if (error) {
    throw new Error(`[leaderboard-test] badge seed failed: ${error.message}`);
  }
}

async function seedPreviousRanks(): Promise<void> {
  const admin = createSchemaServiceRoleClient();
  const bob = fixtures.get('bob');
  const alice = fixtures.get('alice');
  const charlie = fixtures.get('charlie');

  if (!bob || !alice || !charlie) {
    throw new Error('[leaderboard-test] missing profile fixtures');
  }

  const { error } = await admin
    .from('leaderboard_previous')
    .upsert([
      {
        profile_id: bob.profileId,
        rank: 2,
        total_tokens: 13_000,
      },
      {
        profile_id: alice.profileId,
        rank: 3,
        total_tokens: 8_000,
      },
      {
        profile_id: charlie.profileId,
        rank: 1,
        total_tokens: 2_500,
      },
    ]);

  if (error) {
    throw new Error(`[leaderboard-test] previous rank seed failed: ${error.message}`);
  }
}

beforeAll(async () => {
  fixtures.set('alice', await createProfile('alice', 'script_verified'));
  fixtures.set('bob', await createProfile('bob', 'script_verified'));
  fixtures.set('charlie', await createProfile('charlie', 'self_reported'));

  const alice = fixtures.get('alice');
  const bob = fixtures.get('bob');
  const charlie = fixtures.get('charlie');

  if (!alice || !bob || !charlie) {
    throw new Error('[leaderboard-test] fixture creation failed');
  }

  await seedSessions({
    profileId: alice.profileId,
    source: 'claude',
    ingestionMode: 'script_verified',
    count: 5,
    tokensPerSession: 1_000,
    daysAgo: 1,
    label: 'alice_script',
  });
  await seedSessions({
    profileId: alice.profileId,
    source: 'claude',
    ingestionMode: 'self_reported',
    count: 3,
    tokensPerSession: 1_000,
    daysAgo: 1,
    label: 'alice_self',
  });
  await seedSessions({
    profileId: bob.profileId,
    source: 'codex',
    ingestionMode: 'script_verified',
    count: 4,
    tokensPerSession: 1_500,
    daysAgo: 1,
    label: 'bob_codex_recent',
  });
  await seedSessions({
    profileId: bob.profileId,
    source: 'claude',
    ingestionMode: 'self_reported',
    count: 7,
    tokensPerSession: 1_000,
    daysAgo: 10,
    label: 'bob_claude_old',
  });
  await seedSessions({
    profileId: charlie.profileId,
    source: 'claude',
    ingestionMode: 'self_reported',
    count: 1,
    tokensPerSession: 2_500,
    daysAgo: 1,
    label: 'charlie_recent',
  });
  await seedBadges(alice.profileId);
  await seedPreviousRanks();
});

afterAll(async () => {
  await deleteAuthUsers(createdUserIds);
  createdUserIds.clear();
});

describe('getLeaderboard integration', () => {
  it('returns all profiles in total token order and aggregates ingestion modes together', async () => {
    const rows = await getLeaderboard(createSchemaServiceRoleClient(), {
      period: 'all',
      scope: 'all',
      limit: 50,
      offset: 0,
    });

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.handle)).toEqual(['bob', 'alice', 'charlie']);
    expect(rows.find((row) => row.handle === 'alice')?.tokens_total).toBe(8_000);
    expect(rows.find((row) => row.handle === 'alice')?.badges).toHaveLength(5);
  });

  it('filters the leaderboard by 7 day aggregate dates', async () => {
    const rows = await getLeaderboard(createSchemaServiceRoleClient(), {
      period: '7d',
      scope: 'all',
      limit: 50,
      offset: 0,
    });

    expect(rows.map((row) => row.handle)).toEqual(['alice', 'bob', 'charlie']);
    expect(rows.find((row) => row.handle === 'bob')?.tokens_total).toBe(6_000);
  });

  it('filters the leaderboard by Claude source without filtering ingestion mode', async () => {
    const rows = await getLeaderboard(createSchemaServiceRoleClient(), {
      period: 'all',
      scope: 'claude',
      limit: 50,
      offset: 0,
    });

    expect(rows.map((row) => row.handle)).toEqual(['alice', 'bob', 'charlie']);
    expect(rows.find((row) => row.handle === 'alice')?.tokens_total).toBe(8_000);
    expect(rows.find((row) => row.handle === 'bob')?.tokens_total).toBe(7_000);
  });

  it('paginates after ranking and preserves absolute rank numbers', async () => {
    const rows = await getLeaderboard(createSchemaServiceRoleClient(), {
      period: 'all',
      scope: 'all',
      limit: 2,
      offset: 1,
    });

    expect(rows.map((row) => [row.rank, row.handle])).toEqual([
      [2, 'alice'],
      [3, 'charlie'],
    ]);
  });

  it('computes rank deltas from the previous hourly snapshot', async () => {
    const rows = await getLeaderboard(createSchemaServiceRoleClient(), {
      period: 'all',
      scope: 'all',
      limit: 50,
      offset: 0,
    });

    expect(rows.map((row) => [row.handle, row.rank_delta])).toEqual([
      ['bob', -1],
      ['alice', -1],
      ['charlie', 2],
    ]);
  });

  it('computes formatted USD costs from token totals', async () => {
    const rows = await getLeaderboard(createSchemaServiceRoleClient(), {
      period: 'all',
      scope: 'all',
      limit: 50,
      offset: 0,
    });

    expect(rows.find((row) => row.handle === 'bob')?.cost_usd_total).toBe(0.04);
    expect(rows.find((row) => row.handle === 'alice')?.cost_usd_total).toBe(0.02);
  });
});
