#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_HOME="${TOKENSRANK_HOME:-${HOME}/.tokensrank}"
BIN_DIR="${INSTALL_HOME}/bin"
LOG_DIR="${INSTALL_HOME}/logs"
SCHEDULER_SOURCE_DIR="${SCRIPT_DIR}/scheduler"
CONFIG_PATH="${INSTALL_HOME}/config.json"
STATE_PATH="${INSTALL_HOME}/state.json"
ACCESS_KEY_PATH="${INSTALL_HOME}/access-key"
INSTALL_LOG="${LOG_DIR}/install.log"
AGENT_SOURCE="${SCRIPT_DIR}/bin/agent.mjs"
AGENT_TARGET="${INSTALL_HOME}/agent.mjs"
BIN_AGENT_TARGET="${BIN_DIR}/agent.mjs"
WRAPPER_TARGET="${BIN_DIR}/tokensrank"
API_BASE="${TOKENSRANK_API_BASE:-https://api.tokensrank.ai}"
ACCESS_KEY="${TOKENSRANK_ACCESS_KEY:-${TOKENSRANK_SCRIPT_KEY:-}}"
PROFILE_HANDLE="${TOKENSRANK_PROFILE_HANDLE:-}"
CLIENT_VERSION="0.0.1"
SCHEDULER_MODE="${TOKENSRANK_INSTALL_SCHEDULER:-auto}"
RUN_FIRST="${TOKENSRANK_INSTALL_RUN_FIRST:-1}"

log() {
  mkdir -p "$LOG_DIR"
  chmod 0700 "$INSTALL_HOME" "$LOG_DIR" 2>/dev/null || true
  printf '[tokensrank-install] %s\n' "$*" | tee -a "$INSTALL_LOG" >/dev/null
}

fail() {
  log "ERROR: $*"
  printf '[tokensrank-install] ERROR: %s\n' "$*" >&2
  exit 1
}

require_node() {
  command -v node >/dev/null 2>&1 || fail 'Node.js 20 LTS or newer is required before installing TokensRank.'
}

generate_uuid() {
  node -e 'process.stdout.write(require("node:crypto").randomUUID())'
}

iso_now() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

atomic_write_json() {
  local target="$1"
  local body="$2"
  local directory tmp

  directory="$(dirname "$target")"
  tmp="$(mktemp "${directory}/.${target##*/}.tmp.XXXXXX")"
  chmod 0600 "$tmp"
  printf '%s\n' "$body" > "$tmp"
  mv "$tmp" "$target"
  chmod 0600 "$target"
}

read_existing_install_id() {
  if [[ -f "$CONFIG_PATH" ]]; then
    node -e '
      const fs = require("node:fs");
      try {
        const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).install_id;
        if (typeof value === "string" && value) process.stdout.write(value);
      } catch {}
    ' "$CONFIG_PATH"
    return
  fi

  if [[ -f "$STATE_PATH" ]]; then
    node -e '
      const fs = require("node:fs");
      try {
        const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).install_id;
        if (typeof value === "string" && value) process.stdout.write(value);
      } catch {}
    ' "$STATE_PATH"
  fi
}

build_config_json() {
  local install_id="$1"
  local installed_at="$2"

  node -e '
    const fs = require("node:fs");
    const [
      path,
      accessKey,
      profileHandle,
      apiBase,
      installId,
      clientVersion,
      installedAt,
    ] = process.argv.slice(1);

    let existing = {};
    try {
      if (fs.existsSync(path)) {
        const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          existing = parsed;
        }
      }
    } catch {}

    const next = { ...existing };
    if (accessKey) next.access_key = accessKey;
    else if (!Object.prototype.hasOwnProperty.call(next, "access_key")) next.access_key = "";

    if (profileHandle || !Object.prototype.hasOwnProperty.call(next, "profile_handle")) {
      next.profile_handle = profileHandle;
    }

    next.api_base = apiBase;
    next.install_id = typeof next.install_id === "string" && next.install_id ? next.install_id : installId;
    next.client_version = clientVersion;
    next.ingestion_mode = "script";
    next.installed_at = typeof next.installed_at === "string" && next.installed_at ? next.installed_at : installedAt;

    process.stdout.write(JSON.stringify(next, null, 2));
  ' "$CONFIG_PATH" "$ACCESS_KEY" "$PROFILE_HANDLE" "$API_BASE" "$install_id" "$CLIENT_VERSION" "$installed_at"
}

build_state_json() {
  local install_id="$1"

  # Every install resets runtime state so the next sync re-ships every session
  # the user has on disk. Server-side dedup (UNIQUE on profile/source/session/sha)
  # makes re-shipping idempotent. Only install_id is preserved for telemetry
  # continuity across reinstalls.
  node -e '
    const fs = require("node:fs");
    const [path, installId] = process.argv.slice(1);

    let existingInstallId = installId;
    try {
      if (fs.existsSync(path)) {
        const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
            && typeof parsed.install_id === "string" && parsed.install_id) {
          existingInstallId = parsed.install_id;
        }
      }
    } catch {}

    const next = {
      install_id: existingInstallId,
      access_key_invalid: false,
      last_run_at: null,
      shipped_session_ids: [],
      pending_payloads: [],
    };

    process.stdout.write(JSON.stringify(next, null, 2));
  ' "$STATE_PATH" "$install_id"
}

write_initial_config_and_state() {
  local install_id installed_at config state config_existed state_existed

  install_id="$(read_existing_install_id)"
  if [[ -z "$install_id" ]]; then
    install_id="$(generate_uuid)"
  fi

  installed_at="$(iso_now)"

  config_existed=0
  if [[ -f "$CONFIG_PATH" ]]; then
    config_existed=1
  fi

  config="$(build_config_json "$install_id" "$installed_at")"
  atomic_write_json "$CONFIG_PATH" "$config"
  if [[ "$config_existed" == "1" ]]; then
    log "Updated config.json with latest install settings"
  else
    log "Created config.json"
  fi

  if [[ -n "$ACCESS_KEY" ]]; then
    printf '%s\n' "$ACCESS_KEY" > "$ACCESS_KEY_PATH"
    chmod 0600 "$ACCESS_KEY_PATH"
    log "Updated access-key handoff file"
  fi

  state_existed=0
  if [[ -f "$STATE_PATH" ]]; then
    state_existed=1
  fi

  state="$(build_state_json "$install_id")"
  atomic_write_json "$STATE_PATH" "$state"
  if [[ "$state_existed" == "1" ]]; then
    log "Reset state.json runtime fields (shipped_session_ids, pending_payloads, last_run_at, access_key_invalid); install_id preserved"
  else
    log "Created state.json"
  fi
}

install_agent() {
  [[ -f "$AGENT_SOURCE" ]] || fail "agent.mjs not found at $AGENT_SOURCE"
  cp "$AGENT_SOURCE" "$AGENT_TARGET"
  chmod 0755 "$AGENT_TARGET"
  cp "$AGENT_TARGET" "$BIN_AGENT_TARGET"
  chmod 0755 "$BIN_AGENT_TARGET"
  cat > "$WRAPPER_TARGET" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v node >/dev/null 2>&1; then
  exec node "${SCRIPT_DIR}/agent.mjs" "$@"
fi

printf '[tokensrank-script] ERROR: Node.js 20 LTS or newer is required.\n' >&2
exit 2
SH
  chmod 0755 "$WRAPPER_TARGET"
}

render_scheduler_template() {
  local template="$1"
  local target="$2"
  local tmp="$3"
  local node_bin="$4"

  [[ -f "$template" ]] || fail "Scheduler template not found at $template"
  node -e '
    const fs = require("node:fs");
    const [template, target, installHome, nodeBin, apiBase] = process.argv.slice(1);
    const rendered = fs.readFileSync(template, "utf8")
      .replaceAll("__TOKENSRANK_HOME__", installHome)
      .replaceAll("__TOKENSRANK_NODE__", nodeBin)
      .replaceAll("__TOKENSRANK_API_BASE__", apiBase);
    fs.writeFileSync(target, rendered, { mode: 0o644 });
  ' "$template" "$tmp" "$INSTALL_HOME" "$node_bin" "$API_BASE"
  chmod 0644 "$tmp"
  mv "$tmp" "$target"
  chmod 0644 "$target"
}

write_launchd_plist() {
  local launch_agents plist tmp node_bin template

  node_bin="$(command -v node)"
  launch_agents="${TOKENSRANK_LAUNCHD_DIR:-${HOME}/Library/LaunchAgents}"
  plist="${launch_agents}/com.tokensrank.runner.plist"
  template="${SCHEDULER_SOURCE_DIR}/com.tokensrank.runner.plist"
  mkdir -p "$launch_agents"
  tmp="$(mktemp "${launch_agents}/.com.tokensrank.runner.plist.tmp.XXXXXX")"

  render_scheduler_template "$template" "$plist" "$tmp" "$node_bin"

  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$plist" >/dev/null
  fi

  if command -v launchctl >/dev/null 2>&1 && [[ "${TOKENSRANK_SKIP_SCHEDULER_REGISTER:-0}" != "1" ]]; then
    launchctl unload "$plist" >/dev/null 2>&1 || launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
    launchctl load "$plist" >/dev/null 2>&1 || launchctl bootstrap "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
  fi

  log "Registered macOS launchd scheduler at $plist"
}

write_systemd_units() {
  local unit_dir service timer node_bin service_template timer_template service_tmp timer_tmp

  node_bin="$(command -v node)"
  unit_dir="${TOKENSRANK_SYSTEMD_USER_DIR:-${HOME}/.config/systemd/user}"
  service="${unit_dir}/tokensrank.service"
  timer="${unit_dir}/tokensrank.timer"
  service_template="${SCHEDULER_SOURCE_DIR}/tokensrank.service"
  timer_template="${SCHEDULER_SOURCE_DIR}/tokensrank.timer"
  mkdir -p "$unit_dir"
  service_tmp="$(mktemp "${unit_dir}/.tokensrank.service.tmp.XXXXXX")"
  timer_tmp="$(mktemp "${unit_dir}/.tokensrank.timer.tmp.XXXXXX")"

  render_scheduler_template "$service_template" "$service" "$service_tmp" "$node_bin"
  render_scheduler_template "$timer_template" "$timer" "$timer_tmp" "$node_bin"

  if command -v systemctl >/dev/null 2>&1 && [[ "${TOKENSRANK_SKIP_SCHEDULER_REGISTER:-0}" != "1" ]]; then
    systemctl --user disable --now tokensrank.timer >/dev/null 2>&1 || true
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    systemctl --user enable tokensrank.timer >/dev/null 2>&1 || true
    systemctl --user start tokensrank.timer >/dev/null 2>&1 || true
    if command -v loginctl >/dev/null 2>&1; then
      loginctl enable-linger "$USER" >/dev/null 2>&1 || log 'loginctl enable-linger failed; timer will run while the user session is active.'
    fi
  fi

  log "Registered Linux systemd scheduler at $unit_dir"
}

register_scheduler() {
  local kernel

  if [[ "$SCHEDULER_MODE" == "none" ]]; then
    log 'Scheduler registration skipped by TOKENSRANK_INSTALL_SCHEDULER=none'
    return
  fi

  kernel="${TOKENSRANK_TEST_UNAME:-$(uname -s)}"
  case "$kernel" in
    Darwin)
      write_launchd_plist
      ;;
    Linux)
      write_systemd_units
      ;;
    *)
      fail "Unsupported OS: $kernel"
      ;;
  esac
}

run_first_sync() {
  if [[ "$RUN_FIRST" != "1" ]]; then
    log 'First run skipped by TOKENSRANK_INSTALL_RUN_FIRST'
    return
  fi

  node "$AGENT_TARGET" --first-run --scan-home >> "$INSTALL_LOG" 2>&1 || log 'First run failed; scheduler remains installed.'
}

signal_installation_complete() {
  if [[ -z "$ACCESS_KEY" ]]; then
    log 'Skipping installation signal: no access key'
    return
  fi

  local api_response
  api_response=$(node -e '
    (async () => {
      const accessKey = process.argv[1];
      const apiBase = process.argv[2].replace(/\/+$/, "");
      try {
        const response = await fetch(`${apiBase}/api/installer/complete`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({})
        });
        if (response.ok) {
          process.stdout.write("ok");
        } else {
          process.stdout.write(`error:${response.status}`);
        }
      } catch (error) {
        process.stdout.write(`error:${error.message}`);
      }
    })();
  ' "$ACCESS_KEY" "$API_BASE" 2>/dev/null || echo "failed")

  if [[ "$api_response" == "ok" ]]; then
    log 'Installation complete signal sent to server.'
  else
    log "Installation signal failed: $api_response"
  fi
}

main() {
  require_node
  umask 077
  mkdir -p "$BIN_DIR" "$LOG_DIR"
  chmod 0700 "$INSTALL_HOME" "$BIN_DIR" "$LOG_DIR"
  : > "$INSTALL_LOG"
  chmod 0600 "$INSTALL_LOG"

  write_initial_config_and_state
  install_agent
  register_scheduler
  run_first_sync
  signal_installation_complete

  printf 'TokensRank script installed at %s\n' "$INSTALL_HOME"
}

main "$@"
