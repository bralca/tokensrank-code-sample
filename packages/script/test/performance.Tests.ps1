Describe 'TokensRank agent performance' {
  BeforeAll {
    $script:Agent = (Resolve-Path (Join-Path $PSScriptRoot '..' 'bin' 'agent.mjs')).Path
  }

  BeforeEach {
    $script:TestHome = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
    New-Item -Path $script:TestHome -ItemType Directory -Force | Out-Null
    $script:InputPath = Join-Path $script:TestHome 'performance-1000.json'

    $sessions = for ($index = 0; $index -lt 1000; $index += 1) {
      $id = "perf-session-$index"
      $sha = [System.BitConverter]::ToString(
        [System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($id))
      ).Replace('-', '').ToLowerInvariant()

      [ordered]@{
        session_id = $id
        source = if ($index % 2 -eq 0) { 'claude' } else { 'codex' }
        model = if ($index % 2 -eq 0) { 'claude-3-5-sonnet-20241022' } else { 'gpt-5-codex' }
        first_event_at = '2026-04-27T10:00:00.000Z'
        last_event_at = '2026-04-27T10:05:00.000Z'
        input_tokens = 1000 + $index
        output_tokens = 250
        cache_read_input_tokens = 0
        cache_creation_input_tokens = 0
        cached_input_tokens = 0
        reasoning_output_tokens = 0
        turns = 2
        file_sha256 = $sha
      }
    }

    [ordered]@{ sessions = @($sessions) } |
      ConvertTo-Json -Depth 20 |
      Set-Content -LiteralPath $script:InputPath -Encoding UTF8
  }

  AfterEach {
    Remove-Item -LiteralPath $script:TestHome -Recurse -Force -ErrorAction SilentlyContinue
  }

  It 'processes 1000 sessions within the Windows runtime budget' {
    $previousHome = $env:TOKENSRANK_HOME
    $env:TOKENSRANK_HOME = $script:TestHome

    try {
      $elapsed = Measure-Command {
        $output = & node $script:Agent --dry-run --input $script:InputPath
        $script:PerformanceOutput = ($output -join "`n")
      }

      $LASTEXITCODE | Should -Be 0
      $script:PerformanceOutput | Should -Match 'Dry-run mode: would send 1000 sessions in 10 batch\(es\)'
      $elapsed.TotalSeconds | Should -BeLessThan 60
    } finally {
      $env:TOKENSRANK_HOME = $previousHome
    }
  }
}
