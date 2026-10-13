<#
.SYNOPSIS
Acquires and releases the TokensRank Windows named mutex.

.DESCRIPTION
This script module provides a thin PowerShell wrapper over
System.Threading.Mutex for the TokensRank Windows runner. The mutex name is
Global\TokensRankSync so scheduled and manual invocations in the same Windows
session cannot process state.json concurrently.
#>

$script:TokensRankMutexName = 'Global\TokensRankSync'
$script:TokensRankMutexHeld = $false

function Acquire-TokensRankMutex {
  [CmdletBinding()]
  param()

  if ($script:TokensRankMutexHeld) {
    throw 'Another instance is running; exiting.'
  }

  $mutex = [System.Threading.Mutex]::new($false, $script:TokensRankMutexName)

  try {
    try {
      $acquired = $mutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
      $acquired = $true
    }

    if (-not $acquired) {
      $mutex.Dispose()
      throw 'Another instance is running; exiting.'
    }

    $script:TokensRankMutexHeld = $true

    [pscustomobject]@{
      acquired = $true
      mutex = $mutex
      name = $script:TokensRankMutexName
    }
  } catch {
    if ($mutex) {
      $mutex.Dispose()
    }
    throw
  }
}

function Release-TokensRankMutex {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $false)]
    [System.Threading.Mutex]$Mutex
  )

  if (-not $Mutex) {
    $script:TokensRankMutexHeld = $false
    return
  }

  try {
    if ($script:TokensRankMutexHeld) {
      $Mutex.ReleaseMutex()
    }
  } catch [System.ApplicationException] {
    throw 'TokensRank mutex release failed because the current thread does not own the mutex.'
  } finally {
    $Mutex.Dispose()
    $script:TokensRankMutexHeld = $false
  }
}
