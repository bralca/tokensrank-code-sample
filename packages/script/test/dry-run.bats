#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SCRIPT_ROOT="$REPO_ROOT/packages/script"
  AGENT="$SCRIPT_ROOT/bin/agent.mjs"
  TEST_HOME="$(mktemp -d)"
  FIXTURES="$SCRIPT_ROOT/test/fixtures"
}

teardown() {
  rm -rf "$TEST_HOME"
}

write_input_fixture() {
  INPUT_FILE="$TEST_HOME/input.json"
  cat > "$INPUT_FILE" <<'JSON'
{
  "sessions": [
    {
      "session_id": "dry-run-cli-session",
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
JSON
}

assert_output_json_valid() {
  printf '%s' "$output" | node --input-type=module -e '
    const input = await new Promise((resolve) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { data += chunk; });
      process.stdin.on("end", () => resolve(data));
    });
    const start = input.indexOf("{");
    if (start === -1) process.exit(1);
    const payload = JSON.parse(input.slice(start));
    if (!Array.isArray(payload.sessions)) process.exit(2);
  '
}

@test "recognizes --dry-run and exits 0" {
  run env TOKENSRANK_HOME="$TEST_HOME" node "$AGENT" --dry-run

  [ "$status" -eq 0 ]
  [[ "$output" == *"Dry-run mode: would send 0 sessions in 0 batch(es)"* ]]
}

@test "prints a valid JSON payload" {
  write_input_fixture

  run env TOKENSRANK_HOME="$TEST_HOME" node "$AGENT" --dry-run --input "$INPUT_FILE"

  [ "$status" -eq 0 ]
  assert_output_json_valid
  [[ "$output" == *'"session_id": "dry-run-cli-session"'* ]]
}

@test "does not create a lock file" {
  write_input_fixture

  run env TOKENSRANK_HOME="$TEST_HOME" node "$AGENT" --dry-run --input "$INPUT_FILE"

  [ "$status" -eq 0 ]
  [[ ! -e "$TEST_HOME/.lock" ]]
}

@test "does not modify state.json even when last_run_at would normally guard" {
  write_input_fixture
  state_file="$TEST_HOME/state.json"
  cat > "$state_file" <<'JSON'
{"last_run_at":"2099-01-01T00:00:00.000Z","shipped_session_ids":[],"pending_payloads":[]}
JSON
  before="$(cat "$state_file")"

  run env TOKENSRANK_HOME="$TEST_HOME" node "$AGENT" --dry-run --input "$INPUT_FILE" --state "$state_file"

  [ "$status" -eq 0 ]
  after="$(cat "$state_file")"
  [ "$before" = "$after" ]
}

@test "prints a session summary" {
  write_input_fixture

  run env TOKENSRANK_HOME="$TEST_HOME" node "$AGENT" --dry-run --input "$INPUT_FILE"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Sessions summary:"* ]]
  [[ "$output" == *"by_source:"* ]]
  [[ "$output" == *"- claude: 1"* ]]
}

@test "extracts fixture Claude and Codex sessions" {
  run env TOKENSRANK_HOME="$TEST_HOME" node "$AGENT" --dry-run \
    --claude-root "$FIXTURES/claude" \
    --codex-root "$FIXTURES/codex"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Dry-run mode: would send 3 sessions in 1 batch(es)"* ]]
  [[ "$output" == *"- claude: 2"* ]]
  [[ "$output" == *"- codex: 1"* ]]
  assert_output_json_valid
}

@test "handles empty source directories" {
  mkdir -p "$TEST_HOME/empty-claude" "$TEST_HOME/empty-codex"

  run env TOKENSRANK_HOME="$TEST_HOME" node "$AGENT" --dry-run \
    --claude-root "$TEST_HOME/empty-claude" \
    --codex-root "$TEST_HOME/empty-codex"

  [ "$status" -eq 0 ]
  [[ "$output" == *"would send 0 sessions"* ]]
  [[ "$output" == *'"sessions": []'* ]]
  assert_output_json_valid
}

@test "does not POST to the API" {
  write_input_fixture

  run env TOKENSRANK_HOME="$TEST_HOME" node "$AGENT" --dry-run \
    --input "$INPUT_FILE" \
    --api-base "http://127.0.0.1:1"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"session_id": "dry-run-cli-session"'* ]]
}
