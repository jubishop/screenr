#!/bin/bash
# Screenr Sentry skill helpers: wrap the installed `sentry` CLI (cli.sentry.dev).
# Auth: SENTRY_AUTH_TOKEN, or a token from an earlier `sentry auth login`.
# The helpers that source this file use its variables.
# shellcheck disable=SC2034

SENTRY_ORG="artisanal-software"
# The Screenr projects, as a Sentry search filter.
SENTRY_PROJECT_FILTER="project:[screenr-ios,screenr-server]"

screenr_project() {
  [[ "$1" == "screenr-ios" || "$1" == "screenr-server" ]]
}

sentry_bin() {
  local bin
  if [[ -n "${SENTRY_BIN:-}" ]]; then
    bin="${SENTRY_BIN}"
  elif command -v sentry >/dev/null 2>&1; then
    bin="$(command -v sentry)"
  else
    echo "Error: the sentry CLI is required on PATH." >&2
    echo "  Install it from https://cli.sentry.dev, then run: sentry auth login" >&2
    return 127
  fi
  echo "$bin"
}

sentry_cmd() {
  local bin
  bin="$(sentry_bin)" || return
  "$bin" "$@"
}

sentry_api_json() {
  local endpoint="$1" kind="$2" output="$3" response helper_dir
  helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || return
  response="$(mktemp)" || return
  if ! sentry_cmd api "$endpoint" --json >"$response"; then
    echo "Error: Sentry CLI request failed for ${endpoint}" >&2
    rm -f "$response" "$output"
    return 1
  fi
  if ! python3 -I "${helper_dir}/api_payload.py" "$endpoint" "$kind" <"$response" >"$output"; then
    rm -f "$response" "$output"
    return 1
  fi
  rm -f "$response"
}

require_sentry_auth() {
  local bin
  bin="$(sentry_bin)" || return
  if ! "$bin" auth status >/dev/null 2>&1; then
    echo "Error: Sentry auth required. Run: sentry auth login" >&2
    echo "  (or set SENTRY_AUTH_TOKEN)" >&2
    return 1
  fi
}
