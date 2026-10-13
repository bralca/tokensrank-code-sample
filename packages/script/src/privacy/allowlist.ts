import {
  IngestRequestSchema,
  SessionPayloadSchema,
  type IngestRequest,
  type SessionPayload,
} from '@tokensrank/shared';

export type ExtractorSource = 'claude' | 'codex';

export type JsonObject = Record<string, unknown>;

export type ExtractionWarning = {
  line: number;
  code: 'invalid_json' | 'invalid_shape' | 'missing_required_fields' | 'invalid_timestamp';
};

export type ExtractorResult = {
  sessions: SessionPayload[];
  warnings: ExtractionWarning[];
};

export type SourceAllowlist = {
  source: ExtractorSource;
  readPaths: readonly string[];
};

export const SESSION_PAYLOAD_ALLOWLIST = [
  'session_id',
  'source',
  'model',
  'first_event_at',
  'last_event_at',
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'cached_input_tokens',
  'reasoning_output_tokens',
  'turns',
  'active_seconds',
  'longest_active_seconds',
  'file_sha256',
] as const satisfies readonly (keyof SessionPayload)[];

export const INGEST_REQUEST_ALLOWLIST = [
  'client',
  'run',
  'sessions',
  'version',
  'install_id',
  'platform',
  'arch',
  'run_id',
  'started_at',
  'finished_at',
  ...SESSION_PAYLOAD_ALLOWLIST,
] as const;

export const CLAUDE_SOURCE_ALLOWLIST = {
  source: 'claude',
  readPaths: [
    'message.usage.input_tokens',
    'message.usage.output_tokens',
    'message.usage.cache_read_input_tokens',
    'message.usage.cache_creation_input_tokens',
    'message.model',
    'timestamp',
    'sessionId',
  ],
} as const satisfies SourceAllowlist;

export const CODEX_SOURCE_ALLOWLIST = {
  source: 'codex',
  readPaths: [
    'payload.info.last_token_usage.input_tokens',
    'payload.info.last_token_usage.output_tokens',
    'payload.info.last_token_usage.cached_input_tokens',
    'payload.info.last_token_usage.reasoning_output_tokens',
    'payload.model',
    'type',
    'payload.type',
    'timestamp',
  ],
} as const satisfies SourceAllowlist;

export const SOURCE_ALLOWLISTS = [
  CLAUDE_SOURCE_ALLOWLIST,
  CODEX_SOURCE_ALLOWLIST,
] as const;

const SESSION_KEY_SET = new Set<string>(SESSION_PAYLOAD_ALLOWLIST);
const INGEST_KEY_SET = new Set<string>(INGEST_REQUEST_ALLOWLIST);

const FORBIDDEN_KEY_PATTERNS = [
  /(^|_)(prompt|response|hostname|username|command|diff|cwd)$/iu,
  /(^|_)(project|repository|repo|branch|commit)(_|$)/iu,
  /(^|_)(file|dir|directory|workspace|home|root)_(path|name)$/iu,
  /^(content|text|tool|tools|git|args|argv|env)$/iu,
] as const;

const FORBIDDEN_STRING_PATTERNS = [
  /(?:^|[\s"'=])(?:\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\)/u,
  /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\b\d{1,3}(?:\.\d{1,3}){3}\b)/u,
  /https?:\/\/|ssh:\/\/|git@/u,
] as const;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getObject(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

export function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function getNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

export function toIsoTimestamp(value: unknown): string | undefined {
  const candidate = getString(value);
  if (!candidate) {
    return undefined;
  }

  const timestampMs = Date.parse(candidate);
  return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : undefined;
}

export function enforceSessionAllowlist(session: SessionPayload): SessionPayload {
  const unexpectedKeys = Object.keys(session).filter((key) => !SESSION_KEY_SET.has(key));
  if (unexpectedKeys.length > 0) {
    throw new Error(`Session payload contains non-allowlisted keys: ${unexpectedKeys.join(', ')}`);
  }

  assertNoForbiddenKeys(session);
  assertNoForbiddenStringValues(session);

  return SessionPayloadSchema.parse(session);
}

export function enforceIngestRequestAllowlist(payload: IngestRequest): IngestRequest {
  assertNoForbiddenKeys(payload);
  assertNoForbiddenStringValues(payload);

  for (const session of payload.sessions) {
    enforceSessionAllowlist(session);
  }

  return IngestRequestSchema.parse(payload);
}

export function assertNoForbiddenKeys(value: unknown, path: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, [...path, String(index)]));
    return;
  }

  if (!isJsonObject(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (!INGEST_KEY_SET.has(key) && FORBIDDEN_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
      const location = [...path, key].join('.');
      throw new Error(`Forbidden key blocked by privacy allowlist: ${location}`);
    }

    assertNoForbiddenKeys(child, [...path, key]);
  }
}

export function assertNoForbiddenStringValues(value: unknown, path: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenStringValues(item, [...path, String(index)]));
    return;
  }

  if (typeof value === 'string') {
    if (FORBIDDEN_STRING_PATTERNS.some((pattern) => pattern.test(value))) {
      const location = path.join('.');
      throw new Error(`Forbidden private value blocked by privacy allowlist: ${location}`);
    }
    return;
  }

  if (!isJsonObject(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    assertNoForbiddenStringValues(child, [...path, key]);
  }
}

export function scrubLogValue(value: unknown): string {
  const raw = value instanceof Error ? `${value.name}: ${value.message}` : String(value);

  return raw
    .replace(/\/Users\/[^/\s]+/gu, '/[HOME]')
    .replace(/\/home\/[^/\s]+/gu, '/[HOME]')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gu, '/[HOME]')
    .replace(/(?:tr_(?:script|self_reported)_[A-Za-z0-9_-]+)/gu, '[REDACTED_KEY]');
}
