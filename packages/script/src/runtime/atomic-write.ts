import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const DEFAULT_JSON_FILE_MODE = 0o600;

type JsonReplacer = Parameters<typeof JSON.stringify>[1];

export interface WriteJsonAtomicOptions {
  mode?: number;
  spaces?: number;
  replacer?: JsonReplacer;
  tempPrefix?: string;
}

export interface ReadJsonAtomicOptions<T> {
  defaultValue?: T;
}

export class AtomicWriteError extends Error {
  readonly targetPath: string;
  readonly tempPath?: string;
  readonly cause?: unknown;

  constructor(message: string, options: {
    targetPath: string;
    tempPath?: string;
    cause?: unknown;
  }) {
    super(message);
    this.name = 'AtomicWriteError';
    this.targetPath = options.targetPath;
    this.tempPath = options.tempPath;
    this.cause = options.cause;
  }
}

export class AtomicReadError extends Error {
  readonly targetPath: string;
  readonly code: 'ENOENT' | 'JSON_PARSE' | 'READ_FAILED';
  readonly cause?: unknown;

  constructor(message: string, options: {
    targetPath: string;
    code: 'ENOENT' | 'JSON_PARSE' | 'READ_FAILED';
    cause?: unknown;
  }) {
    super(message);
    this.name = 'AtomicReadError';
    this.targetPath = options.targetPath;
    this.code = options.code;
    this.cause = options.cause;
  }
}

export async function writeJsonAtomic<T>(
  targetPath: string,
  value: T,
  options: WriteJsonAtomicOptions = {},
): Promise<void> {
  const directory = dirname(targetPath);
  const mode = options.mode ?? DEFAULT_JSON_FILE_MODE;
  const tempPath = makeTempPath(targetPath, options.tempPrefix);
  const json = `${JSON.stringify(value, options.replacer, options.spaces ?? 2)}\n`;

  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    fileHandle = await open(tempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
    await fileHandle.writeFile(json, 'utf8');
    await fileHandle.sync();
    await fileHandle.chmod(mode);
    await fileHandle.close();
    fileHandle = undefined;

    await rename(tempPath, targetPath);
    await fsyncDirectory(directory);
  } catch (error) {
    if (fileHandle) {
      await fileHandle.close().catch(() => undefined);
    }

    await rm(tempPath, { force: true }).catch(() => undefined);

    throw new AtomicWriteError(`Failed to atomically write JSON file at ${targetPath}`, {
      targetPath,
      tempPath,
      cause: error,
    });
  }
}

export async function readJsonAtomic<T>(
  targetPath: string,
  options: ReadJsonAtomicOptions<T> = {},
): Promise<T> {
  let content: string;

  try {
    content = await readFile(targetPath, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      if ('defaultValue' in options) {
        return options.defaultValue as T;
      }

      throw new AtomicReadError(`JSON file does not exist at ${targetPath}`, {
        targetPath,
        code: 'ENOENT',
        cause: error,
      });
    }

    throw new AtomicReadError(`Failed to read JSON file at ${targetPath}`, {
      targetPath,
      code: 'READ_FAILED',
      cause: error,
    });
  }

  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw new AtomicReadError(`Failed to parse JSON file at ${targetPath}`, {
      targetPath,
      code: 'JSON_PARSE',
      cause: error,
    });
  }
}

function makeTempPath(targetPath: string, tempPrefix = '.tmp'): string {
  return join(
    dirname(targetPath),
    `${tempPrefix}.${basename(targetPath)}.${process.pid}.${Date.now()}.${randomUUID()}`,
  );
}

async function fsyncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }

  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    directoryHandle = await open(directory, fsConstants.O_RDONLY);
    await directoryHandle.sync();
  } catch {
    // Some filesystems do not permit fsync on directories; the file itself was already synced.
  } finally {
    if (directoryHandle) {
      await directoryHandle.close().catch(() => undefined);
    }
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code);
}
