import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import Database from 'better-sqlite3';
import type { UsageImportProvider, UsageImportSource } from '@tokensrank/shared';

import type { LocalDatabase } from './db.js';
import { nowIso, writeSyncState } from './db.js';
import type { LocalCoreOptions } from './types.js';
import type { PricingMap } from './cost.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;

export const SUPPORTED_CCUSAGE_SOURCES = ['claude', 'codex', 'opencode'] as const;
export type CcusageSource = typeof SUPPORTED_CCUSAGE_SOURCES[number];

type JsonRecord = Record<string, unknown>;

type TokenComponents = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
};

export type CcusageSessionRollup = TokenComponents & {
  source: CcusageSource;
  provider: UsageImportProvider;
  session_id: string;
  model: string;
  first_event_at: string;
  last_event_at: string;
  turns: number;
  cost_usd_total: number;
  ccusage_version: string;
  missing_price?: boolean;
};

export type CcusageSessionModelRollup = CcusageSessionRollup;
export type CcusageDailyRollup = TokenComponents & {
  date: string;
  source: CcusageSource;
  provider: UsageImportProvider;
  model: string;
  cost_usd_total: number;
  missing_price?: boolean;
};

export type CcusageReadResult = {
  version: string;
  sessions: CcusageSessionRollup[];
  modelSessions: CcusageSessionModelRollup[];
  warnings: string[];
  failedSources?: CcusageSource[];
  daily?: CcusageDailyRollup[];
  eventDateSources?: CcusageSource[];
};

export type CcusageRunner = (source: CcusageSource, args: string[]) => Promise<unknown>;

export type CcusageReadOptions = LocalCoreOptions & {
  runner?: CcusageRunner;
  pricing?: PricingMap;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function stringAt(record: unknown, keys: string[]): string | null {
  if (!isRecord(record)) return null;
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return null;
}

function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return 0;
}

function intValue(value: unknown): number {
  return Math.trunc(numberValue(value));
}

function providerForSource(source: CcusageSource): UsageImportProvider {
  if (source === 'claude') return 'anthropic';
  if (source === 'codex') return 'openai';
  return 'unknown';
}

function resolveCcusageCliPath(): string {
  const packagePath = require.resolve('ccusage/package.json');
  const packageJson = require(packagePath) as { bin?: { ccusage?: string }; version?: string };
  const binPath = packageJson.bin?.ccusage ?? './dist/cli.js';
  return path.join(path.dirname(packagePath), binPath);
}

function ccusagePackageVersion(): string {
  const packagePath = require.resolve('ccusage/package.json');
  const packageJson = require(packagePath) as { version?: string };
  return packageJson.version ?? 'unknown';
}

async function defaultCcusageRunner(source: CcusageSource, args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [resolveCcusageCliPath(), source, ...args],
    { maxBuffer: 256 * 1024 * 1024, timeout: 120_000 },
  );
  return JSON.parse(stdout) as unknown;
}

function sessionRowsFromPayload(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  const candidates = [payload.sessions, payload.data, payload.session];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

function isoFromCcusageDate(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00:00.000Z` : value;
  const date = new Date(dateOnly);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function canonicalSessionId(source: CcusageSource, raw: string): string {
  if (source !== 'codex') return raw;
  const uuid = raw.match(UUID_RE)?.[0];
  return uuid ? uuid.toLowerCase() : raw;
}

function componentsFromRecord(row: JsonRecord): TokenComponents {
  const input = intValue(row.inputTokens ?? row.input_tokens);
  const output = intValue(row.outputTokens ?? row.output_tokens);
  const cacheRead = intValue(row.cacheReadTokens ?? row.cacheReadInputTokens ?? row.cache_read_tokens);
  const cacheCreate = intValue(row.cacheCreationTokens ?? row.cacheCreateTokens ?? row.cache_create_tokens);
  const cached = intValue(row.cachedInputTokens ?? row.cachedTokens ?? row.cached_tokens);
  const reasoning = intValue(row.reasoningOutputTokens ?? row.reasoningTokens ?? row.reasoning_tokens);
  const explicitTotal = intValue(row.totalTokens ?? row.total_tokens);
  // ccusage returns fresh input separately from cached input. Reasoning is a
  // subset of output, so it must never be added again when total is absent.
  const additiveTotal = input + output + cacheRead + cacheCreate + cached;
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_create_tokens: cacheCreate,
    cached_tokens: cached,
    reasoning_tokens: reasoning,
    total_tokens: explicitTotal > 0 ? explicitTotal : additiveTotal,
  };
}

function modelNameFromBreakdown(row: JsonRecord): string {
  return stringAt(row, ['modelName', 'model', 'model_id', 'name']) ?? 'unknown';
}

function modelBreakdownsFromSession(
  source: CcusageSource,
  row: JsonRecord,
  session: CcusageSessionRollup,
  warnings: string[],
): CcusageSessionModelRollup[] {
  const breakdowns: CcusageSessionModelRollup[] = [];

  if (Array.isArray(row.modelBreakdowns)) {
    for (const value of row.modelBreakdowns) {
      if (!isRecord(value)) continue;
      const model = modelNameFromBreakdown(value);
      const tokens = componentsFromRecord(value);
      breakdowns.push({
        ...session,
        ...tokens,
        model,
        cost_usd_total: numberValue(value.cost ?? value.totalCost ?? value.costUSD),
        missing_price: typeof (value.cost ?? value.totalCost ?? value.costUSD) !== 'number',
      });
    }
  }

  if (isRecord(row.models)) {
    const modelEntries = Object.entries(row.models).filter(([, value]) => isRecord(value)) as Array<[string, JsonRecord]>;
    modelEntries.forEach(([model, value]) => {
      const tokens = componentsFromRecord(value);
      const explicitCost = numberValue(value.cost ?? value.totalCost ?? value.costUSD);
      breakdowns.push({
        ...session,
        ...tokens,
        model,
        cost_usd_total: explicitCost,
        missing_price: typeof (value.cost ?? value.totalCost ?? value.costUSD) !== 'number',
      });
    });
  }

  if (breakdowns.length > 0) return breakdowns;

  const modelsUsed = Array.isArray(row.modelsUsed)
    ? row.modelsUsed.map((model) => stringValue(model)).filter((model): model is string => Boolean(model))
    : [];
  if (modelsUsed.length === 1) {
    return [{ ...session, model: modelsUsed[0]! }];
  }

  if (source === 'opencode' && modelsUsed.length > 1) {
    warnings.push(`${source}: session ${session.session_id} lists multiple models but ccusage did not provide per-model token splits`);
    return [{
      ...session,
      model: 'unknown',
    }];
  }

  return [{ ...session }];
}

function topModel(modelRows: CcusageSessionModelRollup[]): string {
  return modelRows
    .slice()
    .sort((a, b) => b.total_tokens - a.total_tokens)[0]?.model ?? 'unknown';
}

function resolveHomeDir(options: LocalCoreOptions): string {
  return options.homeDir ?? process.env.HOME ?? os.homedir();
}

function openCodeSessionTimes(options: LocalCoreOptions): Map<string, { first: string; last: string }> {
  const dbPath = path.join(resolveHomeDir(options), '.local', 'share', 'opencode', 'opencode.db');
  if (!existsSync(dbPath)) return new Map();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`
      SELECT id, time_created, time_updated
      FROM session
    `).all() as Array<{ id: string; time_created: number; time_updated: number }>;
    const map = new Map<string, { first: string; last: string }>();
    for (const row of rows) {
      if (!row.id) continue;
      const first = new Date(row.time_created).toISOString();
      const last = new Date(row.time_updated).toISOString();
      map.set(row.id, { first, last });
    }
    return map;
  } finally {
    db.close();
  }
}

function openCodeDailyBreakdowns(options: CcusageReadOptions): Map<string, JsonRecord[]> {
  const dbPath = path.join(resolveHomeDir(options), '.local', 'share', 'opencode', 'opencode.db');
  if (!existsSync(dbPath)) return new Map();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // Read only counters and identifiers. Message contents never enter this reader.
    const rows = db.prepare(`SELECT
      date(json_extract(data,'$.time.created') / 1000, 'unixepoch') AS date,
      coalesce(json_extract(data,'$.modelID'),'unknown') AS modelName,
      CASE WHEN count(DISTINCT json_extract(data,'$.providerID'))=1
        THEN max(json_extract(data,'$.providerID')) ELSE 'unknown' END AS recordedProvider,
      sum(coalesce(json_extract(data,'$.tokens.input'),0)) AS inputTokens,
      sum(coalesce(json_extract(data,'$.tokens.output'),0)) AS outputTokens,
      sum(coalesce(json_extract(data,'$.tokens.reasoning'),0)) AS reasoningOutputTokens,
      sum(coalesce(json_extract(data,'$.tokens.cache.read'),0)) AS cacheReadTokens,
      sum(coalesce(json_extract(data,'$.tokens.cache.write'),0)) AS cacheCreationTokens
      FROM message WHERE json_valid(data) AND json_extract(data,'$.role')='assistant'
      GROUP BY date, modelName ORDER BY date, modelName`).all() as JsonRecord[];
    const grouped = new Map<string, JsonRecord[]>();
    for (const row of rows) {
      if (typeof row.date !== 'string') continue;
      grouped.set(row.date, [...(grouped.get(row.date) ?? []), row]);
    }
    return grouped;
  } finally { db.close(); }
}

export function dailyRowsFromPayload(source: CcusageSource, payload: unknown, options: CcusageReadOptions = {}): CcusageDailyRollup[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.daily)) return null;
  const openCode = source === 'opencode' ? openCodeDailyBreakdowns(options) : new Map<string, JsonRecord[]>();
  return payload.daily.flatMap((row: unknown) => {
    if (!isRecord(row) || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)
      || !Number.isFinite(Date.parse(`${row.date}T00:00:00Z`))
      || new Date(`${row.date}T00:00:00Z`).toISOString().slice(0,10)!==row.date) {
      throw new Error(`${source}: daily report contains an invalid UTC date`);
    }
    const dayTokens = componentsFromRecord(row);
    let parts: JsonRecord[] = Array.isArray(row.modelBreakdowns) ? row.modelBreakdowns.filter(isRecord)
      : isRecord(row.models) ? Object.entries(row.models).filter(([,v])=>isRecord(v)).map(([model,v])=>({...v as JsonRecord,modelName:model})) : [];
    if (!parts.length && source === 'opencode') {
      const candidates = openCode.get(row.date) ?? [];
      // Concurrent writes or an unsupported source format must not invent a split.
      if (candidates.reduce((n,p)=>n+componentsFromRecord(p).total_tokens,0) === dayTokens.total_tokens) parts = candidates;
    }
    if (!parts.length) {
      const names = Array.isArray(row.modelsUsed) ? row.modelsUsed : [];
      parts = [{...row, modelName:names.length===1 ? names[0] : 'unknown'}];
    }
    const components = parts.map(componentsFromRecord);
    if (components.reduce((n,p)=>n+p.total_tokens,0) !== dayTokens.total_tokens) {
      throw new Error(`${source}: model totals do not reconcile with the daily total`);
    }
    if (parts.some(part=>{
      const output=part.outputTokens??part.output_tokens;
      return output===undefined || output===null || !Number.isFinite(Number(output)) || Number(output)<0;
    })) throw new Error(`${source}: daily report does not provide a valid output counter`);
    const estimates = parts.map((p,i) => {
      const provider=source==='opencode' ? p.recordedProvider : providerForSource(source);
      const rate=options.pricing?.get(`${provider}:${modelNameFromBreakdown(p)}`);
      const c=components[i]!;
      const pricedParts=[[c.input_tokens,rate?.input],[c.output_tokens,rate?.output],
        [c.cache_read_tokens+c.cached_tokens,rate?.cache_read],[c.cache_create_tokens,rate?.cache_write]] as const;
      const matched=pricedParts.reduce((n,[count])=>n+count,0)===c.total_tokens
        && pricedParts.every(([count,price])=>count===0 || (typeof price==='number'&&Number.isFinite(price)));
      return {matched,costUsd:matched?pricedParts.reduce((n,[count,price])=>n+count*(price??0)/1_000_000,0):0};
    });
    return parts.map((p,i)=>{
      const recordedCost = p.cost ?? p.totalCost ?? p.costUSD;
      const hasCost = typeof recordedCost === 'number' && Number.isFinite(recordedCost);
      const provider:UsageImportProvider=source==='opencode' && (p.recordedProvider==='openai'||p.recordedProvider==='anthropic')?p.recordedProvider:providerForSource(source);
      return {date:row.date as string,source,provider,model:modelNameFromBreakdown(p),...components[i]!,
        // Never spread a combined dollar total between models using token shares.
        // Either use the reader's model estimate or multiply counters by known rates.
        cost_usd_total:hasCost ? numberValue(recordedCost) : estimates[i]!.costUsd,
        missing_price:!hasCost && !estimates[i]!.matched,
      };
    }).filter(r=>r.total_tokens>0);
  });
}

export async function readCcusageUsage(options: CcusageReadOptions = {}): Promise<CcusageReadResult> {
  const runner = options.runner ?? defaultCcusageRunner;
  const version = ccusagePackageVersion();
  const warnings: string[] = [];
  const failedSources: CcusageSource[] = [];
  const sessions: CcusageSessionRollup[] = [];
  const modelSessions: CcusageSessionModelRollup[] = [];
  const daily: CcusageDailyRollup[] = [];
  const eventDateSources: CcusageSource[] = [];
  const opencodeTimes = openCodeSessionTimes(options);

  for (const source of SUPPORTED_CCUSAGE_SOURCES) {
    let payload: unknown;
    try {
      payload = await runner(source, ['session', '--json']);
      const report = await runner(source, ['daily', '--json', '--timezone', 'UTC']);
      const dayRows = dailyRowsFromPayload(source, report, options);
      if (dayRows) { daily.push(...dayRows); eventDateSources.push(source); }
    } catch (error) {
      failedSources.push(source);
      warnings.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    for (const row of sessionRowsFromPayload(payload)) {
      const rawSessionId = stringAt(row, ['sessionId', 'session_id', 'session', 'sessionFile']);
      if (!rawSessionId) {
        warnings.push(`${source}: skipped ccusage session without session_id`);
        continue;
      }

      const sessionId = canonicalSessionId(source, rawSessionId);
      const fallbackNow = nowIso();
      const opencodeTime = source === 'opencode' ? opencodeTimes.get(sessionId) : undefined;
      const lastEventAt = opencodeTime?.last ?? isoFromCcusageDate(stringAt(row, ['lastActivity', 'last_activity', 'updatedAt']), fallbackNow);
      const firstEventAt = opencodeTime?.first ?? isoFromCcusageDate(stringAt(row, ['firstActivity', 'first_activity', 'createdAt']), lastEventAt);
      const tokens = componentsFromRecord(row);
      const session: CcusageSessionRollup = {
        source,
        provider: providerForSource(source),
        session_id: sessionId,
        model: 'unknown',
        first_event_at: firstEventAt,
        last_event_at: lastEventAt,
        ...tokens,
        turns: intValue(row.turns ?? row.messages ?? row.requests),
        cost_usd_total: numberValue(row.totalCost ?? row.costUSD ?? row.cost),
        missing_price: typeof (row.totalCost ?? row.costUSD ?? row.cost) !== 'number',
        ccusage_version: version,
      };

      const models = modelBreakdownsFromSession(source, row, session, warnings);
      session.model = topModel(models);
      sessions.push(session);
      modelSessions.push(...models);
    }
  }

  return { version, sessions, modelSessions, warnings, failedSources, daily, eventDateSources };
}

export function writeCcusageRollups(db: LocalDatabase, result: CcusageReadResult): number {
  const now = nowIso();
  const write = db.transaction(() => {
    // A temporarily unreadable source must retain its last successful snapshot.
    for (const source of SUPPORTED_CCUSAGE_SOURCES) {
      if (result.failedSources?.includes(source)) continue;
      db.prepare('DELETE FROM usage_session_rollups WHERE source = ?').run(source);
      db.prepare('DELETE FROM usage_session_model_rollups WHERE source = ?').run(source);
      db.prepare('DELETE FROM usage_daily_aggregates WHERE source = ?').run(source);
    }

    const sessionStmt = db.prepare(`
      INSERT INTO usage_session_rollups (
        source, provider, session_id, model, first_event_at, last_event_at,
        input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
        cached_tokens, reasoning_tokens, total_tokens, turns, cost_usd_total,
        source_file_hashes_json, ccusage_version, updated_at
      )
      VALUES (
        @source, @provider, @session_id, @model, @first_event_at, @last_event_at,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_create_tokens,
        @cached_tokens, @reasoning_tokens, @total_tokens, @turns, @cost_usd_total,
        '[]', @ccusage_version, @updated_at
      )
    `);

    const modelStmt = db.prepare(`
      INSERT INTO usage_session_model_rollups (
        source, provider, session_id, model, first_event_at, last_event_at,
        input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
        cached_tokens, reasoning_tokens, total_tokens, turns, cost_usd_total,
        ccusage_version, updated_at
      )
      VALUES (
        @source, @provider, @session_id, @model, @first_event_at, @last_event_at,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_create_tokens,
        @cached_tokens, @reasoning_tokens, @total_tokens, @turns, @cost_usd_total,
        @ccusage_version, @updated_at
      )
    `);

    for (const session of result.sessions) {
      sessionStmt.run({ ...session, updated_at: now });
    }
    for (const modelSession of result.modelSessions) {
      modelStmt.run({
        ...modelSession,
        cost_usd_total: Math.round(modelSession.cost_usd_total * 10000) / 10000,
        updated_at: now,
      });
    }

    const dailyStmt = db.prepare(`
      INSERT INTO usage_daily_aggregates (
        date, source, provider, model, total_tokens, input_tokens, output_tokens,
        cache_read_tokens, cache_create_tokens, cached_tokens, reasoning_tokens,
        total_sessions, event_count, cost_usd_total, updated_at
      )
      SELECT
        substr(last_event_at, 1, 10) AS date,
        source,
        provider,
        model,
        SUM(total_tokens) AS total_tokens,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_create_tokens) AS cache_create_tokens,
        SUM(cached_tokens) AS cached_tokens,
        SUM(reasoning_tokens) AS reasoning_tokens,
        COUNT(DISTINCT source || ':' || session_id) AS total_sessions,
        SUM(CASE WHEN turns > 0 THEN turns ELSE 1 END) AS event_count,
        SUM(cost_usd_total) AS cost_usd_total,
        ? AS updated_at
      FROM usage_session_model_rollups WHERE source = ?
      GROUP BY substr(last_event_at, 1, 10), source, provider, model
    `);
    const eventDailyStmt = db.prepare(`INSERT INTO usage_daily_aggregates (
      date,source,provider,model,total_tokens,input_tokens,output_tokens,cache_read_tokens,
      cache_create_tokens,cached_tokens,reasoning_tokens,total_sessions,event_count,cost_usd_total,updated_at
    ) VALUES (@date,@source,@provider,@model,@total_tokens,@input_tokens,@output_tokens,@cache_read_tokens,
      @cache_create_tokens,@cached_tokens,@reasoning_tokens,0,0,@cost_usd_total,@updated_at)`);
    for (const source of SUPPORTED_CCUSAGE_SOURCES) {
      if (result.failedSources?.includes(source)) continue;
      const eventDates = result.eventDateSources?.includes(source) ?? false;
      if (eventDates) {
        for (const row of result.daily?.filter(r=>r.source===source) ?? []) eventDailyStmt.run({...row,updated_at:now});
      } else dailyStmt.run(now,source);
      const priceRows=eventDates ? result.daily??[] : result.modelSessions;
      writeSyncState(db,`usage_unpriced_models_${source}`,[...new Set(priceRows.filter(r=>r.source===source&&r.missing_price).map(r=>r.model))]);
      db.prepare(`INSERT INTO usage_source_evidence(source,daily_basis,read_at) VALUES(?,?,?)
        ON CONFLICT(source) DO UPDATE SET daily_basis=excluded.daily_basis,read_at=excluded.read_at`)
        .run(source,eventDates?'event_dates':'session_dates',now);
    }
  });

  write();
  return result.modelSessions.length;
}
