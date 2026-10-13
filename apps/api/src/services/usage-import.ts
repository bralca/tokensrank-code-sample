import {
  UsageImportFinalizeRequestSchema,
  UsageImportRequestSchema,
  type UsageEvent,
  type UsageImportRejectedDetail,
  type UsageImportRequest,
  type UsageSourceFile,
} from '@tokensrank/shared';
import type { FastifyBaseLogger } from 'fastify';
import { randomUUID } from 'node:crypto';

import { adminClient } from '../clients/supabase';
import { costForSession, pricingKey, type PricingMap } from '../lib/cost';
import type { AuthContext } from '../middleware/auth';
import { writeAuditEvent } from './audit';
import { purgeIngestionCaches } from './cache';

const MAX_EVENT_ADDITIVE_TOKENS = 200_000_000;
const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const PROJECTION_BATCH_SIZE = 1000;

type SupabaseLike = typeof adminClient;

type UsageImportOptions = {
  supabaseClient?: SupabaseLike;
  cacheInvalidator?: () => number;
};

type IngestionRunRow = {
  id: string;
};

type InsertedEventRow = {
  event_id: string;
};

type UsageEventRow = {
  source: 'claude' | 'codex';
  provider: 'anthropic' | 'openai' | 'unknown';
  session_id: string;
  event_at: string;
  model: string;
  input_tokens: number | string;
  output_tokens: number | string;
  cache_read_tokens: number | string;
  cache_create_tokens: number | string;
  cached_tokens: number | string;
  reasoning_tokens: number | string;
  total_tokens: number | string;
  source_file_hash: string;
};

export type UsageImportSuccess = {
  ok: true;
  ingestion_run_id: string;
  accepted_count: number;
  deduped_count: number;
  rejected_count: number;
  rejected_details: UsageImportRejectedDetail[];
  projected: boolean;
  run_duration_ms: number;
};

export type UsageImportFailure = {
  ok: false;
  ingestion_run_id: string;
  status_code: 400;
  reason_code: 'schema_invalid';
  message: string;
  details: Record<string, unknown>;
  run_duration_ms: number;
};

export type UsageImportResult = UsageImportSuccess | UsageImportFailure;

export type UsageImportFinalizeSuccess = {
  ok: true;
  projected: boolean;
  run_duration_ms: number;
};

export type UsageImportFinalizeFailure = {
  ok: false;
  status_code: 400;
  reason_code: 'schema_invalid';
  message: string;
  details: Record<string, unknown>;
  run_duration_ms: number;
};

export type UsageImportFinalizeResult = UsageImportFinalizeSuccess | UsageImportFinalizeFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function parseNumeric(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function additiveTokens(event: UsageEvent): number {
  return event.input_tokens
    + event.output_tokens
    + event.cache_read_tokens
    + event.cache_create_tokens;
}

function rawEventsFromBody(body: unknown): Record<string, unknown>[] {
  if (!isRecord(body) || !Array.isArray(body.events)) {
    return [];
  }

  return body.events.filter(isRecord);
}

function rawFilesFromBody(body: unknown): Record<string, unknown>[] {
  if (!isRecord(body) || !Array.isArray(body.files)) {
    return [];
  }

  return body.files.filter(isRecord);
}

function minIso(values: Array<string | null>): string | null {
  const valid = values
    .filter((value): value is string => value !== null)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);

  return valid.length > 0 ? new Date(Math.min(...valid)).toISOString() : null;
}

function maxIso(values: Array<string | null>): string | null {
  const valid = values
    .filter((value): value is string => value !== null)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);

  return valid.length > 0 ? new Date(Math.max(...valid)).toISOString() : null;
}

function dateOnly(value: string): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function totalTokens(row: UsageEventRow): number {
  const generated = parseNumeric(row.total_tokens);

  if (generated > 0) {
    return generated;
  }

  return parseNumeric(row.input_tokens)
    + parseNumeric(row.output_tokens)
    + parseNumeric(row.cache_read_tokens)
    + parseNumeric(row.cache_create_tokens);
}

function eventCost(row: UsageEventRow, pricing: PricingMap): number {
  return costForSession({
    source: row.source,
    model: row.model,
    input_tokens: parseNumeric(row.input_tokens),
    output_tokens: parseNumeric(row.output_tokens),
    cache_read_tokens: parseNumeric(row.cache_read_tokens),
    cache_create_tokens: parseNumeric(row.cache_create_tokens),
    cached_tokens: parseNumeric(row.cached_tokens),
    reasoning_tokens: parseNumeric(row.reasoning_tokens),
  }, pricing).costUsd;
}

function roundCurrency(value: number): number {
  return Math.round(Math.max(0, value) * 10000) / 10000;
}

function validationRejection(event: UsageEvent, nowMs: number): UsageImportRejectedDetail | null {
  const additiveTotal = additiveTokens(event);

  if (additiveTotal > MAX_EVENT_ADDITIVE_TOKENS) {
    return {
      event_id: event.event_id,
      reason_code: 'bounds_violation',
      details: {
        additive_tokens: additiveTotal,
        max_additive_tokens: MAX_EVENT_ADDITIVE_TOKENS,
      },
    };
  }

  const eventMs = new Date(event.event_at).getTime();

  if (!Number.isFinite(eventMs) || eventMs > nowMs + FUTURE_SKEW_MS) {
    return {
      event_id: event.event_id,
      reason_code: 'future_timestamp',
      details: {
        event_at: event.event_at,
      },
    };
  }

  const metadataSize = JSON.stringify(event.metadata ?? {}).length;

  if (metadataSize > 4096) {
    return {
      event_id: event.event_id,
      reason_code: 'privacy_violation',
      details: {
        metadata_bytes: metadataSize,
        max_metadata_bytes: 4096,
      },
    };
  }

  return null;
}

function eventInsertRow(profileId: string, ingestionRunId: string, event: UsageEvent) {
  return {
    profile_id: profileId,
    import_run_id: ingestionRunId,
    event_id: event.event_id,
    source: event.source,
    provider: event.provider,
    event_kind: event.event_kind,
    session_id: event.session_id,
    source_event_id: event.source_event_id ?? null,
    event_at: event.event_at,
    model: event.model,
    model_source: event.model_source,
    input_tokens: event.input_tokens,
    output_tokens: event.output_tokens,
    cache_read_tokens: event.cache_read_tokens,
    cache_create_tokens: event.cache_create_tokens,
    cached_tokens: event.cached_tokens,
    reasoning_tokens: event.reasoning_tokens,
    source_file_hash: event.source_file_hash,
    source_file_size: event.source_file_size ?? null,
    line_number: event.line_number ?? null,
    parser_version: event.parser_version,
    metadata: event.metadata ?? {},
  };
}

function sourceFileInsertRow(profileId: string, ingestionRunId: string, file: UsageSourceFile) {
  return {
    profile_id: profileId,
    import_run_id: ingestionRunId,
    source: file.source,
    source_file_hash: file.source_file_hash,
    source_file_size: file.source_file_size,
    line_count: file.line_count,
    parsed_event_count: file.parsed_event_count,
    ignored_line_count: file.ignored_line_count,
    warning_count: file.warning_count,
    parser_version: file.parser_version,
    metadata: file.metadata ?? {},
    last_seen_at: new Date().toISOString(),
  };
}

async function loadModelPricing(client: SupabaseLike): Promise<PricingMap> {
  const { data, error } = await client
    .from('model_pricing')
    .select('provider,model_id,input_per_mtok,output_per_mtok,cache_read_per_mtok,cache_write_per_mtok')
    .returns<Array<{
      provider: string;
      model_id: string;
      input_per_mtok: number | null;
      output_per_mtok: number | null;
      cache_read_per_mtok: number | null;
      cache_write_per_mtok: number | null;
    }>>();

  if (error) {
    throw new Error(`[usage-import] model pricing lookup failed: ${error.message}`);
  }

  const map: PricingMap = new Map();

  for (const row of data ?? []) {
    map.set(pricingKey(row.provider, row.model_id), {
      input: row.input_per_mtok,
      output: row.output_per_mtok,
      cache_read: row.cache_read_per_mtok,
      cache_write: row.cache_write_per_mtok,
    });
  }

  return map;
}

async function loadUsageEventsForProfile(client: SupabaseLike, profileId: string): Promise<UsageEventRow[]> {
  const rows: UsageEventRow[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from('usage_events')
      .select([
        'source',
        'provider',
        'session_id',
        'event_at',
        'model',
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'cache_create_tokens',
        'cached_tokens',
        'reasoning_tokens',
        'total_tokens',
        'source_file_hash',
      ].join(','))
      .eq('profile_id', profileId)
      .order('event_at', { ascending: true })
      .range(from, from + pageSize - 1)
      .returns<UsageEventRow[]>();

    if (error) {
      throw new Error(`[usage-import] usage event lookup failed: ${error.message}`);
    }

    rows.push(...(data ?? []));

    if ((data ?? []).length < pageSize) {
      return rows;
    }
  }
}

type DailyRollup = {
  profile_id: string;
  date: string;
  source: 'claude' | 'codex';
  provider: 'anthropic' | 'openai' | 'unknown';
  model: string;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  total_sessions: number;
  event_count: number;
  cost_usd_total: number;
};

type SessionRollup = {
  profile_id: string;
  source: 'claude' | 'codex';
  provider: 'anthropic' | 'openai' | 'unknown';
  session_id: string;
  model: string;
  first_event_at: string;
  last_event_at: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  turns: number;
  cost_usd_total: number;
  source_file_hashes: string[];
};

function dailyKey(day: string, source: string, model: string): string {
  return JSON.stringify([day, source, model]);
}

function sessionKey(source: string, sessionId: string): string {
  return JSON.stringify([source, sessionId]);
}

async function upsertBatches(client: SupabaseLike, table: string, rows: Record<string, unknown>[], onConflict: string): Promise<void> {
  for (let i = 0; i < rows.length; i += PROJECTION_BATCH_SIZE) {
    const batch = rows.slice(i, i + PROJECTION_BATCH_SIZE);
    const { error } = await client
      .from(table)
      .upsert(batch, { onConflict });

    if (error) {
      throw new Error(`[usage-import] ${table} upsert failed: ${error.message}`);
    }
  }
}

export class UsageImportService {
  private readonly supabaseClient: SupabaseLike;

  private readonly cacheInvalidator: () => number;

  constructor(options: UsageImportOptions = {}) {
    this.supabaseClient = options.supabaseClient ?? adminClient;
    this.cacheInvalidator = options.cacheInvalidator ?? purgeIngestionCaches;
  }

  async importBrowserUsage(
    auth: AuthContext,
    body: unknown,
    requestLog?: Pick<FastifyBaseLogger, 'debug' | 'error' | 'info' | 'warn'>,
  ): Promise<UsageImportResult> {
    const startedAtMs = Date.now();
    const ingestionRunId = await this.openImportRun(auth, body, startedAtMs);
    const parsed = UsageImportRequestSchema.safeParse(body);

    if (!parsed.success) {
      const details = parsed.error.flatten() as unknown as Record<string, unknown>;

      await this.closeImportRun({
        ingestionRunId,
        status: 'failed',
        acceptedCount: 0,
        dedupedCount: 0,
        rejectedCount: 1,
        rejectedDetails: [{
          event_id: '__batch__',
          reason_code: 'schema_invalid',
          details,
        }],
        startedAtMs,
      });

      return {
        ok: false,
        ingestion_run_id: ingestionRunId,
        status_code: 400,
        reason_code: 'schema_invalid',
        message: 'Usage import payload failed schema validation',
        details,
        run_duration_ms: Date.now() - startedAtMs,
      };
    }

    try {
      const request = parsed.data;
      const nowMs = Date.now();
      const accepted: UsageEvent[] = [];
      const rejected: UsageImportRejectedDetail[] = [];

      for (const event of request.events) {
        const rejection = validationRejection(event, nowMs);

        if (rejection) {
          rejected.push(rejection);
          continue;
        }

        accepted.push(event);
      }

      await this.upsertSourceFiles(auth.profileId, ingestionRunId, request.files);
      const insertedEventIds = await this.insertEvents(auth.profileId, ingestionRunId, accepted);
      const insertedCount = insertedEventIds.length;
      const dedupedCount = Math.max(0, accepted.length - insertedCount);

      await Promise.all([
        writeAuditEvent({
          event_type: 'usage_import.completed',
          severity: 'info',
          profile_id: auth.profileId,
          payload: {
            ingestion_run_id: ingestionRunId,
            accepted_count: insertedCount,
            deduped_count: dedupedCount,
            rejected_count: rejected.length,
            file_count: request.files.length,
          },
          requestLog,
          supabaseClient: this.supabaseClient,
        }),
        ...rejected.map((detail) => writeAuditEvent({
          event_type: 'usage_import.rejected',
          severity: 'warn',
          profile_id: auth.profileId,
          payload: detail,
          requestLog,
          supabaseClient: this.supabaseClient,
        })),
      ]);

      await this.closeImportRun({
        ingestionRunId,
        status: rejected.length === 0 ? (insertedCount > 0 || dedupedCount > 0 ? 'completed' : 'failed') : (insertedCount > 0 ? 'partial' : 'failed'),
        acceptedCount: insertedCount,
        dedupedCount,
        rejectedCount: rejected.length,
        rejectedDetails: rejected,
        startedAtMs,
      });

      return {
        ok: true,
        ingestion_run_id: ingestionRunId,
        accepted_count: insertedCount,
        deduped_count: dedupedCount,
        rejected_count: rejected.length,
        rejected_details: rejected,
        projected: false,
        run_duration_ms: Date.now() - startedAtMs,
      };
    } catch (error) {
      await this.closeImportRun({
        ingestionRunId,
        status: 'failed',
        acceptedCount: 0,
        dedupedCount: 0,
        rejectedCount: 1,
        rejectedDetails: [{
          event_id: '__batch__',
          reason_code: 'schema_invalid',
          details: {
            message: error instanceof Error ? error.message : 'unknown usage import failure',
          },
        }],
        startedAtMs,
      });

      throw error;
    }
  }

  async finalizeBrowserUsage(
    auth: AuthContext,
    body: unknown,
    requestLog?: Pick<FastifyBaseLogger, 'debug' | 'error' | 'info' | 'warn'>,
  ): Promise<UsageImportFinalizeResult> {
    const startedAtMs = Date.now();
    const parsed = UsageImportFinalizeRequestSchema.safeParse(body);

    if (!parsed.success) {
      return {
        ok: false,
        status_code: 400,
        reason_code: 'schema_invalid',
        message: 'Usage import finalize payload failed schema validation',
        details: parsed.error.flatten() as unknown as Record<string, unknown>,
        run_duration_ms: Date.now() - startedAtMs,
      };
    }

    const hasEvents = await this.hasUsageEvents(auth.profileId);

    if (hasEvents) {
      await this.rebuildProfileUsageProjections(auth.profileId);
      this.cacheInvalidator();
      await this.markProfileImported(auth.profileId);
    }

    await writeAuditEvent({
      event_type: 'usage_import.finalized',
      severity: 'info',
      profile_id: auth.profileId,
      payload: {
        run_id: parsed.data.run.run_id,
        projected: hasEvents,
      },
      requestLog,
      supabaseClient: this.supabaseClient,
    });

    return {
      ok: true,
      projected: hasEvents,
      run_duration_ms: Date.now() - startedAtMs,
    };
  }

  async openImportRun(auth: AuthContext, body: unknown, startedAtMs: number): Promise<string> {
    const ingestionRunId = randomUUID();
    const rawEvents = rawEventsFromBody(body);
    const rawFiles = rawFilesFromBody(body);
    const client = isRecord(body) && isRecord(body.client) ? body.client : {};
    const run = isRecord(body) && isRecord(body.run) ? body.run : {};

    const { data, error } = await this.supabaseClient
      .from('ingestion_runs')
      .insert({
        id: ingestionRunId,
        profile_id: auth.profileId,
        status: 'processing',
        started_at: new Date(startedAtMs).toISOString(),
        file_count: rawFiles.length,
        session_count: rawEvents.length,
        duplicate_count: 0,
        rejected_count: 0,
        source_first_event_at: minIso(rawEvents.map((event) => getString(event.event_at))),
        source_last_event_at: maxIso(rawEvents.map((event) => getString(event.event_at))),
        ingestion_mode: 'self_reported',
        client_version: getString(client.version),
        platform: null,
        client_json: {
          ...client,
          import_kind: 'browser_usage_events',
        },
        run_json: {
          ...run,
          import_kind: 'browser_usage_events',
          accepted_count: 0,
          deduped_count: 0,
          rejected_count: 0,
          total_duration_ms: 0,
        },
        rejected_details_json: [],
        error_summary: {
          run,
          client,
        },
      })
      .select('id')
      .single<IngestionRunRow>();

    if (error || !data) {
      throw new Error(`usage import run insert failed: ${error?.message ?? 'missing row'}`);
    }

    return data.id;
  }

  async closeImportRun({
    ingestionRunId,
    status,
    acceptedCount,
    dedupedCount,
    rejectedCount,
    rejectedDetails,
    startedAtMs,
  }: {
    ingestionRunId: string;
    status: 'completed' | 'partial' | 'failed';
    acceptedCount: number;
    dedupedCount: number;
    rejectedCount: number;
    rejectedDetails: UsageImportRejectedDetail[];
    startedAtMs: number;
  }): Promise<void> {
    const completedAt = new Date().toISOString();
    const totalDurationMs = Date.now() - startedAtMs;
    const runJson = {
      import_kind: 'browser_usage_events',
      accepted_count: acceptedCount,
      deduped_count: dedupedCount,
      rejected_count: rejectedCount,
      total_duration_ms: totalDurationMs,
    };
    const { error } = await this.supabaseClient
      .from('ingestion_runs')
      .update({
        status,
        finished_at: completedAt,
        completed_at: completedAt,
        session_count: acceptedCount,
        duplicate_count: dedupedCount,
        rejected_count: rejectedCount,
        error_summary: {
          ...runJson,
          rejected_details: rejectedDetails,
        },
        run_json: runJson,
        rejected_details_json: rejectedDetails,
      })
      .eq('id', ingestionRunId);

    if (error) {
      throw new Error(`usage import run update failed: ${error.message}`);
    }
  }

  async upsertSourceFiles(profileId: string, ingestionRunId: string, files: UsageImportRequest['files']): Promise<void> {
    if (files.length === 0) {
      return;
    }

    await upsertBatches(
      this.supabaseClient,
      'usage_source_files',
      files.map((file) => sourceFileInsertRow(profileId, ingestionRunId, file)),
      'profile_id,source,source_file_hash',
    );
  }

  async hasUsageEvents(profileId: string): Promise<boolean> {
    const { data, error } = await this.supabaseClient
      .from('usage_events')
      .select('event_id')
      .eq('profile_id', profileId)
      .limit(1)
      .returns<InsertedEventRow[]>();

    if (error) {
      throw new Error(`[usage-import] usage event existence check failed: ${error.message}`);
    }

    return (data ?? []).length > 0;
  }

  async insertEvents(profileId: string, ingestionRunId: string, events: UsageEvent[]): Promise<string[]> {
    if (events.length === 0) {
      return [];
    }

    const inserted: string[] = [];

    for (let i = 0; i < events.length; i += PROJECTION_BATCH_SIZE) {
      const batch = events.slice(i, i + PROJECTION_BATCH_SIZE);
      const { data, error } = await this.supabaseClient
        .from('usage_events')
        .upsert(
          batch.map((event) => eventInsertRow(profileId, ingestionRunId, event)),
          {
            onConflict: 'profile_id,event_id',
            ignoreDuplicates: true,
          },
        )
        .select('event_id')
        .returns<InsertedEventRow[]>();

      if (error) {
        throw new Error(`usage event insert failed: ${error.message}`);
      }

      inserted.push(...(data ?? []).map((row) => row.event_id));
    }

    return inserted;
  }

  async rebuildProfileUsageProjections(profileId: string): Promise<void> {
    const [events, pricing] = await Promise.all([
      loadUsageEventsForProfile(this.supabaseClient, profileId),
      loadModelPricing(this.supabaseClient),
    ]);
    const daily = new Map<string, DailyRollup & { sessionIds: Set<string> }>();
    const sessions = new Map<string, SessionRollup & {
      modelTokens: Map<string, number>;
      sourceFileHashes: Set<string>;
    }>();

    for (const event of events) {
      const day = dateOnly(event.event_at);

      if (!day) {
        continue;
      }

      const tokens = totalTokens(event);
      const cost = eventCost(event, pricing);
      const dKey = dailyKey(day, event.source, event.model);
      const dailyRollup = daily.get(dKey) ?? {
        profile_id: profileId,
        date: day,
        source: event.source,
        provider: event.provider,
        model: event.model,
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_create_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
        total_sessions: 0,
        event_count: 0,
        cost_usd_total: 0,
        sessionIds: new Set<string>(),
      };

      dailyRollup.total_tokens += tokens;
      dailyRollup.input_tokens += parseNumeric(event.input_tokens);
      dailyRollup.output_tokens += parseNumeric(event.output_tokens);
      dailyRollup.cache_read_tokens += parseNumeric(event.cache_read_tokens);
      dailyRollup.cache_create_tokens += parseNumeric(event.cache_create_tokens);
      dailyRollup.cached_tokens += parseNumeric(event.cached_tokens);
      dailyRollup.reasoning_tokens += parseNumeric(event.reasoning_tokens);
      dailyRollup.event_count += 1;
      dailyRollup.cost_usd_total += cost;
      dailyRollup.sessionIds.add(event.session_id);
      daily.set(dKey, dailyRollup);

      const sKey = sessionKey(event.source, event.session_id);
      const sessionRollup = sessions.get(sKey) ?? {
        profile_id: profileId,
        source: event.source,
        provider: event.provider,
        session_id: event.session_id,
        model: event.model,
        first_event_at: event.event_at,
        last_event_at: event.event_at,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_create_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 0,
        turns: 0,
        cost_usd_total: 0,
        source_file_hashes: [],
        modelTokens: new Map<string, number>(),
        sourceFileHashes: new Set<string>(),
      };

      if (event.event_at < sessionRollup.first_event_at) {
        sessionRollup.first_event_at = event.event_at;
      }

      if (event.event_at > sessionRollup.last_event_at) {
        sessionRollup.last_event_at = event.event_at;
      }

      sessionRollup.input_tokens += parseNumeric(event.input_tokens);
      sessionRollup.output_tokens += parseNumeric(event.output_tokens);
      sessionRollup.cache_read_tokens += parseNumeric(event.cache_read_tokens);
      sessionRollup.cache_create_tokens += parseNumeric(event.cache_create_tokens);
      sessionRollup.cached_tokens += parseNumeric(event.cached_tokens);
      sessionRollup.reasoning_tokens += parseNumeric(event.reasoning_tokens);
      sessionRollup.total_tokens += tokens;
      sessionRollup.turns += 1;
      sessionRollup.cost_usd_total += cost;
      sessionRollup.modelTokens.set(event.model, (sessionRollup.modelTokens.get(event.model) ?? 0) + tokens);
      sessionRollup.sourceFileHashes.add(event.source_file_hash);
      sessions.set(sKey, sessionRollup);
    }

    const dailyRows = Array.from(daily.values()).map((row) => ({
      profile_id: row.profile_id,
      date: row.date,
      source: row.source,
      provider: row.provider,
      model: row.model,
      total_tokens: Math.trunc(row.total_tokens),
      input_tokens: Math.trunc(row.input_tokens),
      output_tokens: Math.trunc(row.output_tokens),
      cache_read_tokens: Math.trunc(row.cache_read_tokens),
      cache_create_tokens: Math.trunc(row.cache_create_tokens),
      cached_tokens: Math.trunc(row.cached_tokens),
      reasoning_tokens: Math.trunc(row.reasoning_tokens),
      total_sessions: row.sessionIds.size,
      event_count: row.event_count,
      cost_usd_total: roundCurrency(row.cost_usd_total),
      updated_at: new Date().toISOString(),
    }));

    const sessionRows = Array.from(sessions.values()).map((row) => {
      const topModel = Array.from(row.modelTokens.entries())
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? row.model;

      return {
        profile_id: row.profile_id,
        source: row.source,
        provider: row.provider,
        session_id: row.session_id,
        model: topModel,
        first_event_at: row.first_event_at,
        last_event_at: row.last_event_at,
        input_tokens: Math.trunc(row.input_tokens),
        output_tokens: Math.trunc(row.output_tokens),
        cache_read_tokens: Math.trunc(row.cache_read_tokens),
        cache_create_tokens: Math.trunc(row.cache_create_tokens),
        cached_tokens: Math.trunc(row.cached_tokens),
        reasoning_tokens: Math.trunc(row.reasoning_tokens),
        total_tokens: Math.trunc(row.total_tokens),
        turns: row.turns,
        cost_usd_total: roundCurrency(row.cost_usd_total),
        source_file_hashes: Array.from(row.sourceFileHashes).sort(),
        updated_at: new Date().toISOString(),
      };
    });

    const [dailyDelete, sessionDelete] = await Promise.all([
      this.supabaseClient.from('usage_daily_aggregates').delete().eq('profile_id', profileId),
      this.supabaseClient.from('usage_session_rollups').delete().eq('profile_id', profileId),
    ]);

    if (dailyDelete.error) {
      throw new Error(`[usage-import] daily projection delete failed: ${dailyDelete.error.message}`);
    }

    if (sessionDelete.error) {
      throw new Error(`[usage-import] session projection delete failed: ${sessionDelete.error.message}`);
    }

    await Promise.all([
      dailyRows.length > 0
        ? upsertBatches(this.supabaseClient, 'usage_daily_aggregates', dailyRows, 'profile_id,date,source,model')
        : Promise.resolve(),
      sessionRows.length > 0
        ? upsertBatches(this.supabaseClient, 'usage_session_rollups', sessionRows, 'profile_id,source,session_id')
        : Promise.resolve(),
    ]);
  }

  async markProfileImported(profileId: string): Promise<void> {
    const onboardedAt = new Date().toISOString();

    const [modeUpdate, onboardedUpdate] = await Promise.all([
      this.supabaseClient
        .from('profiles')
        .update({ mode: 'self_reported' })
        .eq('id', profileId)
        .is('mode', null),
      this.supabaseClient
        .from('profiles')
        .update({ onboarded_at: onboardedAt })
        .eq('id', profileId)
        .is('onboarded_at', null),
    ]);

    if (modeUpdate.error) {
      throw new Error(`[usage-import] profile mode update failed: ${modeUpdate.error.message}`);
    }

    if (onboardedUpdate.error) {
      throw new Error(`[usage-import] profile onboarded update failed: ${onboardedUpdate.error.message}`);
    }
  }
}
