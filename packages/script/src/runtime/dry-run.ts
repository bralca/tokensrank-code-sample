import { IngestRequestSchema, type IngestRequest, type SessionPayload } from '@tokensrank/shared';

import { INGEST_REQUEST_ALLOWLIST, SESSION_PAYLOAD_ALLOWLIST } from '../privacy/allowlist.js';

export interface DryRunHeaderOptions {
  sessionCount: number;
  batchCount: number;
}

export interface DryRunBatchOptions {
  batchIndex?: number;
  batchCount?: number;
}

export interface PayloadPrivacyValidation {
  isClean: boolean;
  issues: string[];
}

const TOP_LEVEL_KEYS = new Set(['client', 'run', 'sessions']);
const CLIENT_KEYS = new Set(['version', 'install_id', 'platform', 'arch']);
const RUN_KEYS = new Set(['run_id', 'started_at', 'finished_at']);
const SESSION_KEYS = new Set<string>(SESSION_PAYLOAD_ALLOWLIST);
const INGEST_KEYS = new Set<string>(INGEST_REQUEST_ALLOWLIST);

const FORBIDDEN_KEY_PATTERNS = [
  /(^|_)(prompt|response|hostname|username|command|diff|cwd)$/iu,
  /(^|_)(project|repository|repo|branch|commit)(_|$)/iu,
  /(^|_)(file|dir|directory|workspace|home|root)_(path|name)$/iu,
  /^(content|text|tool|tools|git|args|argv|env)$/iu,
] as const;

const FORBIDDEN_VALUE_PATTERNS = [
  /(?:^|[\s"'=])(?:\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\)/u,
  /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\b\d{1,3}(?:\.\d{1,3}){3}\b)/u,
  /https?:\/\/|ssh:\/\/|git@/u,
] as const;

export function formatDryRunHeader(options: DryRunHeaderOptions): string {
  return `Dry-run mode: would send ${options.sessionCount} sessions in ${options.batchCount} batch(es)`;
}

export function formatBatchPayload(payload: IngestRequest, options: DryRunBatchOptions = {}): string {
  const json = JSON.stringify(payload, null, 2);
  if (options.batchIndex === undefined || options.batchCount === undefined) {
    return json;
  }

  return `Dry-run batch ${options.batchIndex}/${options.batchCount}\n${json}`;
}

export function formatSessionsSummary(sessions: readonly SessionPayload[]): string {
  const bySource = countBy(sessions, (session) => session.source);
  const byModel = countBy(sessions, (session) => session.model);

  return [
    'Sessions summary:',
    `total: ${sessions.length}`,
    'by_source:',
    ...formatCounts(bySource),
    'by_model:',
    ...formatCounts(byModel),
  ].join('\n');
}

export function validatePayloadPrivacy(payload: unknown): PayloadPrivacyValidation {
  const issues: string[] = [];
  collectPrivacyIssues(payload, [], issues);

  const schemaResult = IngestRequestSchema.safeParse(payload);
  if (!schemaResult.success) {
    for (const issue of schemaResult.error.issues) {
      issues.push(`schema.${issue.path.join('.') || '<root>'}: ${issue.message}`);
    }
  }

  return {
    isClean: issues.length === 0,
    issues,
  };
}

function countBy<T>(values: readonly T[], selector: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = selector(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return new Map([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function formatCounts(counts: ReadonlyMap<string, number>): string[] {
  if (counts.size === 0) {
    return ['- none: 0'];
  }

  return [...counts.entries()].map(([key, count]) => `- ${key}: ${count}`);
}

function collectPrivacyIssues(value: unknown, path: string[], issues: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPrivacyIssues(item, [...path, String(index)], issues));
    return;
  }

  if (typeof value === 'string') {
    if (FORBIDDEN_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      issues.push(`${formatPath(path)} contains a forbidden private-looking value`);
    }
    return;
  }

  if (!isJsonObject(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];

    if (!isAllowedKeyForPath(key, path)) {
      issues.push(`${formatPath(childPath)} is not in the dry-run payload allowlist`);
    }

    if (!INGEST_KEYS.has(key) && FORBIDDEN_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
      issues.push(`${formatPath(childPath)} matches a forbidden private field pattern`);
    }

    collectPrivacyIssues(child, childPath, issues);
  }
}

function isAllowedKeyForPath(key: string, path: readonly string[]): boolean {
  if (path.length === 0) {
    return TOP_LEVEL_KEYS.has(key);
  }

  if (path.length === 1 && path[0] === 'client') {
    return CLIENT_KEYS.has(key);
  }

  if (path.length === 1 && path[0] === 'run') {
    return RUN_KEYS.has(key);
  }

  if (path.length === 2 && path[0] === 'sessions') {
    return SESSION_KEYS.has(key);
  }

  return false;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatPath(path: readonly string[]): string {
  return path.length > 0 ? path.join('.') : '<root>';
}
