import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import Database from 'better-sqlite3';

import type { UsageImportSource } from '@tokensrank/shared';

import { sha256Hex, stableHash } from './hash.js';
import type { NormalizedToolEvent, NormalizedUsageEvent, ParsedUsageFile } from './types.js';

export const LOCAL_PARSER_VERSION = 'local-files-v1';

type ModelSource = 'explicit' | 'session_context' | 'unknown';

type JsonLine = {
  lineNumber: number;
  record: Record<string, unknown>;
};

type Tokens = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
};

type ParsedEvents = {
  events: NormalizedUsageEvent[];
  toolEvents: NormalizedToolEvent[];
  warnings: string[];
};

type OpenCodeToolRow = {
  part_id: string | null;
  session_id: string;
  part_data: string;
  message_data: string | null;
  session_directory: string | null;
  part_time_updated: number | null;
};

type ParserInput = {
  filePath: string;
  fileHash: string;
  fileSize: number;
  fileMtimeMs: number;
};

type ClaudeParseState = ParsedEvents & {
  toolUsesById: Map<string, ToolCallContext>;
};

type CodexParseState = ParsedEvents & {
  sessionId: string;
  currentModel: string;
  currentCwd: string | null;
  previousTotal: Tokens | null;
  toolCallsById: Map<string, ToolCallContext>;
};

type CommandKind = 'git_commit' | 'git_inspection' | 'git_other' | 'shell_other' | 'unknown_command';

type ToolCallContext = {
  toolName?: string;
  command?: string;
  commandKind: CommandKind;
  model: string;
  modelSource: ModelSource;
  provider: 'anthropic' | 'openai' | 'unknown';
  cwd?: string;
};

const emptyTokens: Tokens = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_create_tokens: 0,
  cached_tokens: 0,
  reasoning_tokens: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getPath(value: unknown, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>((current, key) => {
    if (!isRecord(current)) return undefined;
    return current[key];
  }, value);
}

function stringAt(record: unknown, paths: string[]): string | null {
  for (const dottedPath of paths) {
    const value = getPath(record, dottedPath);
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return null;
}

function numberAt(record: unknown, paths: string[]): number {
  for (const dottedPath of paths) {
    const value = getPath(record, dottedPath);
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.trunc(value));
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return Math.max(0, Math.trunc(parsed));
      }
    }
  }
  return 0;
}

function objectKeys(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.keys(value).sort().slice(0, 40);
}

function jsonObjectKeys(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    return objectKeys(JSON.parse(value) as unknown);
  } catch {
    return [];
  }
}

function commitShasFromValue(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const matches = text.match(/\b[0-9a-f]{7,40}\b/giu) ?? [];
  const shas = matches
    .map((match) => match.toLowerCase())
    .filter((match) => /[a-f]/u.test(match));
  return Array.from(new Set(shas)).slice(0, 10);
}

function commandFromValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const command = commandFromValue(parsed);
        if (command) return command;
      } catch {
        // Fall through to returning the raw string for simple shell payloads.
      }
    }
  }
  const command = stringAt(value, [
    'command',
    'cmd',
    'input.command',
    'parameters.command',
    'args.command',
    'arguments.command',
  ]);
  if (command) return command;
  if (typeof value === 'string' && value.length < 4000) return value;
  return undefined;
}

function classifyCommand(command: string | undefined): CommandKind {
  if (!command) return 'unknown_command';
  const normalized = command.replace(/\s+/gu, ' ').trim().toLowerCase();
  if (!normalized) return 'unknown_command';
  if (/(\b|&&|\|\||;)\s*git\s+commit(\s|$)/u.test(normalized)) return 'git_commit';
  if (/(\b|&&|\|\||;)\s*git\s+(log|show|diff|status|branch|rev-parse|merge-base)(\s|$)/u.test(normalized)) {
    return 'git_inspection';
  }
  if (/(\b|&&|\|\||;)\s*git\s+/u.test(normalized)) return 'git_other';
  return 'shell_other';
}

function isShellToolName(toolName: string | undefined): boolean {
  const normalized = (toolName ?? '').toLowerCase();
  return ['bash', 'shell', 'terminal', 'exec_command', 'command'].includes(normalized);
}

function shellCommandForTool(toolName: string | undefined, value: unknown): string | undefined {
  return isShellToolName(toolName) ? commandFromValue(value) : undefined;
}

function safeToolName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 120) return undefined;
  return trimmed;
}

function toolCategory(toolName: string | undefined): string {
  const normalized = (toolName ?? '').toLowerCase();
  if (['bash', 'exec_command', 'write_stdin'].includes(normalized)) return 'shell';
  if (['edit', 'write', 'apply_patch'].includes(normalized)) return 'file_write';
  if (['read', 'grep', 'glob'].includes(normalized)) return 'file_read';
  if (['agent', 'spawn_agent'].includes(normalized)) return 'agent';
  if (!normalized) return 'unknown';
  return 'other';
}

function toolEvent(input: {
  source: UsageImportSource;
  fileHash: string;
  lineNumber: number;
  sessionId: string;
  eventAt: string;
  toolName?: string;
  cwd?: string;
  commitSha?: string;
  confidence: number;
  metadata?: Record<string, unknown>;
  provider?: 'anthropic' | 'openai' | 'unknown';
  model?: string;
  modelSource?: ModelSource;
  commandKind?: CommandKind;
  evidenceOrigin?: string;
}): NormalizedToolEvent {
  const sourcePathHash = typeof input.metadata?.source_path_hash === 'string'
    ? input.metadata.source_path_hash
    : input.fileHash;
  const eventId = stableHash([
    'tool-event',
    input.source,
    sourcePathHash,
    input.lineNumber,
    input.sessionId,
    input.eventAt,
    input.toolName ?? null,
    input.commitSha ?? null,
    input.metadata?.call_id ?? null,
    input.metadata?.tool_use_id ?? null,
    input.metadata?.record_type ?? null,
  ]);

  return {
    event_id: eventId,
    source: input.source,
    session_id: input.sessionId,
    event_at: input.eventAt,
    provider: input.provider ?? 'unknown',
    model: input.model ?? 'unknown',
    model_source: input.modelSource ?? 'unknown',
    ...(input.toolName ? { tool_name: input.toolName } : {}),
    command_kind: input.commandKind ?? 'unknown_command',
    evidence_origin: input.evidenceOrigin ?? 'unknown',
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.commitSha ? { commit_sha: input.commitSha } : {}),
    confidence: Math.max(0, Math.min(1, input.confidence)),
    metadata: {
      tool_category: toolCategory(input.toolName),
      ...(input.cwd ? { cwd_hash: sha256Hex(input.cwd) } : {}),
      ...(input.metadata ?? {}),
    },
  };
}

function toolEventsForCommitEvidence(input: {
  source: UsageImportSource;
  fileHash: string;
  lineNumber: number;
  sessionId: string;
  eventAt: string;
  toolName?: string;
  cwd?: string;
  valueWithCommitEvidence: unknown;
  confidence: number;
  metadata?: Record<string, unknown>;
  provider?: 'anthropic' | 'openai' | 'unknown';
  model?: string;
  modelSource?: ModelSource;
  commandKind?: CommandKind;
  evidenceOrigin?: string;
}): NormalizedToolEvent[] {
  if (!isShellToolName(input.toolName) || input.commandKind !== 'git_commit') {
    return [toolEvent({
      ...input,
      confidence: 0,
      metadata: { ...(input.metadata ?? {}), commit_sha_count: 0 },
    })];
  }

  const shas = commitShasFromValue(input.valueWithCommitEvidence);
  if (shas.length === 0) {
    return [toolEvent({
      ...input,
      confidence: 0,
      metadata: { ...(input.metadata ?? {}), commit_sha_count: 0 },
    })];
  }
  return shas.map((commitSha) => toolEvent({
    ...input,
    commitSha,
    metadata: {
      ...(input.metadata ?? {}),
      commit_sha_count: shas.length,
    },
  }));
}

function additiveTokenTotal(tokens: Tokens): number {
  return tokens.input_tokens
    + tokens.output_tokens
    + tokens.cache_read_tokens
    + tokens.cache_create_tokens;
}

function tokensFromUsage(value: unknown, source: UsageImportSource): Tokens | null {
  if (!isRecord(value)) return null;

  const tokens: Tokens = {
    input_tokens: numberAt(value, ['input_tokens', 'inputTokens']),
    output_tokens: numberAt(value, ['output_tokens', 'outputTokens']),
    cache_read_tokens: numberAt(value, [
      'cache_read_input_tokens',
      'cache_read_tokens',
      'cacheReadInputTokens',
      'cacheReadTokens',
    ]),
    cache_create_tokens: numberAt(value, [
      'cache_creation_input_tokens',
      'cache_create_input_tokens',
      'cache_create_tokens',
      'cacheCreationInputTokens',
      'cacheCreateInputTokens',
      'cacheCreateTokens',
    ]),
    cached_tokens: numberAt(value, [
      'cached_input_tokens',
      'cached_tokens',
      'cachedInputTokens',
      'input_tokens_details.cached_tokens',
      'inputTokensDetails.cachedTokens',
    ]),
    reasoning_tokens: numberAt(value, [
      'reasoning_output_tokens',
      'reasoning_tokens',
      'reasoningOutputTokens',
      'output_tokens_details.reasoning_tokens',
      'outputTokensDetails.reasoningTokens',
    ]),
  };

  if (source === 'claude' && tokens.cache_read_tokens === 0) {
    tokens.cache_read_tokens = numberAt(value, ['cache_read', 'cacheRead']);
  }

  return additiveTokenTotal(tokens) > 0 ? tokens : null;
}

function subtractTokens(current: Tokens, previous: Tokens): Tokens {
  return {
    input_tokens: Math.max(0, current.input_tokens - previous.input_tokens),
    output_tokens: Math.max(0, current.output_tokens - previous.output_tokens),
    cache_read_tokens: Math.max(0, current.cache_read_tokens - previous.cache_read_tokens),
    cache_create_tokens: Math.max(0, current.cache_create_tokens - previous.cache_create_tokens),
    cached_tokens: Math.max(0, current.cached_tokens - previous.cached_tokens),
    reasoning_tokens: Math.max(0, current.reasoning_tokens - previous.reasoning_tokens),
  };
}

function hasTokenRegression(current: Tokens, previous: Tokens): boolean {
  return current.input_tokens < previous.input_tokens
    || current.output_tokens < previous.output_tokens
    || current.cache_read_tokens < previous.cache_read_tokens
    || current.cache_create_tokens < previous.cache_create_tokens
    || current.cached_tokens < previous.cached_tokens
    || current.reasoning_tokens < previous.reasoning_tokens;
}

function timestampFor(record: Record<string, unknown>, fileMtimeMs: number): string {
  const raw = stringAt(record, [
    'timestamp',
    'created_at',
    'createdAt',
    'time',
    'message.created_at',
    'message.createdAt',
    'payload.timestamp',
    'payload.created_at',
  ]);
  const date = raw ? new Date(raw) : new Date(fileMtimeMs);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export function shouldParseUsageFile(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  return name.endsWith('.jsonl') || name.endsWith('.json') || name === 'opencode.db';
}

export function usageSourceForPath(filePath: string): UsageImportSource | 'unknown' {
  const lower = filePath.toLowerCase().replaceAll(path.sep, '/');
  if (lower.includes('/.claude/projects/') || lower.includes('/claude/projects/')) return 'claude';
  if (lower.includes('/.codex/sessions/') || lower.includes('/codex/sessions/')) return 'codex';
  if (lower.includes('/opencode/') || lower.endsWith('/opencode.db')) return 'opencode';
  return 'unknown';
}

function normalizeProvider(value: string | null | undefined): 'anthropic' | 'openai' | 'unknown' {
  const provider = value?.toLowerCase();
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'openai') return 'openai';
  return 'unknown';
}

function emptyParsedEvents(): ParsedEvents {
  return { events: [], toolEvents: [], warnings: [] };
}

function parsedEventsFromState(state: ParsedEvents): ParsedEvents {
  return {
    events: state.events,
    toolEvents: state.toolEvents,
    warnings: state.warnings,
  };
}

function createClaudeState(): ClaudeParseState {
  return {
    ...emptyParsedEvents(),
    toolUsesById: new Map<string, ToolCallContext>(),
  };
}

function parseClaudeLine(input: ParserInput, state: ClaudeParseState, line: JsonLine): void {
  const sessionId = stringAt(line.record, [
    'sessionId',
    'session_id',
    'conversationId',
    'conversation_id',
  ]) ?? `claude:${input.fileHash.slice(0, 16)}`;
  const eventAt = timestampFor(line.record, input.fileMtimeMs);
  const cwd = stringAt(line.record, ['cwd']);
  const currentModel = stringAt(line.record, ['message.model', 'model']) ?? 'unknown';
  const currentModelSource: ModelSource = currentModel === 'unknown' ? 'unknown' : 'explicit';

  const messageContent = getPath(line.record, 'message.content');
  if (Array.isArray(messageContent)) {
    for (const part of messageContent) {
      if (!isRecord(part)) continue;
      if (part.type === 'tool_use') {
        const toolUseId = stringAt(part, ['id']);
        const toolName = safeToolName(stringAt(part, ['name']));
        const command = shellCommandForTool(toolName, part.input);
        const commandKind = classifyCommand(command);
        if (toolUseId) {
          state.toolUsesById.set(toolUseId, {
            toolName,
            command,
            commandKind,
            model: currentModel,
            modelSource: currentModelSource,
            provider: 'anthropic',
            cwd: cwd ?? undefined,
          });
        }
        state.toolEvents.push(toolEvent({
          source: 'claude',
          fileHash: input.fileHash,
          lineNumber: line.lineNumber,
          sessionId,
          eventAt,
          toolName,
          cwd: cwd ?? undefined,
          provider: 'anthropic',
          model: currentModel,
          modelSource: currentModelSource,
          commandKind,
          evidenceOrigin: 'tool_use',
          confidence: 0,
          metadata: {
            record_type: 'assistant.tool_use',
            ...(toolUseId ? { tool_use_id: toolUseId } : {}),
            input_keys: objectKeys(part.input),
            source_path_hash: sha256Hex(input.filePath),
          },
        }));
      } else if (part.type === 'tool_result') {
        const toolUseId = stringAt(part, ['tool_use_id']);
        const context = toolUseId ? state.toolUsesById.get(toolUseId) : undefined;
        state.toolEvents.push(...toolEventsForCommitEvidence({
          source: 'claude',
          fileHash: input.fileHash,
          lineNumber: line.lineNumber,
          sessionId,
          eventAt,
          toolName: context?.toolName,
          cwd: context?.cwd ?? cwd ?? undefined,
          provider: context?.provider ?? 'anthropic',
          model: context?.model ?? currentModel,
          modelSource: context?.modelSource ?? currentModelSource,
          commandKind: context?.commandKind ?? 'unknown_command',
          evidenceOrigin: 'tool_result',
          valueWithCommitEvidence: part.content,
          confidence: 0.9,
          metadata: {
            record_type: 'user.tool_result',
            ...(toolUseId ? { tool_use_id: toolUseId } : {}),
            source_path_hash: sha256Hex(input.filePath),
          },
        }));
      }
    }
  }

  const toolUseResult = getPath(line.record, 'toolUseResult');
  if (isRecord(toolUseResult)) {
    const toolName = safeToolName(stringAt(toolUseResult, ['name', 'toolName', 'tool_name']));
    const command = shellCommandForTool(toolName, toolUseResult);
    const commandKind = classifyCommand(command);
    state.toolEvents.push(...toolEventsForCommitEvidence({
      source: 'claude',
      fileHash: input.fileHash,
      lineNumber: line.lineNumber,
      sessionId,
      eventAt,
      toolName,
      cwd: cwd ?? undefined,
      provider: 'anthropic',
      model: currentModel,
      modelSource: currentModelSource,
      commandKind,
      evidenceOrigin: 'toolUseResult',
      valueWithCommitEvidence: {
        stdout: toolUseResult.stdout,
        stderr: toolUseResult.stderr,
        content: toolUseResult.content,
        gitOperation: toolUseResult.gitOperation,
      },
      confidence: 0.9,
      metadata: {
        record_type: 'user.toolUseResult',
        result_keys: objectKeys(toolUseResult),
        source_path_hash: sha256Hex(input.filePath),
      },
    }));
  }

  const messageUsage = getPath(line.record, 'message.usage');
  const toolUsage = getPath(line.record, 'toolUseResult.usage');
  const messageTokens = tokensFromUsage(messageUsage, 'claude');
  const usage = messageTokens ?? tokensFromUsage(toolUsage, 'claude');
  if (!usage) return;

  const isToolUsage = messageTokens === null;
  const sourceEventId = stringAt(line.record, [
    'message.id',
    'uuid',
    'id',
    'requestId',
    'request_id',
  ]) ?? undefined;
  const model = stringAt(line.record, [
    'message.model',
    'model',
    'toolUseResult.model',
  ]) ?? 'unknown';
  const eventId = stableHash([
    'claude',
    sha256Hex(input.filePath),
    line.lineNumber,
    sessionId,
    sourceEventId ?? null,
    eventAt,
    usage,
  ]);

  state.events.push({
    event_id: eventId,
    source: 'claude',
    provider: 'anthropic',
    event_kind: isToolUsage ? 'claude_tool_result_usage' : 'claude_message_usage',
    session_id: sessionId,
    ...(sourceEventId ? { source_event_id: sourceEventId } : {}),
    event_at: eventAt,
    model,
    model_source: model === 'unknown' ? 'unknown' : 'explicit',
    ...usage,
    source_file_hash: input.fileHash,
    source_file_size: input.fileSize,
    line_number: line.lineNumber,
    parser_version: LOCAL_PARSER_VERSION,
    metadata: {
      record_type: isToolUsage ? 'toolUseResult.usage' : 'message.usage',
      source_path_hash: sha256Hex(input.filePath),
    },
  });
}

function parseClaudeLines(input: ParserInput & { lines: JsonLine[] }): ParsedEvents {
  const state = createClaudeState();
  for (const line of input.lines) {
    parseClaudeLine(input, state, line);
  }
  return parsedEventsFromState(state);
}

function createCodexState(fileHash: string): CodexParseState {
  return {
    ...emptyParsedEvents(),
    sessionId: `codex:${fileHash.slice(0, 16)}`,
    currentModel: 'unknown',
    currentCwd: null,
    previousTotal: null,
    toolCallsById: new Map<string, ToolCallContext>(),
  };
}

function parseCodexLine(input: ParserInput, state: CodexParseState, line: JsonLine): void {
  const payload = isRecord(line.record.payload) ? line.record.payload : {};
  const recordType = stringAt(line.record, ['type', 'payload.type']) ?? '';
  const sessionMetaId = recordType === 'session_meta'
    ? stringAt(line.record, ['payload.id', 'payload.session_id', 'payload.sessionId', 'id', 'session_id'])
    : null;

  if (sessionMetaId) {
    state.sessionId = sessionMetaId;
  }

  const contextCwd = stringAt(line.record, [
    'payload.cwd',
    'payload.workdir',
    'payload.current_working_directory',
    'cwd',
  ]);
  if (contextCwd && (recordType === 'turn_context' || recordType === 'session_meta' || recordType === 'session_configured')) {
    state.currentCwd = contextCwd;
  }

  const contextModel = stringAt(line.record, [
    'payload.model',
    'payload.info.model',
    'model',
  ]);

  if (contextModel && (recordType === 'turn_context' || recordType === 'session_meta' || recordType === 'session_configured')) {
    state.currentModel = contextModel;
  }

  const payloadType = stringAt(payload, ['type']);
  if (payloadType === 'function_call' || payloadType === 'custom_tool_call' || payloadType === 'tool_search_call') {
    const toolName = safeToolName(stringAt(payload, ['name', 'namespace']));
    const callId = stringAt(payload, ['call_id']);
    const command = shellCommandForTool(toolName, payload.arguments ?? payload.input);
    const commandKind = classifyCommand(command);
    const modelSource: ModelSource = state.currentModel === 'unknown' ? 'unknown' : 'session_context';
    if (callId) {
      state.toolCallsById.set(callId, {
        toolName,
        command,
        commandKind,
        model: state.currentModel,
        modelSource,
        provider: 'openai',
        cwd: state.currentCwd ?? undefined,
      });
    }
    state.toolEvents.push(toolEvent({
      source: 'codex',
      fileHash: input.fileHash,
      lineNumber: line.lineNumber,
      sessionId: state.sessionId,
      eventAt: timestampFor(line.record, input.fileMtimeMs),
      toolName,
      cwd: state.currentCwd ?? undefined,
      provider: 'openai',
      model: state.currentModel,
      modelSource,
      commandKind,
      evidenceOrigin: 'tool_call',
      confidence: 0,
      metadata: {
        record_type: `codex.${payloadType}`,
        ...(callId ? { call_id: callId } : {}),
        argument_keys: jsonObjectKeys(payload.arguments),
        input_keys: objectKeys(payload.input),
        source_path_hash: sha256Hex(input.filePath),
      },
    }));
  } else if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output' || payloadType === 'tool_search_output') {
    const callId = stringAt(payload, ['call_id']);
    const context = callId ? state.toolCallsById.get(callId) : undefined;
    state.toolEvents.push(...toolEventsForCommitEvidence({
      source: 'codex',
      fileHash: input.fileHash,
      lineNumber: line.lineNumber,
      sessionId: state.sessionId,
      eventAt: timestampFor(line.record, input.fileMtimeMs),
      toolName: context?.toolName,
      cwd: context?.cwd ?? state.currentCwd ?? undefined,
      provider: context?.provider ?? 'openai',
      model: context?.model ?? state.currentModel,
      modelSource: context?.modelSource ?? (state.currentModel === 'unknown' ? 'unknown' : 'session_context'),
      commandKind: context?.commandKind ?? 'unknown_command',
      evidenceOrigin: 'tool_output',
      valueWithCommitEvidence: payload.output ?? payload.execution,
      confidence: 0.9,
      metadata: {
        record_type: `codex.${payloadType}`,
        ...(callId ? { call_id: callId } : {}),
        source_path_hash: sha256Hex(input.filePath),
      },
    }));
  }

  const info = isRecord(payload.info) ? payload.info : isRecord(line.record.info) ? line.record.info : null;
  if (!info) return;

  const totalUsage = tokensFromUsage(getPath(info, 'total_token_usage'), 'codex')
    ?? tokensFromUsage(getPath(info, 'totalTokenUsage'), 'codex');
  const lastUsage = tokensFromUsage(getPath(info, 'last_token_usage'), 'codex')
    ?? tokensFromUsage(getPath(info, 'lastTokenUsage'), 'codex');

  if (!totalUsage && !lastUsage) return;

  const explicitModel = stringAt(info, ['model']) ?? stringAt(payload, ['model']);
  const model = explicitModel ?? state.currentModel;
  const modelSource: ModelSource = explicitModel ? 'explicit' : model === 'unknown' ? 'unknown' : 'session_context';
  let usage: Tokens = lastUsage ?? totalUsage ?? emptyTokens;

  if (totalUsage) {
    if (state.previousTotal) {
      if (hasTokenRegression(totalUsage, state.previousTotal)) {
        usage = lastUsage ?? totalUsage;
        state.warnings.push('Codex cumulative token counter reset; used last_token_usage for that line.');
      } else {
        usage = subtractTokens(totalUsage, state.previousTotal);
      }
    } else {
      usage = totalUsage;
    }

    state.previousTotal = totalUsage;
  }

  if (additiveTokenTotal(usage) <= 0) return;

  const sourceEventId = stringAt(line.record, ['id', 'payload.id', 'event_id']) ?? undefined;
  const eventAt = timestampFor(line.record, input.fileMtimeMs);
  const eventId = stableHash([
    'codex',
    sha256Hex(input.filePath),
    line.lineNumber,
    state.sessionId,
    sourceEventId ?? null,
    eventAt,
    usage,
  ]);

  state.events.push({
    event_id: eventId,
    source: 'codex',
    provider: 'openai',
    event_kind: 'codex_token_count_delta',
    session_id: state.sessionId,
    ...(sourceEventId ? { source_event_id: sourceEventId } : {}),
    event_at: eventAt,
    model,
    model_source: modelSource,
    ...usage,
    source_file_hash: input.fileHash,
    source_file_size: input.fileSize,
    line_number: line.lineNumber,
    parser_version: LOCAL_PARSER_VERSION,
    metadata: {
      record_type: 'token_count',
      cumulative_delta: totalUsage !== null,
      source_path_hash: sha256Hex(input.filePath),
    },
  });
}

function parseCodexLines(input: ParserInput & { lines: JsonLine[] }): ParsedEvents {
  const state = createCodexState(input.fileHash);
  for (const line of input.lines) {
    parseCodexLine(input, state, line);
  }
  return parsedEventsFromState(state);
}

function isoFromEpochMs(value: unknown, fallbackMs: number): string {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value : fallbackMs;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? new Date(fallbackMs).toISOString() : date.toISOString();
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseOpenCodeDb(input: ParserInput): ParsedEvents & { rowCount: number } {
  const result: ParsedEvents & { rowCount: number } = {
    ...emptyParsedEvents(),
    rowCount: 0,
  };
  let sqlite: Database.Database | null = null;

  try {
    sqlite = new Database(input.filePath, { readonly: true, fileMustExist: true });
    const rows = sqlite.prepare(`
      SELECT
        part.id AS part_id,
        part.session_id,
        part.data AS part_data,
        message.data AS message_data,
        session.directory AS session_directory,
        part.time_updated AS part_time_updated
      FROM part
      LEFT JOIN message
        ON message.id = part.message_id
       AND message.session_id = part.session_id
      LEFT JOIN session
        ON session.id = part.session_id
      WHERE part.data LIKE '%"type":"tool"%'
    `).all() as OpenCodeToolRow[];

    result.rowCount = rows.length;
    rows.forEach((row, index) => {
      const part = parseJsonRecord(row.part_data);
      if (!part || part.type !== 'tool') return;
      const state = isRecord(part.state) ? part.state : null;
      if (!state) return;
      const status = stringAt(state, ['status']);
      if (status && status !== 'completed') return;

      const inputRecord = isRecord(state.input) ? state.input : {};
      const toolName = safeToolName(stringAt(part, ['tool']));
      const command = shellCommandForTool(toolName, inputRecord);
      const commandKind = classifyCommand(command);
      const message = parseJsonRecord(row.message_data);
      const model = stringAt(message, ['modelID', 'model']) ?? 'unknown';
      const provider = normalizeProvider(stringAt(message, ['providerID', 'provider']));
      const cwd = stringAt(inputRecord, ['workdir', 'cwd'])
        ?? stringAt(message, ['path.cwd', 'path.root'])
        ?? row.session_directory
        ?? undefined;
      const eventAt = isoFromEpochMs(getPath(state, 'time.end') ?? row.part_time_updated, input.fileMtimeMs);
      const baseMetadata = {
        record_type: 'opencode.tool',
        ...(typeof part.callID === 'string' ? { call_id: part.callID } : {}),
        source_path_hash: sha256Hex(input.filePath),
        ...(command ? { command_hash: sha256Hex(command) } : {}),
      };

      result.toolEvents.push(...toolEventsForCommitEvidence({
        source: 'opencode',
        fileHash: input.fileHash,
        lineNumber: index + 1,
        sessionId: row.session_id,
        eventAt,
        toolName,
        cwd,
        provider,
        model,
        modelSource: model === 'unknown' ? 'unknown' : 'explicit',
        commandKind,
        evidenceOrigin: 'opencode_tool_part',
        valueWithCommitEvidence: state.output ?? state.metadata,
        confidence: 0.9,
        metadata: baseMetadata,
      }));
    });
  } catch (error) {
    result.warnings.push(`OpenCode SQLite scan failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    sqlite?.close();
  }

  return result;
}

export async function sha256File(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => {
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

async function parseJsonLinesFromFile(
  filePath: string,
  onLine: (line: JsonLine) => void,
): Promise<{ invalidCount: number; lineCount: number; recordCount: number }> {
  const lineReader = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let invalidCount = 0;
  let lineCount = 0;
  let recordCount = 0;

  for await (const rawLine of lineReader) {
    lineCount += 1;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) {
        recordCount += 1;
        onLine({ lineNumber: lineCount, record: parsed });
      }
    } catch {
      invalidCount += 1;
    }
  }

  return { invalidCount, lineCount, recordCount };
}

export async function parseUsageFile(filePath: string): Promise<ParsedUsageFile | null> {
  if (!shouldParseUsageFile(filePath)) return null;

  const [fileStat, fileHash] = await Promise.all([
    stat(filePath),
    sha256File(filePath),
  ]);
  const kind = usageSourceForPath(filePath);
  const input = {
    filePath,
    fileHash,
    fileSize: fileStat.size,
    fileMtimeMs: fileStat.mtimeMs,
  };
  if (kind === 'opencode') {
    const opencode = parseOpenCodeDb(input);
    if (opencode.events.length === 0 && opencode.toolEvents.length === 0) return null;
    return {
      file: {
        source: 'opencode',
        path: filePath,
        path_hash: sha256Hex(filePath),
        source_file_hash: fileHash,
        source_file_size: fileStat.size,
        line_count: opencode.rowCount,
        parsed_event_count: opencode.events.length + opencode.toolEvents.length,
        ignored_line_count: Math.max(0, opencode.rowCount - opencode.events.length - opencode.toolEvents.length),
        warning_count: opencode.warnings.length,
        parser_version: LOCAL_PARSER_VERSION,
        metadata: {
          file_kind: kind,
        },
      },
      events: opencode.events,
      tool_events: opencode.toolEvents,
      warnings: opencode.warnings,
    };
  }
  const claudeState = kind === 'codex' ? null : createClaudeState();
  const codexState = kind === 'claude' ? null : createCodexState(fileHash);
  const parsed = await parseJsonLinesFromFile(filePath, (line) => {
    if (claudeState) parseClaudeLine(input, claudeState, line);
    if (codexState) parseCodexLine(input, codexState, line);
  });
  if (parsed.recordCount === 0) return null;

  const claude = claudeState ? parsedEventsFromState(claudeState) : emptyParsedEvents();
  const codex = codexState ? parsedEventsFromState(codexState) : emptyParsedEvents();
  const events = [...claude.events, ...codex.events];
  const toolEvents = [...claude.toolEvents, ...codex.toolEvents];
  if (events.length === 0 && toolEvents.length === 0) return null;

  const source = kind === 'claude' || kind === 'codex'
    ? kind
    : claude.events.length > 0 || claude.toolEvents.length > 0
      ? 'claude'
      : 'codex';
  const warnings = [
    ...claude.warnings,
    ...codex.warnings,
    ...(parsed.invalidCount > 0 ? [`Skipped ${parsed.invalidCount} invalid JSON lines.`] : []),
  ];

  return {
    file: {
      source,
      path: filePath,
      path_hash: sha256Hex(filePath),
      source_file_hash: fileHash,
      source_file_size: fileStat.size,
      line_count: parsed.lineCount,
      parsed_event_count: events.length + toolEvents.length,
      ignored_line_count: Math.max(0, parsed.lineCount - events.length - toolEvents.length),
      warning_count: warnings.length,
      parser_version: LOCAL_PARSER_VERSION,
      metadata: {
        file_kind: kind,
      },
    },
    events,
    tool_events: toolEvents,
    warnings,
  };
}
