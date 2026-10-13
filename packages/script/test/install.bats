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
    TOKENSRANK_ACCESS_KEY="${TOKENSRANK_TEST_ACCESS_KEY:-tr_script_test_key}" \
    TOKENSRANK_PROFILE_HANDLE="${TOKENSRANK_TEST_PROFILE_HANDLE:-}" \
    "$SCRIPT_ROOT/install.sh"
}

config_path() {
  printf '%s/.tokensrank/config.json' "$TEST_HOME"
}

state_path() {
  printf '%s/.tokensrank/state.json' "$TEST_HOME"
}

@test "first run succeeds" {
  run run_install Darwin

  [ "$status" -eq 0 ]
  [[ "$output" == *"TokensRank script installed at $TEST_HOME/.tokensrank"* ]]
  [ -f "$(config_path)" ]
  [ -f "$TEST_HOME/.tokensrank/bin/agent.mjs" ]
}

@test "config.json mode is 0600" {
  run run_install Darwin

  [ "$status" -eq 0 ]
  mode="$(node -e 'process.stdout.write((require("node:fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$(config_path)")"
  [ "$mode" = "600" ]
}

@test "config.json contains required JSON fields" {
  run run_install Darwin

  [ "$status" -eq 0 ]
  run node -e '
    const fs = require("node:fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const key of ["access_key", "profile_handle", "api_base", "install_id", "client_version", "ingestion_mode"]) {
      if (!(key in cfg)) process.exit(1);
    }
    if (cfg.api_base !== "https://api.tokensrank.ai") process.exit(2);
  ' "$(config_path)"
  [ "$status" -eq 0 ]
}

@test "install_id is UUID v4" {
  run run_install Darwin

  [ "$status" -eq 0 ]
  run node -e '
    const fs = require("node:fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(cfg.install_id)) process.exit(1);
  ' "$(config_path)"
  [ "$status" -eq 0 ]
}

@test "repeat install preserves config.json exactly" {
  run run_install Darwin
  [ "$status" -eq 0 ]
  before="$(cat "$(config_path)")"

  run run_install Darwin

  [ "$status" -eq 0 ]
  after="$(cat "$(config_path)")"
  [ "$before" = "$after" ]
}

@test "repeat install updates access key and clears invalid state" {
  TOKENSRANK_TEST_ACCESS_KEY="tr_script_old_key"
  run run_install Darwin
  [ "$status" -eq 0 ]

  install_id="$(node -e '
    const fs = require("node:fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(cfg.install_id);
  ' "$(config_path)")"

  run node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const state = JSON.parse(fs.readFileSync(path, "utf8"));
    state.access_key_invalid = true;
    state.shipped_session_ids = ["keep-session"];
    state.pending_payloads = [{ id: "pending-payload" }];
    fs.writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
  ' "$(state_path)"
  [ "$status" -eq 0 ]

  TOKENSRANK_TEST_ACCESS_KEY="tr_script_new_key"
  TOKENSRANK_TEST_PROFILE_HANDLE="alex"
  run run_install Darwin
  [ "$status" -eq 0 ]

  run node -e '
    const fs = require("node:fs");
    const [configPath, statePath, handoffPath, installId] = process.argv.slice(1);
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const handoff = fs.readFileSync(handoffPath, "utf8").trim();
    if (cfg.access_key !== "tr_script_new_key") process.exit(1);
    if (cfg.profile_handle !== "alex") process.exit(2);
    if (cfg.install_id !== installId) process.exit(3);
    if (state.install_id !== installId) process.exit(4);
    if (state.access_key_invalid !== false) process.exit(5);
    if (state.shipped_session_ids.length !== 0) process.exit(6);
    if (state.pending_payloads.length !== 0) process.exit(7);
    if (handoff !== "tr_script_new_key") process.exit(8);
  ' "$(config_path)" "$(state_path)" "$TEST_HOME/.tokensrank/access-key" "$install_id"
  [ "$status" -eq 0 ]
}

@test "repeat install completes in less than 5 seconds" {
  run run_install Darwin
  [ "$status" -eq 0 ]

  start="$(node -e 'process.stdout.write(String(Date.now()))')"
  run run_install Darwin
  finish="$(node -e 'process.stdout.write(String(Date.now()))')"
  elapsed_ms="$((finish - start))"

  [ "$status" -eq 0 ]
  [ "$elapsed_ms" -lt 5000 ]
}

@test "macOS launchd registration writes plist" {
  run run_install Darwin

  [ "$status" -eq 0 ]
  plist="$LAUNCHD_DIR/com.tokensrank.runner.plist"
  [ -f "$plist" ]
  run python3 -c 'import plistlib, sys; plistlib.load(open(sys.argv[1], "rb"))' "$plist"
  [ "$status" -eq 0 ]
  grep -q '<integer>3600</integer>' "$plist"
  grep -q '<key>RunAtLoad</key>' "$plist"
}

@test "Linux systemd registration writes service and timer" {
  run run_install Linux

  [ "$status" -eq 0 ]
  [ -f "$SYSTEMD_DIR/tokensrank.service" ]
  [ -f "$SYSTEMD_DIR/tokensrank.timer" ]
  grep -q 'Type=oneshot' "$SYSTEMD_DIR/tokensrank.service"
  grep -q 'OnUnitActiveSec=1h' "$SYSTEMD_DIR/tokensrank.timer"
  grep -q 'Persistent=true' "$SYSTEMD_DIR/tokensrank.timer"
  grep -q 'RandomizedDelaySec=5min' "$SYSTEMD_DIR/tokensrank.timer"
}

@test "unsupported OS exits non-zero" {
  run run_install FreeBSD

  [ "$status" -ne 0 ]
  [[ "$output" == *"Unsupported OS: FreeBSD"* ]]
}

@test "cleanup and isolation keep artifacts under TOKENSRANK_HOME" {
  run run_install Darwin

  [ "$status" -eq 0 ]
  [ -f "$(state_path)" ]
  [ -d "$TEST_HOME/.tokensrank/logs" ]
  [[ "$(config_path)" == "$TEST_ROOT"* ]]
  [[ "$LAUNCHD_DIR" == "$TEST_ROOT"* ]]
}
