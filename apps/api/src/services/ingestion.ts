import {
  IngestRequestSchema,
  type IngestRequest,
  type IngestionRejectionReason,
  type SessionPayload,
} from '@tokensrank/shared';
import type { FastifyBaseLogger } from 'fastify';
import { randomUUID } from 'node:crypto';

import { adminClient } from '../clients/supabase';
import type { AccessKeyContext } from '../middleware/auth';
import { writeAuditEvent } from './audit';
import { purgeIngestionCaches } from './cache';
import { escalateProfileMode, type IngestionMode } from './mode';

export type IngestionScope = 'script' | 'self_reported';
export type IngestionStatus = 'completed' | 'partial' | 'failed';

// Trivial per-session sanity bounds (data hygiene, not fraud detection).
const MAX_TOTAL_TOKENS = 100_000_000;
const MAX_TURNS = 10_000;

export type IngestionRejectionReasonCode = IngestionRejectionReason | 'batch_too_large';

export type IngestionRejectedDetail = {
  session_id: string;
  reason_code: IngestionRejectionReasonCode;
  details?: Record<string, unknown>;
};

// Mirrors the handler's expected hard-failure shape (discriminated on reason_code).
export type IngestionHardFailure =
  | { ok: false; status_code: 429; reason_code: 'rate_limited'; message: string; details: { reset_at: string }; retry_after_sec: number }
  | { ok: false; status_code: 400; reason_code: 'schema_invalid'; message: string; details: Record<string, unknown> }
  | { ok: false; status_code: 413; reason_code: 'batch_too_large'; message: string; details: { max_sessions: number; received_sessions: number } };

export type IngestionSuccess = {
  ok: true;
  ingestion_run_id: string;
  status: IngestionStatus;
  accepted: number;
  deduped: number;
  rejected: number;
  rejected_details: IngestionRejectedDetail[];
  signals: never[];
  run_duration_ms: number;
};

export type IngestionFailure = IngestionHardFailure & {
  ingestion_run_id: string;
  status: 'failed';
  run_duration_ms: number;
};

export type IngestionResult = IngestionSuccess | IngestionFailure;

type IngestionRunRow = {
  id: string;
};

type InsertedSessionRow = {
  session_id: string;
};

export type IngestionRunContext = {
  ingestionRunId: string;
  startedAtMs: number;
};

type IngestionServiceOptions = {
  supabaseClient?: typeof adminClient;
  cacheInvalidator?: () => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function rawSessionsFromBody(body: unknown): Record<string, unknown>[] {
  if (!isRecord(body) || !Array.isArray(body.sessions)) {
    return [];
  }

  return body.sessions.filter(isRecord);
}

function sessionTotalTokens(session: SessionPayload): number {
  return (
    session.input_tokens
    + session.output_tokens
    + session.cache_read_input_tokens
    + session.cache_creation_input_tokens
    + session.cached_input_tokens
    + session.reasoning_output_tokens
  );
}

function minIso(values: Array<string | null>): string | null {
  const valid = values
    .filter((value): value is string => value !== null)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);

  if (valid.length === 0) {
    return null;
  }

  return new Date(Math.min(...valid)).toISOString();
}

function maxIso(values: Array<string | null>): string | null {
  const valid = values
    .filter((value): value is string => value !== null)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);

  if (valid.length === 0) {
    return null;
  }

  return new Date(Math.max(...valid)).toISOString();
}

function responseStatus(accepted: number, deduped: number, rejected: number): IngestionStatus {
  if (rejected === 0) {
    return accepted > 0 || deduped > 0 ? 'completed' : 'failed';
  }

  return accepted > 0 ? 'partial' : 'failed';
}

function toSessionInsertRows(
  profileId: string,
  ingestionRunId: string,
  mode: IngestionMode,
  clientPlatform: string | undefined,
  sessions: SessionPayload[],
) {
  return sessions.map((session) => ({
    profile_id: profileId,
    source: session.source,
    model: session.model,
    session_id: session.session_id,
    file_sha256: session.file_sha256,
    first_event_at: session.first_event_at,
    last_event_at: session.last_event_at,
    input_tokens: session.input_tokens,
    output_tokens: session.output_tokens,
    cache_read_tokens: session.cache_read_input_tokens,
    cache_create_tokens: session.cache_creation_input_tokens,
    cached_tokens: session.cached_input_tokens,
    reasoning_tokens: session.reasoning_output_tokens,
    turns: session.turns,
    active_seconds: session.active_seconds ?? null,
    longest_active_seconds: session.longest_active_seconds ?? null,
    platform: clientPlatform ?? null,
    ingestion_mode: mode,
    ingestion_run_id: ingestionRunId,
  }));
}

export class IngestionService {
  private readonly supabaseClient: typeof adminClient;

  private readonly cacheInvalidator: () => number;

  constructor(options: IngestionServiceOptions = {}) {
    this.supabaseClient = options.supabaseClient ?? adminClient;
    this.cacheInvalidator = options.cacheInvalidator ?? purgeIngestionCaches;
  }

  // Retained as a no-op lifecycle hook (the fraud engine that previously held
  // resources here has been removed).
  dispose(): void {}

  async ingest(
    auth: AccessKeyContext,
    body: unknown,
    mode: IngestionMode | IngestionScope,
  ): Promise<IngestionResult> {
    if (mode === 'script') {
      return this.ingestWithScope(auth, body, 'script', 'script_verified');
    }

    return this.ingestWithScope(auth, body, mode === 'script_verified' ? 'script' : 'self_reported', mode);
  }

  async ingestWithScope(
    auth: AccessKeyContext,
    body: unknown,
    scope: IngestionScope,
    mode: IngestionMode,
    requestLog?: Pick<FastifyBaseLogger, 'debug' | 'error' | 'info' | 'warn'>,
    runContext?: IngestionRunContext,
  ): Promise<IngestionResult> {
    const startedAtMs = runContext?.startedAtMs ?? Date.now();
    const ingestionRunId = runContext?.ingestionRunId ?? await this.openIngestionRun(auth, body, mode, startedAtMs);

    try {
      const parsed = IngestRequestSchema.safeParse(body);

      if (!parsed.success) {
        const details = parsed.error.flatten() as unknown as Record<string, unknown>;

        await this.closeIngestionRun({
          ingestionRunId,
          status: 'failed',
          acceptedCount: 0,
          dedupedCount: 0,
          rejectedCount: 1,
          rejectedDetails: [{
            session_id: '__batch__',
            reason_code: 'schema_invalid',
            details,
          }],
          startedAtMs,
        });

        return {
          ok: false,
          status_code: 400,
          reason_code: 'schema_invalid',
          message: 'Ingestion payload failed schema validation',
          details,
          ingestion_run_id: ingestionRunId,
          status: 'failed',
          run_duration_ms: Date.now() - startedAtMs,
        };
      }

      const request = parsed.data;
      const accepted: SessionPayload[] = [];
      const rejected: IngestionRejectedDetail[] = [];

      // Trivial per-session bounds (data hygiene). Real anti-fake protection is
      // the GitHub-corroborated ranking score, not session-level heuristics.
      for (const session of request.sessions) {
        const totalTokens = sessionTotalTokens(session);

        if (totalTokens > MAX_TOTAL_TOKENS || session.turns > MAX_TURNS) {
          rejected.push({
            session_id: session.session_id,
            reason_code: 'bounds_violation',
            details: {
              total_tokens: totalTokens,
              turns: session.turns,
              max_total_tokens: MAX_TOTAL_TOKENS,
              max_turns: MAX_TURNS,
            },
          });
          continue;
        }

        accepted.push(session);
      }

      const insertedSessionIds = await this.insertSessions(auth, ingestionRunId, request, mode, accepted);
      const insertedCount = insertedSessionIds.length;
      // Any accepted session that produced no new row was a duplicate (in-batch
      // or pre-existing) collapsed by the upsert's ON CONFLICT DO NOTHING.
      const deduped = Math.max(0, accepted.length - insertedCount);
      const status = responseStatus(insertedCount, deduped, rejected.length);

      // Per-session audit trail (persists to audit_events via writeAuditEvent).
      const insertedSet = new Set(insertedSessionIds);
      await Promise.all([
        ...accepted.map((session) => {
          const wasInserted = insertedSet.has(session.session_id);
          return writeAuditEvent({
            event_type: wasInserted ? 'ingestion.accepted' : 'ingestion.deduped',
            severity: 'info',
            profile_id: auth.profileId,
            payload: {
              session_id: session.session_id,
              reason_code: wasInserted ? 'accepted' : 'deduped',
            },
            requestLog,
            supabaseClient: this.supabaseClient,
          });
        }),
        ...rejected.map((detail) => writeAuditEvent({
          event_type: 'ingestion.rejected',
          severity: 'warn',
          profile_id: auth.profileId,
          payload: { session_id: detail.session_id, reason_code: detail.reason_code, details: detail.details ?? {} },
          requestLog,
          supabaseClient: this.supabaseClient,
        })),
      ]);

      await this.checkModeEscalation(auth, scope, insertedCount, requestLog);

      if (insertedCount > 0) {
        this.invalidateCache();
      }

      this.logIngestionDecisionEvents({
        requestLog,
        ingestionRunId,
        profileId: auth.profileId,
        accepted: insertedCount,
        deduped,
        rejected: rejected.length,
      });

      await this.closeIngestionRun({
        ingestionRunId,
        status,
        acceptedCount: insertedCount,
        dedupedCount: deduped,
        rejectedCount: rejected.length,
        rejectedDetails: rejected,
        startedAtMs,
      });

      return {
        ok: true,
        ingestion_run_id: ingestionRunId,
        status,
        accepted: insertedCount,
        deduped,
        rejected: rejected.length,
        rejected_details: rejected,
        signals: [],
        run_duration_ms: Date.now() - startedAtMs,
      };
    } catch (error) {
      await this.closeIngestionRun({
        ingestionRunId,
        status: 'failed',
        acceptedCount: 0,
        dedupedCount: 0,
        rejectedCount: 1,
        rejectedDetails: [{
          session_id: '__batch__',
          reason_code: 'schema_invalid',
          details: {
            message: error instanceof Error ? error.message : 'unknown ingestion failure',
          },
        }],
        startedAtMs,
      });

      throw error;
    }
  }

  async openIngestionRun(
    auth: AccessKeyContext,
    body: unknown,
    mode: IngestionMode,
    startedAtMs = Date.now(),
  ): Promise<string> {
    const ingestionRunId = randomUUID();
    const rawSessions = rawSessionsFromBody(body);
    const fileSha256Values = rawSessions
      .map((session) => getString(session.file_sha256))
      .filter((value): value is string => value !== null);
    const client = isRecord(body) && isRecord(body.client) ? body.client : {};
    const run = isRecord(body) && isRecord(body.run) ? body.run : {};

    const { data, error } = await this.supabaseClient
      .from('ingestion_runs')
      .insert({
        id: ingestionRunId,
        profile_id: auth.profileId,
        status: 'processing',
        started_at: new Date(startedAtMs).toISOString(),
        file_count: new Set(fileSha256Values).size,
        session_count: rawSessions.length,
        duplicate_count: 0,
        rejected_count: 0,
        source_first_event_at: minIso(rawSessions.map((session) => getString(session.first_event_at))),
        source_last_event_at: maxIso(rawSessions.map((session) => getString(session.last_event_at))),
        ingestion_mode: mode,
        client_version: getString(client.version),
        platform: getString(client.platform),
        client_json: client,
        run_json: {
          ...run,
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
      throw new Error(`ingestion run insert failed: ${error?.message ?? 'missing row'}`);
    }

    return data.id;
  }

  async closeIngestionRun({
    ingestionRunId,
    status,
    acceptedCount,
    dedupedCount,
    rejectedCount,
    rejectedDetails,
    startedAtMs,
    errorMessage,
  }: {
    ingestionRunId: string;
    status: IngestionStatus;
    acceptedCount: number;
    dedupedCount: number;
    rejectedCount: number;
    rejectedDetails: IngestionRejectedDetail[];
    startedAtMs: number;
    errorMessage?: string;
  }): Promise<void> {
    const completedAt = new Date().toISOString();
    const totalDurationMs = Date.now() - startedAtMs;
    const runJson = {
      accepted_count: acceptedCount,
      deduped_count: dedupedCount,
      rejected_count: rejectedCount,
      total_duration_ms: totalDurationMs,
      ...(errorMessage ? { error_message: errorMessage } : {}),
    };
    const { error } = await this.supabaseClient
      .from('ingestion_runs')
      .update({
        status,
        finished_at: completedAt,
        completed_at: completedAt,
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
      throw new Error(`ingestion run update failed: ${error.message}`);
    }
  }

  async failProcessingIngestionRunIfOpen({
    ingestionRunId,
    startedAtMs,
    errorMessage,
  }: {
    ingestionRunId: string;
    startedAtMs: number;
    errorMessage: string;
  }): Promise<void> {
    const completedAt = new Date().toISOString();
    const totalDurationMs = Date.now() - startedAtMs;
    const rejectedDetails = [{
      session_id: '__batch__',
      reason_code: 'schema_invalid' as const,
      details: {
        message: errorMessage,
      },
    }];
    const runJson = {
      accepted_count: 0,
      deduped_count: 0,
      rejected_count: 1,
      total_duration_ms: totalDurationMs,
      error_message: errorMessage,
    };
    const { error } = await this.supabaseClient
      .from('ingestion_runs')
      .update({
        status: 'failed',
        finished_at: completedAt,
        completed_at: completedAt,
        duplicate_count: 0,
        rejected_count: 1,
        error_summary: {
          ...runJson,
          rejected_details: rejectedDetails,
        },
        run_json: runJson,
        rejected_details_json: rejectedDetails,
      })
      .eq('id', ingestionRunId)
      .is('finished_at', null);

    if (error) {
      throw new Error(`ingestion run failed-finalize update failed: ${error.message}`);
    }
  }

  async insertSessions(
    auth: AccessKeyContext,
    ingestionRunId: string,
    body: IngestRequest,
    mode: IngestionMode,
    acceptedSessions: SessionPayload[],
  ): Promise<string[]> {
    if (acceptedSessions.length === 0) {
      return [];
    }

    const { data, error } = await this.supabaseClient
      .from('sessions')
      .upsert(
        toSessionInsertRows(auth.profileId, ingestionRunId, mode, body.client.platform, acceptedSessions),
        {
          onConflict: 'profile_id,source,session_id,file_sha256',
          ignoreDuplicates: true,
        },
      )
      .select('session_id')
      .returns<InsertedSessionRow[]>();

    if (error) {
      throw new Error(`session insert failed: ${error.message}`);
    }

    return (data ?? []).map((row) => row.session_id);
  }

  async checkModeEscalation(
    auth: AccessKeyContext,
    scope: IngestionScope,
    acceptedCount: number,
    requestLog?: Pick<FastifyBaseLogger, 'debug' | 'error' | 'info' | 'warn'>,
  ): Promise<boolean> {
    // FR-31: Mode escalation skipped for self-reported
    if (scope !== 'script' || acceptedCount === 0 || auth.mode === 'script_verified') {
      return false;
    }

    const result = await escalateProfileMode(this.supabaseClient, auth.profileId, 'script_verified');

    if (!result.escalated) {
      auth.mode = result.currentMode;
      return false;
    }

    auth.mode = result.currentMode;
    await writeAuditEvent({
      event_type: 'profile.mode_escalation',
      severity: 'info',
      profile_id: auth.profileId,
      payload: { previous_mode: result.previousMode, next_mode: result.currentMode },
      requestLog,
      supabaseClient: this.supabaseClient,
    });
    requestLog?.debug?.({
      event: 'profile.mode_escalation',
      profile_id: auth.profileId,
      previous_mode: result.previousMode,
      next_mode: result.currentMode,
    }, 'Profile mode escalated');
    return true;
  }

  invalidateCache(): number {
    return this.cacheInvalidator();
  }

  private logIngestionDecisionEvents({
    requestLog,
    ingestionRunId,
    profileId,
    accepted,
    deduped,
    rejected,
  }: {
    requestLog?: Pick<FastifyBaseLogger, 'debug' | 'error' | 'info' | 'warn'>;
    ingestionRunId: string;
    profileId: string;
    accepted: number;
    deduped: number;
    rejected: number;
  }): void {
    requestLog?.debug?.({
      event: 'ingestion.completed',
      ingestion_run_id: ingestionRunId,
      profile_id: profileId,
      accepted,
      deduped,
      rejected,
    }, 'Ingestion completed');
  }
}
