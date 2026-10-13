import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';

const LOCK_CONFLICT_EXIT_CODE = 75;
const LOCK_HELPER_TIMEOUT_MS = 5_000;

export const DEFAULT_STALE_LOCK_MS = 4 * 60 * 60 * 1_000;

type LockMode = 'posix-flock' | 'windows-stub';
type Logger = Pick<Console, 'warn'>;
type LockHelperProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface LockHandle {
  lockPath: string;
  mode: LockMode;
  acquiredAt: Date;
  released: boolean;
  platform: NodeJS.Platform;
  fileHandle?: Awaited<ReturnType<typeof open>>;
  helper?: LockHelperProcess;
}

export interface LockOptions {
  staleMs?: number;
  platform?: NodeJS.Platform;
  logger?: Logger;
}

export interface StaleLockInfo {
  exists: boolean;
  stale: boolean;
  ageMs: number | null;
  pid: number | null;
  pidAlive: boolean;
  mtimeMs: number | null;
}

export class LockAcquireError extends Error {
  readonly code: 'LOCK_CONFLICT' | 'LOCK_UNAVAILABLE';
  readonly lockPath: string;
  readonly cause?: unknown;

  constructor(message: string, options: {
    code: 'LOCK_CONFLICT' | 'LOCK_UNAVAILABLE';
    lockPath: string;
    cause?: unknown;
  }) {
    super(message);
    this.name = 'LockAcquireError';
    this.code = options.code;
    this.lockPath = options.lockPath;
    this.cause = options.cause;
  }
}

export async function acquireLock(lockPath: string, options: LockOptions = {}): Promise<LockHandle> {
  const platform = options.platform ?? process.platform;

  if (platform === 'win32') {
    options.logger?.warn('[tokensrank-script] Windows mutex lock is handled by the PowerShell wrapper; TypeScript lock is a no-op.');
    return {
      lockPath,
      mode: 'windows-stub',
      acquiredAt: new Date(),
      released: false,
      platform,
    };
  }

  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });

  if (typeof (fs as typeof fs & { flock?: unknown }).flock === 'function') {
    return acquireNativeFlock(lockPath, platform);
  }

  return acquirePythonFlock(lockPath, platform);
}

export async function releaseLock(handle: LockHandle): Promise<void> {
  if (handle.released) {
    return;
  }

  handle.released = true;

  if (handle.mode === 'windows-stub') {
    return;
  }

  if (handle.helper) {
    await stopHelper(handle.helper);
    await truncateLockFile(handle.lockPath);
    return;
  }

  if (handle.fileHandle) {
    await flockAsync(handle.fileHandle.fd, 'un', handle.lockPath);
    await handle.fileHandle.close();
    await truncateLockFile(handle.lockPath);
  }
}

export async function detectStaleLock(
  lockPath: string,
  options: Pick<LockOptions, 'staleMs'> = {},
): Promise<StaleLockInfo> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;

  try {
    const lockStat = await stat(lockPath);
    const ageMs = Date.now() - lockStat.mtimeMs;
    const pid = await readLockPid(lockPath);
    const pidAlive = pid === null ? false : isProcessAlive(pid);

    return {
      exists: true,
      stale: ageMs > staleMs && !pidAlive,
      ageMs,
      pid,
      pidAlive,
      mtimeMs: lockStat.mtimeMs,
    };
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return {
        exists: false,
        stale: false,
        ageMs: null,
        pid: null,
        pidAlive: false,
        mtimeMs: null,
      };
    }

    throw error;
  }
}

export async function acquireLockWithStaleRecovery(
  lockPath: string,
  options: LockOptions = {},
): Promise<LockHandle> {
  try {
    return await acquireLock(lockPath, options);
  } catch (error) {
    if (!(error instanceof LockAcquireError) || error.code !== 'LOCK_CONFLICT') {
      throw error;
    }

    const stale = await detectStaleLock(lockPath, options);
    if (!stale.stale) {
      throw error;
    }

    options.logger?.warn(`[tokensrank-script] Stale lock detected at ${lockPath}; removing stale placeholder before retry.`);
    await rm(lockPath, { force: true });
    return acquireLock(lockPath, options);
  }
}

/* v8 ignore start -- Current Node LTS in this workspace does not expose fs.flock; the POSIX fallback is covered. */
async function acquireNativeFlock(lockPath: string, platform: NodeJS.Platform): Promise<LockHandle> {
  const fileHandle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_RDWR, 0o600);

  try {
    await flockAsync(fileHandle.fd, 'ex|nb', lockPath);
    await writeLockMetadata(fileHandle, lockPath);

    return {
      lockPath,
      mode: 'posix-flock',
      acquiredAt: new Date(),
      released: false,
      platform,
      fileHandle,
    };
  } catch (error) {
    await fileHandle.close();

    if (isLockConflict(error)) {
      throw new LockAcquireError('Another instance running', {
        code: 'LOCK_CONFLICT',
        lockPath,
        cause: error,
      });
    }

    throw new LockAcquireError(`Unable to acquire lock at ${lockPath}`, {
      code: 'LOCK_UNAVAILABLE',
      lockPath,
      cause: error,
    });
  }
}

async function acquirePythonFlock(lockPath: string, platform: NodeJS.Platform): Promise<LockHandle> {
  const acquiredAt = new Date();
  const helper = spawn('python3', ['-c', PYTHON_FLOCK_HELPER, lockPath, String(process.pid), acquiredAt.toISOString()], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const response = await waitForHelperResponse(helper, lockPath);

    if (response.status === 'locked') {
      helper.stdout.destroy();
      helper.stderr.destroy();
      helper.unref();

      return {
        lockPath,
        mode: 'posix-flock',
        acquiredAt,
        released: false,
        platform,
        helper,
      };
    }

    helper.kill('SIGTERM');

    if (response.status === 'conflict') {
      throw new LockAcquireError('Another instance running', {
        code: 'LOCK_CONFLICT',
        lockPath,
      });
    }

    throw new LockAcquireError(response.message ?? `Unable to acquire lock at ${lockPath}`, {
      code: 'LOCK_UNAVAILABLE',
      lockPath,
    });
  } catch (error) {
    if (!helper.killed) {
      helper.kill('SIGTERM');
    }

    if (error instanceof LockAcquireError) {
      throw error;
    }

    throw new LockAcquireError(`Unable to acquire lock at ${lockPath}`, {
      code: 'LOCK_UNAVAILABLE',
      lockPath,
      cause: error,
    });
  }
}

async function flockAsync(fd: number, operation: string, lockPath: string): Promise<void> {
  const flock = (fs as typeof fs & {
    flock?: (fd: number, operation: string, callback: (error: NodeJS.ErrnoException | null) => void) => void;
  }).flock;

  if (typeof flock !== 'function') {
    throw new LockAcquireError('Native fs.flock is not available in this Node runtime.', {
      code: 'LOCK_UNAVAILABLE',
      lockPath,
    });
  }

  await new Promise<void>((resolve, reject) => {
    flock(fd, operation, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function writeLockMetadata(fileHandle: Awaited<ReturnType<typeof open>>, lockPath: string): Promise<void> {
  await fileHandle.truncate(0);
  await fileHandle.writeFile(`${JSON.stringify({
    pid: process.pid,
    acquired_at: new Date().toISOString(),
  })}\n`, 'utf8');
  await fileHandle.sync();
  await fs.promises.chmod(lockPath, 0o600);
}
/* v8 ignore stop */

async function truncateLockFile(lockPath: string): Promise<void> {
  try {
    const fileHandle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_RDWR, 0o600);
    await fileHandle.close();
  } catch {
    // Lock release must not fail because placeholder cleanup failed.
  }
}

async function readLockPid(lockPath: string): Promise<number | null> {
  try {
    const content = await readFile(lockPath, 'utf8');
    if (content.trim() === '') {
      return null;
    }

    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || !('pid' in parsed)) {
      return null;
    }

    const pid = (parsed as { pid?: unknown }).pid;
    return Number.isInteger(pid) && Number(pid) > 0 ? Number(pid) : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, 'EPERM');
  }
}

function isLockConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EACCES';
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code);
}

async function waitForHelperResponse(
  helper: LockHelperProcess,
  lockPath: string,
): Promise<{ status: 'locked' | 'conflict' | 'error'; message?: string }> {
  let stdout = '';
  let stderr = '';

  helper.stdout.setEncoding('utf8');
  helper.stderr.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for lock helper at ${lockPath}`));
    }, LOCK_HELPER_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      helper.stdout.off('data', onStdout);
      helper.stderr.off('data', onStderr);
      helper.off('error', onError);
      helper.off('exit', onExit);
    };

    const onStdout = (chunk: string) => {
      stdout += chunk;
      const newlineIndex = stdout.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }

      cleanup();
      const line = stdout.slice(0, newlineIndex);
      try {
        resolve(JSON.parse(line) as { status: 'locked' | 'conflict' | 'error'; message?: string });
      } catch (error) {
        reject(error);
      }
    };

    const onStderr = (chunk: string) => {
      stderr += chunk;
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onExit = (code: number | null) => {
      cleanup();
      if (code === LOCK_CONFLICT_EXIT_CODE) {
        resolve({ status: 'conflict' });
        return;
      }

      /* c8 ignore next -- Helper startup failures are covered through the parent catch path. */
      reject(new Error(stderr.trim() || `Lock helper exited with code ${code ?? 'null'}`));
    };

    helper.stdout.on('data', onStdout);
    helper.stderr.on('data', onStderr);
    helper.once('error', onError);
    helper.once('exit', onExit);
  });
}

async function stopHelper(helper: LockHelperProcess): Promise<void> {
  if (helper.exitCode !== null || helper.killed) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      /* v8 ignore next -- SIGKILL fallback only runs if the helper ignores SIGTERM. */
      if (helper.exitCode === null && !helper.killed) {
        helper.kill('SIGKILL');
      }
      /* c8 ignore next -- This is only reached when the helper ignores SIGTERM. */
      resolve();
    }, 1_000);

    helper.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    helper.kill('SIGTERM');
  });
}

/* v8 ignore start -- Python helper source executes in the child interpreter, outside V8 coverage. */
const PYTHON_FLOCK_HELPER = String.raw`
import errno
import fcntl
import json
import os
import signal
import sys
import time

path = sys.argv[1]
owner_pid = int(sys.argv[2])
acquired_at = sys.argv[3]

fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)

try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError as exc:
    if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EACCES):
        print(json.dumps({"status": "conflict", "errno": exc.errno}), flush=True)
        sys.exit(75)
    print(json.dumps({"status": "error", "errno": exc.errno, "message": str(exc)}), flush=True)
    sys.exit(1)

os.ftruncate(fd, 0)
os.write(fd, (json.dumps({"pid": os.getpid(), "owner_pid": owner_pid, "acquired_at": acquired_at}) + "\n").encode("utf-8"))
os.fsync(fd)
print(json.dumps({"status": "locked", "pid": os.getpid()}), flush=True)

def exit_cleanly(signum, frame):
    sys.exit(0)

signal.signal(signal.SIGTERM, exit_cleanly)
signal.signal(signal.SIGINT, exit_cleanly)

while True:
    try:
        os.kill(owner_pid, 0)
    except OSError:
        sys.exit(0)
    time.sleep(1)
`;
/* v8 ignore stop */
