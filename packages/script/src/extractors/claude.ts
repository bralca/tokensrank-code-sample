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
import { ActiveTimeAccumulator } from './active-time.js';

type ClaudeAccumulator = {
  sessionId: string;
  model: string;
  firstEventAt: string;
  lastEventAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  turns: number;
  activeTime: ActiveTimeAccumulator;
};

type ClaudeAllowedTurn = {
  sessionId: string;
  model: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

type ClaudeState = { sessionsById: Map<string, ClaudeAccumulator>; warnings: ExtractionWarning[] };

function newClaudeState(): ClaudeState {
  return { sessionsById: new Map<string, ClaudeAccumulator>(), warnings: [] };
}

function processClaudeLine(state: ClaudeState, line: string, lineNumber: number): void {
  const trimmedLine = line.trim();
  if (trimmedLine.length === 0) {
    return;
  }

  const parsed = parseJsonLine(trimmedLine, lineNumber, state.warnings);
  if (!parsed) {
    return;
  }

  const turn = extractAllowedClaudeTurn(parsed, lineNumber, state.warnings);
  if (!turn) {
    return;
  }

  accumulateClaudeTurn(state.sessionsById, turn);
}

/** A Claude record counts a turn whenever a `message.usage` object is present,
 * even if it carries no token numbers (error stubs, summary/compaction turns,
 * older usage schemas). Drop sessions whose tokens are all zero so they don't
 * pollute session/active-day counts with no usage to show. */
function hasTokens(a: ClaudeAccumulator): boolean {
  return a.inputTokens + a.outputTokens + a.cacheReadInputTokens + a.cacheCreationInputTokens > 0;
}

function finalizeClaude(state: ClaudeState, fileSha256: string): ExtractorResult {
  return {
    sessions: Array.from(state.sessionsById.values())
      .filter(hasTokens)
      .map((accumulator) => buildClaudeSession(accumulator, fileSha256)),
    warnings: state.warnings,
  };
}

export function parseClaudeJsonl(jsonl: string): ExtractorResult {
  const state = newClaudeState();
  let index = 0;
  for (const line of jsonl.split(/\r?\n/u)) {
    processClaudeLine(state, line, (index += 1));
  }
  return finalizeClaude(state, sha256(jsonl));
}

/**
 * Streaming variant for files too large to hold as one string (>~512MB / >2GB).
 * Holds only the per-session accumulator, not the file. The sha is computed
 * separately from the raw bytes (see extractors/index.ts).
 */
export async function parseClaudeJsonlStream(
  lines: AsyncIterable<string>,
  fileSha256: string,
): Promise<ExtractorResult> {
  const state = newClaudeState();
  let index = 0;
  for await (const line of lines) {
    processClaudeLine(state, line, (index += 1));
  }
  return finalizeClaude(state, fileSha256);
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

function extractAllowedClaudeTurn(
  record: JsonObject,
  lineNumber: number,
  warnings: ExtractionWarning[],
): ClaudeAllowedTurn | null {
  const message = getObject(record.message);
  const usage = getObject(message?.usage);
  const sessionId = getString(record.sessionId);
  const model = getString(message?.model);
  const timestamp = toIsoTimestamp(record.timestamp);

  if (!timestamp && (sessionId || model || usage)) {
    warnings.push({ line: lineNumber, code: 'invalid_timestamp' });
    return null;
  }

  if (!sessionId || !model || !timestamp || !usage) {
    warnings.push({ line: lineNumber, code: 'missing_required_fields' });
    return null;
  }

  return {
    sessionId,
    model,
    timestamp,
    inputTokens: getNonNegativeInteger(usage.input_tokens),
    outputTokens: getNonNegativeInteger(usage.output_tokens),
    cacheReadInputTokens: getNonNegativeInteger(usage.cache_read_input_tokens),
    cacheCreationInputTokens: getNonNegativeInteger(usage.cache_creation_input_tokens),
  };
}

function accumulateClaudeTurn(sessionsById: Map<string, ClaudeAccumulator>, turn: ClaudeAllowedTurn): void {
  const existing = sessionsById.get(turn.sessionId);
  if (!existing) {
    const activeTime = new ActiveTimeAccumulator();
    activeTime.add(Date.parse(turn.timestamp));
    sessionsById.set(turn.sessionId, {
      sessionId: turn.sessionId,
      model: turn.model,
      firstEventAt: turn.timestamp,
      lastEventAt: turn.timestamp,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      cacheReadInputTokens: turn.cacheReadInputTokens,
      cacheCreationInputTokens: turn.cacheCreationInputTokens,
      turns: 1,
      activeTime,
    });
    return;
  }

  existing.inputTokens += turn.inputTokens;
  existing.outputTokens += turn.outputTokens;
  existing.cacheReadInputTokens += turn.cacheReadInputTokens;
  existing.cacheCreationInputTokens += turn.cacheCreationInputTokens;
  existing.turns += 1;
  existing.activeTime.add(Date.parse(turn.timestamp));

  if (Date.parse(turn.timestamp) < Date.parse(existing.firstEventAt)) {
    existing.firstEventAt = turn.timestamp;
  }

  if (Date.parse(turn.timestamp) >= Date.parse(existing.lastEventAt)) {
    existing.lastEventAt = turn.timestamp;
    existing.model = turn.model;
  }
}

function buildClaudeSession(accumulator: ClaudeAccumulator, fileSha256: string): SessionPayload {
  const active = accumulator.activeTime.result();
  return enforceSessionAllowlist({
    session_id: accumulator.sessionId,
    source: 'claude',
    model: accumulator.model,
    first_event_at: accumulator.firstEventAt,
    last_event_at: accumulator.lastEventAt,
    input_tokens: accumulator.inputTokens,
    output_tokens: accumulator.outputTokens,
    cache_read_input_tokens: accumulator.cacheReadInputTokens,
    cache_creation_input_tokens: accumulator.cacheCreationInputTokens,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0,
    turns: accumulator.turns,
    active_seconds: active.activeSeconds,
    longest_active_seconds: active.longestActiveSeconds,
    file_sha256: fileSha256,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
