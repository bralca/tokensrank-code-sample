#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  AGENT="$REPO_ROOT/packages/script/bin/agent.mjs"
  TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/tokensrank-offline-queue.XXXXXX")"
  export TOKENSRANK_HOME="$TEST_ROOT/home"
  mkdir -p "$TOKENSRANK_HOME"
  INPUT_FILE="$TEST_ROOT/input.json"
  STATE_FILE="$TOKENSRANK_HOME/state.json"
  SERVER_PID=""
}

teardown() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_ROOT"
}

write_input_sessions() {
  local count="${1:-1}"
  node --input-type=module - "$INPUT_FILE" "$count" <<'NODE'
import { writeFileSync } from 'node:fs';
const [path, countRaw] = process.argv.slice(2);
const count = Number(countRaw);
const sessions = Array.from({ length: count }, (_, index) => ({
  session_id: `session-${index}`,
  source: 'claude',
  model: 'claude-3-5-sonnet-20241022',
  first_event_at: '2026-04-28T10:00:00.000Z',
  last_event_at: '2026-04-28T10:01:00.000Z',
  input_tokens: index + 1,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cached_input_tokens: 0,
  reasoning_output_tokens: 0,
  turns: 1,
  file_sha256: String(index).padStart(64, 'a').slice(-64),
}));
writeFileSync(path, `${JSON.stringify({ sessions })}\n`);
NODE
}

write_empty_input() {
  printf '{"sessions":[]}\n' > "$INPUT_FILE"
}

write_state_with_pending() {
  local count="$1"
  node --input-type=module - "$STATE_FILE" "$count" <<'NODE'
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const [path, countRaw] = process.argv.slice(2);
const count = Number(countRaw);
const payloadFor = (index) => ({
  client: {
    version: '0.0.1',
    install_id: '11111111-1111-4111-8111-111111111111',
    platform: 'darwin',
    arch: 'arm64',
  },
  run: {
    run_id: `run-${index}`,
    started_at: '2026-04-28T10:00:00.000Z',
    finished_at: '2026-04-28T10:01:00.000Z',
  },
  sessions: [{
    session_id: `session-${index}`,
    source: 'claude',
    model: 'claude-3-5-sonnet-20241022',
    first_event_at: '2026-04-28T10:00:00.000Z',
    last_event_at: '2026-04-28T10:01:00.000Z',
    input_tokens: index + 1,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0,
    turns: 1,
    file_sha256: String(index).padStart(64, 'b').slice(-64),
  }],
});
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, `${JSON.stringify({
  install_id: '11111111-1111-4111-8111-111111111111',
  access_key_invalid: false,
  last_run_at: null,
  shipped_session_ids: [],
  pending_payloads: Array.from({ length: count }, (_, index) => ({
    payload: payloadFor(index),
    attempted_at: '2026-04-28T10:00:00.000Z',
    retry_count: 0,
  })),
}, null, 2)}\n`);
NODE
}

start_accepting_server() {
  PORT_FILE="$TEST_ROOT/port"
  node --input-type=module - "$PORT_FILE" <<'NODE' &
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
const [portFile] = process.argv.slice(2);
const server = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/api/script/sessions') {
    request.resume();
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  writeFileSync(portFile, String(address.port));
});
NODE
  SERVER_PID="$!"
  for _ in $(seq 1 50); do
    [ -s "$PORT_FILE" ] && break
    sleep 0.1
  done
  API_BASE="http://127.0.0.1:$(cat "$PORT_FILE")"
}

@test "network error queues payload in state.json" {
  write_input_sessions 1

  run env TOKENSRANK_HOME="$TOKENSRANK_HOME" node "$AGENT" --first-run --input "$INPUT_FILE" --api-base "http://127.0.0.1:9" --key "tr_script_test"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"queued":1'* ]]
  node --input-type=module - "$STATE_FILE" <<'NODE'
import { readFileSync } from 'node:fs';
const state = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (state.pending_payloads.length !== 1) process.exit(2);
NODE
}

@test "queue survives restart and drains with info log" {
  write_state_with_pending 1
  write_empty_input
  start_accepting_server

  run env TOKENSRANK_HOME="$TOKENSRANK_HOME" node "$AGENT" --force --input "$INPUT_FILE" --api-base "$API_BASE" --key "tr_script_test"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Drained 1 payloads from offline queue"* ]]
  node --input-type=module - "$STATE_FILE" <<'NODE'
import { readFileSync } from 'node:fs';
const state = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (state.pending_payloads.length !== 0) process.exit(2);
NODE
}

@test "24-cap FIFO eviction persists oldest removal" {
  write_state_with_pending 25
  write_empty_input

  run env TOKENSRANK_HOME="$TOKENSRANK_HOME" node "$AGENT" --force --input "$INPUT_FILE"

  [ "$status" -eq 0 ]
  node --input-type=module - "$STATE_FILE" <<'NODE'
import { readFileSync } from 'node:fs';
const state = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (state.pending_payloads.length !== 24) process.exit(2);
if (state.pending_payloads[0].payload.sessions[0].session_id !== 'session-1') process.exit(3);
NODE
}

@test "state.json remains valid JSON after offline queue write" {
  write_input_sessions 1

  run env TOKENSRANK_HOME="$TOKENSRANK_HOME" node "$AGENT" --first-run --input "$INPUT_FILE" --api-base "http://127.0.0.1:9" --key "tr_script_test"

  [ "$status" -eq 0 ]
  node --input-type=module - "$STATE_FILE" <<'NODE'
import { readFileSync } from 'node:fs';
const state = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(state.pending_payloads)) process.exit(2);
NODE
}
