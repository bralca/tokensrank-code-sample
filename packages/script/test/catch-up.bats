#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SCRIPT_ROOT="$REPO_ROOT/packages/script"
  AGENT="$SCRIPT_ROOT/bin/agent.mjs"
  LAUNCHD_TEMPLATE="$SCRIPT_ROOT/scheduler/com.tokensrank.runner.plist"
  SYSTEMD_SERVICE="$SCRIPT_ROOT/scheduler/tokensrank.service"
  SYSTEMD_TIMER="$SCRIPT_ROOT/scheduler/tokensrank.timer"
  TEST_ROOT="$(mktemp -d)"
  TEST_HOME="$TEST_ROOT/home"
  mkdir -p "$TEST_HOME/.tokensrank"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

write_state() {
  local last_run_at="$1"
  node -e '
    const fs = require("node:fs");
    const [statePath, lastRunAt] = process.argv.slice(1);
    const state = {
      install_id: "11111111-1111-4111-8111-111111111111",
      access_key_invalid: false,
      last_run_at: lastRunAt === "null" ? null : lastRunAt,
      shipped_session_ids: [],
      pending_payloads: []
    };
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  ' "$TEST_HOME/.tokensrank/state.json" "$last_run_at"
}

write_input() {
  local target="$1"
  local count="$2"
  node -e '
    const fs = require("node:fs");
    const [target, countValue] = process.argv.slice(1);
    const count = Number(countValue);
    const sessions = Array.from({ length: count }, (_, index) => ({
      session_id: `catch-up-${index}`,
      source: index % 2 === 0 ? "claude" : "codex",
      model: index % 2 === 0 ? "claude-3-5-sonnet-20241022" : "gpt-5.3-codex",
      first_event_at: "2026-04-29T08:00:00.000Z",
      last_event_at: "2026-04-29T08:01:00.000Z",
      input_tokens: 10 + index,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0,
      turns: 1,
      file_sha256: String(index).padStart(64, "a").slice(-64)
    }));
    fs.writeFileSync(target, `${JSON.stringify({ sessions }, null, 2)}\n`);
  ' "$target" "$count"
}

state_value() {
  node -e '
    const fs = require("node:fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const path = process.argv[2].split(".");
    let value = data;
    for (const key of path) value = value?.[key];
    if (Array.isArray(value)) {
      process.stdout.write(String(value.length));
    } else if (value !== undefined && value !== null) {
      process.stdout.write(String(value));
    }
  ' "$TEST_HOME/.tokensrank/state.json" "$1"
}

@test "launchd scheduler catches up with RunAtLoad and hourly StartInterval" {
  grep -A1 '<key>RunAtLoad</key>' "$LAUNCHD_TEMPLATE" | grep -q '<true/>'
  grep -A1 '<key>StartInterval</key>' "$LAUNCHD_TEMPLATE" | grep -q '<integer>3600</integer>'
  grep -q '<key>StandardOutPath</key>' "$LAUNCHD_TEMPLATE"
  grep -q '<key>StandardErrorPath</key>' "$LAUNCHD_TEMPLATE"
}

@test "systemd timer catches up with Persistent OnBootSec and hourly interval" {
  grep -q '^OnUnitActiveSec=1h$' "$SYSTEMD_TIMER"
  grep -q '^Persistent=true$' "$SYSTEMD_TIMER"
  grep -q '^OnBootSec=2min$' "$SYSTEMD_TIMER"
  grep -q '^RandomizedDelaySec=5min$' "$SYSTEMD_TIMER"
}

@test "scheduler templates execute the installed agent entrypoint" {
  grep -q '__TOKENSRANK_NODE__' "$LAUNCHD_TEMPLATE"
  grep -q '__TOKENSRANK_HOME__/agent.mjs' "$LAUNCHD_TEMPLATE"
  grep -q '<string>--scan-home</string>' "$LAUNCHD_TEMPLATE"
  grep -q '^ExecStart=.*__TOKENSRANK_HOME__/agent\.mjs --scan-home$' "$SYSTEMD_SERVICE"
  grep -q '^After=network-online.target$' "$SYSTEMD_SERVICE"
}

@test "last-run guard skips runs within 30 minutes without mutating state" {
  now="$(node -e 'process.stdout.write(new Date().toISOString())')"
  write_state "$now"
  input="$TEST_ROOT/input.json"
  write_input "$input" 1
  before_state="$(cat "$TEST_HOME/.tokensrank/state.json")"

  run env TOKENSRANK_HOME="$TEST_HOME/.tokensrank" node "$AGENT" --input "$input" --state "$TEST_HOME/.tokensrank/state.json"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Skipping run (last_run_at within 30 minutes)"* ]]
  [ "$(cat "$TEST_HOME/.tokensrank/state.json")" = "$before_state" ]
}

@test "--force bypasses the 30-minute last-run guard" {
  now="$(node -e 'process.stdout.write(new Date().toISOString())')"
  write_state "$now"
  input="$TEST_ROOT/input.json"
  write_input "$input" 1

  run env TOKENSRANK_HOME="$TEST_HOME/.tokensrank" node "$AGENT" --force --input "$input" --state "$TEST_HOME/.tokensrank/state.json"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"accepted":1'* ]]
  [[ "$output" == *'"queued":1'* ]]
  [ "$(state_value pending_payloads)" = "1" ]
  [ "$(find "$TEST_HOME/.tokensrank" -name '.state.json.tmp.*' -type f | wc -l | tr -d ' ')" = "0" ]
  run node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$TEST_HOME/.tokensrank/state.json"
  [ "$status" -eq 0 ]
}

@test "--first-run bypasses the 30-minute last-run guard" {
  now="$(node -e 'process.stdout.write(new Date().toISOString())')"
  write_state "$now"
  input="$TEST_ROOT/input.json"
  write_input "$input" 1

  run env TOKENSRANK_HOME="$TEST_HOME/.tokensrank" node "$AGENT" --first-run --input "$input" --state "$TEST_HOME/.tokensrank/state.json"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"accepted":1'* ]]
  [[ "$output" == *'"queued":1'* ]]
  [ "$(state_value pending_payloads)" = "1" ]
}

@test "catch-up batches more than 100 sessions into FIFO pending payloads" {
  write_state "2026-04-29T00:00:00.000Z"
  input="$TEST_ROOT/input.json"
  write_input "$input" 205

  run env TOKENSRANK_HOME="$TEST_HOME/.tokensrank" node "$AGENT" --force --input "$input" --state "$TEST_HOME/.tokensrank/state.json"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"accepted":205'* ]]
  [[ "$output" == *'"queued":3'* ]]
  [ "$(state_value pending_payloads)" = "3" ]
}

@test "dedup state prevents re-shipping sessions during catch-up" {
  state="$TEST_HOME/.tokensrank/state.json"
  input="$TEST_ROOT/input.json"
  write_input "$input" 1
  node -e '
    const fs = require("node:fs");
    const statePath = process.argv[1];
    const inputPath = process.argv[2];
    const session = JSON.parse(fs.readFileSync(inputPath, "utf8")).sessions[0];
    fs.writeFileSync(statePath, `${JSON.stringify({
      install_id: "11111111-1111-4111-8111-111111111111",
      access_key_invalid: false,
      last_run_at: "2026-04-29T00:00:00.000Z",
      shipped_session_ids: [{
        session_id: session.session_id,
        source: session.source,
        file_sha256: session.file_sha256,
        shipped_at: "2026-04-29T00:00:00.000Z"
      }],
      pending_payloads: []
    }, null, 2)}\n`);
  ' "$state" "$input"

  run env TOKENSRANK_HOME="$TEST_HOME/.tokensrank" node "$AGENT" --dry-run --input "$input" --state "$state"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Dry-run mode: would send 0 sessions in 0 batch(es)"* ]]
  [[ "$output" != *"catch-up-0\""* ]]

  privacy_state="$TEST_ROOT/privacy-state.json"
  privacy_input="$TEST_ROOT/privacy-input.json"
  write_state "2026-04-29T00:00:00.000Z"
  cp "$TEST_HOME/.tokensrank/state.json" "$privacy_state"
  write_input "$privacy_input" 1
  node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const data = JSON.parse(fs.readFileSync(path, "utf8"));
    data.sessions[0].prompt = "private prompt";
    data.sessions[0].response = "private response";
    data.sessions[0].file_path = "/Users/alex/private/project";
    fs.writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  ' "$privacy_input"

  run env TOKENSRANK_HOME="$TEST_HOME/.tokensrank" node "$AGENT" --dry-run --input "$privacy_input" --state "$privacy_state"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Dry-run mode: would send 1 sessions in 1 batch(es)"* ]]
  [[ "$output" != *"private prompt"* ]]
  [[ "$output" != *"private response"* ]]
  [[ "$output" != *"/Users/alex/private/project"* ]]
}
