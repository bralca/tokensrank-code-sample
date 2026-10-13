#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SCRIPT_ROOT="$REPO_ROOT/packages/script"
  LAUNCHD_TEMPLATE="$SCRIPT_ROOT/scheduler/com.tokensrank.runner.plist"
  SYSTEMD_SERVICE="$SCRIPT_ROOT/scheduler/tokensrank.service"
  SYSTEMD_TIMER="$SCRIPT_ROOT/scheduler/tokensrank.timer"
  INSTALL_PS1="$SCRIPT_ROOT/install.ps1"
  AGENT="$SCRIPT_ROOT/bin/agent.mjs"
  TEST_ROOT="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

@test "FR-80 macOS catch-up uses RunAtLoad with hourly StartInterval" {
  grep -A1 '<key>RunAtLoad</key>' "$LAUNCHD_TEMPLATE" | grep -q '<true/>'
  grep -A1 '<key>StartInterval</key>' "$LAUNCHD_TEMPLATE" | grep -q '<integer>3600</integer>'
}

@test "FR-80 Linux catch-up uses Persistent plus OnBootSec" {
  grep -q '^Persistent=true$' "$SYSTEMD_TIMER"
  grep -q '^OnBootSec=2min$' "$SYSTEMD_TIMER"
  grep -q '^OnUnitActiveSec=1h$' "$SYSTEMD_TIMER"
}

@test "FR-80 Windows catch-up uses StartWhenAvailable with hourly recurrence" {
  grep -q 'StartWhenAvailable' "$INSTALL_PS1"
  grep -q 'RepetitionInterval (New-TimeSpan -Hours 1)' "$INSTALL_PS1"
}

@test "catch-up scheduler entries all execute agent.mjs" {
  grep -q 'agent\.mjs' "$LAUNCHD_TEMPLATE"
  grep -q '<string>--scan-home</string>' "$LAUNCHD_TEMPLATE"
  grep -q '^ExecStart=.*agent\.mjs --scan-home$' "$SYSTEMD_SERVICE"
  grep -q 'tokensrank\.ps1' "$INSTALL_PS1"
  grep -q -- '--scan-home' "$INSTALL_PS1"
}

@test "dedup state prevents double-processing on catch-up" {
  state="$TEST_ROOT/state.json"
  input="$TEST_ROOT/input.json"
  session_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

  cat > "$state" <<JSON
{
  "install_id": "11111111-1111-4111-8111-111111111111",
  "last_run_at": "2026-04-28T00:00:00.000Z",
  "access_key_invalid": false,
  "shipped_session_ids": [
    {
      "session_id": "catch-up-session",
      "source": "claude",
      "file_sha256": "$session_sha",
      "shipped_at": "2026-04-28T00:00:00.000Z"
    }
  ],
  "pending_payloads": []
}
JSON

  cat > "$input" <<JSON
{
  "sessions": [
    {
      "session_id": "catch-up-session",
      "source": "claude",
      "model": "claude-3-5-sonnet-20241022",
      "first_event_at": "2026-04-28T01:00:00.000Z",
      "last_event_at": "2026-04-28T01:01:00.000Z",
      "input_tokens": 10,
      "output_tokens": 5,
      "cache_read_input_tokens": 0,
      "cache_creation_input_tokens": 0,
      "cached_input_tokens": 0,
      "reasoning_output_tokens": 0,
      "turns": 1,
      "file_sha256": "$session_sha"
    }
  ]
}
JSON

  run env TOKENSRANK_HOME="$TEST_ROOT" node "$AGENT" --dry-run --input "$input" --state "$state"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Dry-run mode: would send 0 sessions in 0 batch(es)"* ]]
  [[ "$output" != *"catch-up-session\""* ]]
}
