import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '../../..');
const sourceAgent = resolve(repoRoot, 'packages/script/bin/agent.mjs');
const tempDistDir = resolve(repoRoot, 'test-results/qc-7-script-dist/runner');
const tempDistAgent = resolve(tempDistDir, 'index.js');

type CommandResult = {
  code: number;
  stderr: string;
  stdout: string;
};

function runPrivacyCheck(target: string): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    execFile(
      'pnpm',
      ['exec', 'tsx', 'scripts/check-script-privacy.ts', target],
      {
        cwd: repoRoot,
      },
      (error, stdout, stderr) => {
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? Number(error.code)
          : 0;

        resolvePromise({
          code,
          stderr,
          stdout,
        });
      },
    );
  });
}

async function writeDistCopy(extraSource = ''): Promise<void> {
  await mkdir(tempDistDir, { recursive: true });
  const source = await readFile(sourceAgent, 'utf8');
  await writeFile(tempDistAgent, `${source}\n${extraSource}`);
}

describe('QC-7 script privacy hook behavior', () => {
  afterEach(async () => {
    await rm(resolve(repoRoot, 'test-results/qc-7-script-dist'), {
      recursive: true,
      force: true,
    });
  });

  it('exits 1 on an injected forbidden dist pattern and exits 0 after cleanup', async () => {
    await writeDistCopy('const qc7ForbiddenPayload = { prompt: "do not ship prompt text" };\n');

    const blocked = await runPrivacyCheck(tempDistAgent);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain('privacy violation');
    expect(blocked.stderr).toContain('prompt or response content access');

    await writeDistCopy();

    const clean = await runPrivacyCheck(tempDistAgent);
    expect(clean.code).toBe(0);
    expect(clean.stdout).toContain('[tokensrank-privacy] Clean:');
  });
});
