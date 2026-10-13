import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.SUPABASE_URL ??= 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';
});

import {
  AUDIT_EVENT_SEVERITIES,
  writeAuditEvent,
  type AuditEventSeverity,
} from '../../../src/services/audit';

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createSupabaseClient(result: unknown = Promise.resolve({ data: null, error: null })) {
  const insert = vi.fn(() => result);
  const from = vi.fn(() => ({ insert }));

  return {
    client: { from },
    from,
    insert,
  };
}

describe('writeAuditEvent', () => {
  it.each(AUDIT_EVENT_SEVERITIES)('inserts audit events with valid %s severity', async (severity) => {
    const supabase = createSupabaseClient();

    await writeAuditEvent({
      event_type: `audit.${severity}`,
      severity,
      payload: { reason_code: `${severity}_reason` },
      profile_id: 'profile-1',
      supabaseClient: supabase.client,
    });

    expect(supabase.from).toHaveBeenCalledWith('audit_events');
    expect(supabase.insert).toHaveBeenCalledWith({
      event_type: `audit.${severity}`,
      severity,
      profile_id: 'profile-1',
      payload: { reason_code: `${severity}_reason` },
    });
  });

  it('short-circuits invalid severity values before database access', async () => {
    const supabase = createSupabaseClient();
    const logger = createLogger();

    await writeAuditEvent({
      event_type: 'audit.invalid',
      severity: ['err', 'or'].join('') as AuditEventSeverity,
      payload: { reason_code: 'invalid' },
      requestLog: logger,
      supabaseClient: supabase.client,
    });

    expect(supabase.from).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'audit.invalid_severity',
        event_type: 'audit.invalid',
      }),
      'Invalid audit event severity',
    );
  });

  it('logs audit.recorded through the provided request logger on success', async () => {
    const supabase = createSupabaseClient();
    const logger = createLogger();

    await writeAuditEvent({
      event_type: 'audit.recorded_probe',
      severity: 'info',
      payload: { reason_code: 'recorded_probe' },
      profile_id: 'profile-2',
      requestLog: logger,
      supabaseClient: supabase.client,
    });

    expect(logger.info).toHaveBeenCalledWith(
      {
        event: 'audit.recorded',
        event_type: 'audit.recorded_probe',
        severity: 'info',
        profile_id: 'profile-2',
      },
      'Audit event recorded',
    );
  });

  it('soft-fails and logs audit.insert_failed when Supabase returns an insert failure', async () => {
    const supabase = createSupabaseClient(Promise.resolve({
      data: null,
      error: { message: 'constraint failed' },
    }));
    const logger = createLogger();

    await expect(writeAuditEvent({
      event_type: 'audit.failed_probe',
      severity: 'warn',
      payload: { reason_code: 'failed_probe' },
      requestLog: logger,
      supabaseClient: supabase.client,
    })).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'audit.insert_failed',
        event_type: 'audit.failed_probe',
        severity: 'warn',
        error: 'constraint failed',
      }),
      'Audit event insert failed',
    );
  });

  it('soft-fails and logs audit.insert_failed when the client throws', async () => {
    const supabase = createSupabaseClient(Promise.reject(new Error('network unavailable')));
    const logger = createLogger();

    await expect(writeAuditEvent({
      event_type: 'audit.throw_probe',
      severity: 'critical',
      payload: { reason_code: 'throw_probe' },
      requestLog: logger,
      supabaseClient: supabase.client,
    })).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'audit.insert_failed',
        event_type: 'audit.throw_probe',
        severity: 'critical',
        error: 'network unavailable',
      }),
      'Audit event insert failed',
    );
  });

  it('preserves nested JSON payload fields for the audit_events payload JSONB column', async () => {
    const supabase = createSupabaseClient();
    const payload = {
      reason_code: 'fingerprint_drift',
      z_scores: {
        model_distribution: 4.2,
        tokens_per_session: 3.1,
      },
      counts: {
        accepted: 4,
        rejected: 1,
      },
    };

    await writeAuditEvent({
      event_type: 'fraud.fingerprint_drift',
      severity: 'critical',
      payload,
      profile_id: null,
      supabaseClient: supabase.client,
    });

    expect(supabase.insert).toHaveBeenCalledWith(expect.objectContaining({
      payload,
    }));
  });

  it('defaults profile_id to null and still resolves Promise<void>', async () => {
    const supabase = createSupabaseClient();

    const result = await writeAuditEvent({
      event_type: 'audit.promise_contract',
      severity: 'info',
      payload: { reason_code: 'promise_contract' },
      supabaseClient: supabase.client,
    });

    expect(result).toBeUndefined();
    expect(supabase.insert).toHaveBeenCalledWith(expect.objectContaining({
      profile_id: null,
    }));
  });
});
