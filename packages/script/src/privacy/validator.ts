import type { IngestRequest, SessionPayload } from '@tokensrank/shared';

import {
  enforceIngestRequestAllowlist,
  enforceSessionAllowlist,
  scrubLogValue,
} from './allowlist.js';

export type PrivacyValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function validateExtractedSession(session: SessionPayload): PrivacyValidationResult<SessionPayload> {
  try {
    return { ok: true, value: enforceSessionAllowlist(session) };
  } catch (error) {
    return { ok: false, error: scrubLogValue(error) };
  }
}

export function validateScriptPayload(payload: IngestRequest): PrivacyValidationResult<IngestRequest> {
  try {
    return { ok: true, value: enforceIngestRequestAllowlist(payload) };
  } catch (error) {
    return { ok: false, error: scrubLogValue(error) };
  }
}

export function requireScriptPayloadPrivacy(payload: IngestRequest): IngestRequest {
  const result = validateScriptPayload(payload);
  if (!result.ok) {
    throw new Error(result.error);
  }

  return result.value;
}
