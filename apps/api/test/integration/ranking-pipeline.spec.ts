import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../../src/clients/supabase';
import { createPostgresClient, quoteIdentifier } from '../../src/lib/postgres';
import { countLeaderboardProfiles, getLeaderboard } from '../../src/services/leaderboard';
import { buildProfileResponse } from '../../src/services/profile';
import { rebuildProfileSummaries } from '../../src/services/scoring';
import { resolveTestSchema } from './setup';

/**
 * End-to-end ranking pipeline against the real DB (isolated test schema):
 * seed daily_aggregates (tokens) + contrib_daily (shipped code) → run the real
 * rebuildProfileSummaries → getLeaderboard. Proves the anti-fake property: a
 * token-only faker (huge tokens, zero shipped code) does NOT appear on the
 * board, while a real builder (modest tokens + shipped code) ranks #1.
 */

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();
const qs = quoteIdentifier(schema);

const REAL = '11111111-1111-4111-8111-111111111111';
const FAKER = '22222222-2222-4222-8222-222222222222';

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

function dayStr(offset: number): string {
  return new Date(NOW - offset * DAY_MS).toISOString().slice(0, 10);
}

async function seedSchema(): Promise<void> {
  const client = await createPostgresClient();
  try {
    // Mirror the two tables the scoring/leaderboard path needs from public.
    for (const table of ['contrib_daily', 'profile_summary']) {
      await client.query(`CREATE TABLE IF NOT EXISTS ${qs}.${table} (LIKE public.${table} INCLUDING ALL)`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${qs}.${table} TO anon, authenticated, service_role`);
    }

    // Clean slate (daily_aggregates/profiles/sessions exist from reset_test_schema).
    await client.query(`TRUNCATE TABLE ${qs}.profile_summary, ${qs}.contrib_daily, ${qs}.daily_aggregates, ${qs}.sessions RESTART IDENTITY CASCADE`);
    await client.query(`DELETE FROM ${qs}.profiles WHERE id = ANY($1::uuid[])`, [[REAL, FAKER]]);

    // Profiles
    await client.query(
      `INSERT INTO ${qs}.profiles (id, user_id, handle, display_name, mode, verified, created_at, updated_at)
       VALUES ($1, $1, 'realbuilder', 'Real Builder', 'script_verified', true, now(), now()),
              ($2, $2, 'tokenfaker', 'Token Faker', 'self_reported', false, now(), now())`,
      [REAL, FAKER],
    );

    // Real builder: 20 active days of moderate tokens AND shipped code.
    for (let i = 0; i < 20; i += 1) {
      await client.query(
        `INSERT INTO ${qs}.daily_aggregates (profile_id, date, source, model, total_tokens, total_sessions, derived_cost_usd, updated_at)
         VALUES ($1, $2, 'claude', 'claude-3-5-sonnet', 250000, 3, 0, now())`,
        [REAL, dayStr(i)],
      );
      await client.query(
        `INSERT INTO ${qs}.contrib_daily (profile_id, day, shipped_loc, commit_count, weighted_shipped, updated_at)
         VALUES ($1, $2, 60, 2, 60, now())`,
        [REAL, dayStr(i)],
      );
    }

    // Real builder sessions (drive hour-of-day + duration metrics): a 30-min
    // morning session and a 2-hour after-midnight session.
    await client.query(
      `INSERT INTO ${qs}.sessions (profile_id, source, model, session_id, file_sha256, first_event_at, last_event_at, input_tokens, ingestion_mode)
       VALUES ($1, 'claude', 'claude-3-5-sonnet', 's1', repeat('a', 64), $2, $3, 100000, 'script_verified'),
              ($1, 'claude', 'claude-3-5-sonnet', 's2', repeat('b', 64), $4, $5, 200000, 'script_verified')`,
      [REAL, `${dayStr(0)}T10:00:00Z`, `${dayStr(0)}T10:30:00Z`, `${dayStr(0)}T02:00:00Z`, `${dayStr(0)}T04:00:00Z`],
    );

    // Token-only faker: one day, 50M tokens, ZERO shipped code.
    await client.query(
      `INSERT INTO ${qs}.daily_aggregates (profile_id, date, source, model, total_tokens, total_sessions, derived_cost_usd, updated_at)
       VALUES ($1, $2, 'claude', 'claude-3-5-sonnet', 50000000, 1, 0, now())`,
      [FAKER, dayStr(0)],
    );

    await client.query("NOTIFY pgrst, 'reload schema'");
  } finally {
    await client.end();
  }
}

async function waitForPostgrest(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const [contrib, summary] = await Promise.all([
      adminClient.from('contrib_daily').select('profile_id', { head: true, count: 'exact' }),
      adminClient.from('profile_summary').select('profile_id', { head: true, count: 'exact' }),
    ]);
    if (!contrib.error && !summary.error) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('[ranking-pipeline] PostgREST did not pick up the new tables in time');
}

describe('ranking pipeline (e2e against test schema)', () => {
  beforeAll(async () => {
    await seedSchema();
    await waitForPostgrest();
    await rebuildProfileSummaries({ nowMs: NOW });
  }, 60_000);

  afterAll(async () => {
    const client = await createPostgresClient();
    try {
      await client.query(`TRUNCATE TABLE ${qs}.profile_summary, ${qs}.contrib_daily, ${qs}.daily_aggregates RESTART IDENTITY CASCADE`);
      await client.query(`DELETE FROM ${qs}.profiles WHERE id = ANY($1::uuid[])`, [[REAL, FAKER]]);
    } finally {
      await client.end();
    }
  });

  it('computes a positive score for the real builder and zero for the token-only faker', async () => {
    const client = await createPostgresClient();
    try {
      const real = await client.query(`SELECT score, metrics FROM ${qs}.profile_summary WHERE profile_id = $1 AND "window" = 'all'`, [REAL]);
      const faker = await client.query(`SELECT score FROM ${qs}.profile_summary WHERE profile_id = $1 AND "window" = 'all'`, [FAKER]);

      expect(Number(real.rows[0]?.score)).toBeGreaterThan(0);
      // Faker has 50M tokens but zero shipped code -> geometric mean collapses to 0.
      expect(Number(faker.rows[0]?.score)).toBe(0);

      // Rich metrics rolled into profile_summary.metrics (20 consecutive active days, single model).
      const metrics = real.rows[0]?.metrics;
      expect(metrics.current_streak).toBe(20);
      expect(metrics.longest_streak).toBe(20);
      // 5.0M from daily_aggregates + 0.3M rolled in by the sessions-insert
      // trigger (2 seeded sessions, same day/source/model) = 5.3M.
      expect(metrics.distinct_models).toBe(1);
      expect(metrics.models[0]).toEqual({ model: 'claude-3-5-sonnet', tokens: 5_300_000 });
      expect(metrics.tools.claude).toBe(5_300_000);

      // Session-derived metrics (from raw sessions).
      expect(metrics.longest_session_seconds).toBe(7200);
      expect(metrics.sessions_over_1h).toBe(1);
      expect(metrics.total_session_time_seconds).toBe(9000);
      expect(metrics.after_midnight.count).toBe(1);
      expect(metrics.largest_tokens_session_tokens).toBe(200000);
    } finally {
      await client.end();
    }
  });

  it('ranks the real builder #1 and excludes the token-only faker from the leaderboard', async () => {
    const rows = await getLeaderboard(adminClient, { period: 'all', scope: 'all', limit: 50, offset: 0 });

    expect(rows.map((row) => row.handle)).toContain('realbuilder');
    expect(rows.map((row) => row.handle)).not.toContain('tokenfaker');

    const real = rows.find((row) => row.handle === 'realbuilder');
    expect(real?.rank).toBe(1);
    expect(real?.tokens_total).toBe(5_300_000); // 20 days * 250k + 300k from the 2 trigger-rolled sessions
  });

  it('counts only profiles with a positive (corroborated) score', async () => {
    const count = await countLeaderboardProfiles(adminClient, { period: 'all', scope: 'all', limit: 50, offset: 0 });
    expect(count).toBe(1);
  });

  it('builds the profile response from profile_summary (read-path repoint)', async () => {
    const resp = await buildProfileResponse(
      {
        id: REAL,
        user_id: REAL,
        handle: 'realbuilder',
        display_name: 'Real Builder',
        avatar_url: null,
        bio: null,
        x_handle: null,
        mode: 'script_verified',
        verified: true,
        share_projects: false,
        created_at: new Date(NOW - 100 * DAY_MS).toISOString(),
      },
      'all',
      false,
    );

    // Headline + at-a-glance come straight from profile_summary scalars.
    expect(resp.headline.tokens_total).toBe(5_300_000);
    expect(resp.headline.rank).toBe(1);
    expect(resp.at_glance.days_active).toBe(20);
    // Model breakdown comes from the metrics blob.
    expect(resp.models.distinct).toBe(1);
    expect(resp.cadence.current_streak).toBe(20);
  });
});
