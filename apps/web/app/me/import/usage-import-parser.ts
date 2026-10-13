export const PARSER_VERSION = 'browser-folder-v1';

export type UsageImportSource = 'claude' | 'codex';
export type UsageImportProvider = 'anthropic' | 'openai' | 'unknown';
export type ModelSource = 'explicit' | 'session_context' | 'unknown';

export type ParsedUsageEvent = {
  event_id: string;
  source: UsageImportSource;
  provider: UsageImportProvider;
  event_kind: string;
  session_id: string;
  source_event_id?: string;
  event_at: string;
  model: string;
  model_source: ModelSource;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  source_file_hash: string;
  source_file_size: number;
  line_number: number;
  parser_version: string;
  metadata: Record<string, unknown>;
};

export type ParsedSourceFile = {
  source: UsageImportSource;
  source_file_hash: string;
  source_file_size: number;
  line_count: number;
  parsed_event_count: number;
  ignored_line_count: number;
  warning_count: number;
  parser_version: string;
  metadata: Record<string, unknown>;
};

export type ParsedUsageImport = {
  events: ParsedUsageEvent[];
  files: ParsedSourceFile[];
  warnings: string[];
  scannedFiles: number;
  skippedFiles: number;
};

type JsonLine = {
  lineNumber: number;
  raw: string;
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

function getPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!isRecord(current)) {
      return undefined;
    }

    return current[key];
  }, value);
}

function stringAt(record: unknown, paths: string[]): string | null {
  for (const path of paths) {
    const value = getPath(record, path);

    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }

  return null;
}

function numberAt(record: unknown, paths: string[]): number {
  for (const path of paths) {
    const value = getPath(record, path);

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

function additiveTokenTotal(tokens: Tokens): number {
  return tokens.input_tokens
    + tokens.output_tokens
    + tokens.cache_read_tokens
    + tokens.cache_create_tokens;
}

function tokenSum(tokens: Tokens): number {
  return additiveTokenTotal(tokens)
    + tokens.cached_tokens
    + tokens.reasoning_tokens;
}

function tokensFromUsage(value: unknown, source: UsageImportSource): Tokens | null {
  if (!isRecord(value)) {
    return null;
  }

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

function timestampFor(record: Record<string, unknown>, file: File): string {
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
  const date = raw ? new Date(raw) : new Date(file.lastModified);

  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function parseJsonLines(text: string): { lines: JsonLine[]; invalidCount: number; lineCount: number } {
  const rawLines = text.split(/\r?\n/u);
  const lineCount = rawLines.at(-1) === '' ? rawLines.length - 1 : rawLines.length;
  const lines: JsonLine[] = [];
  let invalidCount = 0;

  rawLines.forEach((raw, index) => {
    const trimmed = raw.trim();

    if (!trimmed) {
      return;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;

      if (isRecord(parsed)) {
        lines.push({
          lineNumber: index + 1,
          raw: trimmed,
          record: parsed,
        });
      }
    } catch {
      invalidCount += 1;
    }
  });

  return { lines, invalidCount, lineCount };
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function buildEventId(parts: unknown[]): Promise<string> {
  return await sha256Hex(JSON.stringify(parts));
}

function fileKind(file: File): string {
  const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  const lower = path.toLowerCase();

  if (lower.includes('.claude') || lower.includes('/claude')) return 'claude';
  if (lower.includes('.codex') || lower.includes('/codex')) return 'codex';
  return 'unknown';
}

async function parseClaudeLines(input: {
  file: File;
  fileHash: string;
  lines: JsonLine[];
}): Promise<{ events: ParsedUsageEvent[]; warnings: string[] }> {
  const events: ParsedUsageEvent[] = [];
  const warnings: string[] = [];

  for (const line of input.lines) {
    const messageUsage = getPath(line.record, 'message.usage');
    const toolUsage = getPath(line.record, 'toolUseResult.usage');
    const usage = tokensFromUsage(messageUsage, 'claude') ?? tokensFromUsage(toolUsage, 'claude');

    if (!usage) {
      continue;
    }

    const isToolUsage = tokensFromUsage(messageUsage, 'claude') === null;
    const sourceEventId = stringAt(line.record, [
      'message.id',
      'uuid',
      'id',
      'requestId',
      'request_id',
    ]) ?? undefined;
    const sessionId = stringAt(line.record, [
      'sessionId',
      'session_id',
      'conversationId',
      'conversation_id',
    ]) ?? `claude:${input.fileHash.slice(0, 16)}`;
    const model = stringAt(line.record, [
      'message.model',
      'model',
      'toolUseResult.model',
    ]) ?? 'unknown';
    const eventAt = timestampFor(line.record, input.file);
    const eventId = await buildEventId([
      'claude',
      input.fileHash,
      line.lineNumber,
      sessionId,
      sourceEventId ?? null,
      eventAt,
      usage,
    ]);

    events.push({
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
      source_file_size: input.file.size,
      line_number: line.lineNumber,
      parser_version: PARSER_VERSION,
      metadata: {
        record_type: isToolUsage ? 'toolUseResult.usage' : 'message.usage',
      },
    });
  }

  return { events, warnings };
}

async function parseCodexLines(input: {
  file: File;
  fileHash: string;
  lines: JsonLine[];
}): Promise<{ events: ParsedUsageEvent[]; warnings: string[] }> {
  const events: ParsedUsageEvent[] = [];
  const warnings: string[] = [];
  let sessionId = `codex:${input.fileHash.slice(0, 16)}`;
  let currentModel = 'unknown';
  let previousTotal: Tokens | null = null;

  for (const line of input.lines) {
    const payload = isRecord(line.record.payload) ? line.record.payload : {};
    const recordType = stringAt(line.record, ['type', 'payload.type']) ?? '';
    const sessionMetaId = recordType === 'session_meta'
      ? stringAt(line.record, ['payload.id', 'payload.session_id', 'payload.sessionId', 'id', 'session_id'])
      : null;

    if (sessionMetaId) {
      sessionId = sessionMetaId;
    }

    const contextModel = stringAt(line.record, [
      'payload.model',
      'payload.info.model',
      'model',
    ]);

    if (contextModel && (recordType === 'turn_context' || recordType === 'session_meta')) {
      currentModel = contextModel;
      continue;
    }

    const info = isRecord(payload.info) ? payload.info : isRecord(line.record.info) ? line.record.info : null;

    if (!info) {
      continue;
    }

    const totalUsage = tokensFromUsage(getPath(info, 'total_token_usage'), 'codex')
      ?? tokensFromUsage(getPath(info, 'totalTokenUsage'), 'codex');
    const lastUsage = tokensFromUsage(getPath(info, 'last_token_usage'), 'codex')
      ?? tokensFromUsage(getPath(info, 'lastTokenUsage'), 'codex');

    if (!totalUsage && !lastUsage) {
      continue;
    }

    const explicitModel = stringAt(info, ['model']) ?? stringAt(payload, ['model']);
    const model = explicitModel ?? currentModel;
    const modelSource: ModelSource = explicitModel ? 'explicit' : model === 'unknown' ? 'unknown' : 'session_context';
    let usage: Tokens = lastUsage ?? totalUsage ?? emptyTokens;

    if (totalUsage) {
      if (previousTotal) {
        if (hasTokenRegression(totalUsage, previousTotal)) {
          usage = lastUsage ?? totalUsage;
          warnings.push('Codex cumulative token counter reset; used last_token_usage for that line.');
        } else {
          usage = subtractTokens(totalUsage, previousTotal);
        }
      } else {
        usage = totalUsage;
      }

      previousTotal = totalUsage;
    }

    if (additiveTokenTotal(usage) <= 0) {
      continue;
    }

    const sourceEventId = stringAt(line.record, ['id', 'payload.id', 'event_id']) ?? undefined;
    const eventAt = timestampFor(line.record, input.file);
    const eventId = await buildEventId([
      'codex',
      input.fileHash,
      line.lineNumber,
      sessionId,
      sourceEventId ?? null,
      eventAt,
      usage,
    ]);

    events.push({
      event_id: eventId,
      source: 'codex',
      provider: 'openai',
      event_kind: 'codex_token_count_delta',
      session_id: sessionId,
      ...(sourceEventId ? { source_event_id: sourceEventId } : {}),
      event_at: eventAt,
      model,
      model_source: modelSource,
      ...usage,
      source_file_hash: input.fileHash,
      source_file_size: input.file.size,
      line_number: line.lineNumber,
      parser_version: PARSER_VERSION,
      metadata: {
        record_type: 'token_count',
        cumulative_delta: totalUsage !== null,
      },
    });
  }

  return { events, warnings };
}

function shouldScanFile(file: File): boolean {
  const name = file.name.toLowerCase();

  return name.endsWith('.jsonl') || name.endsWith('.json');
}

async function readSelectedFile(file: File): Promise<{ ok: true; text: string } | { ok: false; warning: string }> {
  try {
    return {
      ok: true,
      text: await file.text(),
    };
  } catch {
    return {
      ok: false,
      warning: 'Skipped an unreadable JSON/JSONL file because the browser could not read it after folder selection.',
    };
  }
}

export async function parseUsageFiles(files: File[]): Promise<ParsedUsageImport> {
  const events: ParsedUsageEvent[] = [];
  const sourceFiles: ParsedSourceFile[] = [];
  const warnings: string[] = [];
  let scannedFiles = 0;
  let skippedFiles = 0;

  for (const file of files) {
    if (!shouldScanFile(file)) {
      skippedFiles += 1;
      continue;
    }

    scannedFiles += 1;

    const readResult = await readSelectedFile(file);

    if (!readResult.ok) {
      skippedFiles += 1;
      warnings.push(readResult.warning);
      continue;
    }

    const text = readResult.text;
    const fileHash = await sha256Hex(text);
    const parsed = parseJsonLines(text);

    if (parsed.lines.length === 0) {
      skippedFiles += 1;
      continue;
    }

    const kind = fileKind(file);
    const claude = kind === 'codex'
      ? { events: [], warnings: [] }
      : await parseClaudeLines({ file, fileHash, lines: parsed.lines });
    const codex = kind === 'claude'
      ? { events: [], warnings: [] }
      : await parseCodexLines({ file, fileHash, lines: parsed.lines });
    const fileWarnings = [
      ...claude.warnings,
      ...codex.warnings,
      ...(parsed.invalidCount > 0 ? [`Skipped ${parsed.invalidCount} invalid JSON lines.`] : []),
    ];

    warnings.push(...fileWarnings);
    events.push(...claude.events, ...codex.events);

    for (const [source, parsedEvents] of [
      ['claude', claude.events],
      ['codex', codex.events],
    ] as const) {
      if (parsedEvents.length === 0) {
        continue;
      }

      sourceFiles.push({
        source,
        source_file_hash: fileHash,
        source_file_size: file.size,
        line_count: parsed.lineCount,
        parsed_event_count: parsedEvents.length,
        ignored_line_count: Math.max(0, parsed.lineCount - parsedEvents.length),
        warning_count: fileWarnings.length,
        parser_version: PARSER_VERSION,
        metadata: {
          file_kind: kind,
        },
      });
    }
  }

  return {
    events,
    files: sourceFiles,
    warnings: Array.from(new Set(warnings)).slice(0, 200),
    scannedFiles,
    skippedFiles,
  };
}
