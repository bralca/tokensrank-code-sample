Describe 'TokensRank Windows mutex cross-process behavior' {
  It 'blocks a second PowerShell process immediately while the first holds the mutex' {
    $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
    if (-not $pwsh) {
      $pwsh = Get-Command powershell -ErrorAction SilentlyContinue
    }
    if (-not $pwsh) {
      Set-ItResult -Skipped -Because 'PowerShell is required for cross-process mutex verification.'
      return
    }

    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
    $modulePath = (Resolve-Path (Join-Path $PSScriptRoot 'win-mutex.ps1')).Path.Replace("'", "''")
    $holderScript = Join-Path $tempDir 'hold-mutex.ps1'
    $contenderScript = Join-Path $tempDir 'try-mutex.ps1'
    $holderOut = Join-Path $tempDir 'holder.out'
    $holderErr = Join-Path $tempDir 'holder.err'
    $contenderOut = Join-Path $tempDir 'contender.out'
    $contenderErr = Join-Path $tempDir 'contender.err'
    $holder = $null

    try {
      New-Item -Path $tempDir -ItemType Directory -Force | Out-Null

      @"
. '$modulePath'
`$lockResult = Acquire-TokensRankMutex
try {
  Write-Output 'ACQUIRED'
  Start-Sleep -Seconds 2
} finally {
  if (`$lockResult -and `$lockResult.mutex) {
    Release-TokensRankMutex -Mutex `$lockResult.mutex
  }
}
"@ | Set-Content -Path $holderScript -Encoding UTF8

      @"
. '$modulePath'
`$lockResult = `$null
try {
  `$lockResult = Acquire-TokensRankMutex
  Write-Output 'ACQUIRED'
  exit 3
} catch {
  if (`$_.Exception.Message -like '*Another instance*') {
    Write-Output 'BLOCKED'
    exit 0
  }
  Write-Output "ERROR: `$(`$_.Exception.Message)"
  exit 2
} finally {
  if (`$lockResult -and `$lockResult.mutex) {
    Release-TokensRankMutex -Mutex `$lockResult.mutex
  }
}
"@ | Set-Content -Path $contenderScript -Encoding UTF8

      $holder = Start-Process -FilePath $pwsh.Source -ArgumentList @('-NoProfile', '-File', $holderScript) -RedirectStandardOutput $holderOut -RedirectStandardError $holderErr -PassThru

      $readyDeadline = [DateTimeOffset]::UtcNow.AddSeconds(5)
      while ([DateTimeOffset]::UtcNow -lt $readyDeadline) {
        if ((Test-Path -LiteralPath $holderOut) -and ((Get-Content -LiteralPath $holderOut -Raw -ErrorAction SilentlyContinue) -match 'ACQUIRED')) {
          break
        }
        if ($holder.HasExited) {
          throw "Holder process exited before acquiring mutex: $(Get-Content -LiteralPath $holderErr -Raw -ErrorAction SilentlyContinue)"
        }
        Start-Sleep -Milliseconds 50
      }

      (Get-Content -LiteralPath $holderOut -Raw -ErrorAction SilentlyContinue) | Should -Match 'ACQUIRED'

      $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
      $contender = Start-Process -FilePath $pwsh.Source -ArgumentList @('-NoProfile', '-File', $contenderScript) -RedirectStandardOutput $contenderOut -RedirectStandardError $contenderErr -Wait -PassThru
      $stopwatch.Stop()

      $contender.ExitCode | Should -Be 0
      (Get-Content -LiteralPath $contenderOut -Raw) | Should -Match 'BLOCKED'
      $stopwatch.ElapsedMilliseconds | Should -BeLessThan 1500
    } finally {
      if ($holder -and -not $holder.HasExited) {
        $holder.WaitForExit(5000) | Out-Null
      }
      if ($holder -and -not $holder.HasExited) {
        $holder.Kill()
        $holder.WaitForExit()
      }
      Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
