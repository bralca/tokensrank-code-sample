import { createClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  BADGE_EVALUATOR_CRON_SCHEDULE,
  BADGE_EVALUATOR_CRON_TIMEZONE,
  initBadgeCron,
  runBadgeEvaluationCycle,
  type BadgeCronLogger,
} from '../../src/cron/badge-evaluator.cron';
import {
  BADGE_EVALUATOR_LOCK_NAME,
  hashAdvisoryLockKey,
} from '../../src/services/badge-evaluator';
import { createPostgresClient } from '../../src/lib/postgres';
import { createSchemaServiceRoleClient } from './ingestion-test-helpers';
import { q, runSql } from './db-test-helpers';
import { resolveTestSchema, setupTestSchema } from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();

type LogLine = {
  event?: string;
  [key: string]: unknown;
};

type SeededProfile = {
  id: string;
  handle: string;
  user_id: string;
};

let profileCounter = 0;
let sessionCounter = 0;
let logs: LogLine[] = [];

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[badge-evaluator-cron-test] Missing required environment variable: ${name}`);
  }

  return value;
}

function createLogger(): BadgeCronLogger {
  return {
    debug(first) {
      logs.push(first as LogLine);
    },
    error(first) {
      logs.push(first as LogLine);
    },
    info(first) {
      logs.push(first as LogLine);
    },
    warn(first) {
      logs.push(first as LogLine);
    },
  };
}

function uniqueHandle(label: string): string {
  profileCounter += 1;
  return `cron_${label}_${profileCounter}`.slice(0, 30);
}

function isoFor(dayOffset = 0, hour = 12): string {
  return new Date(Date.UTC(2026, 0, 1 + dayOffset, hour, 0, 0)).toISOString();
}

async function seedProfile(
  label: string,
  mode: 'script_verified' | 'self_reported' = 'script_verified',
): Promise<SeededProfile> {
  const handle = uniqueHandle(label);
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
    `${handle}_${Date.now()}@example.com`,
    handle,
    mode,
  ]);

  const id = rows[0]?.id;

  if (!id) {
    throw new Error('[badge-evaluator-cron-test] Failed to seed profile');
  }

  return {
    id,
    handle,
    user_id: id,
  };
}

async function seedSession(
  profileId: string,
  options: {
    source?: 'claude' | 'codex';
    inputTokens?: number;
    outputTokens?: number;
    dayOffset?: number;
    hour?: number;
    ingestionMode?: 'script_verified' | 'self_reported';
  } = {},
): Promise<void> {
  sessionCounter += 1;
  const source = options.source ?? 'claude';
  const model = source === 'claude' ? 'claude-3-5-sonnet' : 'gpt-5-codex';
  const sessionId = `badge-cron-session-${sessionCounter}`;
  const firstEventAt = isoFor(options.dayOffset, options.hour);
  const lastEventAt = new Date(new Date(firstEventAt).getTime() + 60 * 60 * 1000).toISOString();

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
      $4,
      encode(sha256(convert_to($4, 'UTF8')), 'hex'),
      $5,
      $6,
      $7,
      $8,
      0,
      0,
      0,
      0,
      1,
      $9,
      '{}'::jsonb
    )
  `, [
    profileId,
    source,
    model,
    sessionId,
    firstEventAt,
    lastEventAt,
    options.inputTokens ?? 100,
    options.outputTokens ?? 0,
    options.ingestionMode ?? 'script_verified',
  ]);
}

async function seedTierProfile(
  label: string,
  mode: 'script_verified' | 'self_reported' = 'script_verified',
): Promise<SeededProfile> {
  const profile = await seedProfile(label, mode);

  await seedSession(profile.id, {
    inputTokens: 25_000_000,
    ingestionMode: mode,
  });

  return profile;
}

async function awardedCount(profileId: string, badgeSlug: string): Promise<number> {
  const rows = await runSql<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM ${q(schema)}.profile_badges
    WHERE profile_id = $1
      AND badge_slug = $2
  `, [profileId, badgeSlug]);

  return Number(rows[0]?.count ?? 0);
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

async function badgeAwardAuditCount(profileId: string, badgeSlug: string): Promise<number> {
  const rows = await runSql<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM ${q(schema)}.audit_events
    WHERE profile_id = $1
      AND event_type = 'profile.badge_awarded'
      AND payload->>'badge_slug' = $2
  `, [profileId, badgeSlug]);

  return Number(rows[0]?.count ?? 0);
}

beforeEach(async () => {
  logs = [];
  await setupTestSchema(schema);
});

describe.sequential('badge evaluator cron integration', () => {
  it('initializes a UTC 15-minute node-cron task', () => {
    const task = initBadgeCron({
      logger: createLogger(),
      supabaseClient: createSchemaServiceRoleClient(),
    });

    try {
      expect(BADGE_EVALUATOR_CRON_SCHEDULE).toBe('*/15 * * * *');
      expect(BADGE_EVALUATOR_CRON_TIMEZONE).toBe('UTC');
      expect(task.getNextRun()).toBeInstanceOf(Date);
      expect(logs.some((line) => line.event === 'badge_cron.initialized')).toBe(true);
    } finally {
      task.stop();
    }
  });

  it('skips evaluation when the advisory lock is already held', async () => {
    const profile = await seedTierProfile('locked');
    const lockClient = await createPostgresClient();

    try {
      await lockClient.query('SELECT pg_advisory_lock($1)', [hashAdvisoryLockKey(BADGE_EVALUATOR_LOCK_NAME)]);

      const result = await runBadgeEvaluationCycle({
        logger: createLogger(),
        supabaseClient: createSchemaServiceRoleClient(),
      });

      expect(result.lockAcquired).toBe(false);
      expect(result.awarded).toBe(0);
      expect(await awardedCount(profile.id, 'tier')).toBe(0);
      expect(logs.some((line) => line.event === 'badge_cron.skipped')).toBe(true);
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [hashAdvisoryLockKey(BADGE_EVALUATOR_LOCK_NAME)]);
      await lockClient.end();
    }
  });

  it('awards an eligible verification-gated badge to a script_verified profile', async () => {
    const profile = await seedTierProfile('script');

    const result = await runBadgeEvaluationCycle({
      logger: createLogger(),
      supabaseClient: createSchemaServiceRoleClient(),
    });

    expect(result.lockAcquired).toBe(true);
    expect(result.awarded).toBeGreaterThan(0);
    expect(await awardedCount(profile.id, 'tier')).toBe(1);
    expect(await badgeAwardAuditCount(profile.id, 'tier')).toBe(1);
    expect(logs.some((line) => line.event === 'badge_cron.completed')).toBe(true);
  });

  it('does not award verification-gated badges to self_reported profiles', async () => {
    const profile = await seedTierProfile('self', 'self_reported');

    const result = await runBadgeEvaluationCycle({
      logger: createLogger(),
      supabaseClient: createSchemaServiceRoleClient(),
    });

    const slugs = await awardedSlugs(profile.id);

    expect(result.lockAcquired).toBe(true);
    expect(slugs).not.toContain('tier');
    expect(slugs).not.toContain('operator');
    expect(slugs).not.toContain('iron_streak');
    expect(slugs).not.toContain('cache_whisperer');
    expect(slugs).not.toContain('reasoning_junkie');
  });

  it('does not re-award an already persisted badge on subsequent runs', async () => {
    const profile = await seedTierProfile('idempotent');

    const first = await runBadgeEvaluationCycle({
      logger: createLogger(),
      supabaseClient: createSchemaServiceRoleClient(),
    });
    const second = await runBadgeEvaluationCycle({
      logger: createLogger(),
      supabaseClient: createSchemaServiceRoleClient(),
    });

    expect(first.awarded).toBeGreaterThan(0);
    expect(second.lockAcquired).toBe(true);
    expect(second.awarded).toBe(0);
    expect(await awardedCount(profile.id, 'tier')).toBe(1);
    expect(await badgeAwardAuditCount(profile.id, 'tier')).toBe(1);
  });

  it('prevents concurrent evaluator runs with the advisory lock', async () => {
    const profile = await seedTierProfile('concurrent');

    const [first, second] = await Promise.all([
      runBadgeEvaluationCycle({
        logger: createLogger(),
        supabaseClient: createSchemaServiceRoleClient(),
      }),
      runBadgeEvaluationCycle({
        logger: createLogger(),
        supabaseClient: createSchemaServiceRoleClient(),
      }),
    ]);

    expect([first.lockAcquired, second.lockAcquired].filter(Boolean)).toHaveLength(1);
    expect(first.awarded + second.awarded).toBeGreaterThan(0);
    expect(await awardedCount(profile.id, 'tier')).toBe(1);
  });

  it('logs and swallows cron callback errors without rejecting execution', async () => {
    const missingSchemaClient = createClient(
      readRequiredEnv('SUPABASE_URL'),
      readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
      {
        db: {
          schema: 'tokensrank_missing_cron',
        },
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
        global: {
          headers: {
            'Accept-Profile': 'tokensrank_missing_cron',
            'Content-Profile': 'tokensrank_missing_cron',
          },
        },
      },
    );
    const task = initBadgeCron({
      logger: createLogger(),
      supabaseClient: missingSchemaClient,
    });

    try {
      await expect(task.execute()).resolves.toBeUndefined();
      expect(logs.some((line) => line.event === 'badge_cron.failed')).toBe(true);
    } finally {
      task.stop();
    }
  }, 30000);
});
