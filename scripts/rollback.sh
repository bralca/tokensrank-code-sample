#!/usr/bin/env bash

set -e
set -u
set -o pipefail

CURRENT_LINK="${TOKENSRANK_CURRENT_LINK:-/srv/tokensrank}"
PREVIOUS_LINK="${TOKENSRANK_PREVIOUS_LINK:-/srv/tokensrank-prev}"
WEB_HEALTH_URL="${TOKENSRANK_WEB_HEALTH_URL:-http://127.0.0.1:3000/healthz}"
API_HEALTH_URL="${TOKENSRANK_API_HEALTH_URL:-http://127.0.0.1:3001/healthz}"
PM2_CMD="${TOKENSRANK_PM2_CMD:-pm2}"
HEALTH_ATTEMPTS="${TOKENSRANK_HEALTH_ATTEMPTS:-30}"
HEALTH_DELAY_SECONDS="${TOKENSRANK_HEALTH_DELAY_SECONDS:-1}"

get_release_dir() {
  link_path="$1"

  if [ ! -L "$link_path" ]; then
    echo "ERROR: $link_path is not a symlink" >&2
    return 1
  fi

  target_path="$(readlink "$link_path")"
  if [ -z "$target_path" ]; then
    echo "ERROR: $link_path does not point to a release" >&2
    return 1
  fi

  case "$target_path" in
    /*) ;;
    *) target_path="$(cd "$(dirname "$link_path")" && pwd -P)/$target_path" ;;
  esac

  if [ ! -d "$target_path" ]; then
    echo "ERROR: release directory does not exist: $target_path" >&2
    return 1
  fi

  cd "$target_path" && pwd -P
}

health_check() {
  attempt=1

  while [ "$attempt" -le "$HEALTH_ATTEMPTS" ]; do
    if curl -fsS "$WEB_HEALTH_URL" >/dev/null && curl -fsS "$API_HEALTH_URL" >/dev/null; then
      echo "Health checks passed for web and api"
      return 0
    fi

    echo "Health check attempt $attempt/$HEALTH_ATTEMPTS failed; retrying in ${HEALTH_DELAY_SECONDS}s"
    sleep "$HEALTH_DELAY_SECONDS"
    attempt=$((attempt + 1))
  done

  echo "ERROR: health checks failed for $WEB_HEALTH_URL and $API_HEALTH_URL" >&2
  return 1
}

main() {
  current_release="$(get_release_dir "$CURRENT_LINK")"
  previous_release="$(get_release_dir "$PREVIOUS_LINK")"

  if [ "$current_release" = "$previous_release" ]; then
    echo "ERROR: current and previous releases point to the same directory: $current_release" >&2
    exit 1
  fi

  cat <<EOF
TokensRank rollback

Current release:  $current_release
Previous release: $previous_release

Rollback will:
  1. Point $CURRENT_LINK to $previous_release
  2. Point $PREVIOUS_LINK to $current_release
  3. Restart PM2 processes with updated environment
  4. Verify web and api health endpoints
EOF

  printf "Continue with rollback? Type 'yes' to proceed: "
  read -r confirmation

  if [ "$confirmation" != "yes" ]; then
    echo "Rollback cancelled"
    exit 1
  fi

  ln -sfn "$previous_release" "${CURRENT_LINK}.next"
  if mv -Tf "${CURRENT_LINK}.next" "$CURRENT_LINK" 2>/dev/null; then
    :
  else
    rm -f "$CURRENT_LINK"
    mv "${CURRENT_LINK}.next" "$CURRENT_LINK"
  fi

  ln -sfn "$current_release" "$PREVIOUS_LINK"

  "$PM2_CMD" restart all --update-env

  if health_check; then
    echo "Rollback completed successfully"
    exit 0
  fi

  echo "Rollback completed but health checks failed" >&2
  exit 1
}

main "$@"
