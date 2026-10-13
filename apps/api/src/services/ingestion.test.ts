import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.SUPABASE_URL ??= 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';
});

import type { SessionPayload } from '@tokensrank/shared';
import type { AccessKeyContext } from '../middleware/auth';
import { IngestionService } from './ingestion';

const nowMs = Date.UTC(2026, 3, 28, 12, 0, 0);

type FakeState = {
  cachePurges: number;
  existingSessions: Array<Partial<SessionPayload> & { profile_id?: string; total_tokens?: number; id?: string }>;
  insertedSessions: any[];
  ingestionRuns: any[];
  profile: { id: string; mode: 'script_verified' | 'self_reported' | null; verified: boolean };
  ratchetLookups: number;
};

function iso(offsetMs: number): string {
  return new Date(nowMs + offsetMs).toISOString();
}

function createSession(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    session_id: 'session-1',
    model: 'claude-3-5-sonnet-20241022',
    source: 'claude',
    first_event_at: iso(-60_000),
    last_event_at: iso(0),
    input_tokens: 10_000,
    output_tokens: 5_000,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0,
    turns: 3,
    file_sha256: 'a'.repeat(64),
    ...overrides,
  };
}

function createPayload(sessions: SessionPayload[] = [createSession()]) {
  return {
    client: {
      version: '1.0.0',
      install_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      platform: 'darwin',
      arch: 'arm64',
    },
    run: {
      run_id: 'run-1',
      started_at: iso(-120_000),
      finished_at: iso(0),
    },
    sessions,
  };
}

function createAuth(mode: AccessKeyContext['mode'] = 'self_reported'): AccessKeyContext {
  return {
    profileId: 'profile-1',
    accessKeyId: 'access-key-1',
    keySha256: 'access-key-sha-1',
    scope: 'script',
    mode,
    profile: {},
  };
}

function createState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    cachePurges: 0,
    existingSessions: [],
    insertedSessions: [],
    ingestionRuns: [],
    profile: { id: 'profile-1', mode: 'self_reported', verified: false },
    ratchetLookups: 0,
    ...overrides,
  };
}

function createFakeSupabaseClient(state: FakeState) {
  class Query {
    private filters = new Map<string, unknown>();
    private inFilters = new Map<string, unknown[]>();
    private pendingInsert: unknown;
    private pendingUpdate: Record<string, unknown> | null = null;
    private pendingUpsert: any[] | null = null;
    private orderColumn: string | null = null;
    private selectedColumns = '';

    constructor(private readonly table: string) {}

    select(columns?: string) {
      this.selectedColumns = columns ?? '';
      return this;
    }

    returns() {
      return this;
    }

    insert(payload: unknown) {
      this.pendingInsert = payload;
      return this;
    }

    update(payload: Record<string, unknown>) {
      this.pendingUpdate = payload;
      return this;
    }

    upsert(payload: any[]) {
      this.pendingUpsert = payload;
      return this;
    }

    eq(column: string, value: unknown) {
      this.filters.set(column, value);
      return this;
    }

    or() {
      return this;
    }

    in(column: string, values: unknown[]) {
      this.inFilters.set(column, values);
      return this;
    }

    gte(column: string, value: unknown) {
      this.filters.set(`${column}:gte`, value);
      return this;
    }

    order(column: string) {
      this.orderColumn = column;
      return this;
    }

    limit() {
      return this;
    }

    maybeSingle() {
      if (this.table === 'profiles' && this.pendingUpdate) {
        Object.assign(state.profile, this.pendingUpdate);
        return Promise.resolve({
          data: { mode: state.profile.mode },
          error: null,
        });
      }

      state.ratchetLookups += 1;
      const rows = this.matchSessions();
      const sorted = this.orderColumn
        ? [...rows].sort((a, b) => String(b[this.orderColumn as keyof typeof b]).localeCompare(String(a[this.orderColumn as keyof typeof a])))
        : rows;

      return Promise.resolve({
        data: sorted[0] ?? null,
        error: null,
      });
    }

    single() {
      if (this.table === 'ingestion_runs' && this.pendingInsert) {
        const row = {
          id: `run-${state.ingestionRuns.length + 1}`,
          ...(this.pendingInsert as Record<string, unknown>),
        };
        state.ingestionRuns.push(row);
        return Promise.resolve({ data: { id: row.id }, error: null });
      }

      if (this.table === 'profiles') {
        return Promise.resolve({ data: { mode: state.profile.mode }, error: null });
      }

      return Promise.resolve({ data: null, error: null });
    }

    then(resolve: (value: unknown) => void, reject: (reason?: unknown) => void) {
      return this.execute().then(resolve, reject);
    }

    private execute() {
      if (this.table === 'sessions' && this.pendingUpsert) {
        const inserted = [];

        for (const row of this.pendingUpsert) {
          const duplicate = state.existingSessions.some((existing) => (
            existing.profile_id === row.profile_id
            && existing.source === row.source
            && existing.session_id === row.session_id
            && existing.file_sha256 === row.file_sha256
          ));

          if (!duplicate) {
            const insertedRow = { id: `session-${state.insertedSessions.length + 1}`, ...row };
            state.insertedSessions.push(insertedRow);
            state.existingSessions.push(insertedRow);
            inserted.push({ id: insertedRow.id, session_id: insertedRow.session_id });
          }
        }

        return Promise.resolve({ data: inserted, error: null });
      }

      if (this.table === 'sessions') {
        if (this.selectedColumns.includes('file_sha256') && this.selectedColumns.includes('last_event_at')) {
          state.ratchetLookups += 1;
        }

        return Promise.resolve({ data: this.matchSessions(), error: null });
      }

      if (this.table === 'ingestion_runs' && this.pendingUpdate) {
        const id = this.filters.get('id');
        const run = state.ingestionRuns.find((candidate) => candidate.id === id);

        if (run) {
          Object.assign(run, this.pendingUpdate);
        }

        return Promise.resolve({ data: null, error: null });
      }

      if (this.table === 'profiles' && this.pendingUpdate) {
        Object.assign(state.profile, this.pendingUpdate);
        return Promise.resolve({ data: null, error: null });
      }

      return Promise.resolve({ data: [], error: null });
    }

    private matchSessions() {
      return state.existingSessions.filter((session) => {
        for (const [column, value] of this.filters.entries()) {
          if (column.endsWith(':gte')) {
            const field = column.slice(0, -4);
            const sessionValue = (session as Record<string, unknown>)[field];

            if (typeof sessionValue !== 'string' || typeof value !== 'string' || sessionValue < value) {
              return false;
            }

            continue;
          }

          if ((session as Record<string, unknown>)[column] !== value) {
            return false;
          }
        }

        for (const [column, values] of this.inFilters.entries()) {
          if (!values.includes((session as Record<string, unknown>)[column])) {
            return false;
          }
        }

        return true;
      });
    }
  }

  return {
    from(table: string) {
      return new Query(table);
    },
  } as never;
}

function createServices(state = createState()) {
  const supabaseClient = createFakeSupabaseClient(state);
  const ingestionService = new IngestionService({
    supabaseClient,
    cacheInvalidator: () => {
      state.cachePurges += 1;
      return state.cachePurges;
    },
  });

  return { ingestionService, state };
}

describe('IngestionService lifecycle', () => {
  it('persists accepted sessions, escalates script mode, invalidates cache, and closes completed', async () => {
    const { ingestionService, state } = createServices();
    const result = await ingestionService.ingest(createAuth('self_reported'), createPayload(), 'script');

    expect(result).toMatchObject({
      ok: true,
      accepted: 1,
      deduped: 0,
      rejected: 0,
      status: 'completed',
    });
    expect(state.insertedSessions).toHaveLength(1);
    expect(state.insertedSessions[0]).not.toHaveProperty('total_tokens');
    expect(state.profile).toMatchObject({ mode: 'script_verified', verified: true });
    expect(state.cachePurges).toBe(1);
    expect(state.ingestionRuns[0]).toMatchObject({
      status: 'completed',
      duplicate_count: 0,
      rejected_count: 0,
    });
    ingestionService.dispose();
  });

  it('closes partial when accepted and rejected (bounds-violation) sessions are both present', async () => {
    const { ingestionService, state } = createServices();
    const result = await ingestionService.ingest(createAuth('script_verified'), createPayload([
      createSession({ session_id: 'valid', file_sha256: 'd'.repeat(64) }),
      createSession({
        session_id: 'oversized',
        file_sha256: 'e'.repeat(64),
        input_tokens: 200_000_000, // exceeds MAX_TOTAL_TOKENS -> bounds_violation
      }),
    ]), 'script');

    expect(result).toMatchObject({
      ok: true,
      accepted: 1,
      rejected: 1,
      status: 'partial',
    });
    expect(state.ingestionRuns[0]).toMatchObject({ status: 'partial', rejected_count: 1 });

    ingestionService.dispose();
  });

  it('treats all-deduped retries as completed without inserting sessions', async () => {
    const duplicate = createSession({ session_id: 'dupe' });
    const { ingestionService, state } = createServices(createState({
      existingSessions: [{ ...duplicate, profile_id: 'profile-1' }],
    }));
    const result = await ingestionService.ingest(createAuth('script_verified'), createPayload([duplicate]), 'script');

    expect(result).toMatchObject({
      ok: true,
      accepted: 0,
      deduped: 1,
      rejected: 0,
      status: 'completed',
    });
    expect(state.insertedSessions).toHaveLength(0);
    expect(state.cachePurges).toBe(0);
    expect(state.ingestionRuns[0]).toMatchObject({
      status: 'completed',
      duplicate_count: 1,
      rejected_count: 0,
    });

    ingestionService.dispose();
  });

  it('does not escalate self-reported ingestion', async () => {
    const auth = createAuth('self_reported');
    auth.scope = 'self_reported';
    const { ingestionService, state } = createServices();
    const result = await ingestionService.ingest(auth, createPayload(), 'self_reported');

    expect(result).toMatchObject({ ok: true, accepted: 1, status: 'completed' });
    expect(state.profile).toMatchObject({ mode: 'self_reported', verified: false });

    ingestionService.dispose();
  });

  it('opens and closes a failed ingestion run for schema failures', async () => {
    const { ingestionService, state } = createServices();
    const result = await ingestionService.ingest(createAuth(), { sessions: [{ extra: true }] }, 'script');

    expect(result).toMatchObject({
      ok: false,
      reason_code: 'schema_invalid',
      status: 'failed',
    });
    expect(state.ingestionRuns[0]).toMatchObject({
      status: 'failed',
      rejected_count: 1,
    });

    ingestionService.dispose();
  });
});
