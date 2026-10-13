import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';

type InstallerAsset = {
  sourcePath: string;
  targetPath: string;
  executable?: boolean;
};

export type LoadedInstallerAsset = InstallerAsset & {
  contents: string;
};

const sourceDir = dirname(fileURLToPath(import.meta.url));

const scriptRootCandidates = [
  process.env.TOKENSRANK_SCRIPT_ROOT,
  resolve(process.cwd(), '../../packages/script'),
  resolve(process.cwd(), 'packages/script'),
  resolve(sourceDir, '../../../../packages/script'),
].filter((candidate): candidate is string => Boolean(candidate));

const posixInstallerAssets: InstallerAsset[] = [
  { sourcePath: 'install.sh', targetPath: 'install.sh', executable: true },
  { sourcePath: 'bin/agent.mjs', targetPath: 'bin/agent.mjs', executable: true },
  { sourcePath: 'scheduler/com.tokensrank.runner.plist', targetPath: 'scheduler/com.tokensrank.runner.plist' },
  { sourcePath: 'scheduler/tokensrank.service', targetPath: 'scheduler/tokensrank.service' },
  { sourcePath: 'scheduler/tokensrank.timer', targetPath: 'scheduler/tokensrank.timer' },
];

const powershellInstallerAssets: InstallerAsset[] = [
  { sourcePath: 'install.ps1', targetPath: 'install.ps1' },
  { sourcePath: 'bin/agent.mjs', targetPath: 'bin/agent.mjs' },
];

function findScriptRoot(): string {
  const scriptRoot = scriptRootCandidates.find((candidate) => (
    existsSync(resolve(candidate, 'install.sh'))
      && existsSync(resolve(candidate, 'install.ps1'))
      && existsSync(resolve(candidate, 'bin/agent.mjs'))
  ));

  if (!scriptRoot) {
    throw new Error('TokensRank script assets were not found');
  }

  return scriptRoot;
}

async function loadInstallerAssets(assets: InstallerAsset[]): Promise<LoadedInstallerAsset[]> {
  const scriptRoot = findScriptRoot();

  return await Promise.all(assets.map(async (asset) => ({
    ...asset,
    contents: await readFile(resolve(scriptRoot, asset.sourcePath), 'utf8'),
  })));
}

function encodeAsset(contents: string): string {
  const encoded = Buffer.from(contents, 'utf8').toString('base64');

  return encoded.match(/.{1,76}/gu)?.join('\n') ?? '';
}

function posixAssetDelimiter(targetPath: string): string {
  return `TOKENSRANK_ASSET_${targetPath.replace(/[^A-Za-z0-9]/gu, '_').toUpperCase()}`;
}

export function buildPosixInstallerBootstrap(assets: LoadedInstallerAsset[]): string {
  const assetBlocks = assets.map((asset) => {
    const targetPath = asset.targetPath.replace(/"/gu, '\\"');
    const delimiter = posixAssetDelimiter(asset.targetPath);
    const chmod = asset.executable ? `chmod 0755 "$TOKENSRANK_INSTALL_TMP/${targetPath}"` : '';

    return [
      `write_asset "$TOKENSRANK_INSTALL_TMP/${targetPath}" <<'${delimiter}'`,
      encodeAsset(asset.contents),
      delimiter,
      chmod,
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  return `#!/usr/bin/env bash
set -euo pipefail

printf '[tokensrank-install] Preparing installer...\\n'

if ! command -v node >/dev/null 2>&1; then
  printf '[tokensrank-install] ERROR: Node.js 20 LTS or newer is required before installing TokensRank.\\n' >&2
  exit 1
fi

TOKENSRANK_INSTALL_TMP="$(mktemp -d "\${TMPDIR:-/tmp}/tokensrank-install.XXXXXX")"

cleanup() {
  rm -rf "$TOKENSRANK_INSTALL_TMP"
}

trap cleanup EXIT

write_asset() {
  local target="$1"
  mkdir -p "$(dirname "$target")"
  node -e 'const fs = require("node:fs"); const target = process.argv[1]; let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => { fs.writeFileSync(target, Buffer.from(input.replace(/\\s+/g, ""), "base64")); });' "$target"
}

${assetBlocks}

printf '[tokensrank-install] Installing sync agent...\\n'
"$TOKENSRANK_INSTALL_TMP/install.sh" "$@"
`;
}

function powerShellSingleQuoted(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

export function buildPowerShellInstallerBootstrap(assets: LoadedInstallerAsset[]): string {
  const assetBlocks = assets.map((asset) => {
    const variableName = `$Asset${asset.targetPath.replace(/[^A-Za-z0-9]/gu, '')}`;
    const targetPath = powerShellSingleQuoted(asset.targetPath);

    return [
      `${variableName} = @'`,
      encodeAsset(asset.contents),
      "'@",
      `Write-Asset -Path (Join-Path $TokensRankInstallTmp ${targetPath}) -Base64 ${variableName}`,
    ].join('\n');
  }).join('\n\n');

  return `[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Output '[tokensrank-install] Preparing installer...'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  [Console]::Error.WriteLine('[tokensrank-install] ERROR: Node.js 20 LTS or newer is required before installing TokensRank.')
  exit 1
}

$TokensRankInstallTmp = Join-Path ([System.IO.Path]::GetTempPath()) ('tokensrank-install-' + [guid]::NewGuid().ToString('N'))
$ExitCode = 0

function Write-Asset {
  param(
    [string]$Path,
    [string]$Base64
  )

  $Directory = Split-Path -Parent $Path
  New-Item -Path $Directory -ItemType Directory -Force | Out-Null
  [System.IO.File]::WriteAllBytes($Path, [Convert]::FromBase64String(($Base64 -replace '\\s', '')))
}

try {
  New-Item -Path $TokensRankInstallTmp -ItemType Directory -Force | Out-Null

${assetBlocks}

  Write-Output '[tokensrank-install] Installing sync agent...'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $TokensRankInstallTmp 'install.ps1')
  if ($null -ne $LASTEXITCODE) {
    $ExitCode = $LASTEXITCODE
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  $ExitCode = 1
} finally {
  Remove-Item -LiteralPath $TokensRankInstallTmp -Recurse -Force -ErrorAction SilentlyContinue
}

exit $ExitCode
`;
}

export async function installerRoutes(fastify: FastifyInstance) {
  fastify.get('/install.sh', async (_request, reply) => {
    const assets = await loadInstallerAssets(posixInstallerAssets);

    return reply
      .type('text/x-shellscript; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(buildPosixInstallerBootstrap(assets));
  });

  fastify.get('/install.ps1', async (_request, reply) => {
    const assets = await loadInstallerAssets(powershellInstallerAssets);

    return reply
      .type('text/plain; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(buildPowerShellInstallerBootstrap(assets));
  });
}
