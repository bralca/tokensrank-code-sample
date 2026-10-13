import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server';
import { resetCacheForTests } from '../../src/services/cache';
import {
  buildIngestPayload,
  createAccessKeyFixture,
  createSchemaServiceRoleClient,
  deleteAuthUsers,
} from './ingestion-test-helpers';

const INGESTION_P95_BUDGET_MS = Number.parseInt(process.env.PERF_INGESTION_P95_MS ?? '500', 10);
const REQUEST_COUNT = Number.parseInt(process.env.PERF_INGESTION_REQUESTS ?? '20', 10);
const WARMUP_REQUEST_COUNT = Number.parseInt(process.env.PERF_INGESTION_WARMUP_REQUESTS ?? '2', 10);
const SESSIONS_PER_REQUEST = 100;

type AccessKeyFixture = Awaited<ReturnType<typeof createAccessKeyFixture>>;
type ScriptKey = {
  plaintext: string;
};

const createdUserIds = new Set<string>();

let app: Awaited<ReturnType<typeof buildServer>>;
let admin: ReturnType<typeof createSchemaServiceRoleClient>;
let originalFraudRateLimitMaxRequests: string | undefined;
let originalGlobalRateLimitMaxRequests: string | undefined;

function percentile(values: number[], percentileValue: number): number {
  const sortedValues = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil((percentileValue / 100) * sortedValues.length) - 1,
  );

  return sortedValues[index] ?? 0;
}

function uniqueLabel(prefix: string, index: number): string {
  return `${prefix}-${index}-${crypto.randomUUID().slice(0, 8)}`;
}

function sha(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function createScriptFixture(label: string): Promise<AccessKeyFixture> {
  const fixture = await createAccessKeyFixture('script', label);
  createdUserIds.add(fixture.userId);
  return fixture;
}

async function createAdditionalScriptKeys(profileId: string, count: number): Promise<ScriptKey[]> {
  const keys = Array.from({ length: count }, () => {
    const plaintext = `tr_script_${crypto.randomBytes(24).toString('base64url')}`;

    return {
      plaintext,
      row: {
        profile_id: profileId,
        key_sha256: sha(plaintext),
        key_prefix: plaintext.slice(0, 11),
        scope: 'script',
      },
    };
  });

  const { error } = await admin
    .from('access_keys')
    .insert(keys.map((key) => key.row));

  if (error) {
    throw new Error(`[performance-ingestion] access key seed failed: ${error.message}`);
  }

  return keys.map((key) => ({
    plaintext: key.plaintext,
  }));
}

async function postScriptSessions(accessKey: string, payload: unknown) {
  return await app.inject({
    method: 'POST',
    url: '/api/script/sessions',
    headers: {
      origin: 'http://localhost:3000',
      authorization: `Bearer ${accessKey}`,
      'content-type': 'application/json',
    },
    payload,
  });
}

async function getProfileMode(profileId: string): Promise<{ mode: string | null; verified: boolean }> {
  const { data, error } = await admin
    .from('profiles')
    .select('mode, verified')
    .eq('id', profileId)
    .single();

  if (error || !data) {
    throw new Error(`[performance-ingestion] profile lookup failed: ${error?.message ?? 'missing profile'}`);
  }

  return data as { mode: string | null; verified: boolean };
}

async function countRows(table: 'sessions' | 'daily_aggregates' | 'ingestion_runs', profileId: string): Promise<number> {
  const { count, error } = await admin
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('profile_id', profileId);

  if (error) {
    throw new Error(`[performance-ingestion] ${table} count failed: ${error.message}`);
  }

  return count ?? 0;
}

async function getIngestionRun(ingestionRunId: string): Promise<{ status: string; session_count: number; rejected_count: number }> {
  const { data, error } = await admin
    .from('ingestion_runs')
    .select('status, session_count, rejected_count')
    .eq('id', ingestionRunId)
    .single();

  if (error || !data) {
    throw new Error(`[performance-ingestion] ingestion run lookup failed: ${error?.message ?? 'missing run'}`);
  }

  return data as { status: string; session_count: number; rejected_count: number };
}

beforeAll(async () => {
  originalFraudRateLimitMaxRequests = process.env.FRAUD_RATE_LIMIT_MAX_REQUESTS;
  originalGlobalRateLimitMaxRequests = process.env.INGESTION_GLOBAL_RATE_LIMIT_MAX_REQUESTS;
  process.env.FRAUD_RATE_LIMIT_MAX_REQUESTS = String(Math.max(REQUEST_COUNT + 5, 25));
  process.env.INGESTION_GLOBAL_RATE_LIMIT_MAX_REQUESTS = String(
    Math.max(REQUEST_COUNT + WARMUP_REQUEST_COUNT + 5, 50),
  );
  admin = createSchemaServiceRoleClient();
  app = await buildServer({ logger: false });
  await app.ready();
});

beforeEach(() => {
  resetCacheForTests();
});

afterAll(async () => {
  resetCacheForTests();
  await app?.close();
  await deleteAuthUsers(createdUserIds);
  createdUserIds.clear();

  if (originalFraudRateLimitMaxRequests === undefined) {
    delete process.env.FRAUD_RATE_LIMIT_MAX_REQUESTS;
  } else {
    process.env.FRAUD_RATE_LIMIT_MAX_REQUESTS = originalFraudRateLimitMaxRequests;
  }

  if (originalGlobalRateLimitMaxRequests === undefined) {
    delete process.env.INGESTION_GLOBAL_RATE_LIMIT_MAX_REQUESTS;
  } else {
    process.env.INGESTION_GLOBAL_RATE_LIMIT_MAX_REQUESTS = originalGlobalRateLimitMaxRequests;
  }
});

describe.sequential('POST /api/script/sessions ingestion performance', () => {
  it('keeps 100-session batches under the p95 budget through fraud gates and persistence', async () => {
    const fixture = await createScriptFixture('perf_ingestion');
    const scriptKeys = await createAdditionalScriptKeys(fixture.profileId, REQUEST_COUNT + WARMUP_REQUEST_COUNT);

    const latenciesMs: number[] = [];
    const runDurationsMs: number[] = [];
    const ingestionRunIds: string[] = [];

    for (let index = 0; index < WARMUP_REQUEST_COUNT; index += 1) {
      const scriptKey = scriptKeys[index];

      if (!scriptKey) {
        throw new Error(`[performance-ingestion] missing script key ${index}`);
      }

      const payload = buildIngestPayload(SESSIONS_PER_REQUEST, uniqueLabel('perf-ingestion-warmup', index));
      const response = await postScriptSessions(scriptKey.plaintext, payload);

      expect(response.statusCode).toBe(202);
    }

    for (let index = 0; index < REQUEST_COUNT; index += 1) {
      const scriptKey = scriptKeys[index + WARMUP_REQUEST_COUNT];

      if (!scriptKey) {
        throw new Error(`[performance-ingestion] missing script key ${index + WARMUP_REQUEST_COUNT}`);
      }

      const payload = buildIngestPayload(SESSIONS_PER_REQUEST, uniqueLabel('perf-ingestion', index));
      const startedAt = performance.now();
      const response = await postScriptSessions(scriptKey.plaintext, payload);
      latenciesMs.push(performance.now() - startedAt);
      const body = response.json();

      expect(response.statusCode).toBe(202);
      expect(body).toMatchObject({
        accepted: SESSIONS_PER_REQUEST,
        deduped: 0,
        rejected: 0,
      });

      runDurationsMs.push(Number(body.run_duration_ms ?? body.runDurationMs ?? 0));
      ingestionRunIds.push(body.ingestion_run_id as string);
    }

    const p95Ms = percentile(latenciesMs, 95);
    const runDurationP95Ms = percentile(runDurationsMs, 95);
    const firstRunId = ingestionRunIds[0];

    if (!firstRunId) {
      throw new Error('[performance-ingestion] missing first ingestion run id');
    }

    await expect(getProfileMode(fixture.profileId)).resolves.toEqual({
      mode: 'script_verified',
      verified: true,
    });
    await expect(countRows('sessions', fixture.profileId)).resolves.toBe(
      SESSIONS_PER_REQUEST * (REQUEST_COUNT + WARMUP_REQUEST_COUNT),
    );
    await expect(countRows('daily_aggregates', fixture.profileId)).resolves.toBeGreaterThan(0);
    await expect(countRows('ingestion_runs', fixture.profileId)).resolves.toBe(REQUEST_COUNT + WARMUP_REQUEST_COUNT);
    await expect(getIngestionRun(firstRunId)).resolves.toMatchObject({
      status: 'completed',
      session_count: SESSIONS_PER_REQUEST,
      rejected_count: 0,
    });

    expect(
      runDurationP95Ms,
      `ingestion backend run_duration p95 ${runDurationP95Ms.toFixed(2)}ms exceeded ${INGESTION_P95_BUDGET_MS}ms; endpoint wall p95 ${p95Ms.toFixed(2)}ms; wall samples=${latenciesMs.map((value) => value.toFixed(2)).join(',')}`,
    ).toBeLessThan(INGESTION_P95_BUDGET_MS);
  }, 240_000);
});
