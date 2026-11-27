#!/bin/bash
# Close a Screenr Sentry error issue or feedback item once its tracking work
# is done, then read it back and fail unless Sentry recorded the closure.
#
# Usage:
#   close_sentry_issue.sh ISSUE_ID [--archive]
#
#   ISSUE_ID   The numeric Sentry issue ID, in screenr-ios or screenr-server.
#   --archive  The error is accepted as expected behavior: archive it until it
#              escalates, so the daily intake ignores it.
#
# Without --archive it resolves the issue plainly, never in a commit or
# release: Screenr's Sentry releases name no commits and server events name no
# release, so Sentry would never mark a recurrence as a regression. An issue
# already resolved, or archived with --archive, gets only the readback.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

USAGE="Usage: close_sentry_issue.sh ISSUE_ID [--archive]"
ISSUE_ID=""
ARCHIVE=0

usage_error() {
  echo "Error: $1" >&2
  echo "$USAGE" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive)
      ARCHIVE=1
      shift
      ;;
    -h | --help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    -*)
      usage_error "unknown argument: $1"
      ;;
    *)
      [[ -z "$ISSUE_ID" ]] || usage_error "give one issue ID."
      ISSUE_ID="$1"
      shift
      ;;
  esac
done

[[ "$ISSUE_ID" =~ ^[0-9]+$ ]] || usage_error "give the numeric Sentry issue ID."

require_sentry_auth
ISSUE="${SENTRY_ORG}/${ISSUE_ID}"

# Prints the issue's status and project.
read_issue() {
  local issue_json
  issue_json="$(sentry_cmd issue view "$ISSUE" --fresh --json --fields id,status,statusDetails,project.slug)" || {
    echo "Error: could not read Sentry issue ${ISSUE_ID}." >&2
    return 1
  }
  python3 -I -c '
import json, sys
try:
    issue = json.loads(sys.argv[1])
    print(issue["status"], issue["project"]["slug"])
except (ValueError, KeyError, TypeError):
    sys.exit("Error: Sentry returned unreadable data for the issue.")
' "$issue_json"
}

if [[ "$ARCHIVE" == 1 ]]; then
  EXPECTED=ignored
  DONE="archived until it escalates"
else
  EXPECTED=resolved
  DONE=resolved
fi

STATE="$(read_issue)"
read -r STATUS PROJECT <<<"$STATE"
screenr_project "$PROJECT" || {
  echo "Error: Sentry issue ${ISSUE_ID} is not a Screenr issue: its project is ${PROJECT}." >&2
  exit 1
}

if [[ "$STATUS" == "$EXPECTED" ]]; then
  echo "Sentry issue ${ISSUE_ID} was already ${DONE}."
  exit 0
fi

if [[ "$ARCHIVE" == 1 ]]; then
  sentry_cmd issue archive "$ISSUE" --until auto >/dev/null
else
  sentry_cmd issue resolve "$ISSUE" >/dev/null
fi

STATE="$(read_issue)"
read -r STATUS _ <<<"$STATE"
if [[ "$STATUS" != "$EXPECTED" ]]; then
  echo "Error: Sentry did not record the closure: issue ${ISSUE_ID} reads status ${STATUS}." >&2
  exit 1
fi
echo "Sentry issue ${ISSUE_ID} is ${DONE}."
