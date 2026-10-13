import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import Database from 'better-sqlite3';

import { discoverUsageFiles } from '../packages/local-core/src/discovery.js';
import { sha256Hex } from '../packages/local-core/src/hash.js';
import { resolveDatabasePath } from '../packages/local-core/src/paths.js';

type Source = 'claude' | 'codex' | 'opencode';
type CommandKind = 'git_commit' | 'git_inspection' | 'git_other' | 'shell_other' | 'unknown_command';

type JsonRecord = Record<string, unknown>;

type Repo = {
  id: string;
  localRoot: string;
  fullName: string | null;
  prodBranch: string | null;
  shas: Set<string>;
};

type RepoAlias = {
  repoId: string;
  localRoot: string;
};

type RawEvidence = {
  source: Source;
  sessionId: string;
  eventAt: string;
  toolName: string | null;
  commandKind: CommandKind;
  cwd: string | null;
  model: string;
  provider: string;
  modelSource: 'explicit' | 'session_context' | 'unknown';
  commitSha: string;
  origin: string;
};

type ResolvedEvidence = RawEvidence & {
  repoId: string;
  repoFullName: string | null;
  resolvedSha: string;
};

type CurrentEvidenceRow = {
  source: Source;
  session_id: string;
  repo_id: string | null;
  commit_sha: string;
  confidence: number;
};

type CurrentLinkRow = {
  source: Source;
  session_id: string;
  repo_id: string;
  commit_sha: string;
  linked_tokens: number;
};

type ResolveResult =
  | { ok: true; repo: Repo; sha: string }
  | { ok: false; reason: 'no_repo' | 'not_found' | 'ambiguous' };

type ToolContext = {
  toolName: string | null;
  command: string | null;
  cwd: string | null;
  model: string;
  provider: string;
  modelSource: 'explicit' | 'session_context' | 'unknown';
};

type UnresolvedSummary = {
  by_reason: Record<string, number>;
  by_source: Record<string, number>;
  by_source_reason: Record<string, number>;
};

const COMMIT_SHA_RE = /\b[0-9a-f]{7,40}\b/giu;
const GIT_COMMIT_RE =
  /(?:^|[;&|\n]\s*)(?:env\s+[^;&|\n]*\s+)?git(?:\s+(?:-C|-c|--git-dir|--work-tree)\s+(?:"[^"]+"|'[^']+'|\S+))*\s+commit(?:\s|$)/iu;
const GIT_INSPECTION_RE =
  /(?:^|[;&|\n]\s*)git(?:\s+(?:-C|-c|--git-dir|--work-tree)\s+(?:"[^"]+"|'[^']+'|\S+))*\s+(?:log|show|diff|rev-list|reflog|status|branch|merge-base|cat-file)(?:\s|$)/iu;
const GIT_ANY_RE = /(?:^|[;&|\n]\s*)git(?:\s|$)/iu;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function safeJsonParse(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function timestampFor(record: unknown, fallbackMs: number): string {
  const raw = stringAt(record, [
    'timestamp',
    'created_at',
    'createdAt',
    'time',
    'message.created_at',
    'message.createdAt',
  ]);
  if (!raw) return new Date(fallbackMs).toISOString();
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? new Date(fallbackMs).toISOString() : date.toISOString();
}

function classifyCommand(command: string | null): CommandKind {
  if (!command) return 'unknown_command';
  if (GIT_COMMIT_RE.test(command)) return 'git_commit';
  if (GIT_INSPECTION_RE.test(command)) return 'git_inspection';
  if (GIT_ANY_RE.test(command)) return 'git_other';
  return 'shell_other';
}

function isShellTool(toolName: string | null): boolean {
  const normalized = (toolName ?? '').toLowerCase();
  return ['bash', 'shell', 'exec_command', 'terminal', 'command'].includes(normalized);
}

function commitShasFromValue(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const matches = text.match(COMMIT_SHA_RE) ?? [];
  return Array.from(new Set(matches
    .map((match) => match.toLowerCase())
    .filter((match) => /[a-f]/u.test(match))));
}

function extractCommand(value: unknown): string | null {
  const parsed = safeJsonParse(value);
  if (!isRecord(parsed)) return null;
  return stringAt(parsed, [
    'cmd',
    'command',
    'shell',
    'input.cmd',
    'input.command',
    'arguments.cmd',
    'arguments.command',
  ]);
}

function normalizeFsPath(value: string): string {
  const normalized = value.replace(/\\/gu, '/').replace(/\/+$/u, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function evidenceKey(evidence: Pick<ResolvedEvidence, 'source' | 'sessionId' | 'repoId' | 'resolvedSha'>): string {
  return `${evidence.source}:${evidence.sessionId}:${evidence.repoId}:${evidence.resolvedSha.toLowerCase()}`;
}

function currentKey(row: CurrentLinkRow | (CurrentEvidenceRow & { repo_id: string; resolved_sha?: string })): string {
  const sha = 'resolved_sha' in row && row.resolved_sha ? row.resolved_sha : row.commit_sha;
  return `${row.source}:${row.session_id}:${row.repo_id}:${sha.toLowerCase()}`;
}

function compactSessionId(sessionId: string): string {
  return sha256Hex(sessionId).slice(0, 12);
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function mapCount<T>(rows: T[], keyFn: (row: T) => string): Record<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = keyFn(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b)));
}

function sourceFromComparisonKey(key: string): string {
  return key.split(':', 1)[0] ?? 'unknown';
}

function uniqueByKey<T>(rows: T[], keyFn: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = keyFn(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function listRepoShas(repoRoot: string): Set<string> {
  try {
    const stdout = execFileSync('git', ['-C', repoRoot, 'rev-list', '--all'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set(stdout
      .split('\n')
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean));
  } catch {
    return new Set();
  }
}

function loadRepos(db: Database.Database): { repos: Repo[]; aliases: RepoAlias[] } {
  const repoRows = db.prepare(`
    SELECT id, local_root, full_name, prod_branch
    FROM local_repos
    WHERE selected = 1
      AND local_root NOT LIKE '%/.worktrees/%'
      AND local_root NOT LIKE '%\\.worktrees\\%'
    ORDER BY full_name ASC, local_root ASC
  `).all() as Array<{ id: string; local_root: string; full_name: string | null; prod_branch: string | null }>;

  const repos = repoRows.map((row) => ({
    id: row.id,
    localRoot: row.local_root,
    fullName: row.full_name,
    prodBranch: row.prod_branch,
    shas: listRepoShas(row.local_root),
  }));
  const selectedIds = new Set(repos.map((repo) => repo.id));

  const aliasRows = db.prepare(`
    SELECT repo_id, local_root
    FROM local_repo_roots
    ORDER BY LENGTH(local_root) DESC
  `).all() as Array<{ repo_id: string; local_root: string }>;

  const aliases = aliasRows
    .filter((row) => selectedIds.has(row.repo_id))
    .map((row) => ({ repoId: row.repo_id, localRoot: row.local_root }));

  for (const repo of repos) {
    aliases.push({ repoId: repo.id, localRoot: repo.localRoot });
  }

  return {
    repos,
    aliases: uniqueByKey(aliases, (alias) => `${alias.repoId}:${normalizeFsPath(alias.localRoot)}`)
      .sort((a, b) => b.localRoot.length - a.localRoot.length),
  };
}

function repoIdForCwd(cwd: string | null, aliases: RepoAlias[]): string | null {
  if (!cwd) return null;
  const normalizedCwd = normalizeFsPath(cwd);
  for (const alias of aliases) {
    const root = normalizeFsPath(alias.localRoot);
    if (normalizedCwd === root || normalizedCwd.startsWith(`${root}/`)) return alias.repoId;
  }
  return null;
}

function resolveSha(
  sha: string,
  repos: Repo[],
  aliases: RepoAlias[],
  input: { repoId?: string | null; cwd?: string | null },
): ResolveResult {
  const repoId = input.repoId ?? repoIdForCwd(input.cwd ?? null, aliases);
  const candidateRepos = repoId ? repos.filter((repo) => repo.id === repoId) : repos;
  if (candidateRepos.length === 0) return { ok: false, reason: 'no_repo' };

  const normalized = sha.toLowerCase();
  const matches: Array<{ repo: Repo; sha: string }> = [];
  for (const repo of candidateRepos) {
    for (const knownSha of repo.shas) {
      if (knownSha === normalized || knownSha.startsWith(normalized) || normalized.startsWith(knownSha)) {
        matches.push({ repo, sha: knownSha });
      }
    }
  }

  const unique = uniqueByKey(matches, (match) => `${match.repo.id}:${match.sha}`);
  if (unique.length === 0) return { ok: false, reason: 'not_found' };
  if (unique.length > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, repo: unique[0]!.repo, sha: unique[0]!.sha };
}

async function parseJsonl(filePath: string, onRecord: (record: JsonRecord, lineNumber: number) => void): Promise<void> {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const reader = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of reader) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) onRecord(parsed, lineNumber);
    } catch {
      // Prototype scanner: ignore malformed JSONL lines.
    }
  }
}

async function scanClaudeFile(filePath: string): Promise<RawEvidence[]> {
  const fileHash = sha256Hex(filePath);
  const fallbackMs = Date.now();
  const toolUseById = new Map<string, ToolContext>();
  const evidence: RawEvidence[] = [];

  await parseJsonl(filePath, (record) => {
    const sessionId = stringAt(record, ['sessionId', 'session_id', 'conversationId', 'conversation_id'])
      ?? `claude:${fileHash.slice(0, 16)}`;
    const eventAt = timestampFor(record, fallbackMs);
    const cwd = stringAt(record, ['cwd']);
    const model = stringAt(record, ['message.model', 'model', 'toolUseResult.model']) ?? 'unknown';
    const modelSource = model === 'unknown' ? 'unknown' : 'explicit';
    const content = getPath(record, 'message.content');

    if (Array.isArray(content)) {
      for (const part of content) {
        if (!isRecord(part)) continue;
        if (part.type === 'tool_use') {
          const toolUseId = stringAt(part, ['id']);
          const toolName = stringAt(part, ['name']);
          const command = extractCommand(part.input);
          if (toolUseId) {
            toolUseById.set(toolUseId, {
              toolName,
              command,
              cwd,
              model,
              provider: 'anthropic',
              modelSource,
            });
          }
        } else if (part.type === 'tool_result') {
          const toolUseId = stringAt(part, ['tool_use_id']);
          const context = toolUseId ? toolUseById.get(toolUseId) : undefined;
          const shas = commitShasFromValue(part.content);
          for (const commitSha of shas) {
            evidence.push({
              source: 'claude',
              sessionId,
              eventAt,
              toolName: context?.toolName ?? null,
              commandKind: classifyCommand(context?.command ?? null),
              cwd: context?.cwd ?? cwd,
              model: context?.model ?? model,
              provider: context?.provider ?? 'anthropic',
              modelSource: context?.modelSource ?? modelSource,
              commitSha,
              origin: 'claude.message.tool_result',
            });
          }
        }
      }
    }

    const toolUseResult = getPath(record, 'toolUseResult');
    if (isRecord(toolUseResult)) {
      const toolName = stringAt(toolUseResult, ['name', 'toolName', 'tool_name']);
      const command = extractCommand(toolUseResult);
      for (const commitSha of commitShasFromValue({
        stdout: toolUseResult.stdout,
        stderr: toolUseResult.stderr,
        content: toolUseResult.content,
        gitOperation: toolUseResult.gitOperation,
      })) {
        evidence.push({
          source: 'claude',
          sessionId,
          eventAt,
          toolName,
          commandKind: classifyCommand(command),
          cwd,
          model,
          provider: 'anthropic',
          modelSource,
          commitSha,
          origin: 'claude.toolUseResult',
        });
      }
    }
  });

  return evidence;
}

async function scanCodexFile(filePath: string): Promise<RawEvidence[]> {
  const fileHash = sha256Hex(filePath);
  const fallbackMs = Date.now();
  const callsById = new Map<string, ToolContext>();
  const evidence: RawEvidence[] = [];
  let sessionId = `codex:${fileHash.slice(0, 16)}`;
  let currentModel = 'unknown';
  let currentCwd: string | null = null;

  await parseJsonl(filePath, (record) => {
    const payload = isRecord(record.payload) ? record.payload : {};
    const recordType = stringAt(record, ['type', 'payload.type']) ?? '';
    const sessionMetaId = recordType === 'session_meta'
      ? stringAt(record, ['payload.id', 'payload.session_id', 'payload.sessionId', 'id', 'session_id'])
      : null;
    if (sessionMetaId) sessionId = sessionMetaId;

    const contextCwd = stringAt(record, [
      'payload.cwd',
      'payload.workdir',
      'payload.current_working_directory',
      'cwd',
    ]);
    if (contextCwd && ['turn_context', 'session_meta', 'session_configured'].includes(recordType)) {
      currentCwd = contextCwd;
    }

    const contextModel = stringAt(record, ['payload.model', 'payload.info.model', 'model']);
    if (contextModel && ['turn_context', 'session_meta', 'session_configured'].includes(recordType)) {
      currentModel = contextModel;
    }

    const payloadType = stringAt(payload, ['type']);
    if (payloadType === 'function_call' || payloadType === 'custom_tool_call' || payloadType === 'tool_search_call') {
      const callId = stringAt(payload, ['call_id']);
      const toolName = stringAt(payload, ['name', 'namespace']);
      const explicitModel = stringAt(payload, ['model', 'info.model']);
      const command = extractCommand(payload.arguments) ?? extractCommand(payload.input);
      if (callId) {
        callsById.set(callId, {
          toolName,
          command,
          cwd: currentCwd,
          model: explicitModel ?? currentModel,
          provider: 'openai',
          modelSource: explicitModel ? 'explicit' : currentModel === 'unknown' ? 'unknown' : 'session_context',
        });
      }
    } else if (
      payloadType === 'function_call_output'
      || payloadType === 'custom_tool_call_output'
      || payloadType === 'tool_search_output'
    ) {
      const callId = stringAt(payload, ['call_id']);
      const context = callId ? callsById.get(callId) : undefined;
      for (const commitSha of commitShasFromValue(payload.output ?? payload.execution)) {
        evidence.push({
          source: 'codex',
          sessionId,
          eventAt: timestampFor(record, fallbackMs),
          toolName: context?.toolName ?? null,
          commandKind: classifyCommand(context?.command ?? null),
          cwd: context?.cwd ?? currentCwd,
          model: context?.model ?? currentModel,
          provider: context?.provider ?? 'openai',
          modelSource: context?.modelSource ?? (currentModel === 'unknown' ? 'unknown' : 'session_context'),
          commitSha,
          origin: `codex.${payloadType}`,
        });
      }
    }
  });

  return evidence;
}

function scanOpenCode(opencodeDbPath: string): RawEvidence[] {
  if (!existsSync(opencodeDbPath)) return [];
  const sqlite = new Database(opencodeDbPath, { readonly: true, fileMustExist: true });
  try {
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
    `).all() as Array<{
      part_id: string;
      session_id: string;
      part_data: string;
      message_data: string | null;
      session_directory: string | null;
      part_time_updated: number;
    }>;

    const evidence: RawEvidence[] = [];
    for (const row of rows) {
      const partData = safeJsonParse(row.part_data);
      const messageData = safeJsonParse(row.message_data);
      if (!isRecord(partData) || partData.type !== 'tool') continue;
      const toolName = stringAt(partData, ['tool']);
      const command = stringAt(partData, ['state.input.command']);
      const output = getPath(partData, 'state.output');
      const status = stringAt(partData, ['state.status']);
      if (status && status !== 'completed') continue;

      const cwd = stringAt(partData, ['state.input.workdir'])
        ?? stringAt(messageData, ['path.cwd', 'path.root'])
        ?? row.session_directory;
      const model = stringAt(messageData, ['modelID', 'model']) ?? 'unknown';
      const provider = stringAt(messageData, ['providerID', 'provider']) ?? 'unknown';
      const eventAtMs = Number(getPath(partData, 'state.time.end'))
        || row.part_time_updated
        || Date.now();

      for (const commitSha of commitShasFromValue(output)) {
        evidence.push({
          source: 'opencode',
          sessionId: row.session_id,
          eventAt: new Date(eventAtMs).toISOString(),
          toolName,
          commandKind: classifyCommand(command),
          cwd,
          model,
          provider,
          modelSource: model === 'unknown' ? 'unknown' : 'explicit',
          commitSha,
          origin: 'opencode.part.tool',
        });
      }
    }
    return evidence;
  } finally {
    sqlite.close();
  }
}

async function scanRawEvidence(files: string[]): Promise<RawEvidence[]> {
  const evidence: RawEvidence[] = [];
  let scanned = 0;
  for (const filePath of files) {
    scanned += 1;
    if (scanned % 500 === 0) {
      process.stderr.write(`[commit-attribution] scanned ${scanned}/${files.length} usage files\n`);
    }
    const normalized = filePath.toLowerCase().replaceAll(path.sep, '/');
    try {
      if (normalized.includes('/.claude/projects/') || normalized.includes('/claude/projects/')) {
        evidence.push(...await scanClaudeFile(filePath));
      } else if (normalized.includes('/.codex/sessions/') || normalized.includes('/codex/sessions/')) {
        evidence.push(...await scanCodexFile(filePath));
      }
    } catch (error) {
      process.stderr.write(`[commit-attribution] skipped ${filePath}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  evidence.push(...scanOpenCode(path.join(homedir(), '.local', 'share', 'opencode', 'opencode.db')));
  return evidence;
}

function resolveEvidenceRows(
  evidenceRows: RawEvidence[],
  repos: Repo[],
  aliases: RepoAlias[],
): { resolved: ResolvedEvidence[]; unresolved: UnresolvedSummary } {
  const unresolved = new Map<string, number>();
  const unresolvedBySource = new Map<string, number>();
  const unresolvedBySourceReason = new Map<string, number>();
  const resolved: ResolvedEvidence[] = [];
  for (const evidence of evidenceRows) {
    const result = resolveSha(evidence.commitSha, repos, aliases, { cwd: evidence.cwd });
    if (!result.ok) {
      unresolved.set(result.reason, (unresolved.get(result.reason) ?? 0) + 1);
      unresolvedBySource.set(evidence.source, (unresolvedBySource.get(evidence.source) ?? 0) + 1);
      const sourceReason = `${evidence.source}:${result.reason}`;
      unresolvedBySourceReason.set(sourceReason, (unresolvedBySourceReason.get(sourceReason) ?? 0) + 1);
      continue;
    }
    resolved.push({
      ...evidence,
      repoId: result.repo.id,
      repoFullName: result.repo.fullName,
      resolvedSha: result.sha,
    });
  }
  return {
    resolved: uniqueByKey(resolved, evidenceKey),
    unresolved: {
      by_reason: Object.fromEntries(Array.from(unresolved.entries()).sort(([a], [b]) => a.localeCompare(b))),
      by_source: Object.fromEntries(Array.from(unresolvedBySource.entries()).sort(([a], [b]) => a.localeCompare(b))),
      by_source_reason: Object.fromEntries(Array.from(unresolvedBySourceReason.entries()).sort(([a], [b]) => a.localeCompare(b))),
    },
  };
}

function resolveCurrentEvidenceRows(
  rows: CurrentEvidenceRow[],
  repos: Repo[],
  aliases: RepoAlias[],
): { resolved: Array<CurrentEvidenceRow & { repo_id: string; resolved_sha: string }>; unresolved: UnresolvedSummary } {
  const unresolved = new Map<string, number>();
  const unresolvedBySource = new Map<string, number>();
  const unresolvedBySourceReason = new Map<string, number>();
  const resolved: Array<CurrentEvidenceRow & { repo_id: string; resolved_sha: string }> = [];
  for (const row of rows) {
    const result = resolveSha(row.commit_sha, repos, aliases, { repoId: row.repo_id });
    if (!result.ok) {
      unresolved.set(result.reason, (unresolved.get(result.reason) ?? 0) + 1);
      unresolvedBySource.set(row.source, (unresolvedBySource.get(row.source) ?? 0) + 1);
      const sourceReason = `${row.source}:${result.reason}`;
      unresolvedBySourceReason.set(sourceReason, (unresolvedBySourceReason.get(sourceReason) ?? 0) + 1);
      continue;
    }
    resolved.push({
      ...row,
      repo_id: result.repo.id,
      resolved_sha: result.sha,
    });
  }
  return {
    resolved: uniqueByKey(resolved, currentKey),
    unresolved: {
      by_reason: Object.fromEntries(Array.from(unresolved.entries()).sort(([a], [b]) => a.localeCompare(b))),
      by_source: Object.fromEntries(Array.from(unresolvedBySource.entries()).sort(([a], [b]) => a.localeCompare(b))),
      by_source_reason: Object.fromEntries(Array.from(unresolvedBySourceReason.entries()).sort(([a], [b]) => a.localeCompare(b))),
    },
  };
}

function loadUsageFilePaths(db: Database.Database): Promise<string[]> {
  const rows = db.prepare(`
    SELECT local_path
    FROM source_files
    WHERE local_path IS NOT NULL AND local_path != ''
  `).all() as Array<{ local_path: string }>;

  return discoverUsageFiles()
    .then((discovered) => Array.from(new Set([
      ...discovered,
      ...rows.map((row) => row.local_path).filter((filePath) => existsSync(filePath)),
    ])).sort());
}

function currentRows(db: Database.Database): { evidenceRows: CurrentEvidenceRow[]; linkRows: CurrentLinkRow[] } {
  const evidenceRows = db.prepare(`
    SELECT source, session_id, repo_id, lower(commit_sha) AS commit_sha, confidence
    FROM ai_tool_events
    WHERE commit_sha IS NOT NULL
      AND confidence >= 0.9
  `).all() as CurrentEvidenceRow[];

  const linkRows = db.prepare(`
    SELECT source, session_id, repo_id, lower(commit_sha) AS commit_sha, linked_tokens
    FROM ai_commit_links
  `).all() as CurrentLinkRow[];

  return { evidenceRows, linkRows };
}

function summarizeBySourceModel(rows: ResolvedEvidence[]): Array<Record<string, unknown>> {
  const grouped = new Map<string, {
    source: string;
    provider: string;
    model: string;
    commits: Set<string>;
    sessions: Set<string>;
  }>();

  for (const row of rows) {
    const key = `${row.source}:${row.provider}:${row.model}`;
    const group = grouped.get(key) ?? {
      source: row.source,
      provider: row.provider,
      model: row.model,
      commits: new Set<string>(),
      sessions: new Set<string>(),
    };
    group.commits.add(`${row.repoId}:${row.resolvedSha}`);
    group.sessions.add(row.sessionId);
    grouped.set(key, group);
  }

  return Array.from(grouped.values())
    .map((group) => ({
      source: group.source,
      provider: group.provider,
      model: group.model,
      resolved_commits: group.commits.size,
      sessions: group.sessions.size,
    }))
    .sort((a, b) => Number(b.resolved_commits) - Number(a.resolved_commits));
}

function sampleMissing(
  missingKeys: string[],
  currentByKey: Map<string, CurrentLinkRow>,
  broadRawByKey: Map<string, ResolvedEvidence[]>,
  limit = 20,
): Array<Record<string, unknown>> {
  return missingKeys.slice(0, limit).map((key) => {
    const current = currentByKey.get(key);
    const broadMatches = broadRawByKey.get(key) ?? [];
    const commandKinds = Array.from(new Set(broadMatches.map((match) => match.commandKind))).sort();
    const models = Array.from(new Set(broadMatches.map((match) => `${match.provider}/${match.model}`))).sort();
    return {
      source: current?.source,
      repo_id: current?.repo_id,
      commit: current ? shortSha(current.commit_sha) : undefined,
      session_hash: current ? compactSessionId(current.session_id) : undefined,
      broad_raw_command_kinds: commandKinds,
      broad_raw_models: models,
    };
  });
}

function writeReports(report: Record<string, unknown>): void {
  mkdirSync('test-results', { recursive: true });
  const jsonPath = path.join('test-results', 'commit-attribution-prototype.json');
  const mdPath = path.join('test-results', 'commit-attribution-prototype.md');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

  const comparison = report.comparison as Record<string, unknown>;
  const strict = report.strict_method as Record<string, unknown>;
  const current = report.current_method as Record<string, unknown>;
  const lines = [
    '# Commit Attribution Prototype',
    '',
    `Generated: \`${report.generated_at}\``,
    '',
    '## Current vs Strict',
    '',
    '| Metric | Count |',
    '|---|---:|',
    `| Current linked commits | ${current.current_link_unique} |`,
    `| Current resolved tool evidence | ${current.resolved_tool_evidence_unique} |`,
    `| Strict resolved git-commit evidence | ${strict.strict_resolved_unique} |`,
    `| Current links kept by strict method | ${comparison.current_links_kept_by_strict} |`,
    `| Current links missing from strict method | ${comparison.current_links_missing_from_strict} |`,
    `| Strict Claude/Codex links not in current links | ${comparison.strict_supported_added_vs_current_links} |`,
    `| Strict OpenCode resolved commits | ${comparison.strict_opencode_resolved} |`,
    `| Missing current links with no broad raw match | ${comparison.missing_current_links_without_broad_raw_match} |`,
    '',
    '## Source Breakdown',
    '',
    '```json',
    JSON.stringify({
      current_links_by_source: current.current_links_by_source,
      strict_git_commit_raw_by_source: strict.strict_git_commit_raw_by_source,
      strict_resolved_by_source: strict.strict_by_source,
      kept_by_source: comparison.current_links_kept_by_strict_by_source,
      missing_by_source: comparison.current_links_missing_from_strict_by_source,
      strict_unresolved: strict.strict_unresolved,
    }, null, 2),
    '```',
    '',
    '## Strict by Source / Model',
    '',
    '| Source | Provider | Model | Resolved commits | Sessions |',
    '|---|---|---|---:|---:|',
    ...((strict.by_source_model as Array<Record<string, unknown>>).slice(0, 30).map((row) =>
      `| ${row.source} | ${row.provider} | ${row.model} | ${row.resolved_commits} | ${row.sessions} |`
    )),
    '',
    '## Missing Current Links: Broad Raw Command Kinds',
    '',
    'These are current links that strict `git commit` evidence did not keep. If they show as `git_inspection`, they are likely false positives from reading existing history.',
    '',
    '```json',
    JSON.stringify(comparison.missing_current_links_broad_raw_command_kinds, null, 2),
    '```',
    '',
    `JSON report: \`${jsonPath}\``,
  ];
  writeFileSync(mdPath, `${lines.join('\n')}\n`);
}

async function main(): Promise<void> {
  const dbPath = process.env.TOKENSRANK_LOCAL_DB ?? resolveDatabasePath();
  if (!existsSync(dbPath)) {
    throw new Error(`Local TokensRank database not found at ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const { repos, aliases } = loadRepos(db);
    const usageFiles = await loadUsageFilePaths(db);
    const rawEvidence = await scanRawEvidence(usageFiles);
    const broadRaw = rawEvidence.filter((row) => isShellTool(row.toolName));
    const strictRaw = broadRaw.filter((row) => row.commandKind === 'git_commit');
    const broadResolved = resolveEvidenceRows(broadRaw, repos, aliases);
    const strictResolved = resolveEvidenceRows(strictRaw, repos, aliases);
    const { evidenceRows, linkRows } = currentRows(db);
    const currentResolved = resolveCurrentEvidenceRows(evidenceRows, repos, aliases);

    const strictSupported = strictResolved.resolved.filter((row) => row.source === 'claude' || row.source === 'codex');
    const strictSupportedKeys = new Set(strictSupported.map(evidenceKey));
    const strictAllKeys = new Set(strictResolved.resolved.map(evidenceKey));
    const currentLinkKeys = new Set(linkRows.map(currentKey));
    const currentResolvedKeys = new Set(currentResolved.resolved.map(currentKey));

    const currentLinksKept = Array.from(currentLinkKeys).filter((key) => strictSupportedKeys.has(key));
    const currentLinksMissing = Array.from(currentLinkKeys).filter((key) => !strictSupportedKeys.has(key));
    const strictSupportedAdded = Array.from(strictSupportedKeys).filter((key) => !currentLinkKeys.has(key));
    const currentResolvedKept = Array.from(currentResolvedKeys).filter((key) => strictSupportedKeys.has(key));
    const currentResolvedMissing = Array.from(currentResolvedKeys).filter((key) => !strictSupportedKeys.has(key));

    const currentByKey = new Map(linkRows.map((row) => [currentKey(row), row]));
    const broadRawByKey = new Map<string, ResolvedEvidence[]>();
    for (const row of broadResolved.resolved) {
      const key = evidenceKey(row);
      const list = broadRawByKey.get(key) ?? [];
      list.push(row);
      broadRawByKey.set(key, list);
    }

    const report = {
      generated_at: new Date().toISOString(),
      db_path: dbPath,
      selected_repos: repos.map((repo) => ({
        id: repo.id,
        full_name: repo.fullName,
        local_root_hash: sha256Hex(repo.localRoot).slice(0, 12),
        prod_branch: repo.prodBranch,
        commit_count: repo.shas.size,
      })),
      usage_files_scanned: usageFiles.length,
      current_method: {
        tool_evidence_rows: evidenceRows.length,
        resolved_tool_evidence_unique: currentResolved.resolved.length,
        unresolved_tool_evidence: currentResolved.unresolved,
        current_link_rows: linkRows.length,
        current_link_unique: currentLinkKeys.size,
        current_links_by_source: mapCount(linkRows, (row) => row.source),
      },
      strict_method: {
        broad_raw_shell_evidence_rows: broadRaw.length,
        broad_raw_by_source: mapCount(broadRaw, (row) => row.source),
        broad_resolved_unique: broadResolved.resolved.length,
        broad_unresolved: broadResolved.unresolved,
        strict_git_commit_raw_rows: strictRaw.length,
        strict_git_commit_raw_by_source: mapCount(strictRaw, (row) => row.source),
        strict_resolved_unique: strictAllKeys.size,
        strict_unresolved: strictResolved.unresolved,
        strict_by_source: mapCount(strictResolved.resolved, (row) => row.source),
        unknown_model_resolved: strictResolved.resolved.filter((row) => row.model === 'unknown').length,
        by_source_model: summarizeBySourceModel(strictResolved.resolved),
      },
      comparison: {
        current_links_kept_by_strict: currentLinksKept.length,
        current_links_missing_from_strict: currentLinksMissing.length,
        current_links_kept_by_strict_by_source: mapCount(
          currentLinksKept.map((key) => ({ source: sourceFromComparisonKey(key) })),
          (row) => row.source,
        ),
        current_links_missing_from_strict_by_source: mapCount(
          currentLinksMissing.map((key) => ({ source: sourceFromComparisonKey(key) })),
          (row) => row.source,
        ),
        current_resolved_tool_evidence_kept_by_strict: currentResolvedKept.length,
        current_resolved_tool_evidence_missing_from_strict: currentResolvedMissing.length,
        strict_supported_added_vs_current_links: strictSupportedAdded.length,
        strict_opencode_resolved: strictResolved.resolved.filter((row) => row.source === 'opencode').length,
        missing_current_links_broad_raw_command_kinds: mapCount(
          currentLinksMissing.flatMap((key) => broadRawByKey.get(key) ?? []),
          (row) => row.commandKind,
        ),
        missing_current_links_without_broad_raw_match: currentLinksMissing
          .filter((key) => !broadRawByKey.has(key)).length,
        missing_current_links_sample: sampleMissing(currentLinksMissing, currentByKey, broadRawByKey),
      },
    };

    writeReports(report);
    process.stdout.write(`${JSON.stringify({
      current_links: currentLinkKeys.size,
      strict_supported: strictSupportedKeys.size,
      kept: currentLinksKept.length,
      missing: currentLinksMissing.length,
      strict_added: strictSupportedAdded.length,
      opencode_strict: strictResolved.resolved.filter((row) => row.source === 'opencode').length,
      report: 'test-results/commit-attribution-prototype.md',
    }, null, 2)}\n`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
