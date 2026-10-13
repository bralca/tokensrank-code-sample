Describe 'V-14 Windows scheduler catch-up' {
  BeforeAll {
    $script:ScriptRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
    $script:Installer = Join-Path $script:ScriptRoot 'install.ps1'
    $script:Agent = Join-Path $script:ScriptRoot 'bin/agent.mjs'
    $script:InstallerSource = Get-Content -LiteralPath $script:Installer -Raw
  }

  BeforeEach {
    $script:TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString('N'))
    $script:TokensRankHome = Join-Path $script:TestRoot '.tokensrank'
    New-Item -Path $script:TokensRankHome -ItemType Directory -Force | Out-Null
    $script:PreviousHome = $env:TOKENSRANK_HOME
    $script:PreviousAccessKey = $env:TOKENSRANK_ACCESS_KEY
    $env:TOKENSRANK_HOME = $script:TokensRankHome
    $env:TOKENSRANK_ACCESS_KEY = ''
  }

  AfterEach {
    $env:TOKENSRANK_HOME = $script:PreviousHome
    $env:TOKENSRANK_ACCESS_KEY = $script:PreviousAccessKey
    Remove-Item -LiteralPath $script:TestRoot -Recurse -Force -ErrorAction SilentlyContinue
  }

  function script:Get-StatePath {
    Join-Path $script:TokensRankHome 'state.json'
  }

  function script:Write-TestState {
    param([AllowNull()][string]$LastRunAt)

    $state = [ordered]@{
      install_id = '11111111-1111-4111-8111-111111111111'
      access_key_invalid = $false
      last_run_at = $LastRunAt
      shipped_session_ids = @()
      pending_payloads = @()
    }
    $state | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Get-StatePath) -Encoding utf8
  }

  function script:Write-TestInput {
    param(
      [string]$Path,
      [int]$Count
    )

    $sessions = for ($index = 0; $index -lt $Count; $index += 1) {
      [ordered]@{
        session_id = "win-catch-up-$index"
        source = if ($index % 2 -eq 0) { 'claude' } else { 'codex' }
        model = if ($index % 2 -eq 0) { 'claude-3-5-sonnet-20241022' } else { 'gpt-5.3-codex' }
        first_event_at = '2026-04-29T08:00:00.000Z'
        last_event_at = '2026-04-29T08:01:00.000Z'
        input_tokens = 10 + $index
        output_tokens = 5
        cache_read_input_tokens = 0
        cache_creation_input_tokens = 0
        cached_input_tokens = 0
        reasoning_output_tokens = 0
        turns = 1
        file_sha256 = ('a' * 60) + ('{0:d4}' -f $index)
      }
    }
    [ordered]@{ sessions = @($sessions) } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Path -Encoding utf8
  }

  function script:Invoke-TestAgent {
    param([string[]]$Arguments)

    $output = & node $script:Agent @Arguments 2>&1 | Out-String
    [pscustomobject]@{
      ExitCode = $LASTEXITCODE
      Output = $output
    }
  }

  It 'configures Task Scheduler StartWhenAvailable for missed-run catch-up' {
    $script:InstallerSource | Should -Match 'New-ScheduledTaskSettingsSet'
    $script:InstallerSource | Should -Match 'StartWhenAvailable'
  }

  It 'configures an hourly recurrence trigger' {
    $script:InstallerSource | Should -Match 'New-ScheduledTaskTrigger -Once'
    $script:InstallerSource | Should -Match 'RepetitionInterval \(New-TimeSpan -Hours 1\)'
  }

  It 'configures an AtStartup trigger for reboot catch-up' {
    $script:InstallerSource | Should -Match 'New-ScheduledTaskTrigger -AtStartup'
    $script:InstallerSource | Should -Match '\$startupTrigger'
  }

  It 'runs as the current user with overlapping instances ignored' {
    $script:InstallerSource | Should -Match 'WindowsIdentity\]::GetCurrent\(\)\.Name'
    $script:InstallerSource | Should -Match 'New-ScheduledTaskPrincipal -UserId \$currentUser -LogonType Interactive -RunLevel Limited'
    $script:InstallerSource | Should -Match 'MultipleInstances IgnoreNew'
  }

  It 'last-run guard skips runs within 30 minutes without changing state' {
    Write-TestState -LastRunAt (Get-Date).ToUniversalTime().ToString('o')
    $inputPath = Join-Path $script:TestRoot 'input.json'
    Write-TestInput -Path $inputPath -Count 1
    $before = Get-Content -LiteralPath (Get-StatePath) -Raw

    $result = Invoke-TestAgent -Arguments @('--input', $inputPath, '--state', (Get-StatePath))

    $result.ExitCode | Should -Be 0
    $result.Output | Should -Match 'Skipping run \(last_run_at within 30 minutes\)'
    (Get-Content -LiteralPath (Get-StatePath) -Raw) | Should -Be $before
  }

  It '--force bypasses the 30-minute last-run guard' {
    Write-TestState -LastRunAt (Get-Date).ToUniversalTime().ToString('o')
    $inputPath = Join-Path $script:TestRoot 'input.json'
    Write-TestInput -Path $inputPath -Count 1

    $result = Invoke-TestAgent -Arguments @('--force', '--input', $inputPath, '--state', (Get-StatePath))

    $state = Get-Content -LiteralPath (Get-StatePath) -Raw | ConvertFrom-Json
    $result.ExitCode | Should -Be 0
    $result.Output | Should -Match '"accepted":1'
    @($state.pending_payloads).Count | Should -Be 1
    @(Get-ChildItem -LiteralPath $script:TokensRankHome -Filter '.state.json.tmp.*' -Force).Count | Should -Be 0
    { Get-Content -LiteralPath (Get-StatePath) -Raw | ConvertFrom-Json } | Should -Not -Throw
  }

  It '--first-run bypasses the 30-minute last-run guard' {
    Write-TestState -LastRunAt (Get-Date).ToUniversalTime().ToString('o')
    $inputPath = Join-Path $script:TestRoot 'input.json'
    Write-TestInput -Path $inputPath -Count 1

    $result = Invoke-TestAgent -Arguments @('--first-run', '--input', $inputPath, '--state', (Get-StatePath))

    $state = Get-Content -LiteralPath (Get-StatePath) -Raw | ConvertFrom-Json
    $result.ExitCode | Should -Be 0
    $result.Output | Should -Match '"accepted":1'
    @($state.pending_payloads).Count | Should -Be 1
  }

  It 'catch-up queues batches FIFO when more than 100 sessions are pending' {
    Write-TestState -LastRunAt '2026-04-29T00:00:00.000Z'
    $inputPath = Join-Path $script:TestRoot 'input.json'
    Write-TestInput -Path $inputPath -Count 205

    $result = Invoke-TestAgent -Arguments @('--force', '--input', $inputPath, '--state', (Get-StatePath))

    $state = Get-Content -LiteralPath (Get-StatePath) -Raw | ConvertFrom-Json
    $result.ExitCode | Should -Be 0
    $result.Output | Should -Match '"accepted":205'
    $result.Output | Should -Match '"queued":3'
    @($state.pending_payloads).Count | Should -Be 3

    $privacyStatePath = Join-Path $script:TestRoot 'privacy-state.json'
    Write-TestState -LastRunAt '2026-04-29T00:00:00.000Z'
    Copy-Item -LiteralPath (Get-StatePath) -Destination $privacyStatePath -Force
    $privacyInputPath = Join-Path $script:TestRoot 'privacy-input.json'
    Write-TestInput -Path $privacyInputPath -Count 1
    $privacyInput = Get-Content -LiteralPath $privacyInputPath -Raw | ConvertFrom-Json
    $privacyInput.sessions[0] | Add-Member -NotePropertyName prompt -NotePropertyValue 'private prompt'
    $privacyInput.sessions[0] | Add-Member -NotePropertyName response -NotePropertyValue 'private response'
    $privacyInput.sessions[0] | Add-Member -NotePropertyName file_path -NotePropertyValue 'C:\Users\alex\private\project'
    $privacyInput | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $privacyInputPath -Encoding utf8

    $privacyResult = Invoke-TestAgent -Arguments @('--dry-run', '--input', $privacyInputPath, '--state', $privacyStatePath)
    $privacyResult.ExitCode | Should -Be 0
    $privacyResult.Output | Should -Match 'Dry-run mode: would send 1 sessions in 1 batch\(es\)'
    $privacyResult.Output | Should -Not -Match 'private prompt'
    $privacyResult.Output | Should -Not -Match 'private response'
    $privacyResult.Output | Should -Not -Match 'C:\\Users\\alex\\private\\project'
  }
}
