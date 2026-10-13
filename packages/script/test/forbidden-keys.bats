#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  AGENT="$REPO_ROOT/packages/script/bin/agent.mjs"
  PRE_COMMIT_HOOK="$REPO_ROOT/.husky/pre-commit"
  LINT_STAGED_CONFIG="$REPO_ROOT/.lintstagedrc.json"
}

scan_agent() {
  local pattern="$1"

  if command -v rg >/dev/null 2>&1; then
    rg --line-number --no-heading --color never -e "$pattern" "$AGENT"
    return $?
  fi

  grep -En "$pattern" "$AGENT"
}

assert_no_matches() {
  local label="$1"
  local pattern="$2"
  local violations

  set +e
  violations="$(scan_agent "$pattern")"
  local status=$?
  set -e

  if [ "$status" -eq 0 ]; then
    printf 'Privacy violation: %s\n%s\n' "$label" "$violations" >&2
    return 1
  fi

  return 0
}

assert_has_matches() {
  local label="$1"
  local pattern="$2"
  local matches

  set +e
  matches="$(scan_agent "$pattern")"
  local status=$?
  set -e

  if [ "$status" -ne 0 ]; then
    printf 'Expected allowlisted field reference missing: %s\n' "$label" >&2
    return 1
  fi

  printf '%s\n' "$matches"
  return 0
}

@test "agent does not reference prompt or response content fields" {
  assert_no_matches \
    "message.content, response_text, or prompt extraction" \
    "(message\\.(content|text|thinking)|\\[['\"](content|text|thinking|prompt|response|response_text)['\"]\\]|(^|[^A-Za-z0-9_])(response_text|prompt)\\s*:)"
}

@test "agent does not reference file path, directory, or project path fields" {
  assert_no_matches \
    "file_path, directory, or project_path extraction" \
    "(\\[['\"](file_path|directory|project_path)['\"]\\]|(^|[^A-Za-z0-9_])(file_path|directory|project_path)\\s*:|\\.(file_path|directory|project_path)\\b)"
}

@test "agent does not reference hostnames or IP literals" {
  assert_no_matches \
    "hostname or IP extraction" \
    "(\\[['\"](hostname|hostnames|ip|ip_address)['\"]\\]|(^|[^A-Za-z0-9_])(hostname|hostnames|ip|ip_address)\\s*:|\\b([0-9]{1,3}\\.){3}[0-9]{1,3}\\b)"
}

@test "agent does not reference git, command, or terminal fields" {
  assert_no_matches \
    "git, command, or terminal extraction" \
    "(\\[['\"](git|git_diff|command|commands|terminal|terminal_command)['\"]\\]|(^|[^A-Za-z0-9_])(git|git_diff|command|commands|terminal|terminal_command)\\s*:)"
}

@test "agent references required allowlisted token and session fields" {
  assert_has_matches "input_tokens" "input_tokens" >/dev/null
  assert_has_matches "output_tokens" "output_tokens" >/dev/null
  assert_has_matches "sessionId" "sessionId" >/dev/null
}

@test "pre-commit hook runs forbidden-keys suite for staged script changes" {
  [ -x "$PRE_COMMIT_HOOK" ]
  grep -q 'git diff --cached --name-only -- packages/script/src/ packages/script/bin/agent.mjs' "$PRE_COMMIT_HOOK"
  grep -q 'pnpm --filter @tokensrank/script test:forbidden-keys' "$PRE_COMMIT_HOOK"
}

@test "lint-staged invokes the TypeScript privacy scanner for agent.mjs" {
  run node -e '
    const fs = require("node:fs");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const command = config["packages/script/bin/agent.mjs"];
    if (command !== "pnpm exec tsx scripts/check-script-privacy.ts") process.exit(1);
  ' "$LINT_STAGED_CONFIG"

  [ "$status" -eq 0 ]
}

@test "TypeScript privacy scanner rejects forbidden prompt access" {
  fixture="$BATS_TEST_TMPDIR/privacy-violation.mjs"
  printf '%s\n' 'const leaked = event.prompt;' > "$fixture"

  run pnpm --dir "$REPO_ROOT" exec tsx scripts/check-script-privacy.ts "$fixture"

  [ "$status" -ne 0 ]
  [[ "$output" == *"privacy violation"* ]]
  [[ "$output" == *"prompts_responses"* ]]
}
