#!/usr/bin/env bats

setup_file() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SCRIPT_ROOT="$REPO_ROOT/packages/script"
  export TOKENSRANK_TEST_HOME="${TOKENSRANK_TEST_HOME:-$HOME/.tokensrank-test}"
  export TOKENSRANK_TEST_DIST="$TOKENSRANK_TEST_HOME/dist"
  export ATOMIC_MODULE="$TOKENSRANK_TEST_DIST/script/src/runtime/atomic-write.js"

  rm -rf "$TOKENSRANK_TEST_HOME"
  mkdir -p "$TOKENSRANK_TEST_HOME"
  (cd "$SCRIPT_ROOT" && pnpm exec tsc -p tsconfig.json --noEmit false --declaration false --declarationMap false --outDir "$TOKENSRANK_TEST_DIST")
}

teardown_file() {
  rm -rf "$TOKENSRANK_TEST_HOME"
}

setup() {
  TEST_ROOT="$(mktemp -d "$TOKENSRANK_TEST_HOME/atomic-write.XXXXXX")"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

@test "atomic write completes with no temp leftovers from the write" {
  run env ATOMIC_MODULE="$ATOMIC_MODULE" STATE_PATH="$TEST_ROOT/state.json" node --input-type=module -e '
    import { readdir } from "node:fs/promises";
    const { writeJsonAtomic, readJsonAtomic } = await import(process.env.ATOMIC_MODULE);
    await writeJsonAtomic(process.env.STATE_PATH, { ok: true });
    const state = await readJsonAtomic(process.env.STATE_PATH);
    const entries = await readdir(new URL(".", `file://${process.env.STATE_PATH}`));
    if (!state.ok) process.exit(2);
    if (entries.some((entry) => entry.startsWith(".tmp."))) process.exit(3);
  '

  [ "$status" -eq 0 ]
}

@test "orphaned temp file from crash does not affect state reads" {
  printf '{"ok":"old"}\n' > "$TEST_ROOT/state.json"
  printf '{"ok":"partial"\n' > "$TEST_ROOT/.tmp.state.json.crash"

  run env ATOMIC_MODULE="$ATOMIC_MODULE" STATE_PATH="$TEST_ROOT/state.json" node --input-type=module -e '
    const { readJsonAtomic } = await import(process.env.ATOMIC_MODULE);
    const state = await readJsonAtomic(process.env.STATE_PATH);
    if (state.ok !== "old") process.exit(2);
  '

  [ "$status" -eq 0 ]
}

@test "concurrent writes leave one complete valid JSON document" {
  run env ATOMIC_MODULE="$ATOMIC_MODULE" STATE_PATH="$TEST_ROOT/state.json" node --input-type=module -e '
    const { writeJsonAtomic, readJsonAtomic } = await import(process.env.ATOMIC_MODULE);
    const candidates = Array.from({ length: 12 }, (_, index) => ({ writer: index, payload: "x".repeat(2048) }));
    await Promise.all(candidates.map((candidate) => writeJsonAtomic(process.env.STATE_PATH, candidate)));
    const stored = await readJsonAtomic(process.env.STATE_PATH);
    if (!candidates.some((candidate) => candidate.writer === stored.writer && candidate.payload === stored.payload)) {
      process.exit(2);
    }
  '

  [ "$status" -eq 0 ]
}

@test "rename atomicity keeps readers on old or new JSON during writes" {
  run env ATOMIC_MODULE="$ATOMIC_MODULE" STATE_PATH="$TEST_ROOT/state.json" node --input-type=module -e '
    const { writeJsonAtomic, readJsonAtomic } = await import(process.env.ATOMIC_MODULE);
    await writeJsonAtomic(process.env.STATE_PATH, { version: "old", entries: [] });
    const reads = [];
    const writes = [];
    for (let index = 0; index < 50; index += 1) {
      reads.push(readJsonAtomic(process.env.STATE_PATH));
      writes.push(writeJsonAtomic(process.env.STATE_PATH, { version: "new", index, entries: Array(100).fill(index) }));
    }
    const seen = await Promise.all(reads);
    await Promise.all(writes);
    if (!seen.every((item) => item.version === "old" || item.version === "new")) process.exit(2);
    await readJsonAtomic(process.env.STATE_PATH);
  '

  [ "$status" -eq 0 ]
}

@test "state.json integration shape persists expected fields" {
  run env ATOMIC_MODULE="$ATOMIC_MODULE" STATE_PATH="$TEST_ROOT/state.json" node --input-type=module -e '
    const { writeJsonAtomic, readJsonAtomic } = await import(process.env.ATOMIC_MODULE);
    const state = {
      install_id: "11111111-1111-4111-8111-111111111111",
      last_run_at: null,
      shipped_session_ids: [],
      pending_payloads: [],
      access_key_invalid: false
    };
    await writeJsonAtomic(process.env.STATE_PATH, state);
    const stored = await readJsonAtomic(process.env.STATE_PATH);
    for (const key of ["install_id", "last_run_at", "shipped_session_ids", "pending_payloads", "access_key_invalid"]) {
      if (!(key in stored)) process.exit(2);
    }
  '

  [ "$status" -eq 0 ]
}

@test "large state with 1000+ entries persists intact" {
  run env ATOMIC_MODULE="$ATOMIC_MODULE" STATE_PATH="$TEST_ROOT/state.json" node --input-type=module -e '
    const { writeJsonAtomic, readJsonAtomic } = await import(process.env.ATOMIC_MODULE);
    const state = {
      install_id: "11111111-1111-4111-8111-111111111111",
      last_run_at: "2026-04-28T01:00:00.000Z",
      shipped_session_ids: Array.from({ length: 1200 }, (_, index) => ({
        session_id: `session-${index}`,
        source: index % 2 === 0 ? "claude" : "codex",
        file_sha256: String(index % 10).repeat(64).slice(0, 64),
        shipped_at: "2026-04-28T01:00:00.000Z"
      })),
      pending_payloads: [],
      access_key_invalid: false
    };
    await writeJsonAtomic(process.env.STATE_PATH, state);
    const stored = await readJsonAtomic(process.env.STATE_PATH);
    if (stored.shipped_session_ids.length !== 1200) process.exit(2);
  '

  [ "$status" -eq 0 ]
}
