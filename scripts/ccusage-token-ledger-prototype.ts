import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openLocalStore } from '../packages/local-core/src/db.js';

type JsonRecord = Record<string, unknown>;

type CcusageCommandResult = {
  ok: boolean;
  args: string[];
  error: string | null;
  json: JsonRecord | null;
};

type TokenTotals = {
  rows: number;
  total_tokens: number;
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cached_input_tokens: number;
  reasoning_output_tokens: number;
  models: string[];
};

type CcusageAgentSummary = {
  agent: string;
  daily: TokenTotals;
  sessions: TokenTotals;
  session_rows: JsonRecord[];
  errors: string[];
};

type DbSession = {
  source: string;
  session_id: string;
  total_tokens: number;
  cost_usd_total: number;
};

type DbLink = {
  source: string;
  session_id: string;
  repo_id: string;
  commit_sha: string;
  linked_tokens: number;
};

type JoinSummary = {
  source: string;
  ccusage_sessions: number;
  ccusage_tokens: number;
  db_sessions: number;
  db_tokens: number;
  exact_matches: number;
  normalized_matches: number;
  matched_ccusage_tokens: number;
  matched_db_tokens: number;
  unmatched_ccusage_sessions: number;
  unmatched_ccusage_tokens: number;
  db_sessions_missing_from_ccusage: number;
  db_tokens_missing_from_ccusage: number;
  tool_sessions: number;
  tool_sessions_matched_to_ccusage: number;
  commit_link_sessions: number;
  commit_link_sessions_matched_to_ccusage: number;
  commit_link_rows: number;
  commit_link_rows_without_ccusage_session: number;
  current_linked_tokens: number;
  projected_linked_tokens_from_ccusage: number;
  projected_linked_tokens_delta: number;
  largest_matched_session_token_deltas: Array<{
    session_id: string;
    ccusage_tokens: number;
    db_tokens: number;
    delta: number;
    match_method: string;
  }>;
  sample_unmatched_ccusage_sessions: Array<{
    session_id: string | null;
    session_file: string | null;
    total_tokens: number;
  }>;
  sample_db_sessions_missing_from_ccusage: Array<{
    session_id: string;
    total_tokens: number;
  }>;
};

const CCUSAGE_AGENTS = [
  'claude',
  'codex',
  'opencode',
  'amp',
  'droid',
  'codebuff',
  'hermes',
  'pi',
  'goose',
  'kilo',
  'copilot',
  'gemini',
  'kimi',
  'qwen',
  'openclaw',
] as const;

const SOURCE_AGENTS = new Set(['claude', 'codex']);
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function runCcusage(args: string[]): CcusageCommandResult {
  const result = spawnSync('pnpm', ['dlx', 'ccusage', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });

  if (result.status !== 0) {
    return {
      ok: false,
      args,
      error: `${result.stderr || result.stdout}`.trim(),
      json: null,
    };
  }

  try {
    return {
      ok: true,
      args,
      error: null,
      json: JSON.parse(result.stdout) as JsonRecord,
    };
  } catch (error) {
    return {
      ok: false,
      args,
      error: `failed to parse ccusage JSON: ${error instanceof Error ? error.message : String(error)}`,
      json: null,
    };
  }
}

function rowsFromReport(json: JsonRecord | null, report: 'daily' | 'session'): JsonRecord[] {
  if (!json) return [];
  const direct = json[report];
  if (Array.isArray(direct)) return direct.filter(isRecord);

  const data = json.data;
  if (Array.isArray(data)) return data.filter(isRecord);

  const sessions = json.sessions;
  if (report === 'session' && Array.isArray(sessions)) return sessions.filter(isRecord);

  const projects = json.projects;
  if (report === 'daily' && isRecord(projects)) {
    return Object.values(projects).flatMap((value) => Array.isArray(value) ? value.filter(isRecord) : []);
  }

  return [];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function modelNamesFromRow(row: JsonRecord): string[] {
  const names = new Set<string>();
  const models = row.models;
  if (Array.isArray(models)) {
    for (const model of models) {
      const value = str(model);
      if (value) names.add(value);
    }
  } else if (isRecord(models)) {
    for (const key of Object.keys(models)) {
      if (key) names.add(key);
    }
  }

  const modelsUsed = row.modelsUsed;
  if (Array.isArray(modelsUsed)) {
    for (const model of modelsUsed) {
      const value = str(model);
      if (value) names.add(value);
    }
  }

  const breakdowns = row.modelBreakdowns;
  if (Array.isArray(breakdowns)) {
    for (const breakdown of breakdowns) {
      if (!isRecord(breakdown)) continue;
      const value = str(breakdown.modelName ?? breakdown.model);
      if (value) names.add(value);
    }
  }

  return Array.from(names).sort();
}

function rowTotalTokens(row: JsonRecord): number {
  const explicitTotal = num(row.totalTokens ?? row.total_tokens);
  if (explicitTotal > 0) return explicitTotal;
  return num(row.inputTokens ?? row.input_tokens)
    + num(row.outputTokens ?? row.output_tokens)
    + num(row.cacheCreationTokens ?? row.cache_creation_tokens)
    + num(row.cacheReadTokens ?? row.cache_read_tokens)
    + num(row.cachedInputTokens ?? row.cached_input_tokens)
    + num(row.reasoningOutputTokens ?? row.reasoning_output_tokens);
}

function rowCost(row: JsonRecord): number {
  return num(row.totalCost ?? row.costUSD ?? row.costUsd ?? row.totalCostUSD);
}

function summarizeRows(rows: JsonRecord[]): TokenTotals {
  const models = new Set<string>();
  const totals = rows.reduce<TokenTotals>((acc, row) => {
    acc.rows += 1;
    acc.total_tokens += rowTotalTokens(row);
    acc.total_cost_usd += rowCost(row);
    acc.input_tokens += num(row.inputTokens ?? row.input_tokens);
    acc.output_tokens += num(row.outputTokens ?? row.output_tokens);
    acc.cache_creation_tokens += num(row.cacheCreationTokens ?? row.cache_creation_tokens);
    acc.cache_read_tokens += num(row.cacheReadTokens ?? row.cache_read_tokens);
    acc.cached_input_tokens += num(row.cachedInputTokens ?? row.cached_input_tokens);
    acc.reasoning_output_tokens += num(row.reasoningOutputTokens ?? row.reasoning_output_tokens);
    for (const model of modelNamesFromRow(row)) models.add(model);
    return acc;
  }, emptyTotals());
  totals.models = Array.from(models).sort();
  return totals;
}

function emptyTotals(): TokenTotals {
  return {
    rows: 0,
    total_tokens: 0,
    total_cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0,
    models: [],
  };
}

function summarizeCcusageAgent(agent: string): CcusageAgentSummary {
  const daily = runCcusage([agent, 'daily', '--json', '--offline']);
  const session = runCcusage([agent, 'session', '--json', '--offline']);
  const dailyRows = rowsFromReport(daily.json, 'daily');
  const sessionRows = rowsFromReport(session.json, 'session');
  return {
    agent,
    daily: summarizeRows(dailyRows),
    sessions: summarizeRows(sessionRows),
    session_rows: sessionRows,
    errors: [daily.error, session.error].filter((error): error is string => Boolean(error)),
  };
}

function dbSourceTotals(
  db: ReturnType<typeof openLocalStore>['db'],
  table: 'usage_events' | 'usage_session_rollups' | 'usage_daily_aggregates',
): Array<Record<string, unknown>> {
  const costExpr = table === 'usage_events' ? '0' : 'COALESCE(SUM(cost_usd_total), 0)';
  return db.prepare(`
    SELECT source,
      COUNT(*) AS rows,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      ${costExpr} AS total_cost_usd
    FROM ${table}
    GROUP BY source
    ORDER BY source
  `).all() as Array<Record<string, unknown>>;
}

function loadDbSessions(db: ReturnType<typeof openLocalStore>['db']): DbSession[] {
  return db.prepare(`
    SELECT source, session_id, total_tokens, cost_usd_total
    FROM usage_session_rollups
  `).all() as DbSession[];
}

function loadDbLinks(db: ReturnType<typeof openLocalStore>['db']): DbLink[] {
  return db.prepare(`
    SELECT source, session_id, repo_id, commit_sha, linked_tokens
    FROM ai_commit_links
  `).all() as DbLink[];
}

function dbComponentTotals(db: ReturnType<typeof openLocalStore>['db']): Array<Record<string, unknown>> {
  return db.prepare(`
    SELECT source,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_create_tokens), 0) AS cache_create_tokens,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
      COALESCE(SUM(total_tokens), 0) AS stored_total_tokens,
      COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens + cached_tokens + reasoning_tokens), 0)
        AS expanded_component_tokens
    FROM usage_events
    GROUP BY source
    ORDER BY source
  `).all() as Array<Record<string, unknown>>;
}

function lowerKey(value: string): string {
  return value.toLowerCase();
}

function addCandidate(candidates: Array<{ key: string; method: string }>, value: unknown, method: string): void {
  const text = str(value);
  if (!text) return;
  candidates.push({ key: lowerKey(text), method });
}

function candidateKeysForCcusageSession(row: JsonRecord): Array<{ key: string; method: string }> {
  const candidates: Array<{ key: string; method: string }> = [];
  addCandidate(candidates, row.sessionId, 'sessionId');
  addCandidate(candidates, row.session_id, 'session_id');
  addCandidate(candidates, row.session, 'session');
  addCandidate(candidates, row.sessionFile, 'sessionFile');

  const searchable = [
    str(row.sessionId),
    str(row.session_id),
    str(row.session),
    str(row.sessionFile),
    str(row.directory),
  ].filter((value): value is string => Boolean(value)).join(' ');
  for (const match of searchable.matchAll(UUID_PATTERN)) {
    candidates.push({ key: lowerKey(match[0]), method: 'extracted_uuid' });
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const id = `${candidate.method}:${candidate.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function setIntersectionCount(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
}

function buildJoinSummary(input: {
  source: string;
  ccusageSessions: JsonRecord[];
  dbSessions: DbSession[];
  toolSessions: Set<string>;
  links: DbLink[];
}): JoinSummary {
  const dbSessionById = new Map(input.dbSessions.map((session) => [lowerKey(session.session_id), session]));
  const dbSessionIds = new Set(dbSessionById.keys());
  const linkSessionIds = new Set(input.links.map((link) => lowerKey(link.session_id)));
  const linkedRowsBySession = new Map<string, number>();
  for (const link of input.links) {
    const key = lowerKey(link.session_id);
    linkedRowsBySession.set(key, (linkedRowsBySession.get(key) ?? 0) + 1);
  }

  const matchedDbIds = new Set<string>();
  const ccusageTokensByDbSession = new Map<string, number>();
  const matchedDeltas: JoinSummary['largest_matched_session_token_deltas'] = [];
  const unmatchedCcusage: JoinSummary['sample_unmatched_ccusage_sessions'] = [];
  let exactMatches = 0;
  let normalizedMatches = 0;
  let matchedCcusageTokens = 0;
  let matchedDbTokens = 0;
  let unmatchedCcusageTokens = 0;

  for (const row of input.ccusageSessions) {
    const candidates = candidateKeysForCcusageSession(row);
    const exact = candidates.find((candidate) => candidate.method === 'sessionId' && dbSessionById.has(candidate.key));
    const normalized = candidates.find((candidate) => candidate.method !== 'sessionId' && dbSessionById.has(candidate.key));
    const match = exact ?? normalized;
    const ccTokens = rowTotalTokens(row);
    if (!match) {
      unmatchedCcusageTokens += ccTokens;
      if (unmatchedCcusage.length < 10) {
        unmatchedCcusage.push({
          session_id: str(row.sessionId ?? row.session_id ?? row.session),
          session_file: str(row.sessionFile),
          total_tokens: ccTokens,
        });
      }
      continue;
    }

    if (match.method === 'sessionId') exactMatches += 1;
    else normalizedMatches += 1;

    const dbSession = dbSessionById.get(match.key);
    if (!dbSession) continue;
    matchedDbIds.add(match.key);
    matchedCcusageTokens += ccTokens;
    matchedDbTokens += dbSession.total_tokens;
    ccusageTokensByDbSession.set(match.key, (ccusageTokensByDbSession.get(match.key) ?? 0) + ccTokens);
    matchedDeltas.push({
      session_id: dbSession.session_id,
      ccusage_tokens: ccTokens,
      db_tokens: dbSession.total_tokens,
      delta: ccTokens - dbSession.total_tokens,
      match_method: match.method,
    });
  }

  const missingDbSessions = input.dbSessions.filter((session) => !matchedDbIds.has(lowerKey(session.session_id)));
  const currentLinkedTokens = input.links.reduce((sum, link) => sum + link.linked_tokens, 0);
  let projectedLinkedTokens = 0;
  let linkRowsWithoutCcusage = 0;
  for (const link of input.links) {
    const sessionKey = lowerKey(link.session_id);
    const ccusageTokens = ccusageTokensByDbSession.get(sessionKey);
    if (ccusageTokens == null) {
      linkRowsWithoutCcusage += 1;
      continue;
    }
    projectedLinkedTokens += Math.round(ccusageTokens / Math.max(1, linkedRowsBySession.get(sessionKey) ?? 1));
  }

  const matchedToolSessions = setIntersectionCount(input.toolSessions, new Set(ccusageTokensByDbSession.keys()));
  const matchedLinkSessions = setIntersectionCount(linkSessionIds, new Set(ccusageTokensByDbSession.keys()));

  return {
    source: input.source,
    ccusage_sessions: input.ccusageSessions.length,
    ccusage_tokens: input.ccusageSessions.reduce((sum, row) => sum + rowTotalTokens(row), 0),
    db_sessions: input.dbSessions.length,
    db_tokens: input.dbSessions.reduce((sum, session) => sum + session.total_tokens, 0),
    exact_matches: exactMatches,
    normalized_matches: normalizedMatches,
    matched_ccusage_tokens: matchedCcusageTokens,
    matched_db_tokens: matchedDbTokens,
    unmatched_ccusage_sessions: input.ccusageSessions.length - exactMatches - normalizedMatches,
    unmatched_ccusage_tokens: unmatchedCcusageTokens,
    db_sessions_missing_from_ccusage: missingDbSessions.length,
    db_tokens_missing_from_ccusage: missingDbSessions.reduce((sum, session) => sum + session.total_tokens, 0),
    tool_sessions: input.toolSessions.size,
    tool_sessions_matched_to_ccusage: matchedToolSessions,
    commit_link_sessions: linkSessionIds.size,
    commit_link_sessions_matched_to_ccusage: matchedLinkSessions,
    commit_link_rows: input.links.length,
    commit_link_rows_without_ccusage_session: linkRowsWithoutCcusage,
    current_linked_tokens: currentLinkedTokens,
    projected_linked_tokens_from_ccusage: projectedLinkedTokens,
    projected_linked_tokens_delta: projectedLinkedTokens - currentLinkedTokens,
    largest_matched_session_token_deltas: matchedDeltas
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 10),
    sample_unmatched_ccusage_sessions: unmatchedCcusage,
    sample_db_sessions_missing_from_ccusage: missingDbSessions
      .sort((a, b) => b.total_tokens - a.total_tokens)
      .slice(0, 10)
      .map((session) => ({ session_id: session.session_id, total_tokens: session.total_tokens })),
  };
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function markdownReport(report: JsonRecord): string {
  const agentSummaries = report.ccusage_agents as Record<string, CcusageAgentSummary>;
  const joins = report.join_analysis as JoinSummary[];
  const db = report.database as JsonRecord;
  const all = report.ccusage_all_daily as TokenTotals;
  const lines: string[] = [];
  lines.push('# ccusage Token Ledger Prototype');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Database: \`${db.database_path}\``);
  lines.push(`ccusage version: \`${report.ccusage_version}\``);
  lines.push('');
  lines.push('## Token Totals');
  lines.push('');
  lines.push(`ccusage all agents: **${formatNumber(all.total_tokens)} tokens**, **${formatUsd(all.total_cost_usd)}**`);
  lines.push('');
  lines.push('| Source | ccusage session tokens | DB session tokens | Delta | ccusage sessions | DB sessions |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const join of joins) {
    lines.push([
      join.source,
      formatNumber(join.ccusage_tokens),
      formatNumber(join.db_tokens),
      formatNumber(join.ccusage_tokens - join.db_tokens),
      formatNumber(join.ccusage_sessions),
      formatNumber(join.db_sessions),
    ].join(' | '));
  }
  lines.push('');
  lines.push('## Additional ccusage Agent Coverage');
  lines.push('');
  lines.push('| Agent | Daily rows | Session rows | Tokens | Cost | Models |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const agent of Object.values(agentSummaries).sort((a, b) => b.sessions.total_tokens - a.sessions.total_tokens)) {
    if (SOURCE_AGENTS.has(agent.agent) || agent.sessions.total_tokens === 0) continue;
    lines.push([
      agent.agent,
      formatNumber(agent.daily.rows),
      formatNumber(agent.sessions.rows),
      formatNumber(agent.sessions.total_tokens),
      formatUsd(agent.sessions.total_cost_usd),
      formatNumber(agent.sessions.models.length),
    ].join(' | '));
  }
  lines.push('');
  lines.push('## Session Join And Attribution Impact');
  lines.push('');
  lines.push('| Source | Exact matches | Normalized matches | Unmatched ccusage sessions | DB sessions missing | Tool sessions matched | Commit-link sessions matched | Current linked tokens | Projected ccusage linked tokens | Delta |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const join of joins) {
    lines.push([
      join.source,
      formatNumber(join.exact_matches),
      formatNumber(join.normalized_matches),
      formatNumber(join.unmatched_ccusage_sessions),
      formatNumber(join.db_sessions_missing_from_ccusage),
      `${formatNumber(join.tool_sessions_matched_to_ccusage)} / ${formatNumber(join.tool_sessions)}`,
      `${formatNumber(join.commit_link_sessions_matched_to_ccusage)} / ${formatNumber(join.commit_link_sessions)}`,
      formatNumber(join.current_linked_tokens),
      formatNumber(join.projected_linked_tokens_from_ccusage),
      formatNumber(join.projected_linked_tokens_delta),
    ].join(' | '));
  }
  lines.push('');
  lines.push('## Current DB Token Component Semantics');
  lines.push('');
  lines.push('| Source | Stored total | Input | Cached | Reasoning | Expanded component sum |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const row of db.component_totals_by_source as Array<Record<string, unknown>>) {
    lines.push([
      row.source,
      formatNumber(num(row.stored_total_tokens)),
      formatNumber(num(row.input_tokens)),
      formatNumber(num(row.cached_tokens)),
      formatNumber(num(row.reasoning_tokens)),
      formatNumber(num(row.expanded_component_tokens)),
    ].join(' | '));
  }
  lines.push('');
  lines.push('Note: Codex token component names are not directly comparable between the current DB and ccusage. ccusage reports cached input separately and uses its own normalized total; the current DB stores Codex `total_tokens` from our parser rollup semantics.');
  lines.push('');
  lines.push('## Largest Matched Session Deltas');
  for (const join of joins) {
    lines.push('');
    lines.push(`### ${join.source}`);
    lines.push('| Session | ccusage | DB | Delta | Match |');
    lines.push('| --- | ---: | ---: | ---: | --- |');
    for (const delta of join.largest_matched_session_token_deltas.slice(0, 5)) {
      lines.push([
        `\`${delta.session_id}\``,
        formatNumber(delta.ccusage_tokens),
        formatNumber(delta.db_tokens),
        formatNumber(delta.delta),
        delta.match_method,
      ].join(' | '));
    }
  }
  lines.push('');
  lines.push('## Prototype Interpretation');
  lines.push('');
  lines.push('- Use ccusage as the token/session/model/cost source of truth only if session ids can be normalized into the attribution session ids.');
  lines.push('- Keep the raw TokensRank scanner for tool events, cwd, commit SHAs, repo mapping, and production-branch verification.');
  lines.push('- Claude exact session joins validate the basic model; Codex requires UUID extraction from ccusage session file names.');
  lines.push('- Extra agents found by ccusage can enter usage/cost charts immediately, but not the AI-code funnel until we add direct commit evidence scanners for those agents.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main(): void {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log([
      'Usage: pnpm exec tsx scripts/ccusage-token-ledger-prototype.ts',
      '',
      'Runs ccusage as the token/session/model/cost source of truth, compares it',
      'against the current local TokensRank SQLite database, and writes:',
      '  test-results/ccusage-token-ledger-prototype.json',
      '  test-results/ccusage-token-ledger-prototype.md',
      '',
      'This script is read-only with respect to the local SQLite database.',
    ].join('\n'));
    return;
  }

  const generatedAt = new Date().toISOString();
  const version = spawnSync('pnpm', ['dlx', 'ccusage', '--version'], { encoding: 'utf8' }).stdout.trim();
  const allDaily = runCcusage(['daily', '--json', '--offline']);
  const allDailyRows = rowsFromReport(allDaily.json, 'daily');
  const ccusageAllDaily = summarizeRows(allDailyRows);
  if (allDaily.json && isRecord(allDaily.json.totals)) {
    ccusageAllDaily.total_tokens = num(allDaily.json.totals.totalTokens);
    ccusageAllDaily.total_cost_usd = num(allDaily.json.totals.totalCost ?? allDaily.json.totals.costUSD);
  }

  const ccusageAgents = Object.fromEntries(CCUSAGE_AGENTS.map((agent) => [agent, summarizeCcusageAgent(agent)]));

  const store = openLocalStore();
  const db = store.db;
  const dbSessions = loadDbSessions(db);
  const dbLinks = loadDbLinks(db);
  const toolRows = db.prepare(`
    SELECT source, session_id
    FROM ai_tool_events
    GROUP BY source, session_id
  `).all() as Array<{ source: string; session_id: string }>;
  const toolSessionsBySource = new Map<string, Set<string>>();
  for (const row of toolRows) {
    const set = toolSessionsBySource.get(row.source) ?? new Set<string>();
    set.add(lowerKey(row.session_id));
    toolSessionsBySource.set(row.source, set);
  }

  const tableCounts = Object.fromEntries([
    'source_files',
    'usage_events',
    'usage_daily_aggregates',
    'usage_session_rollups',
    'ai_tool_events',
    'ai_commit_links',
    'local_repos',
    'local_commits',
    'github_code_daily',
    'ai_linked_code_daily',
    'model_pricing',
  ].map((table) => [
    table,
    (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
  ]));

  const joinAnalysis = ['claude', 'codex'].map((source) => buildJoinSummary({
    source,
    ccusageSessions: ccusageAgents[source].session_rows,
    dbSessions: dbSessions.filter((session) => session.source === source),
    toolSessions: toolSessionsBySource.get(source) ?? new Set<string>(),
    links: dbLinks.filter((link) => link.source === source),
  }));

  const report = {
    generated_at: generatedAt,
    ccusage_version: version,
    ccusage_all_daily: ccusageAllDaily,
    ccusage_agents: ccusageAgents,
    database: {
      database_path: store.databasePath,
      table_counts: tableCounts,
      usage_events_by_source: dbSourceTotals(db, 'usage_events'),
      usage_session_rollups_by_source: dbSourceTotals(db, 'usage_session_rollups'),
      usage_daily_aggregates_by_source: dbSourceTotals(db, 'usage_daily_aggregates'),
      component_totals_by_source: dbComponentTotals(db),
    },
    join_analysis: joinAnalysis,
    ccusage_errors: [
      allDaily.error,
      ...Object.values(ccusageAgents).flatMap((agent) => agent.errors.map((error) => `${agent.agent}: ${error}`)),
    ].filter((error): error is string => Boolean(error)),
  };

  store.close();

  mkdirSync('test-results', { recursive: true });
  const jsonPath = join('test-results', 'ccusage-token-ledger-prototype.json');
  const mdPath = join('test-results', 'ccusage-token-ledger-prototype.md');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(mdPath, markdownReport(report as JsonRecord));
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

main();
