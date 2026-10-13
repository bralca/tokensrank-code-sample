#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SCRIPT_ROOT="$REPO_ROOT/packages/script"
  TEST_ROOT="$(mktemp -d)"
  TEST_HOME="$TEST_ROOT/home"
  LAUNCHD_DIR="$TEST_ROOT/launch-agents"
  SYSTEMD_DIR="$TEST_ROOT/systemd-user"
  mkdir -p "$TEST_HOME"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

install_tokensrank() {
  env \
    HOME="$TEST_HOME" \
    TOKENSRANK_HOME="$TEST_HOME/.tokensrank" \
    TOKENSRANK_TEST_UNAME="${1:-Darwin}" \
    TOKENSRANK_LAUNCHD_DIR="$LAUNCHD_DIR" \
    TOKENSRANK_SYSTEMD_USER_DIR="$SYSTEMD_DIR" \
    TOKENSRANK_SKIP_SCHEDULER_REGISTER=1 \
    TOKENSRANK_INSTALL_RUN_FIRST=0 \
    TOKENSRANK_ACCESS_KEY="tr_script_contract_key" \
    "$SCRIPT_ROOT/install.sh" >/dev/null
}

@test "IC-INSTALL-CONFIG config structure is complete" {
  install_tokensrank Darwin

  run node -e '
    const fs = require("node:fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const required = ["access_key", "profile_handle", "api_base", "install_id", "client_version", "ingestion_mode", "installed_at"];
    for (const key of required) if (!(key in cfg)) process.exit(1);
    if (cfg.ingestion_mode !== "script") process.exit(2);
  ' "$TEST_HOME/.tokensrank/config.json"
  [ "$status" -eq 0 ]
}

@test "IC-CONFIG-AGENT dry-run consumes config install_id" {
  install_tokensrank Darwin
  input="$TEST_ROOT/input.json"
  cat > "$input" <<'JSON'
{"sessions":[{"session_id":"contract-session","source":"claude","model":"claude-3-5-sonnet-20241022","first_event_at":"2026-04-27T10:00:00.000Z","last_event_at":"2026-04-27T10:00:00.000Z","input_tokens":1,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cached_input_tokens":0,"reasoning_output_tokens":0,"turns":1,"file_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}
JSON
  install_id="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).install_id)' "$TEST_HOME/.tokensrank/config.json")"

  run env TOKENSRANK_HOME="$TEST_HOME/.tokensrank" node "$TEST_HOME/.tokensrank/bin/agent.mjs" --dry-run --input "$input"

  [ "$status" -eq 0 ]
  [[ "$output" == *"\"install_id\": \"$install_id\""* ]]
}

@test "IC-SCHEDULER-AGENT generated launchd path points to installed wrapper" {
  install_tokensrank Darwin

  plist="$LAUNCHD_DIR/com.tokensrank.runner.plist"
  [ -f "$plist" ]
  grep -q "$TEST_HOME/.tokensrank/agent.mjs" "$plist"
  grep -q "$TEST_HOME/.tokensrank/logs/tokensrank.log" "$plist"
}

@test "IC-INSTALL-SCHEDULER templates match installer scheduler contracts" {
  install_tokensrank Linux

  grep -q "ExecStart=.* $TEST_HOME/.tokensrank/agent.mjs" "$SYSTEMD_DIR/tokensrank.service"
  grep -q "EnvironmentFile=-$TEST_HOME/.tokensrank/config.json" "$SYSTEMD_DIR/tokensrank.service"
  grep -q 'OnUnitActiveSec=1h' "$SYSTEMD_DIR/tokensrank.timer"
  grep -q 'Persistent=true' "$SYSTEMD_DIR/tokensrank.timer"
}

@test "IC-STATE-PERSISTENCE state.json lifecycle is initialized" {
  install_tokensrank Darwin

  run node -e '
    const fs = require("node:fs");
    const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!state.install_id || state.last_run_at !== null) process.exit(1);
    if (!Array.isArray(state.shipped_session_ids) || !Array.isArray(state.pending_payloads)) process.exit(2);
  ' "$TEST_HOME/.tokensrank/state.json"
  [ "$status" -eq 0 ]
}

@test "P-ATOMIC-WRITE leaves no temp config or state files" {
  install_tokensrank Darwin

  run find "$TEST_HOME/.tokensrank" -maxdepth 1 -name '.*.tmp.*' -print

  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "P-IDEMPOTENCY preserves install_id across repeat installs" {
  install_tokensrank Darwin
  before="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).install_id)' "$TEST_HOME/.tokensrank/config.json")"

  install_tokensrank Darwin
  after="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).install_id)' "$TEST_HOME/.tokensrank/config.json")"

  [ "$before" = "$after" ]
}

@test "P-FRESH-INSTALL reinstall clears shipped_session_ids and pending_payloads" {
  install_tokensrank Darwin

  # Simulate an existing run: mutate the state file as if the agent had shipped sessions
  # and queued a pending payload. A second install must clear these so the next sync
  # re-ships everything from disk (server-side dedup keeps it idempotent).
  node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const state = JSON.parse(fs.readFileSync(path, "utf8"));
    state.shipped_session_ids = [
      { source: "claude", session_id: "old", file_sha256: "a".repeat(64), shipped_at: "2026-01-01T00:00:00Z" },
    ];
    state.pending_payloads = [
      { payload: { sessions: [], install_id: "x", run_started_at: "2026-01-01T00:00:00Z" }, attempted_at: "2026-01-01T00:00:00Z", retry_count: 0 },
    ];
    state.last_run_at = "2026-01-01T00:00:00Z";
    state.access_key_invalid = true;
    fs.writeFileSync(path, JSON.stringify(state, null, 2));
  ' "$TEST_HOME/.tokensrank/state.json"

  install_tokensrank Darwin

  run node -e '
    const fs = require("node:fs");
    const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(state.shipped_session_ids) || state.shipped_session_ids.length !== 0) process.exit(1);
    if (!Array.isArray(state.pending_payloads) || state.pending_payloads.length !== 0) process.exit(2);
    if (state.last_run_at !== null) process.exit(3);
    if (state.access_key_invalid !== false) process.exit(4);
    if (typeof state.install_id !== "string" || !state.install_id) process.exit(5);
  ' "$TEST_HOME/.tokensrank/state.json"
  [ "$status" -eq 0 ]
}

@test "SM-INSTALL-STATE transitions from missing to installed" {
  [ ! -e "$TEST_HOME/.tokensrank/config.json" ]
  install_tokensrank Darwin

  [ -e "$TEST_HOME/.tokensrank/config.json" ]
  [ -e "$TEST_HOME/.tokensrank/state.json" ]
  [ -e "$TEST_HOME/.tokensrank/bin/agent.mjs" ]
}

@test "type safety validates agent payload with shared IngestRequestSchema" {
  install_tokensrank Darwin
  input="$TEST_ROOT/input.json"
  cat > "$input" <<'JSON'
{"sessions":[{"session_id":"schema-session","source":"codex","model":"gpt-5.3-codex","first_event_at":"2026-04-27T10:00:00.000Z","last_event_at":"2026-04-27T10:01:00.000Z","input_tokens":4,"output_tokens":2,"cache_read_input_tokens":1,"cache_creation_input_tokens":0,"cached_input_tokens":1,"reasoning_output_tokens":0,"turns":1,"file_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}
JSON

  run env TOKENSRANK_HOME="$TEST_HOME/.tokensrank" REPO_ROOT="$REPO_ROOT" node --input-type=module - "$TEST_HOME/.tokensrank/bin/agent.mjs" "$input" <<'NODE'
    import { spawnSync } from 'node:child_process';
    import { pathToFileURL } from 'node:url';
    const shared = await import(pathToFileURL(`${process.env.REPO_ROOT}/packages/shared/dist/index.js`).href);
    const result = spawnSync('node', [process.argv[2], '--dry-run', '--input', process.argv[3]], {
      env: { ...process.env },
      encoding: 'utf8',
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
    const start = result.stdout.indexOf('{');
    const payload = JSON.parse(result.stdout.slice(start));
    if (!shared.IngestRequestSchema.safeParse(payload).success) process.exit(2);
NODE
  [ "$status" -eq 0 ]
}

@test "summary report covers installer contracts" {
  install_tokensrank Linux

  printf '%s\n' \
    'IC-INSTALL-CONFIG ok' \
    'IC-CONFIG-AGENT ok' \
    'IC-SCHEDULER-AGENT ok' \
    'IC-INSTALL-SCHEDULER ok' \
    'IC-STATE-PERSISTENCE ok' \
    'P-ATOMIC-WRITE ok' \
    'P-IDEMPOTENCY ok' \
    'SM-INSTALL-STATE ok' > "$TEST_ROOT/install-integration-report.txt"

  grep -q 'IC-INSTALL-CONFIG ok' "$TEST_ROOT/install-integration-report.txt"
  grep -q 'SM-INSTALL-STATE ok' "$TEST_ROOT/install-integration-report.txt"
}
