import { describe, expect, it } from 'vitest';

import {
  criteriaValidators,
  evaluateBadge,
  applyUniqueSessionCounts,
} from './badge-evaluator';
import type {
  AggregateSnapshot,
  BadgeCriteria,
  ProfileSnapshot,
  SessionSnapshot,
} from './badges/types';

const profile: ProfileSnapshot = {
  id: 'profile-1',
  mode: 'script_verified',
  handle: 'badgeunit',
};

it('does not award a session-count badge by counting a multi-model session twice', () => {
  const rows = ['model-a', 'model-b'].map((model) => ({ profile_id: profile.id, date: '2026-09-14', source: 'codex', model, total_tokens: 10, total_sessions: 6 }));
  rows.push({ ...rows[0]!, date: '2026-09-13' });
  const corrected = applyUniqueSessionCounts(rows, [{ profile_id: profile.id, date: '2026-09-14', source: 'codex', total_sessions: 6 }]);
  expect(corrected.reduce((total, row) => total + Number(row.total_tokens), 0)).toBe(30);
  expect(corrected.reduce((total, row) => total + Number(row.total_sessions), 0)).toBe(6);
  expect(evaluateBadge(profile, [], corrected, { slug: 'operator' }).awarded).toBe(false);
});

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    source: 'claude',
    session_id: `session-${Math.random().toString(36).slice(2)}`,
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

function aggregate(overrides: Partial<AggregateSnapshot> = {}): AggregateSnapshot {
  return {
    profile_id: profile.id,
    date: '2026-04-01',
    source: 'claude',
    model: 'claude-3-5-sonnet',
    total_tokens: 100,
    total_sessions: 1,
    ...overrides,
  };
}

function modelSessions(count: number, tokens = 100): SessionSnapshot[] {
  return Array.from({ length: count }, (_, index) => session({
    model: `model-${index}`,
    total_tokens: tokens,
  }));
}

function consecutiveAggregates(count: number): AggregateSnapshot[] {
  return Array.from({ length: count }, (_, index) => aggregate({
    date: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    total_sessions: 1,
  }));
}

type ValidatorCase = {
  slug: keyof typeof criteriaValidators;
  criteria: BadgeCriteria;
  passSessions?: SessionSnapshot[];
  passAggregates?: AggregateSnapshot[];
  failSessions?: SessionSnapshot[];
  failAggregates?: AggregateSnapshot[];
  evidenceKey: string;
};

const cases: ValidatorCase[] = [
  {
    slug: 'tier',
    criteria: { threshold_tokens: 25_000_000 },
    passSessions: [session({ total_tokens: 25_000_000 })],
    failSessions: [session({ total_tokens: 24_999_999 })],
    evidenceKey: 'tokens_total',
  },
  {
    slug: 'iron_streak',
    criteria: { min_consecutive_days: 30 },
    passAggregates: consecutiveAggregates(30),
    failAggregates: [aggregate({ date: '2026-01-01' }), aggregate({ date: '2026-01-03' })],
    evidenceKey: 'consecutive_days',
  },
  {
    slug: 'operator',
    criteria: { min_sessions_per_day_avg: 10 },
    passAggregates: [aggregate({ total_sessions: 10 })],
    failAggregates: [aggregate({ total_sessions: 9 })],
    evidenceKey: 'sessions_per_day_avg',
  },
  {
    slug: 'cache_whisperer',
    criteria: { min_cache_read_ratio: 0.3 },
    passSessions: [session({ input_tokens: 70, output_tokens: 0, cache_read_tokens: 30 })],
    failSessions: [session({ input_tokens: 80, output_tokens: 0, cache_read_tokens: 20 })],
    evidenceKey: 'cache_read_ratio',
  },
  {
    slug: 'night_owl',
    criteria: { min_night_sessions_pct: 0.5, night_start_hour: 22, night_end_hour: 6 },
    passSessions: [
      session({ first_event_at: '2026-04-01T22:00:00.000Z' }),
      session({ first_event_at: '2026-04-01T05:59:00.000Z' }),
    ],
    failSessions: [
      session({ first_event_at: '2026-04-01T12:00:00.000Z' }),
      session({ first_event_at: '2026-04-01T13:00:00.000Z' }),
    ],
    evidenceKey: 'night_session_ratio',
  },
  {
    slug: 'multi_provider',
    criteria: { requires_claude: true, requires_codex: true },
    passSessions: [session({ source: 'claude' }), session({ source: 'codex', model: 'gpt-5-codex' })],
    failSessions: [session({ source: 'claude' })],
    evidenceKey: 'has_codex',
  },
  {
    slug: 'conductor',
    criteria: { min_models_used: 5 },
    passSessions: modelSessions(5),
    failSessions: modelSessions(4),
    evidenceKey: 'models_used',
  },
  {
    slug: 'outage_witness',
    criteria: { requires_error_tag: true },
    passSessions: [session({ fingerprint: { error_tag: 'api_5xx' } })],
    failSessions: [session({ fingerprint: { status: 'ok' } })],
    evidenceKey: 'error_tag',
  },
  {
    slug: 'reasoning_junkie',
    criteria: { min_reasoning_tokens: 1, min_reasoning_ratio: 0.1 },
    passSessions: [session({ input_tokens: 90, output_tokens: 0, reasoning_tokens: 10 })],
    failSessions: [session({ input_tokens: 99, output_tokens: 0, reasoning_tokens: 1 })],
    evidenceKey: 'reasoning_ratio',
  },
  {
    slug: 'marathoner',
    criteria: { min_session_hours: 6 },
    passSessions: [session({
      first_event_at: '2026-04-01T00:00:00.000Z',
      last_event_at: '2026-04-01T06:00:00.000Z',
    })],
    failSessions: [session({
      first_event_at: '2026-04-01T00:00:00.000Z',
      last_event_at: '2026-04-01T05:59:00.000Z',
    })],
    evidenceKey: 'max_session_hours',
  },
  {
    slug: 'detonation',
    criteria: { min_daily_tokens: 10_000_000 },
    passAggregates: [aggregate({ total_tokens: 10_000_000 })],
    failAggregates: [aggregate({ total_tokens: 9_999_999 })],
    evidenceKey: 'peak_daily_tokens',
  },
  {
    slug: 'long_context',
    criteria: { min_context_tokens: 100_000 },
    passSessions: [session({ input_tokens: 100_000, output_tokens: 0 })],
    failSessions: [session({ input_tokens: 99_999, output_tokens: 0 })],
    evidenceKey: 'max_context_tokens',
  },
  {
    slug: 'defection_arc',
    criteria: { from_model: 'claude', to_model: 'codex' },
    passSessions: [
      session({ source: 'claude', first_event_at: '2026-04-01T00:00:00.000Z' }),
      session({ source: 'codex', model: 'gpt-5-codex', first_event_at: '2026-04-02T00:00:00.000Z' }),
    ],
    failSessions: [
      session({ source: 'codex', model: 'gpt-5-codex', first_event_at: '2026-04-01T00:00:00.000Z' }),
      session({ source: 'claude', first_event_at: '2026-04-02T00:00:00.000Z' }),
    ],
    evidenceKey: 'transitioned',
  },
  {
    slug: 'two_tool',
    criteria: { requires_both_models: true },
    passSessions: [session({ source: 'claude' }), session({ source: 'codex', model: 'gpt-5-codex' })],
    failSessions: [session({ source: 'codex', model: 'gpt-5-codex' })],
    evidenceKey: 'has_claude',
  },
  {
    slug: 'drifter',
    criteria: { min_models_used: 8 },
    passSessions: modelSessions(8),
    failSessions: modelSessions(7),
    evidenceKey: 'models_used',
  },
  {
    slug: 'sniper',
    criteria: { require_singular_focus: true, focus_ratio_threshold: 0.9 },
    passSessions: [
      session({ model: 'claude-opus', total_tokens: 90 }),
      session({ model: 'codex-mini', total_tokens: 10 }),
    ],
    failSessions: [
      session({ model: 'claude-opus', total_tokens: 89 }),
      session({ model: 'codex-mini', total_tokens: 11 }),
    ],
    evidenceKey: 'top_model_ratio',
  },
];

describe('badge evaluator validator map', () => {
  it('registers exactly the 16 design-canon validators', () => {
    expect(Object.keys(criteriaValidators).sort()).toEqual(cases.map((entry) => entry.slug).sort());
  });

  it.each(cases)('$slug passes when criteria are met', (entry) => {
    const result = criteriaValidators[entry.slug](
      profile,
      entry.passSessions ?? [],
      entry.passAggregates ?? [],
      entry.criteria,
    );

    expect(result.earned).toBe(true);
    expect(result.evidence).toHaveProperty(entry.evidenceKey);
  });

  it.each(cases)('$slug fails when criteria are not met', (entry) => {
    const result = criteriaValidators[entry.slug](
      profile,
      entry.failSessions ?? [],
      entry.failAggregates ?? [],
      entry.criteria,
    );

    expect(result.earned).toBe(false);
    expect(result.evidence).toHaveProperty(entry.evidenceKey);
  });

  it.each(cases)('$slug handles empty snapshots without throwing', (entry) => {
    expect(() => criteriaValidators[entry.slug](profile, [], [], entry.criteria)).not.toThrow();
  });
});

describe('evaluateBadge dispatcher', () => {
  it('applies verification gating before criteria evaluation', () => {
    const result = evaluateBadge(
      { ...profile, mode: 'self_reported' },
      [session({ total_tokens: 25_000_000 })],
      [],
      {
        slug: 'tier',
        requires_verification: true,
        criteria_json: { threshold_tokens: 25_000_000 },
      },
    );

    expect(result.awarded).toBe(false);
    expect(result.reason).toBe('verification_gated');
  });

  it('returns criteria_invalid for malformed criteria JSON', () => {
    const result = evaluateBadge(
      profile,
      [session({ total_tokens: 25_000_000 })],
      [],
      {
        slug: 'tier',
        requires_verification: false,
        criteria_json: { threshold_tokens: 'bad' },
      },
    );

    expect(result.awarded).toBe(false);
    expect(result.reason).toBe('criteria_invalid');
    expect(result.evidence.badge_slug).toBe('tier');
  });

  it('returns validator_not_found for unknown slugs', () => {
    const result = evaluateBadge(profile, [], [], {
      slug: 'unknown',
      requires_verification: false,
      criteria_json: {},
    });

    expect(result.awarded).toBe(false);
    expect(result.reason).toBe('validator_not_found');
  });
});
