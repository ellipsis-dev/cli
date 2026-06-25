#!/usr/bin/env bash
#
# Manual end-to-end smoke test of the Ellipsis CLI against a backend.
#
# Drives the device-code login flow and then exercises the authenticated /v1
# surface. Uses an isolated config dir so it never touches your real token.
#
# Usage:
#   ELLIPSIS_API_BASE=http://localhost:5000 ./scripts/smoke.sh
#
# Approval is cookie-authed in the dashboard, so it can't be fully scripted.
# Either approve in the browser at the printed URL, or — for a local backend —
# approve headlessly through the service running in the container:
#
#   docker exec ellipsis-public_api-1 python -c "
#   import os
#   from ellipsis.src.public_api.create_dependencies import create_dependencies
#   from ellipsis.src.public_api.services import cli_auth_service
#   deps = create_dependencies(os.environ)
#   cli_auth_service.approve_cli_auth(deps,
#       customer_id='<CUSTOMER_ID>', user_id='cli-smoke', user_code='<CODE>')"
#
set -euo pipefail

API_BASE="${ELLIPSIS_API_BASE:-http://localhost:5000}"
CONFIG_DIR="$(mktemp -d -t ellipsis-cli-smoke.XXXXXX)"
export ELLIPSIS_API_BASE="$API_BASE"
export ELLIPSIS_CONFIG_DIR="$CONFIG_DIR"

cleanup() { rm -rf "$CONFIG_DIR"; }
trap cleanup EXIT

run() { echo "+ agent $*"; npx tsx src/cli.tsx "$@"; echo; }

echo "API base:    $API_BASE"
echo "Config dir:  $CONFIG_DIR (temporary)"
echo

echo "== Logging in (approve the printed request, then this continues) =="
npx tsx src/cli.tsx login --no-browser

echo "== Authenticated /v1 calls =="
run me
run budget
run usage
run config list
run run list --limit 5

echo "== Logout should clear the token (next call 401s) =="
run logout
if npx tsx src/cli.tsx me; then
  echo "UNEXPECTED: 'me' succeeded after logout" >&2
  exit 1
else
  echo "OK: 'me' failed after logout as expected"
fi

echo
echo "Smoke test complete."
