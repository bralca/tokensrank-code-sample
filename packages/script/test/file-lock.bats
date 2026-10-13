#!/usr/bin/env bats

setup_file() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SCRIPT_ROOT="$REPO_ROOT/packages/script"
  export TOKENSRANK_TEST_HOME="${TOKENSRANK_TEST_HOME:-$HOME/.tokensrank-test}"
  export TOKENSRANK_TEST_DIST="$TOKENSRANK_TEST_HOME/dist"
  export LOCK_MODULE="$TOKENSRANK_TEST_DIST/script/src/runtime/file-lock.js"

  rm -rf "$TOKENSRANK_TEST_HOME"
  mkdir -p "$TOKENSRANK_TEST_HOME"
  (cd "$SCRIPT_ROOT" && pnpm exec tsc -p tsconfig.json --noEmit false --declaration false --declarationMap false --outDir "$TOKENSRANK_TEST_DIST")
}

teardown_file() {
  rm -rf "$TOKENSRANK_TEST_HOME"
}

setup() {
  TEST_ROOT="$(mktemp -d "$TOKENSRANK_TEST_HOME/file-lock.XXXXXX")"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

wait_for_file() {
  local file="$1"
  local attempts=50
  while [[ "$attempts" -gt 0 ]]; do
    [[ -f "$file" ]] && return 0
    sleep 0.1
    attempts=$((attempts - 1))
  done
  return 1
}

@test "lock acquisition and release succeeds" {
  run env LOCK_MODULE="$LOCK_MODULE" LOCK_PATH="$TEST_ROOT/.lock" node --input-type=module -e '
    const { acquireLock, releaseLock } = await import(process.env.LOCK_MODULE);
    const handle = await acquireLock(process.env.LOCK_PATH);
    await releaseLock(handle);
  '

  [ "$status" -eq 0 ]
  [[ -f "$TEST_ROOT/.lock" ]]
}

@test "concurrent execution guard blocks a second process" {
  READY_FILE="$TEST_ROOT/ready"
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
      process.exit(2);
    } catch (error) {
      if (error?.code === "LOCK_CONFLICT") process.exit(23);
      throw error;
    }
  '

  kill "$HOLDER_PID"
  wait "$HOLDER_PID" || true

  [ "$status" -eq 23 ]
}

@test "stale lock recovery replaces old dead-PID placeholder" {
  run env LOCK_MODULE="$LOCK_MODULE" LOCK_PATH="$TEST_ROOT/.lock" node --input-type=module -e '
    import { utimes, writeFile } from "node:fs/promises";
    const { acquireLock, acquireLockWithStaleRecovery, releaseLock } = await import(process.env.LOCK_MODULE);
    const first = await acquireLock(process.env.LOCK_PATH);
    const old = new Date(Date.now() - (5 * 60 * 60 * 1000));
    await writeFile(process.env.LOCK_PATH, `${JSON.stringify({ pid: 9999999 })}\n`, { mode: 0o600 });
    await utimes(process.env.LOCK_PATH, old, old);
    const recovered = await acquireLockWithStaleRecovery(process.env.LOCK_PATH, { logger: { warn() {} } });
    await releaseLock(recovered);
    await releaseLock(first);
  '

  [ "$status" -eq 0 ]
}

@test "lock is released after owner process exits" {
  READY_FILE="$TEST_ROOT/ready"
  run env LOCK_MODULE="$LOCK_MODULE" LOCK_PATH="$TEST_ROOT/.lock" READY_FILE="$READY_FILE" node --input-type=module -e '
    import { writeFile } from "node:fs/promises";
    const { acquireLock } = await import(process.env.LOCK_MODULE);
    await acquireLock(process.env.LOCK_PATH);
    await writeFile(process.env.READY_FILE, "ready");
  '

  [ "$status" -eq 0 ]
  wait_for_file "$READY_FILE"

  run env LOCK_MODULE="$LOCK_MODULE" LOCK_PATH="$TEST_ROOT/.lock" node --input-type=module -e '
    const { acquireLock, releaseLock } = await import(process.env.LOCK_MODULE);
    for (let index = 0; index < 30; index += 1) {
      try {
        const handle = await acquireLock(process.env.LOCK_PATH);
        await releaseLock(handle);
        process.exit(0);
      } catch (error) {
        if (error?.code !== "LOCK_CONFLICT") throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    process.exit(1);
  '

  [ "$status" -eq 0 ]
}

@test "parent directory is created automatically" {
  run env LOCK_MODULE="$LOCK_MODULE" LOCK_PATH="$TEST_ROOT/nested/path/.lock" node --input-type=module -e '
    const { acquireLock, releaseLock } = await import(process.env.LOCK_MODULE);
    const handle = await acquireLock(process.env.LOCK_PATH);
    await releaseLock(handle);
  '

  [ "$status" -eq 0 ]
  [[ -f "$TEST_ROOT/nested/path/.lock" ]]
}
