#!/usr/bin/env bats

setup() {
  if [ "$(uname -s)" != "Linux" ]; then
    skip "systemd scheduler tests require Linux"
  fi

  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SCRIPT_ROOT="$REPO_ROOT/packages/script"
  TEST_ROOT="$(mktemp -d)"
  TEST_HOME="$TEST_ROOT/home"
  SYSTEMD_DIR="$TEST_ROOT/systemd-user"
  mkdir -p "$TEST_HOME" "$SYSTEMD_DIR"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

run_systemd_install() {
  env \
    HOME="$TEST_HOME" \
    TOKENSRANK_HOME="$TEST_HOME/.tokensrank" \
    TOKENSRANK_TEST_UNAME=Linux \
    TOKENSRANK_SYSTEMD_USER_DIR="$SYSTEMD_DIR" \
    TOKENSRANK_SKIP_SCHEDULER_REGISTER=1 \
    TOKENSRANK_INSTALL_RUN_FIRST=0 \
    TOKENSRANK_ACCESS_KEY="tr_script_systemd_test" \
    "$SCRIPT_ROOT/install.sh"
}

service_path() {
  printf '%s/tokensrank.service' "$SYSTEMD_DIR"
}

timer_path() {
  printf '%s/tokensrank.timer' "$SYSTEMD_DIR"
}

@test "systemd installer registers service and timer files" {
  run run_systemd_install

  [ "$status" -eq 0 ]
  [ -f "$(service_path)" ]
  [ -f "$(timer_path)" ]
  [ "$(stat -c '%a' "$(service_path)")" = "644" ]
  [ "$(stat -c '%a' "$(timer_path)")" = "644" ]
}

@test "systemd timer uses OnUnitActiveSec=1h for hourly cadence" {
  run_systemd_install >/dev/null

  grep -q '^OnUnitActiveSec=1h$' "$(timer_path)"
}

@test "systemd timer enables Persistent=true catch-up" {
  run_systemd_install >/dev/null

  grep -q '^Persistent=true$' "$(timer_path)"
}

@test "systemd timer uses OnBootSec=2min for reboot catch-up" {
  run_systemd_install >/dev/null

  grep -q '^OnBootSec=2min$' "$(timer_path)"
}

@test "systemd timer uses RandomizedDelaySec=5min for load spreading" {
  run_systemd_install >/dev/null

  grep -q '^RandomizedDelaySec=5min$' "$(timer_path)"
}

@test "systemd service is oneshot and executes agent.mjs with journal logging" {
  run_systemd_install >/dev/null

  grep -q '^Type=oneshot$' "$(service_path)"
  grep -q '^ExecStart=.*agent\.mjs --scan-home$' "$(service_path)"
  grep -q '^StandardOutput=journal$' "$(service_path)"
  grep -q '^EnvironmentFile=-.*config\.json$' "$(service_path)"
}

@test "systemd installer is idempotent across repeated installs" {
  run_systemd_install >/dev/null
  before_service="$(sha256sum "$(service_path)" | awk '{print $1}')"
  before_timer="$(sha256sum "$(timer_path)" | awk '{print $1}')"

  run run_systemd_install
  after_service="$(sha256sum "$(service_path)" | awk '{print $1}')"
  after_timer="$(sha256sum "$(timer_path)" | awk '{print $1}')"

  [ "$status" -eq 0 ]
  [ "$before_service" = "$after_service" ]
  [ "$before_timer" = "$after_timer" ]
}

@test "systemd registration source disables, reloads, enables, and starts the timer" {
  source="$SCRIPT_ROOT/install.sh"

  grep -q 'systemctl --user disable --now tokensrank.timer' "$source"
  grep -q 'systemctl --user daemon-reload' "$source"
  grep -q 'systemctl --user enable tokensrank.timer' "$source"
  grep -q 'systemctl --user start tokensrank.timer' "$source"
}
