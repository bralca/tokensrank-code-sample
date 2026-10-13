#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SCRIPT_ROOT="$REPO_ROOT/packages/script"
  AGENT="$SCRIPT_ROOT/bin/agent.mjs"
  TEST_HOME="$(mktemp -d)"
  OUTPUT_FILE="$TEST_HOME/output.txt"
  JSON_FILE="$TEST_HOME/payload.json"
  INPUT_FILE="$TEST_HOME/input.json"

  cat > "$INPUT_FILE" <<'JSON'
{
  "sessions": [
    {
      "session_id": "privacy-session",
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
      "file_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "prompt": "do not emit",
      "response": "do not emit",
      "hostname": "workstation.local",
      "project_name": "secret"
    }
  ]
}
JSON
}

teardown() {
  rm -rf "$TEST_HOME"
}

run_dry_run_to_files() {
  run env TOKENSRANK_HOME="$TEST_HOME" node "$AGENT" --dry-run --input "$INPUT_FILE"
  [ "$status" -eq 0 ]
  printf '%s' "$output" > "$OUTPUT_FILE"
  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const output = readFileSync(process.argv[1], "utf8");
    const start = output.indexOf("{");
    if (start === -1) process.exit(1);
    const payload = JSON.parse(output.slice(start));
    writeFileSync(process.argv[2], `${JSON.stringify(payload, null, 2)}\n`);
  ' "$OUTPUT_FILE" "$JSON_FILE"
}

@test "dry-run output contains only allowlisted payload fields" {
  run_dry_run_to_files

  run node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const payload = JSON.parse(readFileSync(process.argv[1], "utf8"));
    const top = new Set(["client", "run", "sessions"]);
    const client = new Set(["version", "install_id", "platform", "arch"]);
    const run = new Set(["run_id", "started_at", "finished_at"]);
    const session = new Set([
      "session_id",
      "source",
      "model",
      "first_event_at",
      "last_event_at",
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "cached_input_tokens",
      "reasoning_output_tokens",
      "turns",
      "file_sha256",
    ]);
    const assertKeys = (value, allowed, label) => {
      const bad = Object.keys(value).filter((key) => !allowed.has(key));
      if (bad.length > 0) throw new Error(`${label}: ${bad.join(",")}`);
    };
    assertKeys(payload, top, "top");
    assertKeys(payload.client, client, "client");
    assertKeys(payload.run, run, "run");
    for (const item of payload.sessions) assertKeys(item, session, "session");
  ' "$JSON_FILE"

  [ "$status" -eq 0 ]
}

@test "dry-run output omits forbidden private fields from fixture input" {
  run_dry_run_to_files

  [[ "$output" != *'"prompt"'* ]]
  [[ "$output" != *'"response"'* ]]
  [[ "$output" != *'"hostname"'* ]]
  [[ "$output" != *'"project_name"'* ]]
  [[ "$output" != *"workstation.local"* ]]
  [[ "$output" != *"secret"* ]]
}

@test "IngestRequestSchema accepts the copied dry-run JSON" {
  run_dry_run_to_files

  run node --input-type=module -e "
    import { readFileSync } from 'node:fs';
    import { IngestRequestSchema } from '${REPO_ROOT}/packages/shared/dist/index.js';
    const payload = JSON.parse(readFileSync(process.argv[1], 'utf8'));
    const result = IngestRequestSchema.safeParse(payload);
    if (!result.success) {
      console.error(result.error.message);
      process.exit(1);
    }
  " "$JSON_FILE"

  [ "$status" -eq 0 ]
}

@test "IngestRequestSchema rejects forbidden extra fields" {
  run_dry_run_to_files

  run node --input-type=module -e "
    import { readFileSync } from 'node:fs';
    import { IngestRequestSchema } from '${REPO_ROOT}/packages/shared/dist/index.js';
    const payload = JSON.parse(readFileSync(process.argv[1], 'utf8'));
    payload.sessions[0].prompt = 'private';
    const result = IngestRequestSchema.safeParse(payload);
    if (result.success) process.exit(1);
  " "$JSON_FILE"

  [ "$status" -eq 0 ]
}

@test "user can copy and inspect JSON output" {
  run_dry_run_to_files

  run node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const payload = JSON.parse(readFileSync(process.argv[1], "utf8"));
    if (payload.sessions.length !== 1) process.exit(1);
    if (payload.sessions[0].session_id !== "privacy-session") process.exit(2);
    console.log(`${payload.sessions[0].source}:${payload.sessions[0].model}`);
  ' "$JSON_FILE"

  [ "$status" -eq 0 ]
  [[ "$output" == "claude:claude-3-5-sonnet-20241022" ]]
}
