#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SCRIPT_ROOT="$REPO_ROOT/packages/script"
  AGENT="$SCRIPT_ROOT/bin/agent.mjs"
  TEST_HOME="$(mktemp -d)"
  INPUT_FILE="$TEST_HOME/performance-1000.json"
}

teardown() {
  rm -rf "$TEST_HOME"
}

write_performance_input() {
  node --input-type=module - "$INPUT_FILE" <<'NODE'
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const outputPath = process.argv[2];
const sessions = Array.from({ length: 1000 }, (_, index) => {
  const id = `perf-session-${index}`;

  return {
    session_id: id,
    source: index % 2 === 0 ? 'claude' : 'codex',
    model: index % 2 === 0 ? 'claude-3-5-sonnet-20241022' : 'gpt-5-codex',
    first_event_at: '2026-04-27T10:00:00.000Z',
    last_event_at: '2026-04-27T10:05:00.000Z',
    input_tokens: 1000 + index,
    output_tokens: 250,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0,
    turns: 2,
    file_sha256: createHash('sha256').update(id).digest('hex'),
  };
});

writeFileSync(outputPath, `${JSON.stringify({ sessions })}\n`);
NODE
}

runtime_budget_seconds() {
  case "$(uname -s)" in
    Darwin) printf '30' ;;
    *) printf '60' ;;
  esac
}

@test "agent.mjs processes 1000 sessions within the platform runtime budget" {
  write_performance_input
  budget="$(runtime_budget_seconds)"
  start="$(date +%s)"

  run env TOKENSRANK_HOME="$TEST_HOME" node "$AGENT" --dry-run --input "$INPUT_FILE"

  end="$(date +%s)"
  elapsed="$((end - start))"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Dry-run mode: would send 1000 sessions in 10 batch(es)"* ]]
  [ "$elapsed" -lt "$budget" ]
}
