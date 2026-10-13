import { createHash } from 'node:crypto';

import type { SessionPayload } from '@tokensrank/shared';

import {
  enforceSessionAllowlist,
  getNonNegativeInteger,
  getObject,
  getString,
  isJsonObject,
  toIsoTimestamp,
  type ExtractionWarning,
  type ExtractorResult,
  type JsonObject,
} from '../privacy/allowlist.js';
import { activeTimeFromTimestamps } from './active-time.js';

type CodexParseOptions = {
  sessionId?: string;
};

type CodexTokenEvent = {
  model?: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  line: number;
};

type CodexState = { tokenEvents: CodexTokenEvent[]; activeModel: string; warnings: ExtractionWarning[] };

function newCodexState(): CodexState {
  return { tokenEvents: [], activeModel: 'unknown', warnings: [] };
}

function processCodexLine(state: CodexState, line: string, lineNumber: number): void {
  const trimmedLine = line.trim();
  if (trimmedLine.length === 0) {
    return;
  }

  const parsed = parseJsonLine(trimmedLine, lineNumber, state.warnings);
  if (!parsed) {
    return;
  }

  const model = extractAllowedCodexModel(parsed);
  const recordType = getString(parsed.type);
  if (
    model
    && (recordType === 'session_meta' || recordType === 'turn_context' || recordType === 'session_configured')
  ) {
    state.activeModel = model;
  }

  const event = extractAllowedCodexTokenEvent(parsed, lineNumber, state.warnings, state.activeModel);
  if (event) {
    state.tokenEvents.push(event);
  }
}

export function parseCodexJsonl(jsonl: string, options: CodexParseOptions = {}): ExtractorResult {
  const state = newCodexState();
  let index = 0;
  for (const line of jsonl.split(/\r?\n/u)) {
    processCodexLine(state, line, (index += 1));
  }
  return finalizeCodex(state, sha256(jsonl), options.sessionId);
}

/**
 * Streaming variant for files too large to hold as one string. Holds only the
 * compact token-event list (the bulk of a large rollout is content the
 * allowlist discards). The sha is computed separately from the raw bytes.
 */
export async function parseCodexJsonlStream(
  lines: AsyncIterable<string>,
  fileSha256: string,
  sessionId?: string,
): Promise<ExtractorResult> {
  const state = newCodexState();
  let index = 0;
  for await (const line of lines) {
    processCodexLine(state, line, (index += 1));
  }
  return finalizeCodex(state, fileSha256, sessionId);
}

function finalizeCodex(state: CodexState, fileSha256: string, sessionIdOption?: string): ExtractorResult {
  const { tokenEvents, warnings } = state;

  if (tokenEvents.length === 0) {
    return { sessions: [], warnings };
  }

  const sessionId = sessionIdOption?.trim() || `codex-${fileSha256.slice(0, 32)}`;
  const firstEventAt = tokenEvents.reduce((earliest, event) =>
    Date.parse(event.timestamp) < Date.parse(earliest) ? event.timestamp : earliest,
  tokenEvents[0]?.timestamp ?? new Date(0).toISOString());
  const latestTokenEvent = tokenEvents.reduce((latest, event) =>
    compareEventOrder(event.timestamp, event.line, { timestamp: latest.timestamp, line: latest.line }) >= 0
      ? event
      : latest,
  tokenEvents[0] as CodexTokenEvent);
  const totals = tokenEvents.reduce((sum, event) => ({
    inputTokens: sum.inputTokens + event.inputTokens,
    outputTokens: sum.outputTokens + event.outputTokens,
    cachedInputTokens: sum.cachedInputTokens + event.cachedInputTokens,
    reasoningOutputTokens: sum.reasoningOutputTokens + event.reasoningOutputTokens,
  }), {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
  });

  const active = activeTimeFromTimestamps(tokenEvents.map((event) => Date.parse(event.timestamp)));

  const session = buildCodexSession({
    sessionId,
    model: latestTokenEvent.model ?? 'unknown',
    firstEventAt,
    lastEventAt: latestTokenEvent.timestamp,
    turns: tokenEvents.length,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    reasoningOutputTokens: totals.reasoningOutputTokens,
    activeSeconds: active.activeSeconds,
    longestActiveSeconds: active.longestActiveSeconds,
    fileSha256,
  });

  return { sessions: [session], warnings };
}

function parseJsonLine(line: string, lineNumber: number, warnings: ExtractionWarning[]): JsonObject | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isJsonObject(parsed)) {
      warnings.push({ line: lineNumber, code: 'invalid_shape' });
      return null;
    }

    return parsed;
  } catch {
    warnings.push({ line: lineNumber, code: 'invalid_json' });
    return null;
  }
}

function extractAllowedCodexTokenEvent(
  record: JsonObject,
  lineNumber: number,
  warnings: ExtractionWarning[],
  activeModel: string,
): CodexTokenEvent | null {
  const payload = getObject(record.payload);
  const recordType = getString(record.type);
  const payloadType = getString(payload?.type);
  const usage = getObject(getObject(payload?.info)?.last_token_usage);

  if (!usage) {
    return null;
  }

  const timestamp = toIsoTimestamp(record.timestamp);
  if (!timestamp) {
    warnings.push({ line: lineNumber, code: 'invalid_timestamp' });
    return null;
  }

  const isTokenCount = payloadType === 'token_count' || recordType === 'token_count';
  if (!isTokenCount) {
    return null;
  }

  const inputTokens = getNonNegativeInteger(usage.input_tokens);
  const outputTokens = getNonNegativeInteger(usage.output_tokens);
  if (inputTokens === 0 && outputTokens === 0) {
    return null;
  }

  return {
    model: getString(payload?.model) ?? activeModel,
    timestamp,
    inputTokens,
    outputTokens,
    cachedInputTokens: getNonNegativeInteger(usage.cached_input_tokens),
    reasoningOutputTokens: getNonNegativeInteger(usage.reasoning_output_tokens),
    line: lineNumber,
  };
}

function extractAllowedCodexModel(record: JsonObject): string | undefined {
  return getString(getObject(record.payload)?.model);
}

function compareEventOrder(
  timestamp: string,
  line: number,
  other: { timestamp: string; line: number },
): number {
  const timestampDelta = Date.parse(timestamp) - Date.parse(other.timestamp);
  if (timestampDelta !== 0) {
    return timestampDelta;
  }

  return line - other.line;
}

function buildCodexSession(args: {
  sessionId: string;
  model: string;
  firstEventAt: string;
  lastEventAt: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  activeSeconds: number;
  longestActiveSeconds: number;
  fileSha256: string;
}): SessionPayload {
  return enforceSessionAllowlist({
    session_id: args.sessionId,
    source: 'codex',
    model: args.model,
    first_event_at: args.firstEventAt,
    last_event_at: args.lastEventAt,
    input_tokens: args.inputTokens,
    output_tokens: args.outputTokens,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cached_input_tokens: args.cachedInputTokens,
    reasoning_output_tokens: args.reasoningOutputTokens,
    turns: args.turns,
    active_seconds: args.activeSeconds,
    longest_active_seconds: args.longestActiveSeconds,
    file_sha256: args.fileSha256,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
