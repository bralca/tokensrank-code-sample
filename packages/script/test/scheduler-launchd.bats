#!/usr/bin/env bats

setup() {
  if [ "$(uname -s)" != "Darwin" ]; then
    skip "launchd scheduler tests require macOS"
  fi

  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SCRIPT_ROOT="$REPO_ROOT/packages/script"
  TEMPLATE="$SCRIPT_ROOT/scheduler/com.tokensrank.runner.plist"
  TEST_ROOT="$(mktemp -d)"
  TEST_HOME="$TEST_ROOT/home"
  LAUNCHD_DIR="$TEST_ROOT/launch-agents"
  mkdir -p "$TEST_HOME" "$LAUNCHD_DIR"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

run_launchd_install() {
  env \
    HOME="$TEST_HOME" \
    TOKENSRANK_HOME="$TEST_HOME/.tokensrank" \
    TOKENSRANK_TEST_UNAME=Darwin \
    TOKENSRANK_LAUNCHD_DIR="$LAUNCHD_DIR" \
    TOKENSRANK_SKIP_SCHEDULER_REGISTER=1 \
    TOKENSRANK_INSTALL_RUN_FIRST=0 \
    TOKENSRANK_ACCESS_KEY="tr_script_launchd_test" \
    "$SCRIPT_ROOT/install.sh"
}

plist_path() {
  printf '%s/com.tokensrank.runner.plist' "$LAUNCHD_DIR"
}

@test "launchd template is valid and labels the TokensRank runner" {
  run plutil -lint "$TEMPLATE"

  [ "$status" -eq 0 ]
  grep -q '<string>com.tokensrank.runner</string>' "$TEMPLATE"
}

@test "installer registers launchd by writing the plist to LaunchAgents" {
  run run_launchd_install

  [ "$status" -eq 0 ]
  [ -f "$(plist_path)" ]
  [ "$(stat -f '%Lp' "$(plist_path)")" = "644" ]
  grep -q "$TEST_HOME/.tokensrank/agent.mjs" "$(plist_path)"
}

@test "launchd plist uses StartInterval=3600 for hourly sync" {
  run_launchd_install >/dev/null

  grep -A1 '<key>StartInterval</key>' "$(plist_path)" | grep -q '<integer>3600</integer>'
}

@test "launchd plist uses RunAtLoad=true for catch-up on login" {
  run_launchd_install >/dev/null

  grep -A1 '<key>RunAtLoad</key>' "$(plist_path)" | grep -q '<true/>'
}

@test "launchd installer is idempotent across repeated installs" {
  run_launchd_install >/dev/null
  before="$(shasum -a 256 "$(plist_path)" | awk '{print $1}')"

  run run_launchd_install
  after="$(shasum -a 256 "$(plist_path)" | awk '{print $1}')"

  [ "$status" -eq 0 ]
  [ "$before" = "$after" ]
}

@test "launchd registration source uses unload before load" {
  source="$SCRIPT_ROOT/install.sh"

  grep -q 'launchctl unload' "$source"
  grep -q 'launchctl load' "$source"
}
