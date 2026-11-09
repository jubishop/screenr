#!/bin/bash
# Search both Screenr projects' error events in a time window via `sentry explore`.
#
# Usage:
#   search_related_errors.sh --period PERIOD --query QUERY --out FILE [--limit N]
#
# QUERY must also match a filter for screenr-ios and screenr-server; give
# alternatives in list form, such as request_id:[a,b]. Give range times in UTC
# with Z: the CLI reads a time without a zone as local time. FILE must not
# exist yet.
#
# Examples:
#   search_related_errors.sh --period '2026-11-08T20:00:00Z..2026-11-08T20:30:00Z' \
#     --query 'request_id:<id>' --out "$work/request.json"
#   search_related_errors.sh --period 90d --query 'user.id:<id>' --out "$work/user.json" --limit 25

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

PERIOD=""
QUERY=""
OUT=""
LIMIT=25

while [[ $# -gt 0 ]]; do
  case "$1" in
    --period)
      PERIOD="$2"
      shift 2
      ;;
    --query)
      QUERY="$2"
      shift 2
      ;;
    --out)
      OUT="$2"
      shift 2
      ;;
    --limit)
      LIMIT="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '1,16p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$PERIOD" || -z "$QUERY" || -z "$OUT" ]]; then
  echo "Usage: search_related_errors.sh --period PERIOD --query QUERY --out FILE [--limit N]" >&2
  exit 1
fi
if [[ -e "$OUT" || -L "$OUT" ]]; then
  echo "Error: output file must not already exist; choose a fresh path: $OUT" >&2
  exit 1
fi

require_sentry_auth

sentry_cmd explore "${SENTRY_ORG}/" --dataset errors \
  --field project --field issue --field title --field timestamp --field 'user.id' \
  --field request_id --field release --field environment \
  --query "${SENTRY_PROJECT_FILTER} ${QUERY}" --period "$PERIOD" --limit "$LIMIT" --json >"$OUT"

python3 -I - "$OUT" "$PERIOD" "$QUERY" <<'PY'
import json
import sys

out, period, query = sys.argv[1], sys.argv[2], sys.argv[3]
payload = json.load(open(out))
rows = payload.get("data", [])
print(f"Matched {len(rows)} events")
print(f"Period: {period}")
print(f"Query: {query}")
print(f"Output: {out}")
print()
for row in rows:
    print(
        f"  {row.get('timestamp')}  {row.get('project')}  {row.get('issue')}  "
        f"{(row.get('title') or '')[:80]}  request_id={row.get('request_id')}  user.id={row.get('user.id')}"
    )
PY
