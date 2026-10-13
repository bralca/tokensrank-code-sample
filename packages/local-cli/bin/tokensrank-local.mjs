#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'));
const localAppUrl = process.argv.includes('--publish')
  ? 'http://localhost:3000/local/publish'
  : 'http://localhost:3000/local';

function printHelp() {
  console.log(`TokensRank local ${packageJson.version}

Usage:
  tokensrank-local              Start the local API and web app
  tokensrank-local --repo DIR   Start from a specific TokensRank repo root
  tokensrank-local --dry-run    Validate and print the launch command
  tokensrank-local --publish    Open the guided sharing flow (does not publish)
  tokensrank-local --version    Print version
  tokensrank-local --help       Show help

Environment:
  TOKENSRANK_REPO_ROOT          Repo root used when --repo is omitted
  TOKENSRANK_PACKAGE_MANAGER    Package manager command, default pnpm
  TOKENSRANK_NO_OPEN            Set to 1 to print the URL without opening a browser

For this open-source v1 launcher, run from a TokensRank checkout or pass --repo.
The local app opens at ${localAppUrl}.
`);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function packageJsonForRoot(root) {
  const packageJsonPath = resolve(root, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  return {
    path: packageJsonPath,
    json: readJson(packageJsonPath),
  };
}

function isTokensRankRepoRoot(root) {
  return Boolean(
    packageJsonForRoot(root)?.json?.scripts?.['dev:local']
    && existsSync(resolve(root, 'pnpm-workspace.yaml'))
    && existsSync(resolve(root, 'apps/local-api/package.json'))
    && existsSync(resolve(root, 'apps/web/package.json')),
  );
}

function findRepoRoot(startDir) {
  let cursor = resolve(startDir);

  while (true) {
    if (isTokensRankRepoRoot(cursor)) {
      return cursor;
    }

    const parent = dirname(cursor);
    if (parent === cursor) {
      return null;
    }

    cursor = parent;
  }
}

function printRepoError(root) {
  const packageJsonPath = resolve(root, 'package.json');

  if (!existsSync(packageJsonPath)) {
    console.error(`[tokensrank-local] Could not find package.json at ${packageJsonPath}`);
  } else {
    console.error(`[tokensrank-local] ${root} is not a TokensRank monorepo root with apps/local-api and apps/web.`);
  }

  console.error('[tokensrank-local] Run from a TokensRank checkout, or pass --repo /path/to/Tokens-Rank.');
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForLocalApp(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status >= 200 && response.status < 500) {
        return true;
      }
    } catch {
      // Server is still booting.
    }

    await sleep(500);
  }

  return false;
}

function openUrl(url) {
  const opener =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];

  const child = spawn(opener[0], opener[1], {
    stdio: 'ignore',
    detached: true,
    shell: false,
  });
  child.unref();
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printHelp();
  process.exit(0);
}

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(packageJson.version);
  process.exit(0);
}

const explicitRepoRoot = argValue('--repo') ?? process.env.TOKENSRANK_REPO_ROOT ?? null;
const repoRoot = explicitRepoRoot
  ? resolve(explicitRepoRoot)
  : findRepoRoot(process.cwd());

if (!repoRoot) {
  console.error('[tokensrank-local] Could not find a TokensRank checkout above the current directory.');
  console.error('[tokensrank-local] Run from a TokensRank checkout, or pass --repo /path/to/Tokens-Rank.');
  process.exit(1);
}

if (!isTokensRankRepoRoot(repoRoot)) {
  printRepoError(repoRoot);
  process.exit(1);
}

const packageManager = process.env.TOKENSRANK_PACKAGE_MANAGER || 'pnpm';
const commandArgs = ['dev:local'];

if (process.argv.includes('--dry-run')) {
  console.log(`[tokensrank-local] Repo: ${repoRoot}`);
  console.log(`[tokensrank-local] Command: ${packageManager} ${commandArgs.join(' ')}`);
  console.log(`[tokensrank-local] URL: ${localAppUrl}`);
  process.exit(0);
}

console.log('[tokensrank-local] Starting local app at http://localhost:3000');
console.log(`[tokensrank-local] Local app: ${localAppUrl}`);
const child = spawn(packageManager, commandArgs, {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (process.env.TOKENSRANK_NO_OPEN === '1') {
  console.log('[tokensrank-local] Browser auto-open disabled with TOKENSRANK_NO_OPEN=1.');
} else {
  waitForLocalApp(localAppUrl)
    .then((ready) => {
      if (!ready) {
        console.log(`[tokensrank-local] App is still starting. Open ${localAppUrl} when it is ready.`);
        return;
      }
      openUrl(localAppUrl);
    })
    .catch((error) => {
      console.log(`[tokensrank-local] Could not open browser automatically: ${error instanceof Error ? error.message : String(error)}`);
      console.log(`[tokensrank-local] Open ${localAppUrl} manually.`);
    });
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
