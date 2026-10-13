Describe 'V-14 Windows idempotency and lock recovery' {
  BeforeAll {
    $script:ScriptRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
    $script:Installer = Join-Path $script:ScriptRoot 'install.ps1'
    $script:MutexModule = Join-Path $script:ScriptRoot 'src/runtime/win-mutex.ps1'
    $script:InstallerSource = Get-Content -LiteralPath $script:Installer -Raw
    $script:IsWindowsHost = if (Get-Variable -Name IsWindows -Scope Global -ErrorAction SilentlyContinue) { $IsWindows } else { $true }
    . $script:MutexModule
  }

  BeforeEach {
    $script:InstallRoot = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString('N'))
    $script:PreviousHome = $env:TOKENSRANK_HOME
    $script:PreviousSkipScheduler = $env:TOKENSRANK_SKIP_SCHEDULER_REGISTER
    $script:PreviousRunFirst = $env:TOKENSRANK_INSTALL_RUN_FIRST
    $script:PreviousAccessKey = $env:TOKENSRANK_ACCESS_KEY
    $script:LockResult = $null
    $env:TOKENSRANK_HOME = $script:InstallRoot
    $env:TOKENSRANK_SKIP_SCHEDULER_REGISTER = '1'
    $env:TOKENSRANK_INSTALL_RUN_FIRST = '0'
    $env:TOKENSRANK_ACCESS_KEY = 'tr_script_windows_idempotency_key'
  }

  AfterEach {
    if ($script:LockResult -and $script:LockResult.mutex) {
      Release-TokensRankMutex -Mutex $script:LockResult.mutex
      $script:LockResult = $null
    }

    $env:TOKENSRANK_HOME = $script:PreviousHome
    $env:TOKENSRANK_SKIP_SCHEDULER_REGISTER = $script:PreviousSkipScheduler
    $env:TOKENSRANK_INSTALL_RUN_FIRST = $script:PreviousRunFirst
    $env:TOKENSRANK_ACCESS_KEY = $script:PreviousAccessKey
    Remove-Item -LiteralPath $script:InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
  }

  function script:Invoke-IsolatedInstall {
    & pwsh -NoProfile -File $script:Installer | Out-String
    $LASTEXITCODE | Should -Be 0
  }

  function script:Get-InstallJson {
    param([string]$LeafName)

    Get-Content -LiteralPath (Join-Path $script:InstallRoot $LeafName) -Raw | ConvertFrom-Json
  }

  It 'creates config.json and state.json with one UUID install_id' {
    Invoke-IsolatedInstall | Out-Null

    $config = Get-InstallJson 'config.json'
    $state = Get-InstallJson 'state.json'
    $config.install_id | Should -Match '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    $state.install_id | Should -Be $config.install_id
    $state.shipped_session_ids.Count | Should -Be 0
    $state.pending_payloads.Count | Should -Be 0
  }

  It 'restricts config.json to the current user on Windows' {
    Invoke-IsolatedInstall | Out-Null

    if ($script:IsWindowsHost) {
      $acl = Get-Acl -LiteralPath (Join-Path $script:InstallRoot 'config.json')
      $acl.AreAccessRulesProtected | Should -BeTrue
      $acl.Access.Count | Should -Be 1
      $acl.Access[0].IdentityReference.Value | Should -Be ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
    } else {
      $script:InstallerSource | Should -Match 'function Set-UserOnlyAcl'
      $script:InstallerSource | Should -Match 'SetAccessRuleProtection\(\$true, \$false\)'
      $script:InstallerSource | Should -Match 'Set-UserOnlyAcl -Path \$configPath'
    }
  }

  It 'preserves config.json exactly on repeat install' {
    Invoke-IsolatedInstall | Out-Null
    $configPath = Join-Path $script:InstallRoot 'config.json'
    $before = Get-Content -LiteralPath $configPath -Raw

    Invoke-IsolatedInstall | Out-Null

    $after = Get-Content -LiteralPath $configPath -Raw
    $after | Should -Be $before
  }

  It 'preserves runtime state on repeat install' {
    Invoke-IsolatedInstall | Out-Null
    $statePath = Join-Path $script:InstallRoot 'state.json'
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $state.last_run_at = 'last-run-sentinel'
    $state.shipped_session_ids = @(
      [pscustomobject]@{
        session_id = 'win-already-shipped'
        source = 'claude'
        file_sha256 = ('a' * 64)
        shipped_at = '2026-04-29T10:00:00.000Z'
      }
    )
    $state | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $statePath -Encoding utf8

    Invoke-IsolatedInstall | Out-Null

    $after = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $after.last_run_at | Should -Be 'last-run-sentinel'
    $after.access_key_invalid | Should -BeFalse
    $after.shipped_session_ids[0].session_id | Should -Be 'win-already-shipped'
    $after.shipped_session_ids[0].source | Should -Be 'claude'
  }

  It 'deduplicates Task Scheduler registration with unregister then register -Force' {
    $script:InstallerSource | Should -Match 'Get-ScheduledTask -TaskName \$Script:TaskName'
    $script:InstallerSource | Should -Match 'Unregister-ScheduledTask -TaskName \$Script:TaskName -Confirm:\$false'
    $script:InstallerSource | Should -Match 'Register-ScheduledTask[\s\S]*-Force'
    $script:InstallerSource | Should -Match "\`$Script:TaskName = 'TokensRank'"
  }

  It 'installs a wrapper that uses the Global TokensRank mutex' {
    Invoke-IsolatedInstall | Out-Null

    $wrapper = Get-Content -LiteralPath (Join-Path $script:InstallRoot 'bin/tokensrank.ps1') -Raw
    $wrapper | Should -Match 'System\.Threading\.Mutex'
    $wrapper | Should -Match 'Global\\TokensRankSync'
    $wrapper | Should -Match 'Another instance running'
  }

  It 'acquires the Windows mutex on first attempt' {
    $script:LockResult = Acquire-TokensRankMutex

    $script:LockResult.acquired | Should -BeTrue
    $script:LockResult.name | Should -Be 'Global\TokensRankSync'
    $script:LockResult.mutex | Should -Not -BeNullOrEmpty
  }

  It 'blocks a second mutex acquire while held' {
    $script:LockResult = Acquire-TokensRankMutex

    { Acquire-TokensRankMutex } | Should -Throw -ExpectedMessage '*Another instance*'
  }

  It 'recovers after mutex owner release or process termination' {
    if (-not $script:IsWindowsHost) {
      $mutexSource = Get-Content -LiteralPath $script:MutexModule -Raw
      $mutexSource | Should -Match 'AbandonedMutexException'
      $mutexSource | Should -Match 'Release-TokensRankMutex'
      return
    }

    $readyFile = Join-Path $script:InstallRoot 'mutex-ready'
    $childCommand = @"
`$ErrorActionPreference = 'Stop'
. '$($script:MutexModule)'
`$lock = Acquire-TokensRankMutex
Set-Content -LiteralPath '$readyFile' -Value 'ready'
Start-Sleep -Seconds 60
"@
    $child = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile', '-Command', $childCommand) -PassThru -WindowStyle Hidden
    try {
      $deadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
      while (-not (Test-Path -LiteralPath $readyFile)) {
        if ([DateTimeOffset]::UtcNow -gt $deadline) {
          throw 'Timed out waiting for mutex holder process.'
        }
        Start-Sleep -Milliseconds 100
      }

      Stop-Process -Id $child.Id -Force
      $child.WaitForExit()
      $script:LockResult = Acquire-TokensRankMutex
      $script:LockResult.acquired | Should -BeTrue
    } finally {
      if (-not $child.HasExited) {
        Stop-Process -Id $child.Id -Force
      }
    }
  }
}
