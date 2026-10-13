import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';

import type { SessionPayload } from '@tokensrank/shared';

import { parseClaudeJsonl, parseClaudeJsonlStream } from './claude.js';
import { parseCodexJsonl, parseCodexJsonlStream } from './codex.js';
import type { ExtractionWarning, ExtractorSource } from '../privacy/allowlist.js';

export { parseClaudeJsonl, parseClaudeJsonlStream } from './claude.js';
export { parseCodexJsonl, parseCodexJsonlStream } from './codex.js';

// Files at/under this stay on the simple read-whole-file path. Above it we stream
// line-by-line, because Node rejects reading a file larger than 2 GiB into memory
// and rejects building a string larger than ~512 MB ("Invalid string length").
// Streaming holds only the per-session accumulator, so memory stays bounded.
const STREAM_THRESHOLD_BYTES = 256 * 1024 * 1024;

export type SessionFileInput = {
  path: string;
  source: ExtractorSource;
  sessionId?: string;
};

export type ExtractSessionsFromFilesResult = {
  sessions: SessionPayload[];
  warnings: ExtractionWarning[];
};

async function hashFileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

function readFileLines(path: string): AsyncIterable<string> {
  // crlfDelay: Infinity treats \r\n as a single break, matching the /\r?\n/ split
  // the in-memory path uses, so streamed and non-streamed parses agree.
  return createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
}

export async function extractSessionsFromFiles(
  files: readonly SessionFileInput[],
): Promise<ExtractSessionsFromFilesResult> {
  const sessions: SessionPayload[] = [];
  const warnings: ExtractionWarning[] = [];

  for (const file of files) {
    const { size } = await stat(file.path);
    let result: ExtractSessionsFromFilesResult;

    if (size <= STREAM_THRESHOLD_BYTES) {
      const jsonl = await readFile(file.path, 'utf8');
      result = file.source === 'claude'
        ? parseClaudeJsonl(jsonl)
        : parseCodexJsonl(jsonl, {
          sessionId: file.sessionId ?? makeOpaqueCodexSessionId(file.path, jsonl),
        });
    } else {
      // Hash the raw bytes (== sha256 of the utf8 string the small path would
      // produce), then stream the lines so the file is never held in one string.
      const fileSha256 = await hashFileSha256(file.path);
      result = file.source === 'claude'
        ? await parseClaudeJsonlStream(readFileLines(file.path), fileSha256)
        : await parseCodexJsonlStream(
          readFileLines(file.path),
          fileSha256,
          file.sessionId ?? `codex-${fileSha256.slice(0, 32)}`,
        );
    }

    sessions.push(...result.sessions);
    warnings.push(...result.warnings);
  }

  return { sessions, warnings };
}

function makeOpaqueCodexSessionId(filePath: string, jsonl: string): string {
  const digest = createHash('sha256')
    .update(`${basename(filePath)}\n${jsonl}`)
    .digest('hex')
    .slice(0, 32);

  return `codex-${digest}`;
}
