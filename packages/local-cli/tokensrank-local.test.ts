import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDir = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(packageDir, 'bin/tokensrank-local.mjs');

type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function runCli(args: string[], options: { cwd?: string } = {}): Promise<CliResult> {
  return new Promise((resolveResult) => {
    execFile(
      process.execPath,
      [binPath, ...args],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          TOKENSRANK_PACKAGE_MANAGER: 'pnpm',
        },
      },
      (error, stdout, stderr) => {
        resolveResult({
          code: typeof error?.code === 'number' ? error.code : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

async function createRepoFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tokensrank-local-cli-'));
  await mkdir(resolve(root, 'apps/local-api'), { recursive: true });
  await mkdir(resolve(root, 'apps/web'), { recursive: true });
  await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  await writeFile(resolve(root, 'package.json'), JSON.stringify({
    name: 'tokensrank-test-root',
    scripts: {
      'dev:local': 'echo local',
    },
  }));
  await writeFile(resolve(root, 'apps/local-api/package.json'), JSON.stringify({ name: '@tokensrank/local-api' }));
  await writeFile(resolve(root, 'apps/web/package.json'), JSON.stringify({
    name: '@tokensrank/web',
    scripts: {
      'dev:local': 'next dev --port 3000',
    },
  }));

  return root;
}

describe('tokensrank-local CLI', () => {
  it('prints the package version', async () => {
    const result = await runCli(['--version']);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('0.0.1');
  });

  it('documents the local setup URL and repo requirement', async () => {
    const result = await runCli(['--help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('http://localhost:3000/local');
    expect(result.stdout).toContain('run from a TokensRank checkout or pass --repo');
  });

  it('validates an explicit repo and prints the launch command in dry-run mode', async () => {
    const repoRoot = await createRepoFixture();
    const result = await runCli(['--repo', repoRoot, '--dry-run']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Repo: ${repoRoot}`);
    expect(result.stdout).toContain('Command: pnpm dev:local');
    expect(result.stdout).toContain('URL: http://localhost:3000/local');
  });

  it('discovers a TokensRank repo when run from a nested directory', async () => {
    const repoRoot = await createRepoFixture();
    const nested = resolve(repoRoot, 'apps/web');
    await mkdir(nested, { recursive: true });

    const result = await runCli(['--dry-run'], { cwd: nested });
    const expectedRoot = await realpath(repoRoot);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Repo: ${expectedRoot}`);
  });

  it('opens the sharing wizard for users arriving from the leaderboard', async () => {
    const repoRoot = await createRepoFixture();
    const result = await runCli(['--repo', repoRoot, '--dry-run', '--publish']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('URL: http://localhost:3000/local/publish');
  });

  it('fails with a setup hint outside a TokensRank checkout', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'tokensrank-local-outside-'));
    const result = await runCli(['--dry-run'], { cwd: outside });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Could not find a TokensRank checkout');
    expect(result.stderr).toContain('pass --repo /path/to/Tokens-Rank');
  });
});
