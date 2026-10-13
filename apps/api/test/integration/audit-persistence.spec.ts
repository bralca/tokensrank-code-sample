import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { writeAuditEvent } from '../../src/services/audit';
import {
  createAccessKeyFixture,
  createSchemaServiceRoleClient,
  deleteAuthUsers,
} from './ingestion-test-helpers';

const createdUserIds = new Set<string>();
let admin: ReturnType<typeof createSchemaServiceRoleClient>;
let profileId: string;

function eventType(label: string): string {
  return `audit.${label}_${crypto.randomUUID()}`;
}

async function readAuditEvent(type: string) {
  const { data, error } = await admin
    .from('audit_events')
    .select('event_type, severity, profile_id, payload, created_at')
    .eq('event_type', type)
    .maybeSingle();

  if (error) {
    throw new Error(`[audit-persistence-test] read audit event failed: ${error.message}`);
  }

  return data as {
    event_type: string;
    severity: string;
    profile_id: string | null;
    payload: Record<string, unknown>;
    created_at: string;
  } | null;
}

beforeAll(async () => {
  admin = createSchemaServiceRoleClient();
  const fixture = await createAccessKeyFixture('script', 'audit_persist');
  profileId = fixture.profileId;
  createdUserIds.add(fixture.userId);
});

afterAll(async () => {
  await deleteAuthUsers(createdUserIds);
});

describe('writeAuditEvent persistence', () => {
  it('persists severity, event_type, profile_id, JSONB payload, and created_at', async () => {
    const type = eventType('persisted');
    const payload = {
      reason_code: 'accepted',
      counts: {
        accepted: 2,
        deduped: 1,
        rejected: 0,
      },
    };

    await writeAuditEvent({
      event_type: type,
      severity: 'info',
      profile_id: profileId,
      payload,
      supabaseClient: admin,
    });

    const row = await readAuditEvent(type);

    expect(row).toEqual(expect.objectContaining({
      event_type: type,
      severity: 'info',
      profile_id: profileId,
      payload,
    }));
    expect(new Date(row?.created_at ?? '').toString()).not.toBe('Invalid Date');
  });

  it('persists warning events with payload.reason_code for fraud decisions', async () => {
    const type = eventType('fraud_rejected');

    await writeAuditEvent({
      event_type: type,
      severity: 'warn',
      profile_id: profileId,
      payload: {
        reason_code: 'future_timestamp',
        session_id: 'session-future',
        counts: { rejected: 1 },
      },
      supabaseClient: admin,
    });

    const row = await readAuditEvent(type);

    expect(row).toMatchObject({
      event_type: type,
      severity: 'warn',
      profile_id: profileId,
      payload: {
        reason_code: 'future_timestamp',
        session_id: 'session-future',
        counts: { rejected: 1 },
      },
    });
  });

  it('persists critical events with nested z-score details', async () => {
    const type = eventType('critical');
    const payload = {
      reason_code: 'fingerprint_drift',
      z_scores: {
        model_distribution: 4.5,
        tokens_per_session: 4.2,
        time_of_day_entropy: 3.8,
      },
    };

    await writeAuditEvent({
      event_type: type,
      severity: 'critical',
      profile_id: profileId,
      payload,
      supabaseClient: admin,
    });

    const row = await readAuditEvent(type);

    expect(row?.severity).toBe('critical');
    expect(row?.payload).toEqual(payload);
  });

  it('persists system-level audit events with null profile_id', async () => {
    const type = eventType('system');

    await writeAuditEvent({
      event_type: type,
      severity: 'info',
      payload: { reason_code: 'cache_purged', purged_keys_affected: 3 },
      supabaseClient: admin,
    });

    const row = await readAuditEvent(type);

    expect(row).toMatchObject({
      event_type: type,
      severity: 'info',
      profile_id: null,
      payload: {
        reason_code: 'cache_purged',
        purged_keys_affected: 3,
      },
    });
  });

  it('soft-fails without throwing when persistence returns an insert failure', async () => {
    const type = eventType('insert_failure');
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    await expect(writeAuditEvent({
      event_type: type,
      severity: 'warn',
      payload: { reason_code: 'missing_profile' },
      requestLog: logger,
      supabaseClient: {
        from: vi.fn(() => ({
          insert: vi.fn(() => Promise.resolve({
            data: null,
            error: { message: 'forced insert failure' },
          })),
        })),
      },
    })).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'forced insert failure',
        event: 'audit.insert_failed',
        event_type: type,
        severity: 'warn',
      }),
      'Audit event insert failed',
    );
  });

  it('does not persist invalid severity values rejected by app-level validation', async () => {
    const type = eventType('invalid_severity');
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    await writeAuditEvent({
      event_type: type,
      severity: ['err', 'or'].join('') as never,
      profile_id: profileId,
      payload: { reason_code: 'invalid' },
      requestLog: logger,
      supabaseClient: admin,
    });

    expect(await readAuditEvent(type)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'audit.invalid_severity',
        event_type: type,
      }),
      'Invalid audit event severity',
    );
  });
});
