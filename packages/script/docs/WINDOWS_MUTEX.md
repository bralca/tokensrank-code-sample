# Windows Mutex Handling

TokensRank uses a Windows named mutex to ensure only one PowerShell runner can
execute `agent.mjs` at a time. This protects `~/.tokensrank/state.json` from
concurrent reads and atomic writes, and it prevents duplicate session uploads
when Task Scheduler starts a new run while an older run is still active.

## Mutex Name

The mutex name is:

```text
Global\TokensRankSync
```

The `Global\` prefix makes the name visible across Windows sessions. Every
TokensRank Windows runner must use this exact name so scheduled runs and manual
runs coordinate through the same lock.

## How Acquisition Works

`packages/script/src/runtime/win-mutex.ps1` wraps
`System.Threading.Mutex`. Acquisition uses `WaitOne(0)`, which is non-blocking:

```powershell
. "$PSScriptRoot\src\runtime\win-mutex.ps1"

$lockResult = $null
try {
  $lockResult = Acquire-TokensRankMutex
  node "$PSScriptRoot\bin\agent.mjs"
} finally {
  if ($lockResult -and $lockResult.mutex) {
    Release-TokensRankMutex -Mutex $lockResult.mutex
  }
}
```

If another process already holds `Global\TokensRankSync`,
`Acquire-TokensRankMutex` throws `Another instance is running; exiting.`.
`install.ps1` catches that error, writes it to stderr, and exits with code `1`.
The caller should treat exit `1` as "run skipped because another TokensRank
agent is active."

## Windows Mutex vs POSIX flock

POSIX runners use `flock` on a lock file such as `~/.tokensrank/.lock`.
Windows runners do not rely on a lock file. They use an OS mutex object.

Key differences:

| Behavior | POSIX `flock` | Windows mutex |
| --- | --- | --- |
| Scope | File descriptor on a lock file | Named OS synchronization object |
| TokensRank name | `~/.tokensrank/.lock` | `Global\TokensRankSync` |
| Acquisition | `flock -n` | `WaitOne(0)` |
| Wait behavior | Non-blocking | Non-blocking |
| Manual release | Unlock or close file descriptor | `ReleaseMutex()` and `Dispose()` |
| Crash behavior | Kernel releases when descriptor closes | OS releases when process terminates |

Both mechanisms are process-scoped for TokensRank's purposes: if the runner
dies, the operating system releases the lock and the next scheduled run can
proceed without deleting a stale file.

## Crash Scenarios

Normal completion:

1. PowerShell acquires `Global\TokensRankSync`.
2. `agent.mjs` reads and writes local state.
3. `finally` calls `Release-TokensRankMutex`.
4. The next run can acquire immediately.

Runner crash:

1. PowerShell acquires `Global\TokensRankSync`.
2. PowerShell or Node terminates unexpectedly.
3. Windows releases the process-scoped mutex during process teardown.
4. The next Task Scheduler run can acquire the mutex without manual cleanup.

Overlapping scheduler fire:

1. Process A acquires the mutex and is still running.
2. Process B starts and calls `WaitOne(0)`.
3. Process B receives `Another instance is running; exiting.` immediately.
4. Process B exits `1`; Process A continues and releases the mutex when done.

## Operational Notes

- Do not replace the named mutex with a filesystem lock on Windows.
- Do not change the mutex name without updating tests and all Windows wrappers.
- Exit `1` from `install.ps1` means concurrency protection worked; it is not a
  data corruption event.
- The release function still calls `ReleaseMutex()` and `Dispose()` during
  normal execution to keep handles short-lived, even though Windows also
  releases the mutex on process termination.
