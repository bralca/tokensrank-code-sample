import type { SupabaseClient } from '@supabase/supabase-js';
import type { FastifyBaseLogger } from 'fastify';

import {
  writeAuditEvent,
  type AuditEventPayload,
  type AuditEventSeverity,
} from '../services/audit';

export type AuditLogger = Pick<FastifyBaseLogger, 'debug' | 'error' | 'info' | 'warn'>;

export type LogAuditEventInput = {
  event_type: string;
  severity: AuditEventSeverity;
  payload: AuditEventPayload;
  profile_id?: string | null;
  requestLog?: AuditLogger;
  supabaseClient?: Pick<SupabaseClient, 'from'>;
};

export async function logAuditEvent(input: LogAuditEventInput): Promise<void> {
  await writeAuditEvent(input);
}
