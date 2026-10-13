import { describe, expect, it } from 'vitest';

import {
  buildPosixInstallCommand,
  buildWindowsInstallCommand,
} from './onboarding-script-install';

describe('onboarding installer commands', () => {
  it('builds a POSIX command from the configured API base and generated script key', () => {
    const command = buildPosixInstallCommand('http://localhost:3001/', 'alex', 'tr_script_abc123');

    expect(command).toBe([
      "curl -fsSL 'http://localhost:3001/install.sh' | \\",
      "  TOKENSRANK_API_BASE='http://localhost:3001' \\",
      "  TOKENSRANK_ACCESS_KEY='tr_script_abc123' \\",
      "  TOKENSRANK_PROFILE_HANDLE='alex' \\",
      '  bash',
    ].join('\n'));
    expect(command).not.toContain('https://tokensrank.ai');
  });

  it('builds a PowerShell command from the configured API base and generated script key', () => {
    const command = buildWindowsInstallCommand('http://localhost:3001/', 'alex', 'tr_script_abc123');

    expect(command).toBe([
      "$env:TOKENSRANK_API_BASE = 'http://localhost:3001'",
      "$env:TOKENSRANK_ACCESS_KEY = 'tr_script_abc123'",
      "$env:TOKENSRANK_PROFILE_HANDLE = 'alex'",
      "irm 'http://localhost:3001/install.ps1' | iex",
    ].join('; '));
    expect(command).not.toContain('https://tokensrank.ai');
  });

  it('shows an explicit key placeholder until access key generation completes', () => {
    const command = buildPosixInstallCommand('https://api.tokensrank.ai', 'alex', null);

    expect(command).toContain("TOKENSRANK_ACCESS_KEY='<paste tr_script key>'");
  });
});
