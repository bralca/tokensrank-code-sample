import { beforeEach, describe, expect, it } from 'vitest';

import {
  BADGE_EVALUATOR_TIMEOUT_WARN_MS,
  criteriaValidators,
  evaluateAllProfiles,
  hashAdvisoryLockKey,
} from '../../src/services/badge-evaluator';
import { BADGE_EVALUATOR_CRON } from '../../src/jobs/badge-cron';
import { cache, purgeKeys, withCache } from '../../src/services/cache';
import { createPostgresClient } from '../../src/lib/postgres';
import { createSchemaServiceRoleClient } from './ingestion-test-helpers';
import { q, runSql } from './db-test-helpers';
import { resolveTestSchema, setupTestSchema } from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();

type SeedProfileOptions = {
  handle: string;
  mode?: 'script_verified' | 'self_reported';
};

type SeedSessionOptions = {
  source?: 'claude' | 'codex';
  model?: string;
  dayOffset?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
  firstHour?: number;
  durationHours?: number;
  errorTag?: string;
};

type LogLine = {
  event?: string;
  severity?: string;
  [key: string]: unknown;
};

const baseDate = Date.UTC(2026, 0, 1, 12, 0, 0);
let sessionCounter = 0;
let logs: LogLine[] = [];

function logger() {
  return {
    debug(line: LogLine) {
      logs.push(line);
    },
    error(line: LogLine) {
      logs.push(line);
    },
    info(line: LogLine) {
      logs.push(line);
    },
    warn(line: LogLine) {
      logs.push(line);
    },
  };
}

function isoFor(dayOffset: number, hour: number): string {
  return new Date(baseDate + (dayOffset * 24 * 60 * 60 * 1000) + ((hour - 12) * 60 * 60 * 1000)).toISOString();
}

async function seedProfile(options: SeedProfileOptions): Promise<{ id: string; user_id: string; handle: string }> {
  const rows = await runSql<{ id: string }>(`
    WITH generated AS (
      SELECT gen_random_uuid() AS id
    ),
    inserted_user AS (
      INSERT INTO auth.users (
        id,
        aud,
        role,
        email,
        raw_app_meta_data,
        raw_user_meta_data,
        created_at,
        updated_at
      )
      SELECT
        id,
        'authenticated',
        'authenticated',
        $1,
        '{}'::jsonb,
        '{}'::jsonb,
        now(),
        now()
      FROM generated
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    )
    INSERT INTO ${q(schema)}.profiles (id, user_id, handle, display_name, mode, verified)
    SELECT
      generated.id,
      generated.id,
      $2::text,
      $2::text,
      $3::text,
      $3::text = 'script_verified'
    FROM generated
    RETURNING id
  `, [
    `${options.handle}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    options.handle,
    options.mode ?? 'script_verified',
  ]);

  const id = rows[0]?.id;
  if (!id) {
    throw new Error('Failed to seed badge profile');
  }

  return {
    id,
    user_id: id,
    handle: options.handle,
  };
}

async function seedSession(profileId: string, options: SeedSessionOptions = {}): Promise<void> {
  sessionCounter += 1;
  const source = options.source ?? 'claude';
  const model = options.model ?? (source === 'claude' ? 'claude-3-5-sonnet' : 'gpt-5-codex');
  const dayOffset = options.dayOffset ?? 0;
  const firstHour = options.firstHour ?? 12;
  const durationHours = options.durationHours ?? 1;
  const firstEventAt = isoFor(dayOffset, firstHour);
  const lastEventAt = new Date(new Date(firstEventAt).getTime() + durationHours * 60 * 60 * 1000).toISOString();
  const fingerprint = options.errorTag
    ? { error_tag: options.errorTag }
    : {};

  await runSql(`
    INSERT INTO ${q(schema)}.sessions (
      profile_id,
      source,
      model,
      session_id,
      file_sha256,
      first_event_at,
      last_event_at,
      input_tokens,
      output_tokens,
      cache_read_tokens,
      cache_create_tokens,
      cached_tokens,
      reasoning_tokens,
      turns,
      ingestion_mode,
      fingerprint
    )
    VALUES (
      $1,
      $2,
      $3,
      $4::text,
      encode(sha256(convert_to($4::text, 'UTF8')), 'hex'),
      $5,
      $6,
      $7,
      $8,
      $9,
      0,
      0,
      $10,
      1,
      'script_verified',
      $11::jsonb
    )
  `, [
    profileId,
    source,
    model,
    `badge-session-${sessionCounter}`,
    firstEventAt,
    lastEventAt,
    options.inputTokens ?? 100,
    options.outputTokens ?? 100,
    options.cacheReadTokens ?? 0,
    options.reasoningTokens ?? 0,
    JSON.stringify(fingerprint),
  ]);
}

async function seedTierProfile(handle: string, mode: 'script_verified' | 'self_reported' = 'script_verified') {
  const profile = await seedProfile({ handle, mode });
  await seedSession(profile.id, {
    source: 'claude',
    model: 'claude-3-5-sonnet',
    inputTokens: 25_000_000,
  });

  return profile;
}

async function awardedSlugs(profileId: string): Promise<string[]> {
  const rows = await runSql<{ badge_slug: string }>(`
    SELECT badge_slug
    FROM ${q(schema)}.profile_badges
    WHERE profile_id = $1
    ORDER BY badge_slug
  `, [profileId]);

  return rows.map((row) => row.badge_slug);
}

async function runEvaluator() {
  return evaluateAllProfiles(createSchemaServiceRoleClient(), {
    logger: logger(),
  });
}

describe.sequential('badge evaluator integration', () => {
  beforeEach(async () => {
    logs = [];
    sessionCounter = 0;
    cache.clear();
    await setupTestSchema(schema);
  });

  it('registers the expected 15 minute cron contract', () => {
    expect(BADGE_EVALUATOR_CRON).toBe('*/15 * * * *');
    expect(BADGE_EVALUATOR_TIMEOUT_WARN_MS).toBe(15 * 60 * 1000);
  });

  it('evaluates profiles and awards badges idempotently', async () => {
    const profile = await seedTierProfile('badgeidem');

    const first = await runEvaluator();
    const afterFirst = await awardedSlugs(profile.id);
    const second = await runEvaluator();
    const afterSecond = await awardedSlugs(profile.id);

    expect(first.evaluated).toBeGreaterThan(0);
    expect(first.awarded).toBeGreaterThan(0);
    expect(second.awarded).toBe(0);
    expect(afterSecond).toEqual(afterFirst);
  });

  it('skips verification-gated badges for self_reported profiles', async () => {
    const profile = await seedTierProfile('badgeself', 'self_reported');

    await runEvaluator();

    const gated = await runSql<{ badge_slug: string }>(`
      SELECT profile_badges.badge_slug
      FROM ${q(schema)}.profile_badges
      JOIN ${q(schema)}.badges ON badges.slug = profile_badges.badge_slug
      WHERE profile_badges.profile_id = $1
        AND badges.requires_verification
    `, [profile.id]);

    expect(gated).toEqual([]);
  });

  it('awards verification-gated badges after mode escalation', async () => {
    const profile = await seedTierProfile('badgeup', 'self_reported');

    await runEvaluator();
    expect(await awardedSlugs(profile.id)).not.toContain('tier');

    await runSql(`UPDATE ${q(schema)}.profiles SET mode = 'script_verified', verified = true WHERE id = $1`, [profile.id]);
    await runEvaluator();

    expect(await awardedSlugs(profile.id)).toContain('tier');
  });

  it('awards tier with evidence snapshot persistence', async () => {
    const profile = await seedTierProfile('badgetier');

    await runEvaluator();

    const rows = await runSql<{ evidence: { tokens_total?: number; threshold_tokens?: number } }>(`
      SELECT evidence
      FROM ${q(schema)}.profile_badges
      WHERE profile_id = $1
        AND badge_slug = 'tier'
    `, [profile.id]);

    expect(rows[0]?.evidence.tokens_total).toBeGreaterThanOrEqual(25_000_000);
    expect(rows[0]?.evidence.threshold_tokens).toBe(25_000_000);
  });

  it('awards iron_streak from consecutive aggregate days', async () => {
    const profile = await seedProfile({ handle: 'badgestreak' });

    for (let index = 0; index < 30; index += 1) {
      await seedSession(profile.id, { dayOffset: index });
    }

    await runEvaluator();

    expect(await awardedSlugs(profile.id)).toContain('iron_streak');
  });

  it('awards multi_provider and drifter sample validators', async () => {
    const profile = await seedProfile({ handle: 'badgedrift' });

    for (let index = 0; index < 8; index += 1) {
      await seedSession(profile.id, {
        source: index === 0 ? 'codex' : 'claude',
        model: `model-${index}`,
        inputTokens: 1000,
      });
    }

    await runEvaluator();

    const slugs = await awardedSlugs(profile.id);
    expect(slugs).toContain('multi_provider');
    expect(slugs).toContain('drifter');
  });

  it('logs audit events after a new badge award', async () => {
    const profile = await seedTierProfile('badgeaudit');

    await runEvaluator();

    const rows = await runSql<{ event_type: string; severity: string; payload: Record<string, unknown> }>(`
      SELECT event_type, severity, payload
      FROM ${q(schema)}.audit_events
      WHERE profile_id = $1
        AND event_type = 'profile.badge_awarded'
      ORDER BY id DESC
      LIMIT 1
    `, [profile.id]);

    expect(rows[0]?.event_type).toBe('profile.badge_awarded');
    expect(rows[0]?.severity).toBe('info');
    expect(rows[0]?.payload.badge_slug).toBeTruthy();
    expect(rows[0]?.payload.mode_at_award).toBe('script_verified');
  });

  it('purges profile and me cache keys after badge award', async () => {
    const profile = await seedTierProfile('badgecache');
    await withCache(`profile:v0:${profile.handle}:all`, 3600, async () => 'stale-profile');
    await withCache(`me:v0:${profile.user_id}`, 3600, async () => 'stale-me');

    await runEvaluator();

    expect(cache.has(`profile:v0:${profile.handle}:all`)).toBe(false);
    expect(cache.has(`me:v0:${profile.user_id}`)).toBe(false);
  });

  it('advisory lock prevents concurrent evaluator runs', async () => {
    const client = await createPostgresClient();

    try {
      await client.query('SELECT pg_advisory_lock($1)', [hashAdvisoryLockKey('badge_evaluator')]);

      const result = await runEvaluator();

      expect(result.lockAcquired).toBe(false);
      expect(result.evaluated).toBe(0);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [hashAdvisoryLockKey('badge_evaluator')]);
      await client.end();
    }
  });

  it('continues and logs critical criteria errors for corrupt badge JSON', async () => {
    const profile = await seedTierProfile('badgebadjson');

    await runSql(`
      UPDATE ${q(schema)}.badges
      SET criteria_json = '{"threshold_tokens":"bad"}'::jsonb
      WHERE slug = 'tier'
    `);

    const result = await runEvaluator();

    expect(result.evaluated).toBeGreaterThan(0);
    expect(await awardedSlugs(profile.id)).not.toContain('tier');
    expect(logs.some((line) => line.event === 'badge.criteria_invalid' && line.severity === 'critical')).toBe(true);
  });

  it('emits timeout warning when evaluation exceeds configured threshold', async () => {
    await seedTierProfile('badgeslow');

    await evaluateAllProfiles(createSchemaServiceRoleClient(), {
      logger: logger(),
      acquireLock: false,
      timeoutWarnMs: 0,
    });

    expect(logs.some((line) => line.event === 'badge_cron.slow')).toBe(true);
  });

  it('registers all 16 validators', () => {
    expect(Object.keys(criteriaValidators).sort()).toEqual([
      'cache_whisperer',
      'conductor',
      'defection_arc',
      'detonation',
      'drifter',
      'iron_streak',
      'long_context',
      'marathoner',
      'multi_provider',
      'night_owl',
      'operator',
      'outage_witness',
      'reasoning_junkie',
      'sniper',
      'tier',
      'two_tool',
    ]);
  });

  it('supports wildcard purgeKeys used by badge awards', async () => {
    await withCache('profile:v0:wild:all', 3600, async () => 'profile');
    await withCache('profile:v1:wild:30d', 3600, async () => 'profile-window');
    await withCache('me:v0:user-1', 3600, async () => 'me');

    expect(purgeKeys(['profile:v*:wild', 'me:v*:user-1'])).toBe(3);
    expect(cache.has('profile:v0:wild:all')).toBe(false);
    expect(cache.has('profile:v1:wild:30d')).toBe(false);
    expect(cache.has('me:v0:user-1')).toBe(false);
  });
});
