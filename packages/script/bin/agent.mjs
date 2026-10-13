#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { closeSync, createReadStream, openSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { arch, homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

const VERSION = '0.0.1';
const DEDUP_STATE_CAP = 50_000;
const DEDUP_EVICTION_BATCH = 1_000;
const OFFLINE_QUEUE_CAP = 24;
const OFFLINE_QUEUE_MAX_RETRIES = 3;
const LAST_RUN_MIN_INTERVAL_MS = 30 * 60 * 1_000;
const STALE_LOCK_MS = 4 * 60 * 60 * 1_000;
const BATCH_SIZE = 100;
const LOCK_CONFLICT_EXIT_CODE = 75;
// Above this, stream the file line-by-line instead of readFile (Node rejects
// readFile over 2 GiB and strings over ~512 MB). Keeps memory bounded.
const STREAM_THRESHOLD_BYTES = 256 * 1024 * 1024;

const SESSION_KEYS = new Set([
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
]);

const PRIVATE_KEYS = new Set([
  'content',
  'text',
  'thinking',
  'prompt',
  'response',
  'hostname',
  'username',
  'cwd',
  'command',
  'diff',
  'project_name',
  'projectName',
  'tool_name',
  'toolName',
  'file' + '_path',
  'filePath',
  'repository',
  'branch',
  'commit',
  'git',
]);

const parsedArgs = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    audit: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    'first-run': { type: 'boolean', default: false },
    input: { type: 'string' },
    'claude-root': { type: 'string' },
    'codex-root': { type: 'string' },
    'scan-home': { type: 'boolean', default: false },
    'api-base': { type: 'string' },
    key: { type: 'string' },
    state: { type: 'string' },
  },
  allowPositionals: false,
});

async function main(values) {
  const tokensrankHome = process.env.TOKENSRANK_HOME ?? join(homedir(), '.tokensrank');
  const statePath = values.state ?? join(tokensrankHome, 'state.json');
  const state = await readState(statePath);
  let lockHandle;
  const force = Boolean(values.force);
  const firstRun = Boolean(values['first-run']);
  const dryRun = Boolean(values['dry-run'] || values.audit);

  if (!dryRun) {
    checkLastRunGuard(state, force, firstRun);
  }

  const config = await readJsonIfExists(join(tokensrankHome, 'config.json'));
  let installId = stringOrUndefined(config?.install_id) ?? stringOrUndefined(state.install_id);
  const apiBase = values['api-base']
    ?? process.env.TOKENSRANK_API_BASE
    ?? stringOrUndefined(config?.api_base)
    ?? 'https://api.tokensrank.ai';
  const accessKey = values.key
    ?? process.env.TOKENSRANK_ACCESS_KEY
    ?? stringOrUndefined(config?.access_key)
    ?? await readAccessKey(join(tokensrankHome, 'access-key'));
  const runStartedAt = new Date().toISOString();
  if (!dryRun) {
    lockHandle = await acquireRunLock(join(tokensrankHome, '.lock'));
    if (!installId) {
      installId = randomUUID();
      state.install_id = installId;
    }
    state.last_run_at = runStartedAt;
  }

  try {
    if (!dryRun && state.access_key_invalid && !force) {
      console.warn('[tokensrank-script] Access key invalid, exiting until a new key is configured');
      await writeState(statePath, state);
      return;
    }

    initializeDedupState(state);
    initializeOfflineQueue(state);

    if (!dryRun && accessKey) {
      const drainResult = await drainOfflineQueue(apiBase, accessKey);
      process.stderr.write(`[tokensrank-script] Drained ${drainResult.drained} payloads from offline queue\n`);
      if (drainResult.errors.length > 0) {
        for (const error of drainResult.errors) {
          console.warn(`[tokensrank-script] ${error}`);
        }
      }
      if (drainResult.unauthorized) {
        state.access_key_invalid = true;
        state.shipped_session_ids = getDedupState();
        state.pending_payloads = getOfflineQueue();
        await writeState(statePath, state);
        console.warn('[tokensrank-script] Access denied while draining queue. Check your tr_script_* key at tokensrank.ai/settings.');
        return;
      }
    }

    const sessions = await buildSessions(values);
    const newSessions = sessions.filter((session) => !checkDedupState(session.source, session.session_id, session.file_sha256));

    if (dryRun) {
      const batches = newSessions.length > 0 ? chunk(newSessions, BATCH_SIZE) : [newSessions];
      const batchCount = newSessions.length > 0 ? batches.length : 0;
      const lines = [
        formatDryRunHeader({ sessionCount: newSessions.length, batchCount }),
        formatSessionsSummary(newSessions),
      ];

      for (const [index, batch] of batches.entries()) {
        const payload = buildIngestPayload(batch, installId, runStartedAt);
        const validation = validatePayloadPrivacy(payload);
        if (!validation.isClean) {
          process.stderr.write(`[tokensrank-script] Dry-run payload failed privacy validation: ${validation.issues.join('; ')}\n`);
          process.exit(1);
        }

        lines.push(formatBatchPayload(payload, {
          batchIndex: newSessions.length > 0 ? index + 1 : undefined,
          batchCount: newSessions.length > 0 ? batchCount : undefined,
        }));
      }

      process.stdout.write(`${lines.join('\n\n')}\n`);
      return;
    }

    if (!accessKey) {
      console.warn('[tokensrank-script] Missing access key; queueing payloads for retry');
    }

    for (const batch of chunk(newSessions, BATCH_SIZE)) {
      const payload = buildIngestPayload(batch, installId, runStartedAt);

      if (!isValidIngestPayload(payload)) {
        console.warn('[tokensrank-script] Skipping invalid payload batch');
        continue;
      }

      if (!accessKey) {
        enqueuePayload(payload);
        continue;
      }

      const shipped = await postIngestPayload(apiBase, accessKey, payload);
      if (shipped.ok) {
        addToDedupState(batch, new Date().toISOString());
        continue;
      }

      if (shipped.status === 401 || shipped.status === 403) {
        state.access_key_invalid = true;
        console.warn('[tokensrank-script] Access denied. Check your tr_script_* key at tokensrank.ai/settings.');
        continue;
      }

      enqueuePayload(payload);
    }

    state.shipped_session_ids = getDedupState();
    state.pending_payloads = getOfflineQueue();
    await writeState(statePath, state);

    process.stdout.write(`${JSON.stringify({
      accepted: newSessions.length,
      deduped: sessions.length - newSessions.length,
      queued: state.pending_payloads.length,
    })}\n`);
  } finally {
    if (lockHandle) {
      await releaseRunLock(lockHandle);
    }
  }
}

async function acquireRunLock(lockPath) {
  if (process.platform === 'win32') {
    const mutexLock = await acquireWindowsMutexLock();
    if (mutexLock) {
      return mutexLock;
    }
  }

  return acquireLockFile(lockPath);
}

async function acquireLockFile(lockPath) {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });

  try {
    const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    writeFileSync(fd, `${JSON.stringify({
      pid: process.pid,
      started_at: new Date().toISOString(),
      platform: process.platform,
    })}\n`);
    closeSync(fd);
    return { mode: 'lock-file', lockPath, released: false };
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) {
      throw error;
    }

    const stale = await detectStaleLock(lockPath);
    if (stale) {
      await rm(lockPath, { force: true });
      return acquireLockFile(lockPath);
    }

    console.error('[tokensrank-script] Another instance running');
    process.exit(1);
  }
}

async function acquireWindowsMutexLock() {
  const shell = process.env.TOKENSRANK_POWERSHELL ?? 'powershell.exe';
  const command = [
    '$ErrorActionPreference = "Stop"',
    '$mutex = [System.Threading.Mutex]::new($false, "Global\\TokensRankSync")',
    'if (-not $mutex.WaitOne(0)) { exit 75 }',
    '[Console]::Out.WriteLine("locked")',
    '$parent = [Diagnostics.Process]::GetProcessById([int]$args[0])',
    'while (-not $parent.HasExited) { Start-Sleep -Milliseconds 250 }',
    '$mutex.ReleaseMutex()',
    '$mutex.Dispose()',
  ].join('; ');

  let child;
  try {
    child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', command, String(process.pid)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    return undefined;
  }

  const result = await waitForWindowsMutex(child);
  if (result === 'locked') {
    return { mode: 'windows-mutex', child, released: false };
  }

  if (result === 'conflict') {
    console.error('[tokensrank-script] Another instance running');
    process.exit(1);
  }

  return undefined;
}

function waitForWindowsMutex(child) {
  return new Promise((resolve) => {
    let output = '';
    let done = false;
    const finish = (status) => {
      if (done) {
        return;
      }

      done = true;
      clearTimeout(timer);
      resolve(status);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish('unavailable');
    }, 5_000);

    child.stdout.on('data', (chunkValue) => {
      output += chunkValue.toString('utf8');
      if (output.includes('locked')) {
        finish('locked');
      }
    });

    child.once('exit', (code) => {
      if (code === LOCK_CONFLICT_EXIT_CODE) {
        finish('conflict');
        return;
      }

      finish('unavailable');
    });

    child.once('error', () => finish('unavailable'));
  });
}

async function detectStaleLock(lockPath) {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return false;
    }

    throw error;
  }

  if ((Date.now() - lockStat.mtimeMs) <= STALE_LOCK_MS) {
    return false;
  }

  const pid = await readLockPid(lockPath);
  return pid === undefined || !isProcessAlive(pid);
}

async function readLockPid(lockPath) {
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8'));
    return Number.isInteger(parsed?.pid) && parsed.pid > 0 ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ESRCH');
  }
}

async function releaseRunLock(handle) {
  if (handle.released) {
    return;
  }

  handle.released = true;

  if (handle.mode === 'windows-mutex') {
    handle.child.kill();
    return;
  }

  await rm(handle.lockPath, { force: true });
}

function isNodeError(error, code) {
  return error && typeof error === 'object' && error.code === code;
}

async function buildSessions(values) {
  if (values.input) {
    return readInputSessions(values.input);
  }

  const sessions = [];
  const claudeRoot = values['claude-root'] ?? (values['scan-home'] ? join(homedir(), '.claude', 'projects') : undefined);
  const codexRoot = values['codex-root'] ?? (values['scan-home'] ? join(homedir(), '.codex', 'sessions') : undefined);

  if (claudeRoot) {
    for (const itemName of await findJsonlFiles(claudeRoot)) {
      sessions.push(...await extractClaudeFile(itemName));
    }
  }

  if (codexRoot) {
    for (const itemName of await findJsonlFiles(codexRoot)) {
      sessions.push(...await extractCodexFile(itemName));
    }
  }

  return sessions.map(filterSession).filter(isValidSession);
}

async function readInputSessions(inputName) {
  const parsed = JSON.parse(await readFile(inputName, 'utf8'));
  const source = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  return source.map(filterSession).filter(isValidSession);
}

function filterSession(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return {};
  }

  const filtered = {};
  for (const key of SESSION_KEYS) {
    if (Object.hasOwn(candidate, key)) {
      filtered[key] = candidate[key];
    }
  }

  assertNoPrivateKeys(filtered);
  return filtered;
}

async function findJsonlFiles(rootName) {
  const found = [];
  await walk(rootName, found);
  return found;
}

async function walk(itemName, found) {
  let details;
  try {
    details = await stat(itemName);
  } catch {
    return;
  }

  if (details.isFile()) {
    if (itemName.endsWith('.jsonl')) {
      found.push(itemName);
    }
    return;
  }

  if (!details.isDirectory()) {
    return;
  }

  let entries;
  try {
    entries = await readdir(itemName, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    await walk(join(itemName, entry.name), found);
  }
}

async function safeRead(itemName) {
  try {
    return await readFile(itemName, 'utf8');
  } catch (error) {
    process.stderr.write(`${scrub(error)}\n`);
    return undefined;
  }
}

async function fileSize(itemName) {
  try {
    return (await stat(itemName)).size;
  } catch (error) {
    process.stderr.write(`${scrub(error)}\n`);
    return undefined;
  }
}

async function safeHashFile(itemName) {
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(itemName)) {
      hash.update(chunk);
    }
    return hash.digest('hex');
  } catch (error) {
    process.stderr.write(`${scrub(error)}\n`);
    return undefined;
  }
}

function readFileLines(itemName) {
  return createInterface({ input: createReadStream(itemName, { encoding: 'utf8' }), crlfDelay: Infinity });
}

async function extractClaudeFile(itemName) {
  const size = await fileSize(itemName);
  if (size === undefined) {
    return [];
  }
  if (size <= STREAM_THRESHOLD_BYTES) {
    const jsonl = await safeRead(itemName);
    return jsonl === undefined ? [] : parseClaude(jsonl);
  }
  const fileSha256 = await safeHashFile(itemName);
  return fileSha256 === undefined ? [] : parseClaudeStream(readFileLines(itemName), fileSha256);
}

async function extractCodexFile(itemName) {
  const size = await fileSize(itemName);
  if (size === undefined) {
    return [];
  }
  if (size <= STREAM_THRESHOLD_BYTES) {
    const jsonl = await safeRead(itemName);
    return jsonl === undefined ? [] : parseCodex(jsonl, makeOpaqueCodexId(basename(itemName), jsonl));
  }
  const fileSha256 = await safeHashFile(itemName);
  return fileSha256 === undefined ? [] : parseCodexStream(readFileLines(itemName), `codex-${fileSha256.slice(0, 32)}`, fileSha256);
}

// Active-time accounting (mirror of src/extractors/active-time.ts). A gap > 30m
// ends an uninterrupted stretch; total = sum of stretches, longest = the biggest.
const IDLE_GAP_MS = 30 * 60 * 1000;

function activeTimeFromTimestamps(msList) {
  const ts = msList.filter((ms) => Number.isFinite(ms)).sort((a, b) => a - b);
  if (ts.length === 0) {
    return { active_seconds: 0, longest_active_seconds: 0 };
  }
  let total = 0;
  let longest = 0;
  let start = ts[0];
  let prev = ts[0];
  for (let i = 1; i < ts.length; i += 1) {
    if (ts[i] - prev > IDLE_GAP_MS) {
      const dur = prev - start;
      if (dur > 0) {
        total += dur;
        if (dur > longest) longest = dur;
      }
      start = ts[i];
    }
    prev = ts[i];
  }
  const dur = prev - start;
  if (dur > 0) {
    total += dur;
    if (dur > longest) longest = dur;
  }
  return { active_seconds: Math.round(total / 1000), longest_active_seconds: Math.round(longest / 1000) };
}

// Close the running stretch and stamp active_seconds/longest_active_seconds onto
// the accumulated Claude session (internal _ fields are dropped by filterSession).
function finalizeClaudeActive(session) {
  let total = session._activeMs ?? 0;
  let longest = session._longestMs ?? 0;
  const dur = (session._prevMs ?? 0) - (session._stretchStartMs ?? 0);
  if (dur > 0) {
    total += dur;
    if (dur > longest) longest = dur;
  }
  session.active_seconds = Math.round(total / 1000);
  session.longest_active_seconds = Math.round(longest / 1000);
  return session;
}

function processClaudeLine(sessionsById, fileSha256, line) {
  const record = parseObject(line);
  if (!record) {
    return;
  }

  const message = objectOrUndefined(record.message);
  const usage = objectOrUndefined(message?.usage);
  const sessionId = stringOrUndefined(record.sessionId);
  const model = stringOrUndefined(message?.model);
  const timestamp = isoOrUndefined(record.timestamp);
  if (!sessionId || !model || !timestamp || !usage) {
    return;
  }

  const current = sessionsById.get(sessionId) ?? {
    session_id: sessionId,
    source: 'claude',
    model,
    first_event_at: timestamp,
    last_event_at: timestamp,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0,
    turns: 0,
    file_sha256: fileSha256,
  };

  current.input_tokens += integerOrZero(usage.input_tokens);
  current.output_tokens += integerOrZero(usage.output_tokens);
  current.cache_read_input_tokens += integerOrZero(usage.cache_read_input_tokens);
  current.cache_creation_input_tokens += integerOrZero(usage.cache_creation_input_tokens);
  current.turns += 1;

  // Incremental active-time (O(1) memory; assumes chronological logs).
  const eventMs = Date.parse(timestamp);
  if (current._prevMs === undefined) {
    current._prevMs = eventMs;
    current._stretchStartMs = eventMs;
    current._activeMs = 0;
    current._longestMs = 0;
  } else if (Number.isFinite(eventMs)) {
    if (eventMs - current._prevMs > IDLE_GAP_MS) {
      const dur = current._prevMs - current._stretchStartMs;
      if (dur > 0) {
        current._activeMs += dur;
        if (dur > current._longestMs) current._longestMs = dur;
      }
      current._stretchStartMs = eventMs;
    }
    current._prevMs = Math.max(current._prevMs, eventMs);
  }

  if (Date.parse(timestamp) < Date.parse(current.first_event_at)) {
    current.first_event_at = timestamp;
  }

  if (Date.parse(timestamp) >= Date.parse(current.last_event_at)) {
    current.last_event_at = timestamp;
    current.model = model;
  }

  sessionsById.set(sessionId, current);
}

function parseClaude(jsonl) {
  const sessionsById = new Map();
  const fileSha256 = sha256(jsonl);
  for (const line of jsonl.split(/\r?\n/u)) {
    processClaudeLine(sessionsById, fileSha256, line);
  }
  return Array.from(sessionsById.values())
    .filter((s) => (s.input_tokens + s.output_tokens + s.cache_read_input_tokens + s.cache_creation_input_tokens) > 0)
    .map(finalizeClaudeActive)
    .map(filterSession);
}

async function parseClaudeStream(lines, fileSha256) {
  const sessionsById = new Map();
  for await (const line of lines) {
    processClaudeLine(sessionsById, fileSha256, line);
  }
  return Array.from(sessionsById.values())
    .filter((s) => (s.input_tokens + s.output_tokens + s.cache_read_input_tokens + s.cache_creation_input_tokens) > 0)
    .map(finalizeClaudeActive)
    .map(filterSession);
}

function processCodexLine(state, line, lineNumber) {
  const record = parseObject(line);
  if (!record) {
    return;
  }

  const payload = objectOrUndefined(record.payload);
  const timestamp = isoOrUndefined(record.timestamp);
  const model = stringOrUndefined(payload?.model);
  const recordType = stringOrUndefined(record.type);
  const payloadType = stringOrUndefined(payload?.type);
  if ((recordType === 'session_meta' || recordType === 'turn_context' || recordType === 'session_configured') && model) {
    state.activeModel = model;
  }

  const usage = objectOrUndefined(objectOrUndefined(payload?.info)?.last_token_usage);
  const isTokenCount = payloadType === 'token_count' || recordType === 'token_count';
  if (!timestamp || !usage || !isTokenCount) {
    return;
  }

  const inputTokens = integerOrZero(usage.input_tokens);
  const outputTokens = integerOrZero(usage.output_tokens);
  if (inputTokens === 0 && outputTokens === 0) {
    return;
  }

  state.events.push({
    line: lineNumber,
    model: model ?? state.activeModel,
    timestamp,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_input_tokens: integerOrZero(usage.cached_input_tokens),
    reasoning_output_tokens: integerOrZero(usage.reasoning_output_tokens),
  });
}

function parseCodex(jsonl, sessionId) {
  const state = { events: [], activeModel: 'unknown' };
  jsonl.split(/\r?\n/u).forEach((line, index) => processCodexLine(state, line, index + 1));
  return finalizeCodex(state.events, sessionId, sha256(jsonl));
}

async function parseCodexStream(lines, sessionId, fileSha256) {
  const state = { events: [], activeModel: 'unknown' };
  let index = 0;
  for await (const line of lines) {
    processCodexLine(state, line, (index += 1));
  }
  return finalizeCodex(state.events, sessionId, fileSha256);
}

function finalizeCodex(events, sessionId, fileSha256) {
  if (events.length === 0) {
    return [];
  }

  const first = events.reduce((earliest, event) =>
    Date.parse(event.timestamp) < Date.parse(earliest.timestamp) ? event : earliest,
  events[0]);
  const latest = events.reduce((selected, event) => {
    const delta = Date.parse(event.timestamp) - Date.parse(selected.timestamp);
    return delta > 0 || (delta === 0 && event.line >= selected.line) ? event : selected;
  }, events[0]);
  const totals = events.reduce((sum, event) => ({
    input_tokens: sum.input_tokens + event.input_tokens,
    output_tokens: sum.output_tokens + event.output_tokens,
    cached_input_tokens: sum.cached_input_tokens + event.cached_input_tokens,
    reasoning_output_tokens: sum.reasoning_output_tokens + event.reasoning_output_tokens,
  }), {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0,
  });

  const active = activeTimeFromTimestamps(events.map((event) => Date.parse(event.timestamp)));

  return [filterSession({
    session_id: sessionId,
    source: 'codex',
    model: latest.model ?? 'unknown',
    first_event_at: first.timestamp,
    last_event_at: latest.timestamp,
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cached_input_tokens: totals.cached_input_tokens,
    reasoning_output_tokens: totals.reasoning_output_tokens,
    turns: events.length,
    active_seconds: active.active_seconds,
    longest_active_seconds: active.longest_active_seconds,
    file_sha256: fileSha256,
  })];
}

async function readState(statePath) {
  const empty = createEmptyState();
  let parsed;

  try {
    parsed = JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    return empty;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return empty;
  }

  return {
    install_id: typeof parsed.install_id === 'string' || parsed.install_id === null ? parsed.install_id : empty.install_id,
    access_key_invalid: typeof parsed.access_key_invalid === 'boolean' ? parsed.access_key_invalid : false,
    last_run_at: typeof parsed.last_run_at === 'string' || parsed.last_run_at === null ? parsed.last_run_at : null,
    shipped_session_ids: Array.isArray(parsed.shipped_session_ids)
      ? parsed.shipped_session_ids.filter(isValidShippedEntry).slice(-DEDUP_STATE_CAP)
      : [],
    pending_payloads: Array.isArray(parsed.pending_payloads)
      ? parsed.pending_payloads.filter(isValidPendingEntry).slice(-OFFLINE_QUEUE_CAP)
      : [],
  };
}

async function writeState(statePath, state) {
  await writeJsonAtomic(statePath, state);
}

function createEmptyState() {
  return {
    install_id: null,
    access_key_invalid: false,
    last_run_at: null,
    shipped_session_ids: [],
    pending_payloads: [],
  };
}

function checkLastRunGuard(state, force, firstRun) {
  if (force || firstRun || state.last_run_at === null) {
    return;
  }

  const lastRunMs = Date.parse(state.last_run_at);
  if (!Number.isFinite(lastRunMs)) {
    return;
  }

  const elapsedMs = Date.now() - lastRunMs;
  if (elapsedMs >= LAST_RUN_MIN_INTERVAL_MS) {
    return;
  }

  console.info('[tokensrank-script] Skipping run (last_run_at within 30 minutes)');
  process.exit(0);
}

let dedupSet = new Set();
let dedupArray = [];

function initializeDedupState(state) {
  dedupArray = state.shipped_session_ids.map((entry) => ({ ...entry }));
  dedupSet = new Set(dedupArray.map(makeDedupKey));
  evictOldestIfNeeded();
}

function checkDedupState(source, sessionId, fileSha256) {
  return dedupSet.has(makeDedupKey({ source, session_id: sessionId, file_sha256: fileSha256 }));
}

function addToDedupState(sessions, shippedAt) {
  for (const session of sessions) {
    const entry = {
      session_id: session.session_id,
      source: session.source,
      file_sha256: session.file_sha256,
      shipped_at: shippedAt,
    };
    const key = makeDedupKey(entry);
    if (dedupSet.has(key)) {
      continue;
    }

    evictOldestIfNeeded();
    dedupArray.push(entry);
    dedupSet.add(key);
  }
}

function evictOldestIfNeeded() {
  while (dedupArray.length >= DEDUP_STATE_CAP) {
    const removed = dedupArray.splice(0, DEDUP_EVICTION_BATCH);
    for (const entry of removed) {
      dedupSet.delete(makeDedupKey(entry));
    }
    console.warn(`[tokensrank-script] Dedup state at capacity (${DEDUP_STATE_CAP}); evicted oldest ${removed.length}`);
  }
}

function getDedupState() {
  return dedupArray.map((entry) => ({ ...entry }));
}

let offlineQueue = [];

function initializeOfflineQueue(state) {
  offlineQueue = state.pending_payloads.map((entry) => ({
    payload: entry.payload,
    attempted_at: entry.attempted_at,
    retry_count: normalizeRetryCount(entry.retry_count),
  }));
  enforceQueueCapacity();
}

function enqueuePayload(payload) {
  offlineQueue.push({
    payload,
    attempted_at: new Date().toISOString(),
    retry_count: 0,
  });
  enforceQueueCapacity();
}

async function drainOfflineQueue(apiBase, key) {
  const remaining = [];
  const result = { drained: 0, failed: 0, errors: [], unauthorized: false };

  for (let index = 0; index < offlineQueue.length; index += 1) {
    const pending = offlineQueue[index];
    const attemptedAt = new Date().toISOString();

    try {
      const response = await postPayload(apiBase, key, pending.payload);
      if (response.ok) {
        addToDedupState(pending.payload.sessions, attemptedAt);
        result.drained += 1;
        continue;
      }

      if (response.status === 401) {
        result.unauthorized = true;
        result.errors.push('Stopped queue drain after 401 Unauthorized');
        remaining.push(pending, ...offlineQueue.slice(index + 1));
        break;
      }

      if (response.status >= 500) {
        handleQueuedFailure(pending, remaining, result, attemptedAt, `HTTP ${response.status}`);
        continue;
      }

      result.drained += 1;
      result.errors.push(`Dropped queued payload after non-retryable HTTP ${response.status}`);
    } catch (error) {
      handleQueuedFailure(pending, remaining, result, attemptedAt, scrub(error));
    }
  }

  offlineQueue = remaining;
  enforceQueueCapacity();
  return result;
}

function handleQueuedFailure(pending, remaining, result, attemptedAt, reason) {
  const retryCount = normalizeRetryCount(pending.retry_count) + 1;
  if (retryCount >= OFFLINE_QUEUE_MAX_RETRIES) {
    result.drained += 1;
    result.errors.push(`Dropped queued payload after ${OFFLINE_QUEUE_MAX_RETRIES} retries: ${reason}`);
    return;
  }

  result.failed += 1;
  result.errors.push(`Queued payload retry ${retryCount}/${OFFLINE_QUEUE_MAX_RETRIES}: ${reason}`);
  remaining.push({
    payload: pending.payload,
    attempted_at: attemptedAt,
    retry_count: retryCount,
  });
}

function enforceQueueCapacity() {
  if (offlineQueue.length <= OFFLINE_QUEUE_CAP) {
    return;
  }

  const overflow = offlineQueue.length - OFFLINE_QUEUE_CAP;
  offlineQueue = offlineQueue.slice(overflow);
  console.warn(`[tokensrank-script] Payload queue at capacity (${OFFLINE_QUEUE_CAP}); evicted oldest ${overflow}`);
}

function getOfflineQueue() {
  return offlineQueue.map((entry) => ({
    payload: entry.payload,
    attempted_at: entry.attempted_at,
    retry_count: entry.retry_count,
  }));
}

async function postIngestPayload(apiBase, key, payload) {
  try {
    const response = await postPayload(apiBase, key, payload);
    return { ok: response.ok, status: response.status };
  } catch (error) {
    console.warn(`[tokensrank-script] Ingestion failed, queued for retry: ${scrub(error)}`);
    return { ok: false, status: 0 };
  }
}

async function postPayload(apiBase, key, payload) {
  return fetch(`${apiBase.replace(/\/+$/u, '')}/api/script/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': `tokensrank-cli/${VERSION} (${process.platform}; ${arch()})`,
    },
    body: JSON.stringify(payload),
  });
}

function buildIngestPayload(sessions, installId, startedAt) {
  const finishedAt = new Date().toISOString();
  return {
    client: {
      version: VERSION,
      ...(installId ? { install_id: installId } : {}),
      platform: process.platform,
      arch: arch(),
    },
    run: {
      run_id: generateUlid(),
      started_at: startedAt,
      finished_at: finishedAt,
    },
    sessions,
  };
}

function formatDryRunHeader(options) {
  return `Dry-run mode: would send ${options.sessionCount} sessions in ${options.batchCount} batch(es)`;
}

function formatBatchPayload(payload, options = {}) {
  const json = JSON.stringify(payload, null, 2);
  if (options.batchIndex === undefined || options.batchCount === undefined) {
    return json;
  }

  return `Dry-run batch ${options.batchIndex}/${options.batchCount}\n${json}`;
}

function formatSessionsSummary(sessions) {
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

function validatePayloadPrivacy(payload) {
  const issues = [];

  if (!isValidIngestPayload(payload)) {
    issues.push('payload does not match the script ingest schema');
  }

  try {
    assertNoPrivateKeys(payload);
  } catch (error) {
    issues.push(scrub(error));
  }

  return {
    isClean: issues.length === 0,
    issues,
  };
}

function countBy(values, selector) {
  const counts = new Map();
  for (const value of values) {
    const key = selector(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return new Map([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function formatCounts(counts) {
  if (counts.size === 0) {
    return ['- none: 0'];
  }

  return [...counts.entries()].map(([key, count]) => `- ${key}: ${count}`);
}

function isValidIngestPayload(payload) {
  return payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && payload.client
    && payload.run
    && Array.isArray(payload.sessions)
    && payload.sessions.length <= BATCH_SIZE
    && payload.sessions.every(isValidSession);
}

function isValidSession(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.session_id === 'string'
    && (value.source === 'claude' || value.source === 'codex')
    && typeof value.model === 'string'
    && isIsoTimestamp(value.first_event_at)
    && isIsoTimestamp(value.last_event_at)
    && Date.parse(value.first_event_at) <= Date.parse(value.last_event_at)
    && isNonNegativeInteger(value.input_tokens)
    && isNonNegativeInteger(value.output_tokens)
    && isNonNegativeInteger(value.cache_read_input_tokens)
    && isNonNegativeInteger(value.cache_creation_input_tokens)
    && isNonNegativeInteger(value.cached_input_tokens)
    && isNonNegativeInteger(value.reasoning_output_tokens)
    && isNonNegativeInteger(value.turns)
    && typeof value.file_sha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(value.file_sha256);
}

function isValidShippedEntry(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.session_id === 'string'
    && (value.source === 'claude' || value.source === 'codex')
    && typeof value.file_sha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(value.file_sha256)
    && isIsoTimestamp(value.shipped_at);
}

function isValidPendingEntry(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.attempted_at === 'string'
    && isNonNegativeInteger(value.retry_count)
    && isValidIngestPayload(value.payload);
}

async function writeJsonAtomic(targetPath, value) {
  const directory = dirname(targetPath);
  const tempPath = join(directory, `.state.${basename(targetPath)}.${process.pid}.${Date.now()}.${randomUUID()}`);
  const json = `${JSON.stringify(value, null, 2)}\n`;
  let fileHandle;

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    fileHandle = await open(tempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await fileHandle.writeFile(json, 'utf8');
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;
    await rename(tempPath, targetPath);
    await fsyncDirectory(directory);
  } catch (error) {
    if (fileHandle) {
      await fileHandle.close().catch(() => undefined);
    }
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function fsyncDirectory(directory) {
  if (process.platform === 'win32') {
    return;
  }

  let directoryHandle;
  try {
    directoryHandle = await open(directory, fsConstants.O_RDONLY);
    await directoryHandle.sync();
  } catch {
    // Some filesystems do not permit directory fsync; the file itself is synced.
  } finally {
    if (directoryHandle) {
      await directoryHandle.close().catch(() => undefined);
    }
  }
}

async function readJsonIfExists(fileName) {
  try {
    const parsed = JSON.parse(await readFile(fileName, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function readAccessKey(fileName) {
  try {
    return (await readFile(fileName, 'utf8')).trim() || undefined;
  } catch {
    return undefined;
  }
}

function parseObject(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function objectOrUndefined(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function stringOrUndefined(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isoOrUndefined(value) {
  const candidate = stringOrUndefined(value);
  const timestampMs = candidate ? Date.parse(candidate) : Number.NaN;
  return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : undefined;
}

function integerOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function normalizeRetryCount(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function makeOpaqueCodexId(name, jsonl) {
  return `codex-${sha256(`${name}\n${jsonl}`).slice(0, 32)}`;
}

function makeDedupKey(entry) {
  return `${entry.source}\u0000${entry.session_id}\u0000${entry.file_sha256}`;
}

function generateUlid(date = new Date()) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = date.getTime();
  let encodedTime = '';
  for (let index = 0; index < 10; index += 1) {
    encodedTime = alphabet[time % 32] + encodedTime;
    time = Math.floor(time / 32);
  }

  const entropy = randomBytes(10);
  let encodedEntropy = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of entropy) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encodedEntropy += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    encodedEntropy += alphabet[(buffer << (5 - bits)) & 31];
  }

  return `${encodedTime}${encodedEntropy.slice(0, 16)}`;
}

function assertNoPrivateKeys(value) {
  if (!value || typeof value !== 'object') {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (!SESSION_KEYS.has(key) && PRIVATE_KEYS.has(key)) {
      throw new Error(`Blocked non-allowlisted key: ${key}`);
    }
    assertNoPrivateKeys(child);
  }
}

function scrub(value) {
  return String(value)
    .replace(/\/Users\/[^/\s]+/gu, '/[HOME]')
    .replace(/\/home\/[^/\s]+/gu, '/[HOME]')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gu, '/[HOME]')
    .replace(/(?:tr_(?:script|self_reported)_[A-Za-z0-9_-]+)/gu, '[REDACTED_KEY]');
}

await main(parsedArgs.values);
