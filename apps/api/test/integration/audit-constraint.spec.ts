import { describe, expect, it, vi } from 'vitest';

import { writeAuditEvent } from '../../src/services/audit';
import { createSchemaServiceRoleClient } from './ingestion-test-helpers';

describe('audit_events severity constraint', () => {
  it('rejects severities outside info, warn, and critical at the database layer', async () => {
    const admin = createSchemaServiceRoleClient();
    const invalidSeverity = ['err', 'or'].join('');

    const { error } = await admin
      .from('audit_events')
      .insert({
        profile_id: null,
        event_type: 'audit.constraint_probe',
        severity: invalidSeverity,
        payload: { reason_code: 'constraint_probe' },
      });

    expect(error).toBeTruthy();
    expect(error?.message).toMatch(/audit_events_severity_check|violates check constraint/i);
  });

  it('rejects invalid severities before calling Supabase from writeAuditEvent', async () => {
    const insert = vi.fn();
    const from = vi.fn(() => ({ insert }));
    const warn = vi.fn();

    await writeAuditEvent({
      event_type: 'audit.invalid_probe',
      severity: ['err', 'or'].join('') as never,
      payload: { reason_code: 'invalid_severity' },
      requestLog: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn,
      },
      supabaseClient: { from },
    });

    expect(from).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'audit.invalid_severity',
        event_type: 'audit.invalid_probe',
      }),
      'Invalid audit event severity',
    );
  });
});
