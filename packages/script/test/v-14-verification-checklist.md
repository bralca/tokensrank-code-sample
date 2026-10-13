# V-14 Verification Checklist

Task: 93.0 - V-14 Integration: script idempotency, file lock crash recovery, scheduler catch-up

Last local verification: 2026-04-29 on macOS with package-local Bats and Pester.

## Test Files

| File | Cases | Status | Scope |
| --- | ---: | --- | --- |
| `packages/script/test/idempotency.bats` | 6 | Verified | POSIX install idempotency, UUID, config mode, scheduler dedupe, state lifecycle |
| `packages/script/test/lock-recovery.bats` | 6 | Verified | POSIX lock acquisition, contention, stale detection, crash release |
| `packages/script/test/catch-up.bats` | 8 | Verified | POSIX scheduler catch-up, guard, force/first-run, batching, dedup, privacy dry-run |
| `packages/script/test/idempotency-lock-recovery.Tests.ps1` | 9 | Verified | Windows installer idempotency, config ACL contract, Task Scheduler dedupe, mutex behavior |
| `packages/script/test/catch-up.Tests.ps1` | 8 | Verified | Windows Task Scheduler catch-up, guard, force/first-run, batching, privacy dry-run |

Local command:

```bash
pnpm --filter @tokensrank/script exec bats test/idempotency.bats test/lock-recovery.bats test/catch-up.bats
pnpm --filter @tokensrank/script exec pwsh -NoProfile -Command "Invoke-Pester -Path test/idempotency-lock-recovery.Tests.ps1,test/catch-up.Tests.ps1 -CI"
```

Observed result: 37 passed, 0 failed, 0 skipped.

## Requirement Traceability

| Requirement | Coverage |
| --- | --- |
| FR-69 install idempotency | `idempotency.bats`; `idempotency-lock-recovery.Tests.ps1` repeat installs preserve config/state and scheduler registration is deduplicated |
| FR-70 UUID install_id | `idempotency.bats`; `idempotency-lock-recovery.Tests.ps1` validate UUID v4 and config/state continuity |
| FR-71 atomic secure config.json | `idempotency.bats` verifies POSIX mode 0600; `idempotency-lock-recovery.Tests.ps1` verifies Windows ACL contract/user-only ACL |
| FR-72 file lock / Mutex | `lock-recovery.bats`; `idempotency-lock-recovery.Tests.ps1` cover lock acquire, conflict, release, and named Mutex |
| FR-73 last-run guard | `catch-up.bats`; `catch-up.Tests.ps1` verify 30-minute skip and `--force`/`--first-run` bypass |
| FR-74 atomic state writes | `catch-up.bats`; `catch-up.Tests.ps1` verify post-run state remains valid JSON and temp state files do not remain after writes |
| FR-75 shipped-session dedup | `catch-up.bats` verifies shipped sessions are not emitted again during catch-up dry-run |
| FR-76 offline queue | `catch-up.bats`; `catch-up.Tests.ps1` verify missing-key catch-up batches are queued FIFO in `pending_payloads` |
| FR-77 dry-run mode | `catch-up.bats`; `catch-up.Tests.ps1` execute `agent.mjs --dry-run` and assert payload summaries without state shipment |
| FR-78 privacy allowlist | `catch-up.bats`; `catch-up.Tests.ps1` inject forbidden prompt/response/path fields and assert dry-run output excludes them |
| FR-79 hourly scheduler registration | `idempotency.bats`; `catch-up.bats`; `catch-up.Tests.ps1` verify launchd StartInterval, systemd OnUnitActiveSec, Windows hourly trigger |
| FR-80 scheduler catch-up | `catch-up.bats`; `catch-up.Tests.ps1` verify RunAtLoad, Persistent/OnBootSec, StartWhenAvailable/AtStartup |
| FR-81 Linux RandomizedDelaySec | `catch-up.bats` verifies `RandomizedDelaySec=5min` in `tokensrank.timer` |
| NFR-21 scheduler catch-up after sleep/reboot | `catch-up.bats`; `catch-up.Tests.ps1` verify platform scheduler catch-up settings |
| NFR-23 POSIX lock crash recovery | `lock-recovery.bats` kills a lock owner and verifies the next process acquires the OS lock |
| NFR-24 Windows Mutex process-scoped release | `idempotency-lock-recovery.Tests.ps1` verifies Mutex release/reacquire and Windows process-termination branch |
| SL-13 lock lifecycle | `lock-recovery.bats`; `idempotency-lock-recovery.Tests.ps1` cover create/acquire/block/release |
| SL-14 state.json lifecycle | `idempotency.bats`; `idempotency-lock-recovery.Tests.ps1` cover initialization and non-reset on reinstall |
| SL-17 last_run_at guard | `catch-up.bats`; `catch-up.Tests.ps1` cover skip, force, and first-run behavior |
| V-14 graceful stale operation | This task's script-side V-14 integration risk is covered by idempotent reruns, crash-safe locks, and catch-up execution. Leaderboard degraded-cache UI behavior remains covered by backend/frontend V-14 tests outside `packages/script`. |
| O-11 Claude transcript ownership | `catch-up.bats`; `catch-up.Tests.ps1` privacy dry-run assertions confirm forbidden local transcript fields are not emitted |
| O-12 Codex transcript ownership | `catch-up.bats`; `catch-up.Tests.ps1` privacy dry-run assertions use mixed Claude/Codex fixture sessions and forbidden local fields |

## CI Verification

| CI item | Status |
| --- | --- |
| Matrix includes `ubuntu-latest` | Verified in `.github/workflows/ci.yml` `script-tests` matrix |
| Matrix includes `macos-latest` | Verified in `.github/workflows/ci.yml` `script-tests` matrix |
| Matrix includes `windows-latest` | Verified in `.github/workflows/ci.yml` `script-tests` matrix |
| POSIX conditional step | Verified: `runner.os != 'Windows'` runs `pnpm --filter @tokensrank/script test:posix` |
| Windows conditional step | Verified: `runner.os == 'Windows'` runs `pnpm --filter @tokensrank/script test:windows` |
| Artifact upload | Verified: `actions/upload-artifact@v4` runs with `if: always()` and ignores missing local reports |

No coverage gaps remain for FR-69 through FR-81, NFR-21/23/24, or SL-13/14/17 in the five V-14 test files plus CI wiring.
