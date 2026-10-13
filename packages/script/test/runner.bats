#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SCRIPT_ROOT="$REPO_ROOT/packages/script"
  TOKENSRANK_TEST_HOME="$(mktemp -d)"
}

teardown() {
  rm -rf "$TOKENSRANK_TEST_HOME"
}

@test "install.sh creates a runnable isolated installation" {
  run env \
    TOKENSRANK_HOME="$TOKENSRANK_TEST_HOME" \
    TOKENSRANK_INSTALL_SCHEDULER=none \
    TOKENSRANK_INSTALL_RUN_FIRST=0 \
    "$SCRIPT_ROOT/install.sh"

  [ "$status" -eq 0 ]
  [[ "$output" == *"TokensRank script installed at $TOKENSRANK_TEST_HOME"* ]]

  run node -e "const fs=require('node:fs'); const cfg=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (!/^[0-9a-f-]{36}$/.test(cfg.install_id)) process.exit(1); if (!cfg.installed_at.endsWith('Z')) process.exit(1);" "$TOKENSRANK_TEST_HOME/config.json"

  [ "$status" -eq 0 ]

  run "$TOKENSRANK_TEST_HOME/bin/agent.mjs" --dry-run

  [ "$status" -eq 0 ]
  [[ "$output" == *'"sessions": []'* ]]
}

@test "agent.mjs supports dry-run output" {
  run node "$SCRIPT_ROOT/bin/agent.mjs" --dry-run

  [ "$status" -eq 0 ]
  [[ "$output" == *'"sessions": []'* ]]
}
