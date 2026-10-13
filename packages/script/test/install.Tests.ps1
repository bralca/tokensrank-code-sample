Describe 'TokensRank PowerShell installer' {
  BeforeAll {
    $script:ScriptRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
    $script:Installer = Join-Path $script:ScriptRoot 'install.ps1'
    $script:IsWindowsHost = if (Get-Variable -Name IsWindows -Scope Global -ErrorAction SilentlyContinue) { $IsWindows } else { $true }
  }

  BeforeEach {
    $script:InstallRoot = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
    $script:PreviousHome = $env:TOKENSRANK_HOME
    $script:PreviousSkipScheduler = $env:TOKENSRANK_SKIP_SCHEDULER_REGISTER
    $script:PreviousRunFirst = $env:TOKENSRANK_INSTALL_RUN_FIRST
    $script:PreviousAccessKey = $env:TOKENSRANK_ACCESS_KEY
    $script:PreviousProfileHandle = $env:TOKENSRANK_PROFILE_HANDLE
    $env:TOKENSRANK_HOME = $script:InstallRoot
    $env:TOKENSRANK_SKIP_SCHEDULER_REGISTER = '1'
    $env:TOKENSRANK_INSTALL_RUN_FIRST = '0'
    $env:TOKENSRANK_ACCESS_KEY = 'tr_script_test_key'
    $env:TOKENSRANK_PROFILE_HANDLE = $null
  }

  AfterEach {
    $env:TOKENSRANK_HOME = $script:PreviousHome
    $env:TOKENSRANK_SKIP_SCHEDULER_REGISTER = $script:PreviousSkipScheduler
    $env:TOKENSRANK_INSTALL_RUN_FIRST = $script:PreviousRunFirst
    $env:TOKENSRANK_ACCESS_KEY = $script:PreviousAccessKey
    $env:TOKENSRANK_PROFILE_HANDLE = $script:PreviousProfileHandle
    Remove-Item -LiteralPath $script:InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
  }

  function script:Invoke-IsolatedInstall {
    & pwsh -NoProfile -File $script:Installer | Out-String
    $LASTEXITCODE | Should -Be 0
  }

  function script:Get-Config {
    Get-Content -LiteralPath (Join-Path $script:InstallRoot 'config.json') -Raw | ConvertFrom-Json
  }

  function script:Get-State {
    Get-Content -LiteralPath (Join-Path $script:InstallRoot 'state.json') -Raw | ConvertFrom-Json
  }

  It 'first run succeeds' {
    $output = Invoke-IsolatedInstall

    $output | Should -Match 'TokensRank script installed at'
    Test-Path -LiteralPath (Join-Path $script:InstallRoot 'config.json') | Should -BeTrue
    Test-Path -LiteralPath (Join-Path $script:InstallRoot 'bin/agent.mjs') | Should -BeTrue
    Test-Path -LiteralPath (Join-Path $script:InstallRoot 'bin/tokensrank.ps1') | Should -BeTrue
    Test-Path -LiteralPath (Join-Path $script:InstallRoot 'bin/tokensrank.cmd') | Should -BeTrue
  }

  It 'config.json has user-only ACL on Windows' {
    Invoke-IsolatedInstall | Out-Null

    if (-not $script:IsWindowsHost) {
      Set-ItResult -Skipped -Because 'Windows ACL verification requires Windows.'
      return
    }

    $acl = Get-Acl -LiteralPath (Join-Path $script:InstallRoot 'config.json')
    $acl.AreAccessRulesProtected | Should -BeTrue
    $acl.Access.Count | Should -Be 1
    $acl.Access[0].IdentityReference.Value | Should -Be ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
  }

  It 'config.json has a valid JSON structure' {
    Invoke-IsolatedInstall | Out-Null

    $config = Get-Config
    $config.access_key | Should -Be 'tr_script_test_key'
    $config.api_base | Should -Be 'https://api.tokensrank.ai'
    $config.PSObject.Properties.Name | Should -Contain 'profile_handle'
    $config.client_version | Should -Not -BeNullOrEmpty
    $config.ingestion_mode | Should -Be 'script'
  }

  It 'install_id is UUID v4' {
    Invoke-IsolatedInstall | Out-Null

    $config = Get-Config
    $config.install_id | Should -Match '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  }

  It 'is idempotent and preserves config.json' {
    Invoke-IsolatedInstall | Out-Null
    $configPath = Join-Path $script:InstallRoot 'config.json'
    $before = Get-Content -LiteralPath $configPath -Raw

    Invoke-IsolatedInstall | Out-Null
    $after = Get-Content -LiteralPath $configPath -Raw

    $after | Should -Be $before
  }

  It 'updates access key and clears invalid state on reinstall' {
    $env:TOKENSRANK_ACCESS_KEY = 'tr_script_old_key'
    Invoke-IsolatedInstall | Out-Null

    $initialConfig = Get-Config
    $installId = $initialConfig.install_id
    $statePath = Join-Path $script:InstallRoot 'state.json'
    $staleState = [ordered]@{
      install_id = $installId
      access_key_invalid = $true
      last_run_at = $null
      shipped_session_ids = @('keep-session')
      pending_payloads = @(@{ id = 'pending-payload' })
    }
    [System.IO.File]::WriteAllText(
      $statePath,
      "$(ConvertTo-Json -InputObject $staleState -Depth 20)`n",
      [System.Text.UTF8Encoding]::new($false)
    )

    $env:TOKENSRANK_ACCESS_KEY = 'tr_script_new_key'
    $env:TOKENSRANK_PROFILE_HANDLE = 'alex'
    Invoke-IsolatedInstall | Out-Null

    $updatedConfig = Get-Config
    $updatedState = Get-State
    $accessKeyHandoff = (Get-Content -LiteralPath (Join-Path $script:InstallRoot 'access-key') -Raw).Trim()

    $updatedConfig.access_key | Should -Be 'tr_script_new_key'
    $updatedConfig.profile_handle | Should -Be 'alex'
    $updatedConfig.install_id | Should -Be $installId
    $updatedState.install_id | Should -Be $installId
    $updatedState.access_key_invalid | Should -BeFalse
    $updatedState.shipped_session_ids.Count | Should -Be 0
    $updatedState.pending_payloads.Count | Should -Be 0
    $accessKeyHandoff | Should -Be 'tr_script_new_key'
  }

  It 'repeat install completes in less than 5 seconds' {
    Invoke-IsolatedInstall | Out-Null
    $watch = [System.Diagnostics.Stopwatch]::StartNew()

    Invoke-IsolatedInstall | Out-Null
    $watch.Stop()

    $watch.Elapsed.TotalSeconds | Should -BeLessThan 5
  }

  It 'Task Scheduler registration is present in install.ps1' {
    $source = Get-Content -LiteralPath $script:Installer -Raw

    $source | Should -Match 'Register-ScheduledTask'
    $source | Should -Match 'TokensRank'
    $source | Should -Match 'New-ScheduledTaskTrigger -AtStartup'
    $source | Should -Match 'RepetitionInterval'
  }

  It 'Task Scheduler action is configured for the PowerShell mutex wrapper' {
    $source = Get-Content -LiteralPath $script:Installer -Raw

    $source | Should -Match "New-ScheduledTaskAction -Execute 'powershell.exe'"
    $source | Should -Match 'tokensrank\.ps1'
    $source | Should -Match '--scan-home'
    $source | Should -Match 'Global\\TokensRankSync'
  }

  It 'Task Scheduler settings enable StartWhenAvailable' {
    $source = Get-Content -LiteralPath $script:Installer -Raw

    $source | Should -Match 'StartWhenAvailable'
    $source | Should -Match 'AllowStartIfOnBatteries'
    $source | Should -Match 'DontStopIfGoingOnBatteries'
  }

  It 'cleanup and isolation keep artifacts under TOKENSRANK_HOME' {
    Invoke-IsolatedInstall | Out-Null

    Test-Path -LiteralPath (Join-Path $script:InstallRoot 'state.json') | Should -BeTrue
    Test-Path -LiteralPath (Join-Path $script:InstallRoot 'logs/install.log') | Should -BeTrue
    (Join-Path $script:InstallRoot 'config.json') | Should -Match ([regex]::Escape($script:InstallRoot))
  }
}
