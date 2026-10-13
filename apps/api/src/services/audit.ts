import type { FastifyBaseLogger, FastifyRequest } from 'fastify';

import { adminClient } from '../clients/supabase';
import { extractClientIp } from './rate-limit';

export const AUDIT_EVENT_SEVERITIES = ['info', 'warn', 'critical'] as const;

export type AuditEventSeverity = typeof AUDIT_EVENT_SEVERITIES[number];

export type AuditEventPayload = Record<string, unknown> & {
  reason_code?: string;
};

export type WriteAuditEventPayload = {
  severity: AuditEventSeverity;
  event_type: string;
  payload: AuditEventPayload;
  profile_id?: string | null;
  requestLog?: Pick<FastifyBaseLogger, 'debug' | 'error' | 'info' | 'warn'>;
  supabaseClient?: unknown;
};

export type RecordAuditEventInput = {
  eventType: string;
  severity: AuditEventSeverity;
  profileId?: string | null;
  details?: AuditEventPayload;
  requestLog?: Pick<FastifyBaseLogger, 'debug' | 'error' | 'info' | 'warn'>;
  supabaseClient?: unknown;
};

export type PasswordResetAuditReason =
  | 'requested'
  | 'rate_limited'
  | 'validation_failed';

const severitySet = new Set<string>(AUDIT_EVENT_SEVERITIES);

function isAuditEventSeverity(value: unknown): value is AuditEventSeverity {
  return typeof value === 'string' && severitySet.has(value);
}

type AuditInsertClient = {
  from: (table: string) => {
    insert: (row: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
  };
};

/**
 * Persists an audit event into `audit_events` and emits a structured log.
 *
 * Soft-fails: a DB error is logged as `audit.insert_failed` and swallowed so
 * audit logging never breaks the calling request. Defaults to `adminClient`
 * when no `supabaseClient` is supplied.
 */
export async function writeAuditEvent({
  severity,
  event_type,
  payload,
  profile_id = null,
  requestLog,
  supabaseClient,
}: WriteAuditEventPayload): Promise<void> {
  if (!isAuditEventSeverity(severity)) {
    requestLog?.warn({
      event: 'audit.invalid_severity',
      event_type,
      severity,
      profile_id,
    }, 'Invalid audit event severity');
    return;
  }

  const client = (supabaseClient ?? adminClient) as AuditInsertClient;

  try {
    const { error } = await client.from('audit_events').insert({
      event_type,
      severity,
      profile_id,
      payload,
    });

    if (error) {
      requestLog?.error({
        event: 'audit.insert_failed',
        event_type,
        severity,
        profile_id,
        error: error.message,
      }, 'Audit event insert failed');
      return;
    }

    requestLog?.info({
      event: 'audit.recorded',
      event_type,
      severity,
      profile_id,
    }, 'Audit event recorded');
  } catch (error) {
    requestLog?.error({
      event: 'audit.insert_failed',
      event_type,
      severity,
      profile_id,
      error: error instanceof Error ? error.message : String(error),
    }, 'Audit event insert failed');
  }
}

export async function recordAuditEvent({
  eventType,
  severity,
  profileId = null,
  details = {},
  requestLog,
  supabaseClient,
}: RecordAuditEventInput): Promise<void> {
  await writeAuditEvent({
    event_type: eventType,
    severity,
    profile_id: profileId,
    payload: details,
    requestLog,
    supabaseClient,
  });
}

function getPasswordResetEmail(request: FastifyRequest): string | null {
  const body = request.body;

  if (!body || typeof body !== 'object' || !('email' in body)) {
    return null;
  }

  const email = (body as { email?: unknown }).email;

  return typeof email === 'string' ? email.trim().toLowerCase() : null;
}

function getEmailDomain(email: string | null): string | null {
  if (!email) {
    return null;
  }

  const atIndex = email.lastIndexOf('@');

  if (atIndex === -1 || atIndex === email.length - 1) {
    return null;
  }

  return email.slice(atIndex + 1).toLowerCase();
}

export async function logPasswordResetRequested(
  request: FastifyRequest,
  success: boolean,
  reason: PasswordResetAuditReason,
): Promise<void> {
  const email = getPasswordResetEmail(request);

  await writeAuditEvent({
    event_type: 'auth.password_reset_requested',
    severity: success ? 'info' : 'warn',
    payload: {
      client_ip: extractClientIp(request),
      email_domain: getEmailDomain(email),
      reason,
      reason_code: reason,
    },
    requestLog: request.log,
  });
}
