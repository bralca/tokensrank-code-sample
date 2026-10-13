import { beforeAll, describe, expect, it } from 'vitest';

import {
  BADGE_EVALUATOR_LOCK_NAME,
  evaluateAllProfiles,
  evaluateBadge,
  hashAdvisoryLockKey,
  type BadgeCatalogRow,
} from '../../src/services/badge-evaluator';
import type {
  AggregateSnapshot,
  BadgeCriteria,
  BadgeSlug,
  ProfileSnapshot,
  SessionSnapshot,
} from '../../src/services/badges/types';
import { createPostgresClient } from '../../src/lib/postgres';
import { createSchemaServiceRoleClient } from './ingestion-test-helpers';
import { q, runSql } from './db-test-helpers';
import { resolveTestSchema, setupTestSchema } from './setup';

const schema = process.env.SUPABASE_SCHEMA ?? resolveTestSchema();

const canonicalSlugs: BadgeSlug[] = [
  'tier',
  'iron_streak',
  'operator',
  'cache_whisperer',
  'night_owl',
  'multi_provider',
  'conductor',
  'outage_witness',
  'reasoning_junkie',
  'marathoner',
  'detonation',
  'long_context',
  'defection_arc',
  'two_tool',
  'drifter',
  'sniper',
];

const verificationGatedSlugs: BadgeSlug[] = [
  'tier',
  'iron_streak',
  'operator',
  'cache_whisperer',
  'reasoning_junkie',
];

const scriptProfile: ProfileSnapshot = {
  id: 'qc3-badge-profile',
  mode: 'script_verified',
  handle: 'qc3badge',
};

let catalog = new Map<BadgeSlug, BadgeCatalogRow>();
let snapshotSessionCounter = 0;
let dbSessionCounter = 0;

type BadgeCase = {
  slug: BadgeSlug;
  passSessions?: SessionSnapshot[];
  passAggregates?: AggregateSnapshot[];
  failSessions?: SessionSnapshot[];
  failAggregates?: AggregateSnapshot[];
  evidenceKey: string;
};

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
  cacheCreateTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  firstHour?: number;
  durationHours?: number;
  errorTag?: string;
  ingestionMode?: 'script_verified' | 'self_reported';
};

function snapshotSession(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  snapshotSessionCounter += 1;

  return {
    source: 'claude',
    session_id: `qc3-badge-snapshot-${snapshotSessionCounter}`,
    model: 'claude-3-5-sonnet',
    first_event_at: '2026-04-01T12:00:00.000Z',
    last_event_at: '2026-04-01T13:00:00.000Z',
    input_tokens: 100,
    output_tokens: 100,
    cache_read_tokens: 0,
    cache_create_tokens: 0,
    cached_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: null,
    turns: 1,
    ...overrides,
  };
}

function snapshotAggregate(overrides: Partial<AggregateSnapshot> = {}): AggregateSnapshot {
  return {
    profile_id: scriptProfile.id,
    date: '2026-04-01',
    source: 'claude',
    model: 'claude-3-5-sonnet',
    total_tokens: 100,
    total_sessions: 1,
    ...overrides,
  };
}

function modelSessions(count: number, tokens = 100): SessionSnapshot[] {
  return Array.from({ length: count }, (_, index) => snapshotSession({
    model: `model-${index}`,
    total_tokens: tokens,
  }));
}

function consecutiveAggregates(count: number): AggregateSnapshot[] {
  return Array.from({ length: count }, (_, index) => snapshotAggregate({
    date: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    total_sessions: 1,
  }));
}

const badgeCases: BadgeCase[] = [
  {
    slug: 'tier',
    passSessions: [snapshotSession({ total_tokens: 25_000_000 })],
    failSessions: [snapshotSession({ total_tokens: 24_999_999 })],
    evidenceKey: 'tokens_total',
  },
  {
    slug: 'iron_streak',
    passAggregates: consecutiveAggregates(30),
    failAggregates: [snapshotAggregate({ date: '2026-01-01' }), snapshotAggregate({ date: '2026-01-03' })],
    evidenceKey: 'consecutive_days',
  },
  {
    slug: 'operator',
    passAggregates: [snapshotAggregate({ total_sessions: 10 })],
    failAggregates: [snapshotAggregate({ total_sessions: 9 })],
    evidenceKey: 'sessions_per_day_avg',
  },
  {
    slug: 'cache_whisperer',
    passSessions: [snapshotSession({ input_tokens: 70, output_tokens: 0, cache_read_tokens: 30 })],
    failSessions: [snapshotSession({ input_tokens: 80, output_tokens: 0, cache_read_tokens: 20 })],
    evidenceKey: 'cache_read_ratio',
  },
  {
    slug: 'night_owl',
    passSessions: [
      snapshotSession({ first_event_at: '2026-04-01T22:00:00.000Z' }),
      snapshotSession({ first_event_at: '2026-04-01T05:59:00.000Z' }),
    ],
    failSessions: [
      snapshotSession({ first_event_at: '2026-04-01T12:00:00.000Z' }),
      snapshotSession({ first_event_at: '2026-04-01T13:00:00.000Z' }),
    ],
    evidenceKey: 'night_session_ratio',
  },
  {
    slug: 'multi_provider',
    passSessions: [snapshotSession({ source: 'claude' }), snapshotSession({ source: 'codex', model: 'gpt-5-codex' })],
    failSessions: [snapshotSession({ source: 'claude' })],
    evidenceKey: 'has_codex',
  },
  {
    slug: 'conductor',
    passSessions: modelSessions(5),
    failSessions: modelSessions(4),
    evidenceKey: 'models_used',
  },
  {
    slug: 'outage_witness',
    passSessions: [snapshotSession({ fingerprint: { error_tag: 'api_5xx' } })],
    failSessions: [snapshotSession({ fingerprint: { status: 'ok' } })],
    evidenceKey: 'error_tag',
  },
  {
    slug: 'reasoning_junkie',
    passSessions: [snapshotSession({ input_tokens: 90, output_tokens: 0, reasoning_tokens: 10 })],
    failSessions: [snapshotSession({ input_tokens: 99, output_tokens: 0, reasoning_tokens: 1 })],
    evidenceKey: 'reasoning_ratio',
  },
  {
    slug: 'marathoner',
    passSessions: [snapshotSession({
      first_event_at: '2026-04-01T00:00:00.000Z',
      last_event_at: '2026-04-01T06:00:00.000Z',
    })],
    failSessions: [snapshotSession({
      first_event_at: '2026-04-01T00:00:00.000Z',
      last_event_at: '2026-04-01T05:59:00.000Z',
    })],
    evidenceKey: 'max_session_hours',
  },
  {
    slug: 'detonation',
    passAggregates: [snapshotAggregate({ total_tokens: 10_000_000 })],
    failAggregates: [snapshotAggregate({ total_tokens: 9_999_999 })],
    evidenceKey: 'peak_daily_tokens',
  },
  {
    slug: 'long_context',
    passSessions: [snapshotSession({ input_tokens: 100_000, output_tokens: 0 })],
    failSessions: [snapshotSession({ input_tokens: 99_999, output_tokens: 0 })],
    evidenceKey: 'max_context_tokens',
  },
  {
    slug: 'defection_arc',
    passSessions: [
      snapshotSession({ source: 'claude', first_event_at: '2026-04-01T00:00:00.000Z' }),
      snapshotSession({ source: 'codex', model: 'gpt-5-codex', first_event_at: '2026-04-02T00:00:00.000Z' }),
    ],
    failSessions: [
      snapshotSession({ source: 'codex', model: 'gpt-5-codex', first_event_at: '2026-04-01T00:00:00.000Z' }),
      snapshotSession({ source: 'claude', first_event_at: '2026-04-02T00:00:00.000Z' }),
    ],
    evidenceKey: 'transitioned',
  },
  {
    slug: 'two_tool',
    passSessions: [snapshotSession({ source: 'claude' }), snapshotSession({ source: 'codex', model: 'gpt-5-codex' })],
    failSessions: [snapshotSession({ source: 'codex', model: 'gpt-5-codex' })],
    evidenceKey: 'has_claude',
  },
  {
    slug: 'drifter',
    passSessions: modelSessions(8),
    failSessions: modelSessions(7),
    evidenceKey: 'models_used',
  },
  {
    slug: 'sniper',
    passSessions: [
      snapshotSession({ model: 'claude-opus', total_tokens: 90 }),
      snapshotSession({ model: 'codex-mini', total_tokens: 10 }),
    ],
    failSessions: [
      snapshotSession({ model: 'claude-opus', total_tokens: 89 }),
      snapshotSession({ model: 'codex-mini', total_tokens: 11 }),
    ],
    evidenceKey: 'top_model_ratio',
  },
];

function badgeFor(slug: BadgeSlug): BadgeCatalogRow {
  const badge = catalog.get(slug);

  if (!badge) {
    throw new Error(`Missing badge catalog row for ${slug}`);
  }

  return badge;
}

async function refreshCatalog(): Promise<void> {
  const admin = createSchemaServiceRoleClient();
  let lastError: string | undefined;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { data, error } = await admin
      .from('badges')
      .select('slug,name,description,icon_slug,requires_verification,criteria_json,tier')
      .order('slug', { ascending: true });

    if (!error) {
      catalog = new Map(
        (data ?? []).map((row) => [row.slug as BadgeSlug, row as BadgeCatalogRow]),
      );

      return;
    }

    lastError = error.message;
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
  }

  throw new Error(`[badge-evaluator-test] badge catalog lookup failed: ${lastError ?? 'unknown error'}`);
}

async function resetBadgeSchema(): Promise<void> {
  dbSessionCounter = 0;
  await setupTestSchema(schema);
  await refreshCatalog();
}

function isoFor(dayOffset: number, hour: number): string {
  const baseDate = Date.UTC(2026, 0, 1, 12, 0, 0);
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
    throw new Error('[badge-evaluator-test] Failed to seed profile');
  }

  return {
    id,
    user_id: id,
    handle: options.handle,
  };
}

async function seedSession(profileId: string, options: SeedSessionOptions = {}): Promise<void> {
  dbSessionCounter += 1;
  const source = options.source ?? 'claude';
  const model = options.model ?? (source === 'claude' ? 'claude-3-5-sonnet' : 'gpt-5-codex');
  const firstEventAt = isoFor(options.dayOffset ?? 0, options.firstHour ?? 12);
  const lastEventAt = new Date(new Date(firstEventAt).getTime() + (options.durationHours ?? 1) * 60 * 60 * 1000).toISOString();
  const fingerprint = options.errorTag ? { error_tag: options.errorTag } : {};
  const sessionId = `qc3-badge-db-session-${dbSessionCounter}`;

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
      $9,
      $10,
      $11,
      $12,
      1,
      $13,
      $14::jsonb
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
    options.cacheReadTokens ?? 0,
    options.cacheCreateTokens ?? 0,
    options.cachedTokens ?? 0,
    options.reasoningTokens ?? 0,
    options.ingestionMode ?? 'script_verified',
    JSON.stringify(fingerprint),
  ]);
}

async function seedTierProfile(handle: string, mode: 'script_verified' | 'self_reported' = 'script_verified') {
  const profile = await seedProfile({ handle, mode });
  await seedSession(profile.id, {
    inputTokens: 25_000_000,
    outputTokens: 0,
    ingestionMode: mode,
  });

  return profile;
}

async function runEvaluator(profileId: string) {
  return evaluateAllProfiles(createSchemaServiceRoleClient(), {
    filterProfileIds: [profileId],
  });
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

async function awardedCount(profileId: string, badgeSlug: BadgeSlug): Promise<number> {
  const rows = await runSql<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM ${q(schema)}.profile_badges
    WHERE profile_id = $1
      AND badge_slug = $2
  `, [profileId, badgeSlug]);

  return Number(rows[0]?.count ?? 0);
}

beforeAll(async () => {
  await resetBadgeSchema();
});

describe.sequential('QC-3 badge evaluator catalog coherence', () => {
  it('loads exactly the 16 design-canon badge rows from the seeded catalog', () => {
    expect(Array.from(catalog.keys()).sort()).toEqual([...canonicalSlugs].sort());
    expect(
      verificationGatedSlugs.every((slug) => catalog.get(slug)?.requires_verification === true),
    ).toBe(true);
  });

  it.each(badgeCases)('$slug awards when the catalog criteria are met', (entry) => {
    const result = evaluateBadge(
      scriptProfile,
      entry.passSessions ?? [],
      entry.passAggregates ?? [],
      badgeFor(entry.slug),
    );

    expect(result.awarded).toBe(true);
    expect(result.reason).toBe('awarded');
    expect(result.evidence).toHaveProperty(entry.evidenceKey);
  });

  it.each(badgeCases)('$slug does not award when the catalog criteria are missed', (entry) => {
    const result = evaluateBadge(
      scriptProfile,
      entry.failSessions ?? [],
      entry.failAggregates ?? [],
      badgeFor(entry.slug),
    );

    expect(result.awarded).toBe(false);
    expect(result.reason).toBe('criteria_not_met');
    expect(result.evidence).toHaveProperty(entry.evidenceKey);
  });

  it.each(verificationGatedSlugs)('%s is blocked for self_reported profiles before criteria evaluation', (slug) => {
    const entry = badgeCases.find((item) => item.slug === slug);

    if (!entry) {
      throw new Error(`Missing positive badge case for ${slug}`);
    }

    const result = evaluateBadge(
      { ...scriptProfile, mode: 'self_reported' },
      entry.passSessions ?? [],
      entry.passAggregates ?? [],
      badgeFor(slug),
    );

    expect(result.awarded).toBe(false);
    expect(result.reason).toBe('verification_gated');
    expect(result.evidence).toEqual({
      badge_slug: slug,
      required_mode: 'script_verified',
      profile_mode: 'self_reported',
    });
  });

  it('does not persist verification-gated badge awards for self_reported profiles', async () => {
    await resetBadgeSchema();
    const profile = await seedTierProfile('qc3_badge_self', 'self_reported');

    await runEvaluator(profile.id);

    const slugs = await awardedSlugs(profile.id);
    expect(slugs.filter((slug) => verificationGatedSlugs.includes(slug as BadgeSlug))).toEqual([]);
  });

  it('persists an evidence snapshot for awarded badges', async () => {
    await resetBadgeSchema();
    const profile = await seedTierProfile('qc3_badge_evidence');

    const result = await runEvaluator(profile.id);

    expect(result.lockAcquired).toBe(true);
    expect(result.awarded).toBeGreaterThan(0);

    const rows = await runSql<{ evidence: Record<string, unknown> }>(`
      SELECT evidence
      FROM ${q(schema)}.profile_badges
      WHERE profile_id = $1
        AND badge_slug = 'tier'
    `, [profile.id]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.evidence).toEqual({
      aggregates_count: 1,
      sessions_count: 1,
      threshold_tokens: 25_000_000,
      tokens_total: 25_000_000,
    });
  });

  it('uses the advisory lock to prevent duplicate awards during concurrent evaluator runs', async () => {
    await resetBadgeSchema();
    const profile = await seedTierProfile('qc3_badge_lock');
    const lockClient = await createPostgresClient();

    try {
      await lockClient.query('SELECT pg_advisory_lock($1)', [hashAdvisoryLockKey(BADGE_EVALUATOR_LOCK_NAME)]);

      const blockedRuns = await Promise.all([
        runEvaluator(profile.id),
        runEvaluator(profile.id),
      ]);

      expect(blockedRuns).toEqual([
        expect.objectContaining({ lockAcquired: false, awarded: 0 }),
        expect.objectContaining({ lockAcquired: false, awarded: 0 }),
      ]);
      expect(await awardedCount(profile.id, 'tier')).toBe(0);
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [hashAdvisoryLockKey(BADGE_EVALUATOR_LOCK_NAME)]);
      await lockClient.end();
    }

    const firstAward = await runEvaluator(profile.id);
    const concurrentReruns = await Promise.all([
      runEvaluator(profile.id),
      runEvaluator(profile.id),
    ]);

    expect(firstAward.lockAcquired).toBe(true);
    expect(firstAward.awarded).toBeGreaterThan(0);
    expect(concurrentReruns.every((result) => result.awarded === 0)).toBe(true);
    expect(await awardedCount(profile.id, 'tier')).toBe(1);
  });
});
