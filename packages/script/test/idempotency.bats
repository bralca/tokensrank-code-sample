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

run_install() {
  env \
    HOME="$TEST_HOME" \
    TOKENSRANK_HOME="$TEST_HOME/.tokensrank" \
    TOKENSRANK_TEST_UNAME="${1:-Darwin}" \
    TOKENSRANK_LAUNCHD_DIR="$LAUNCHD_DIR" \
    TOKENSRANK_SYSTEMD_USER_DIR="$SYSTEMD_DIR" \
    TOKENSRANK_SKIP_SCHEDULER_REGISTER=1 \
    TOKENSRANK_INSTALL_RUN_FIRST=0 \
    TOKENSRANK_ACCESS_KEY="tr_script_idempotency_key" \
    TOKENSRANK_PROFILE_HANDLE="idempotent_user" \
    "$SCRIPT_ROOT/install.sh"
}

config_path() {
  printf '%s/.tokensrank/config.json' "$TEST_HOME"
}

state_path() {
  printf '%s/.tokensrank/state.json' "$TEST_HOME"
}

file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

json_read() {
  node -e '
    const fs = require("node:fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const path = process.argv[2].split(".");
    let value = data;
    for (const key of path) value = value?.[key];
    if (typeof value === "object") {
      process.stdout.write(JSON.stringify(value));
    } else if (value !== undefined && value !== null) {
      process.stdout.write(String(value));
    }
  ' "$1" "$2"
}

@test "creates config.json with persistent UUID install_id and secure mode" {
  run run_install Darwin

  [ "$status" -eq 0 ]
  [ -f "$(config_path)" ]
  [ "$(file_mode "$(config_path)")" = "600" ]

  run node -e '
    const fs = require("node:fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (cfg.access_key !== "tr_script_idempotency_key") process.exit(1);
    if (cfg.profile_handle !== "idempotent_user") process.exit(2);
    if (cfg.api_base !== "https://api.tokensrank.ai") process.exit(3);
    if (cfg.ingestion_mode !== "script") process.exit(4);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(cfg.install_id)) process.exit(5);
  ' "$(config_path)"
  [ "$status" -eq 0 ]
}

@test "does not rewrite config.json or regenerate install_id on rerun" {
  run run_install Darwin
  [ "$status" -eq 0 ]
  before_config="$(cat "$(config_path)")"
  before_install_id="$(json_read "$(config_path)" install_id)"

  run run_install Darwin

  [ "$status" -eq 0 ]
  after_config="$(cat "$(config_path)")"
  after_install_id="$(json_read "$(config_path)" install_id)"
  [ "$after_config" = "$before_config" ]
  [ "$after_install_id" = "$before_install_id" ]
}

@test "launchd scheduler registration remains a single hourly RunAtLoad plist" {
  run run_install Darwin
  [ "$status" -eq 0 ]
  first_plist="$(cat "$LAUNCHD_DIR/com.tokensrank.runner.plist")"

  run run_install Darwin

  [ "$status" -eq 0 ]
  [ "$(find "$LAUNCHD_DIR" -name 'com.tokensrank.runner.plist' -type f | wc -l | tr -d ' ')" = "1" ]
  [ "$(grep -c '<key>StartInterval</key>' "$LAUNCHD_DIR/com.tokensrank.runner.plist")" = "1" ]
  [ "$(grep -c '<integer>3600</integer>' "$LAUNCHD_DIR/com.tokensrank.runner.plist")" = "1" ]
  [ "$(grep -c '<key>RunAtLoad</key>' "$LAUNCHD_DIR/com.tokensrank.runner.plist")" = "1" ]
  [ "$(cat "$LAUNCHD_DIR/com.tokensrank.runner.plist")" = "$first_plist" ]
}

@test "systemd scheduler registration remains one service and one persistent timer" {
  run run_install Linux
  [ "$status" -eq 0 ]
  first_timer="$(cat "$SYSTEMD_DIR/tokensrank.timer")"

  run run_install Linux

  [ "$status" -eq 0 ]
  [ "$(find "$SYSTEMD_DIR" -name 'tokensrank.service' -type f | wc -l | tr -d ' ')" = "1" ]
  [ "$(find "$SYSTEMD_DIR" -name 'tokensrank.timer' -type f | wc -l | tr -d ' ')" = "1" ]
  [ "$(grep -c '^OnUnitActiveSec=1h$' "$SYSTEMD_DIR/tokensrank.timer")" = "1" ]
  [ "$(grep -c '^Persistent=true$' "$SYSTEMD_DIR/tokensrank.timer")" = "1" ]
  [ "$(grep -c '^OnBootSec=2min$' "$SYSTEMD_DIR/tokensrank.timer")" = "1" ]
  [ "$(cat "$SYSTEMD_DIR/tokensrank.timer")" = "$first_timer" ]
}

@test "initializes state.json with install_id and empty runtime collections" {
  run run_install Darwin

  [ "$status" -eq 0 ]
  [ -f "$(state_path)" ]
  [ "$(file_mode "$(state_path)")" = "600" ]

  run node -e '
    const fs = require("node:fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    if (state.install_id !== cfg.install_id) process.exit(1);
    if (state.last_run_at !== null) process.exit(2);
    if (state.access_key_invalid !== false) process.exit(3);
    if (!Array.isArray(state.shipped_session_ids) || state.shipped_session_ids.length !== 0) process.exit(4);
    if (!Array.isArray(state.pending_payloads) || state.pending_payloads.length !== 0) process.exit(5);
  ' "$(config_path)" "$(state_path)"
  [ "$status" -eq 0 ]
}

@test "does not reset existing state.json on subsequent installs" {
  run run_install Darwin
  [ "$status" -eq 0 ]

  run node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const state = JSON.parse(fs.readFileSync(path, "utf8"));
    state.last_run_at = "2026-04-29T10:00:00.000Z";
    state.shipped_session_ids.push({
      session_id: "already-shipped",
      source: "claude",
      file_sha256: "a".repeat(64),
      shipped_at: "2026-04-29T10:00:00.000Z"
    });
    state.pending_payloads.push({
      payload: { client: { install_id: state.install_id }, run: { started_at: "2026-04-29T10:00:00.000Z" }, sessions: [] },
      attempted_at: "2026-04-29T10:00:00.000Z",
      retry_count: 1
    });
    fs.writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  ' "$(state_path)"
  [ "$status" -eq 0 ]
  before_state="$(cat "$(state_path)")"

  run run_install Darwin

  [ "$status" -eq 0 ]
  after_state="$(cat "$(state_path)")"
  [ "$after_state" = "$before_state" ]
}
