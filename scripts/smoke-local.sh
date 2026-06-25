#!/usr/bin/env bash
#
# Fully-automated end-to-end smoke test against a LOCAL docker compose backend.
#
# Unlike scripts/smoke.sh (which waits for you to approve the login by hand),
# this drives the whole device-code flow itself: it starts `agent login`,
# scrapes the user code, and approves it headlessly by calling the cli_auth
# service inside the running `public_api` container — then exercises the
# authenticated /v1 surface. Uses a throwaway config dir, so your real token is
# never touched.
#
# Prereqs: docker compose up (public_api reachable at $ELLIPSIS_API_BASE).
#
# Usage:
#   ./scripts/smoke-local.sh
#   ELLIPSIS_API_BASE=http://localhost:5000 \
#     ELLIPSIS_PUBLIC_API_CONTAINER=ellipsis-public_api-1 \
#     ELLIPSIS_SMOKE_CUSTOMER_ID=cust_xxx ./scripts/smoke-local.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

API_BASE="${ELLIPSIS_API_BASE:-http://localhost:5000}"
CONTAINER="${ELLIPSIS_PUBLIC_API_CONTAINER:-ellipsis-public_api-1}"
CONFIG_DIR="$(mktemp -d -t ellipsis-cli-smoke.XXXXXX)"
LOGIN_OUT="$(mktemp -t ellipsis-cli-login.XXXXXX)"

export ELLIPSIS_API_BASE="$API_BASE"
export ELLIPSIS_CONFIG_DIR="$CONFIG_DIR"

LOGIN_PID=""
cleanup() {
  [ -n "$LOGIN_PID" ] && kill "$LOGIN_PID" 2>/dev/null || true
  rm -rf "$CONFIG_DIR" "$LOGIN_OUT"
}
trap cleanup EXIT

run() { echo "+ agent $*"; npx tsx src/cli.tsx "$@"; echo; }

echo "API base:   $API_BASE"
echo "Container:  $CONTAINER"
echo "Config dir: $CONFIG_DIR (temporary)"
echo

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "ERROR: container '$CONTAINER' is not running. Start docker compose first." >&2
  exit 1
fi

# Pick the customer to attribute the login to (override with ELLIPSIS_SMOKE_CUSTOMER_ID).
CUSTOMER_ID="${ELLIPSIS_SMOKE_CUSTOMER_ID:-}"
if [ -z "$CUSTOMER_ID" ]; then
  CUSTOMER_ID="$(docker exec "$CONTAINER" python -c "
import os, psycopg2
uri = os.environ.get('POSTGRES_URI_POOLED') or os.environ.get('POSTGRES_URI_DIRECT')
c = psycopg2.connect(uri); cur = c.cursor()
cur.execute('select id from customers order by created_at limit 1')
print(cur.fetchone()[0])")"
fi
echo "Approving as customer: $CUSTOMER_ID"
echo

echo "== Starting login (device-code flow) =="
npx tsx src/cli.tsx login --no-browser >"$LOGIN_OUT" 2>&1 &
LOGIN_PID=$!

# Wait for the CLI to print the verification code (format XXXX-XXXX).
USER_CODE=""
for _ in $(seq 1 20); do
  USER_CODE="$(grep -oE '[A-Z0-9]{4}-[A-Z0-9]{4}' "$LOGIN_OUT" | head -1 || true)"
  [ -n "$USER_CODE" ] && break
  sleep 0.5
done
if [ -z "$USER_CODE" ]; then
  echo "ERROR: never saw a verification code. Login output:" >&2
  cat "$LOGIN_OUT" >&2
  exit 1
fi
echo "User code: $USER_CODE"

echo "== Approving via the public_api container =="
docker exec -e SMOKE_CODE="$USER_CODE" -e SMOKE_CUSTOMER="$CUSTOMER_ID" "$CONTAINER" python -c "
import os
from ellipsis.src.public_api.create_dependencies import create_dependencies
from ellipsis.src.public_api.services import cli_auth_service
deps = create_dependencies(os.environ)
cli_auth_service.approve_cli_auth(
    deps,
    customer_id=os.environ['SMOKE_CUSTOMER'],
    user_id='cli-smoke',
    user_code=os.environ['SMOKE_CODE'],
)
print('approved')
"

echo "== Waiting for the CLI to collect the token =="
wait "$LOGIN_PID"
LOGIN_PID=""
cat "$LOGIN_OUT"
echo

echo "== Authenticated /v1 calls =="
run me
run budget
run usage
run config list
run run list --limit 5

echo "== Logout should clear the token (next call 401s) =="
run logout
if npx tsx src/cli.tsx me 2>/dev/null; then
  echo "UNEXPECTED: 'me' succeeded after logout" >&2
  exit 1
fi
echo "OK: 'me' failed after logout as expected"

echo
echo "✓ Local smoke test complete."
