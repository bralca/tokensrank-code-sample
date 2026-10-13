import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AtomicReadError,
  AtomicWriteError,
  readJsonAtomic,
  writeJsonAtomic,
} from '../src/runtime/atomic-write.js';

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tokensrank-atomic-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('atomic JSON writes', () => {
  it('writes a new JSON file with owner-only mode by default', async () => {
    const root = await createTempRoot();
    const target = join(root, 'state.json');

    await writeJsonAtomic(target, { ok: true });

    expect(await readJsonAtomic(target)).toEqual({ ok: true });
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it('roundtrips complex objects without losing structure', async () => {
    const root = await createTempRoot();
    const target = join(root, 'state.json');
    const value = {
      install_id: '11111111-1111-4111-8111-111111111111',
      last_run_at: null,
      shipped_session_ids: [
        {
          session_id: 'session-a',
          source: 'claude',
          file_sha256: 'a'.repeat(64),
          shipped_at: '2026-04-28T01:00:00.000Z',
        },
      ],
      pending_payloads: [
        {
          attempted_at: '2026-04-28T01:01:00.000Z',
          retry_count: 1,
          payload: { sessions: [] },
        },
      ],
      access_key_invalid: false,
    };

    await writeJsonAtomic(target, value);

    await expect(readJsonAtomic<typeof value>(target)).resolves.toEqual(value);
  });

  it('throws a parse-specific error for corrupt JSON', async () => {
    const root = await createTempRoot();
    const target = join(root, 'state.json');
    await writeFile(target, '{"broken"', { mode: 0o600 });

    await expect(readJsonAtomic(target)).rejects.toMatchObject({
      name: 'AtomicReadError',
      code: 'JSON_PARSE',
    });
  });

  it('supports explicit ENOENT handling with and without defaults', async () => {
    const root = await createTempRoot();
    const target = join(root, 'missing.json');

    await expect(readJsonAtomic(target)).rejects.toMatchObject({
      name: 'AtomicReadError',
      code: 'ENOENT',
    });

    await expect(readJsonAtomic(target, { defaultValue: { initialized: true } })).resolves.toEqual({
      initialized: true,
    });
  });

  it('applies custom file modes', async () => {
    const root = await createTempRoot();
    const target = join(root, 'config.json');

    await writeJsonAtomic(target, { mode: 'custom' }, { mode: 0o640 });

    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });

  it('keeps concurrent writes valid and complete', async () => {
    const root = await createTempRoot();
    const target = join(root, 'state.json');
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      writer: index,
      entries: Array.from({ length: 50 }, (__, entry) => `${index}-${entry}`),
    }));

    await Promise.all(candidates.map((candidate) => writeJsonAtomic(target, candidate)));

    const stored = await readJsonAtomic<(typeof candidates)[number]>(target);
    expect(candidates).toContainEqual(stored);
  });

  it('persists large JSON files without partial writes', async () => {
    const root = await createTempRoot();
    const target = join(root, 'state.json');
    const large = {
      entries: Array.from({ length: 11_000 }, (_, index) => ({
        session_id: `session-${index}`,
        data: 'x'.repeat(1_000),
      })),
    };

    await writeJsonAtomic(target, large);

    expect((await stat(target)).size).toBeGreaterThan(10 * 1024 * 1024);
    await expect(readJsonAtomic<typeof large>(target)).resolves.toEqual(large);
  });

  it('cleans up temp files when the final rename fails', async () => {
    const root = await createTempRoot();
    const targetDirectory = join(root, 'state.json');
    await writeJsonAtomic(join(targetDirectory, 'seed.json'), { seed: true });

    await expect(writeJsonAtomic(targetDirectory, { cannot: 'replace non-empty directory' })).rejects.toBeInstanceOf(
      AtomicWriteError,
    );

    const leftovers = await readdir(root);
    expect(leftovers.filter((entry) => entry.startsWith('.tmp.'))).toEqual([]);
    expect(leftovers).toContain('state.json');
  });

  it('surfaces non-ENOENT read failures distinctly', async () => {
    const root = await createTempRoot();

    await expect(readJsonAtomic(root)).rejects.toBeInstanceOf(AtomicReadError);
  });
});
