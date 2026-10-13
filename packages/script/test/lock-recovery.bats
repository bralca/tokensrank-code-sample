#!/usr/bin/env bats

setup_file() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SCRIPT_ROOT="$REPO_ROOT/packages/script"
  export TOKENSRANK_LOCK_TEST_ROOT="${TOKENSRANK_LOCK_TEST_ROOT:-$HOME/.tokensrank-lock-recovery-test}"
  export TOKENSRANK_LOCK_TEST_DIST="$TOKENSRANK_LOCK_TEST_ROOT/dist"
  export LOCK_MODULE="$TOKENSRANK_LOCK_TEST_DIST/script/src/runtime/file-lock.js"

  rm -rf "$TOKENSRANK_LOCK_TEST_ROOT"
  mkdir -p "$TOKENSRANK_LOCK_TEST_ROOT"
  (cd "$SCRIPT_ROOT" && pnpm exec tsc -p tsconfig.json --noEmit false --declaration false --declarationMap false --outDir "$TOKENSRANK_LOCK_TEST_DIST")
}

teardown_file() {
  rm -rf "$TOKENSRANK_LOCK_TEST_ROOT"
}

setup() {
  TEST_ROOT="$(mktemp -d "$TOKENSRANK_LOCK_TEST_ROOT/case.XXXXXX")"
}

teardown() {
  if [[ -n "${HOLDER_PID:-}" ]]; then
    kill "$HOLDER_PID" >/dev/null 2>&1 || true
    wait "$HOLDER_PID" >/dev/null 2>&1 || true
    unset HOLDER_PID
  fi
  rm -rf "$TEST_ROOT"
}

wait_for_file() {
  local file="$1"
  local attempts=80
  while [[ "$attempts" -gt 0 ]]; do
    [[ -f "$file" ]] && return 0
    sleep 0.1
    attempts=$((attempts - 1))
  done
  return 1
}

@test "acquires and releases ~/.tokensrank/.lock with metadata" {
  run env LOCK_MODULE="$LOCK_MODULE" LOCK_PATH="$TEST_ROOT/.tokensrank/.lock" node --input-type=module -e '
    import { readFile } from "node:fs/promises";
    const { acquireLock, releaseLock } = await import(process.env.LOCK_MODULE);
    const handle = await acquireLock(process.env.LOCK_PATH);
    const metadata = JSON.parse(await readFile(process.env.LOCK_PATH, "utf8"));
    if (!Number.isInteger(metadata.pid) || metadata.pid <= 0) process.exit(1);
    if (metadata.owner_pid !== process.pid) process.exit(2);
    if (!metadata.acquired_at) process.exit(3);
    await releaseLock(handle);
  '

  [ "$status" -eq 0 ]
  [ -f "$TEST_ROOT/.tokensrank/.lock" ]
}

@test "blocks a second lock holder while the first process is running" {
  READY_FILE="$TEST_ROOT/holder-ready"
  env LOCK_MODULE="$LOCK_MODULE" LOCK_PATH="$TEST_ROOT/.lock" READY_FILE="$READY_FILE" node --input-type=module -e '
    import { writeFile } from "node:fs/promises";
    const { acquireLock, releaseLock } = await import(process.env.LOCK_MODULE);
    const handle = await acquireLock(process.env.LOCK_PATH);
    await writeFile(process.env.READY_FILE, "ready");
    process.on("SIGTERM", async () => {
      await releaseLock(handle);
      process.exit(0);
    });
    setInterval(() => undefined, 1000);
  ' &
  HOLDER_PID="$!"
  wait_for_file "$READY_FILE"

  run env LOCK_MODULE="$LOCK_MODULE" LOCK_PATH="$TEST_ROOT/.lock" node --input-type=module -e '
    const { acquireLock } = await import(process.env.LOCK_MODULE);
    try {
      await acquireLock(process.env.LOCK_PATH);
    } catch (error) {
      if (error?.code === "LOCK_CONFLICT") process.exit(0);
      throw error;
    }
    process.exit(1);
  '

  [ "$status" -eq 0 ]
}

@test "detects a stale dead-process lock older than 4 hours" {
  run env LOCK_MODULE="$LOCK_MODULE" LOCK_PATH="$TEST_ROOT/.lock" node --input-type=module -e '
    import { utimes, writeFile } from "node:fs/promises";
    const { detectStaleLock } = await import(process.env.LOCK_MODULE);
    await writeFile(process.env.LOCK_PATH, `${JSON.stringify({ pid: 9999999, started_at: "2026-04-28T00:00:00.000Z" })}\n`, { mode: 0o600 });
    const old = new Date(Date.now() - (4 * 60 * 60 * 1000) - 60_000);
    await utimes(process.env.LOCK_PATH, old, old);
    const result = await detectStaleLock(process.env.LOCK_PATH);
    if (!result.exists || !result.stale || result.pidAlive) process.exit(1);
    if (result.ageMs < 4 * 60 * 60 * 1000) process.exit(2);
  '

  [ "$status" -eq 0 ]
}

@test "does not mark a recent lock as stale" {
  run env LOCK_MODULE="$LOCK_MODULE" LOCK_PATH="$TEST_ROOT/.lock" node --input-type=module -e '
    import { writeFile } from "node:fs/promises";
    const { detectStaleLock } = await import(process.env.LOCK_MODULE);
    await writeFile(process.env.LOCK_PATH, `${JSON.stringify({ pid: 9999999, started_at: new Date().toISOString() })}\n`, { mode: 0o600 });
    const result = await detectStaleLock(process.env.LOCK_PATH);
    if (!result.exists) process.exit(1);
    if (result.stale) process.exit(2);
  '

  [ "$status" -eq 0 ]
}

@test "stale recovery removes the placeholder and acquires exclusively" {
  run env LOCK_MODULE="$LOCK_MODULE" LOCK_PATH="$TEST_ROOT/.lock" node --input-type=module -e '
    import { readFile, utimes, writeFile } from "node:fs/promises";
    const { acquireLockWithStaleRecovery, releaseLock } = await import(process.env.LOCK_MODULE);
    await writeFile(process.env.LOCK_PATH, `${JSON.stringify({ pid: 9999999, started_at: "2026-04-28T00:00:00.000Z" })}\n`, { mode: 0o600 });
    const old = new Date(Date.now() - (5 * 60 * 60 * 1000));
    await utimes(process.env.LOCK_PATH, old, old);
    const handle = await acquireLockWithStaleRecovery(process.env.LOCK_PATH, { logger: { warn() {} } });
    const metadata = JSON.parse(await readFile(process.env.LOCK_PATH, "utf8"));
    if (!Number.isInteger(metadata.pid) || metadata.pid <= 0) process.exit(1);
    if (metadata.owner_pid !== process.pid) process.exit(2);
    await releaseLock(handle);
  '

  [ "$status" -eq 0 ]
}

@test "process crash releases the OS lock for the next launch" {
  READY_FILE="$TEST_ROOT/crash-ready"
  env LOCK_MODULE="$LOCK_MODULE" LOCK_PATH="$TEST_ROOT/.lock" READY_FILE="$READY_FILE" node --input-type=module -e '
    import { writeFile } from "node:fs/promises";
    const { acquireLock } = await import(process.env.LOCK_MODULE);
    await acquireLock(process.env.LOCK_PATH);
    await writeFile(process.env.READY_FILE, "ready");
    setInterval(() => undefined, 1000);
  ' &
  HOLDER_PID="$!"
  wait_for_file "$READY_FILE"
  kill -9 "$HOLDER_PID" >/dev/null 2>&1 || true
  wait "$HOLDER_PID" >/dev/null 2>&1 || true
  unset HOLDER_PID

  run env LOCK_MODULE="$LOCK_MODULE" LOCK_PATH="$TEST_ROOT/.lock" node --input-type=module -e '
    const { setTimeout: delay } = await import("node:timers/promises");
    const { acquireLock, releaseLock } = await import(process.env.LOCK_MODULE);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const handle = await acquireLock(process.env.LOCK_PATH);
        await releaseLock(handle);
        process.exit(0);
      } catch (error) {
        if (error?.code !== "LOCK_CONFLICT") throw error;
        await delay(100);
      }
    }
    process.exit(1);
  '

  [ "$status" -eq 0 ]
}
