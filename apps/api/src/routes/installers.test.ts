import { describe, expect, it } from 'vitest';

import {
  buildPosixInstallerBootstrap,
  buildPowerShellInstallerBootstrap,
  type LoadedInstallerAsset,
} from './installers';

const posixAssets: LoadedInstallerAsset[] = [
  {
    sourcePath: 'install.sh',
    targetPath: 'install.sh',
    executable: true,
    contents: '#!/usr/bin/env bash\nprintf "installed\\n"\n',
  },
  {
    sourcePath: 'bin/agent.mjs',
    targetPath: 'bin/agent.mjs',
    executable: true,
    contents: 'console.log("agent");\n',
  },
  {
    sourcePath: 'scheduler/tokensrank.service',
    targetPath: 'scheduler/tokensrank.service',
    contents: '[Service]\nExecStart=node agent.mjs\n',
  },
];

const powershellAssets: LoadedInstallerAsset[] = [
  {
    sourcePath: 'install.ps1',
    targetPath: 'install.ps1',
    contents: 'Write-Output "installed"\n',
  },
  {
    sourcePath: 'bin/agent.mjs',
    targetPath: 'bin/agent.mjs',
    contents: 'console.log("agent");\n',
  },
];

function encoded(contents: string): string {
  return Buffer.from(contents, 'utf8').toString('base64');
}

describe('installer bootstrap builders', () => {
  it('builds a POSIX bootstrap that reconstructs package assets before running install.sh', () => {
    const script = buildPosixInstallerBootstrap(posixAssets);

    expect(script).toContain('[tokensrank-install] Preparing installer...');
    expect(script).toContain('[tokensrank-install] Installing sync agent...');
    expect(script).toContain('write_asset "$TOKENSRANK_INSTALL_TMP/install.sh"');
    expect(script).toContain('write_asset "$TOKENSRANK_INSTALL_TMP/bin/agent.mjs"');
    expect(script).toContain('write_asset "$TOKENSRANK_INSTALL_TMP/scheduler/tokensrank.service"');
    expect(script).toContain(encoded(posixAssets[0]!.contents));
    expect(script).toContain('chmod 0755 "$TOKENSRANK_INSTALL_TMP/install.sh"');
    expect(script).toContain('"$TOKENSRANK_INSTALL_TMP/install.sh" "$@"');
    expect(script).not.toContain('https://tokensrank.ai');
  });

  it('builds a PowerShell bootstrap that reconstructs install.ps1 and the agent', () => {
    const script = buildPowerShellInstallerBootstrap(powershellAssets);

    expect(script).toContain("[tokensrank-install] Preparing installer...");
    expect(script).toContain("[tokensrank-install] Installing sync agent...");
    expect(script).toContain("Write-Asset -Path (Join-Path $TokensRankInstallTmp 'install.ps1')");
    expect(script).toContain("Write-Asset -Path (Join-Path $TokensRankInstallTmp 'bin/agent.mjs')");
    expect(script).toContain(encoded(powershellAssets[1]!.contents));
    expect(script).toContain("powershell.exe -NoProfile -ExecutionPolicy Bypass -File");
    expect(script).not.toContain('https://tokensrank.ai');
  });
});
