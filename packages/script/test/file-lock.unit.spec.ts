import { chmod, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LockAcquireError,
  acquireLock,
  acquireLockWithStaleRecovery,
  detectStaleLock,
  releaseLock,
  type LockHandle,
} from '../src/runtime/file-lock.js';

const tempRoots: string[] = [];
const activeLocks: LockHandle[] = [];

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tokensrank-lock-'));
  tempRoots.push(root);
  return root;
}

async function acquireTracked(lockPath: string): Promise<LockHandle> {
  const handle = await acquireLock(lockPath);
  activeLocks.push(handle);
  return handle;
}

afterEach(async () => {
  while (activeLocks.length > 0) {
    const handle = activeLocks.pop();
    if (handle) {
      await releaseLock(handle);
    }
  }

  for (const root of tempRoots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

describe('file-lock runtime', () => {
  it('acquires a POSIX lock and creates the parent directory', async () => {
    const root = await createTempRoot();
    const lockPath = join(root, 'nested', '.lock');

    const handle = await acquireTracked(lockPath);

    expect(handle.lockPath).toBe(lockPath);
    expect(handle.mode).toBe('posix-flock');
    expect((await stat(lockPath)).isFile()).toBe(true);
  });

  it('blocks successive lock acquisition while the first lock is held', async () => {
    const root = await createTempRoot();
    const lockPath = join(root, '.lock');
    await acquireTracked(lockPath);

    await expect(acquireLock(lockPath)).rejects.toMatchObject({
      name: 'LockAcquireError',
      code: 'LOCK_CONFLICT',
    });
  });

  it('releases and re-acquires the same lock', async () => {
    const root = await createTempRoot();
    const lockPath = join(root, '.lock');
    const first = await acquireTracked(lockPath);

    await releaseLock(first);
    activeLocks.pop();

    const second = await acquireTracked(lockPath);
    expect(second.released).toBe(false);
  });

  it('allows release to be called repeatedly', async () => {
    const root = await createTempRoot();
    const lockPath = join(root, '.lock');
    const handle = await acquireTracked(lockPath);

    await releaseLock(handle);
    await releaseLock(handle);
    activeLocks.pop();

    expect(handle.released).toBe(true);
  });

  it('detects stale lock files with old mtime and dead PID metadata', async () => {
    const root = await createTempRoot();
    const lockPath = join(root, '.lock');
    const old = new Date(Date.now() - (5 * 60 * 60 * 1_000));
    await writeFile(lockPath, `${JSON.stringify({ pid: 9_999_999 })}\n`, { mode: 0o600 });
    await utimes(lockPath, old, old);

    await expect(detectStaleLock(lockPath)).resolves.toMatchObject({
      exists: true,
      stale: true,
      pid: 9_999_999,
      pidAlive: false,
    });
  });

  it('does not mark old lock metadata stale while the PID is alive', async () => {
    const root = await createTempRoot();
    const lockPath = join(root, '.lock');
    const old = new Date(Date.now() - (5 * 60 * 60 * 1_000));
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });
    await utimes(lockPath, old, old);

    await expect(detectStaleLock(lockPath)).resolves.toMatchObject({
      stale: false,
      pid: process.pid,
      pidAlive: true,
    });
  });

  it('treats malformed old lock metadata as stale', async () => {
    const root = await createTempRoot();
    const lockPath = join(root, '.lock');
    const old = new Date(Date.now() - (5 * 60 * 60 * 1_000));
    await writeFile(lockPath, 'not-json', { mode: 0o600 });
    await utimes(lockPath, old, old);

    await expect(detectStaleLock(lockPath)).resolves.toMatchObject({
      stale: true,
      pid: null,
      pidAlive: false,
    });
  });

  it('treats empty old lock metadata as stale', async () => {
    const root = await createTempRoot();
    const lockPath = join(root, '.lock');
    const old = new Date(Date.now() - (5 * 60 * 60 * 1_000));
    await writeFile(lockPath, '', { mode: 0o600 });
    await utimes(lockPath, old, old);

    await expect(detectStaleLock(lockPath)).resolves.toMatchObject({
      stale: true,
      pid: null,
    });
  });

  it('recovers from a stale lock conflict by replacing the stale placeholder', async () => {
    const root = await createTempRoot();
    const lockPath = join(root, '.lock');
    const staleOwner = await acquireTracked(lockPath);
    const old = new Date(Date.now() - (5 * 60 * 60 * 1_000));
    await writeFile(lockPath, `${JSON.stringify({ pid: 9_999_999 })}\n`, { mode: 0o600 });
    await utimes(lockPath, old, old);

    const recovered = await acquireLockWithStaleRecovery(lockPath, {
      logger: { warn: vi.fn() },
    });
    activeLocks.push(recovered);

    expect(recovered).not.toBe(staleOwner);
    expect(recovered.released).toBe(false);
  });

  it('does not recover an active non-stale lock conflict', async () => {
    const root = await createTempRoot();
    const lockPath = join(root, '.lock');
    await acquireTracked(lockPath);

    await expect(acquireLockWithStaleRecovery(lockPath)).rejects.toMatchObject({
      code: 'LOCK_CONFLICT',
    });
  });

  it('reports ENOENT as a non-stale missing lock', async () => {
    const root = await createTempRoot();
    const lockPath = join(root, 'missing', '.lock');

    await expect(detectStaleLock(lockPath)).resolves.toEqual({
      exists: false,
      stale: false,
      ageMs: null,
      pid: null,
      pidAlive: false,
      mtimeMs: null,
    });
  });

  it('ignores lock metadata without a PID field', async () => {
    const root = await createTempRoot();
    const lockPath = join(root, '.lock');
    const old = new Date(Date.now() - (5 * 60 * 60 * 1_000));
    await writeFile(lockPath, `${JSON.stringify({ owner_pid: process.pid })}\n`, { mode: 0o600 });
    await utimes(lockPath, old, old);

    await expect(detectStaleLock(lockPath)).resolves.toMatchObject({
      stale: true,
      pid: null,
    });
  });

  it('surfaces permission errors as lock acquisition failures', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }

    const root = await createTempRoot();
    const blocked = join(root, 'blocked');
    await mkdtemp(`${blocked}-`);
    const blockedRoot = tempRoots.pop();
    if (!blockedRoot) {
      throw new Error('Expected blocked temp root to be created.');
    }
    tempRoots.push(blockedRoot);
    await chmod(blockedRoot, 0o500);

    await expect(acquireLock(join(blockedRoot, '.lock'))).rejects.toBeInstanceOf(LockAcquireError);
  });

  it('passes non-conflict acquisition errors through stale recovery', async () => {
    const root = await createTempRoot();

    await expect(acquireLockWithStaleRecovery(root)).rejects.toMatchObject({
      code: 'LOCK_UNAVAILABLE',
    });
  });

  it('propagates non-ENOENT stale detection filesystem errors', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }

    const root = await createTempRoot();
    const blockedRoot = await mkdtemp(join(root, 'blocked-'));
    await chmod(blockedRoot, 0o000);

    await expect(detectStaleLock(join(blockedRoot, '.lock'))).rejects.toBeTruthy();

    await chmod(blockedRoot, 0o700);
  });

  it('treats already-stopped helper release as a no-op', async () => {
    const root = await createTempRoot();
    const helper = {
      exitCode: 0,
      killed: false,
    };

    const handle = {
      lockPath: join(root, '.lock'),
      mode: 'posix-flock',
      acquiredAt: new Date(),
      released: false,
      platform: process.platform,
      helper,
    } as unknown as LockHandle;

    await releaseLock(handle);

    expect(handle.released).toBe(true);
  });

  it('ignores lock placeholder truncation failures during release', async () => {
    const root = await createTempRoot();
    const helper = {
      exitCode: 0,
      killed: false,
    };

    const handle = {
      lockPath: root,
      mode: 'posix-flock',
      acquiredAt: new Date(),
      released: false,
      platform: process.platform,
      helper,
    } as unknown as LockHandle;

    await releaseLock(handle);

    expect(handle.released).toBe(true);
  });

  it('provides a Windows no-op stub with a warning', async () => {
    const root = await createTempRoot();
    const warn = vi.fn();

    const handle = await acquireLock(join(root, '.lock'), {
      platform: 'win32',
      logger: { warn },
    });

    expect(handle.mode).toBe('windows-stub');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Windows mutex lock'));

    await releaseLock(handle);
    expect(handle.released).toBe(true);
  });
});
