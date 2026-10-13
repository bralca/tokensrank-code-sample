Describe 'TokensRank dry-run mode' {
  BeforeAll {
    $script:Agent = (Resolve-Path (Join-Path $PSScriptRoot '..' 'bin' 'agent.mjs')).Path
    $script:Fixtures = (Resolve-Path (Join-Path $PSScriptRoot 'fixtures')).Path
    $script:GetDryRunJson = {
      param(
        [Parameter(Mandatory = $false)]
        [object]$Output
      )

      $text = if ($null -eq $Output) {
        ''
      } elseif ($Output -is [array]) {
        ($Output -join [Environment]::NewLine)
      } else {
        [string]$Output
      }
      $index = $text.IndexOf('{')
      if ($index -lt 0) {
        throw 'Dry-run output did not contain JSON.'
      }

      return $text.Substring($index) | ConvertFrom-Json
    }
    $script:NewDryRunFixture = {
      param(
        [Parameter(Mandatory = $true)]
        [string]$Root
      )

      $inputPath = Join-Path $Root 'input.json'
      @'
{
  "sessions": [
    {
      "session_id": "dry-run-pester-session",
      "source": "claude",
      "model": "claude-3-5-sonnet-20241022",
      "first_event_at": "2026-04-27T10:00:00.000Z",
      "last_event_at": "2026-04-27T10:05:00.000Z",
      "input_tokens": 10,
      "output_tokens": 5,
      "cache_read_input_tokens": 2,
      "cache_creation_input_tokens": 1,
      "cached_input_tokens": 0,
      "reasoning_output_tokens": 0,
      "turns": 2,
      "file_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ]
}
'@ | Set-Content -LiteralPath $inputPath -Encoding UTF8

      return $inputPath
    }
  }

  BeforeEach {
    $script:TestHome = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
    New-Item -Path $script:TestHome -ItemType Directory -Force | Out-Null
  }

  AfterEach {
    Remove-Item -LiteralPath $script:TestHome -Recurse -Force -ErrorAction SilentlyContinue
  }

  It 'recognizes --dry-run and exits 0' {
    $previousHome = $env:TOKENSRANK_HOME
    $env:TOKENSRANK_HOME = $script:TestHome

    try {
      $output = & node $script:Agent --dry-run
      $LASTEXITCODE | Should -Be 0
      ($output -join "`n") | Should -Match 'Dry-run mode: would send 0 sessions in 0 batch\(es\)'
    } finally {
      $env:TOKENSRANK_HOME = $previousHome
    }
  }

  It 'prints valid JSON payload output' {
    $inputPath = & $script:NewDryRunFixture -Root $script:TestHome
    $previousHome = $env:TOKENSRANK_HOME
    $env:TOKENSRANK_HOME = $script:TestHome

    try {
      $output = & node $script:Agent --dry-run --input $inputPath
      $LASTEXITCODE | Should -Be 0
      $json = & $script:GetDryRunJson -Output $output
      $json.sessions[0].session_id | Should -Be 'dry-run-pester-session'
    } finally {
      $env:TOKENSRANK_HOME = $previousHome
    }
  }

  It 'does not create a lock file' {
    $inputPath = & $script:NewDryRunFixture -Root $script:TestHome
    $previousHome = $env:TOKENSRANK_HOME
    $env:TOKENSRANK_HOME = $script:TestHome

    try {
      & node $script:Agent --dry-run --input $inputPath | Out-Null
      $LASTEXITCODE | Should -Be 0
      Test-Path -LiteralPath (Join-Path $script:TestHome '.lock') | Should -BeFalse
    } finally {
      $env:TOKENSRANK_HOME = $previousHome
    }
  }

  It 'does not modify state.json' {
    $inputPath = & $script:NewDryRunFixture -Root $script:TestHome
    $statePath = Join-Path $script:TestHome 'state.json'
    '{"last_run_at":"2099-01-01T00:00:00.000Z","shipped_session_ids":[],"pending_payloads":[]}' | Set-Content -LiteralPath $statePath -Encoding UTF8
    $before = Get-Content -LiteralPath $statePath -Raw
    $previousHome = $env:TOKENSRANK_HOME
    $env:TOKENSRANK_HOME = $script:TestHome

    try {
      & node $script:Agent --dry-run --input $inputPath --state $statePath | Out-Null
      $LASTEXITCODE | Should -Be 0
      (Get-Content -LiteralPath $statePath -Raw) | Should -Be $before
    } finally {
      $env:TOKENSRANK_HOME = $previousHome
    }
  }

  It 'extracts fixture-based Claude and Codex sessions' {
    $previousHome = $env:TOKENSRANK_HOME
    $env:TOKENSRANK_HOME = $script:TestHome

    try {
      $output = & node $script:Agent --dry-run --claude-root (Join-Path $script:Fixtures 'claude') --codex-root (Join-Path $script:Fixtures 'codex')
      $LASTEXITCODE | Should -Be 0
      ($output -join "`n") | Should -Match 'Dry-run mode: would send 3 sessions in 1 batch\(es\)'
      ($output -join "`n") | Should -Match 'Sessions summary:'
      $json = & $script:GetDryRunJson -Output $output
      $json.sessions.Count | Should -Be 3
    } finally {
      $env:TOKENSRANK_HOME = $previousHome
    }
  }
}
