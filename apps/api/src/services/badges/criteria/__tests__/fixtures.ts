import {
  type AggregateSnapshot,
  type ProfileSnapshot,
  type SessionSnapshot,
} from '../../types';

export const profileFixture: ProfileSnapshot = {
  id: '11111111-1111-1111-1111-111111111111',
  handle: 'alice',
  mode: 'script_verified',
};

export function sessionFixture(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    session_id: 'session-1',
    source: 'claude',
    model: 'claude-3-5-sonnet',
    first_event_at: '2026-04-01T10:00:00.000Z',
    last_event_at: '2026-04-01T11:00:00.000Z',
    input_tokens: 1_000,
    output_tokens: 1_000,
    cache_read_tokens: 0,
    cache_create_tokens: 0,
    cached_tokens: 0,
    reasoning_tokens: 0,
    ...overrides,
  };
}

export function aggregateFixture(overrides: Partial<AggregateSnapshot> = {}): AggregateSnapshot {
  return {
    profile_id: profileFixture.id,
    date: '2026-04-01',
    source: 'claude',
    model: 'claude-3-5-sonnet',
    total_tokens: 2_000,
    total_sessions: 1,
    ...overrides,
  };
}

export function consecutiveAggregates(days: number): AggregateSnapshot[] {
  return Array.from({ length: days }, (_, index) => aggregateFixture({
    date: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    total_tokens: 100,
    total_sessions: 1,
  }));
}

export function modelSessions(count: number): SessionSnapshot[] {
  return Array.from({ length: count }, (_, index) => sessionFixture({
    session_id: `model-session-${index}`,
    model: `model-${index}`,
    input_tokens: 1_000 + index,
    output_tokens: 100,
  }));
}
