#!/bin/sh
# deploy/up.sh (H-504) — first start / restart of the production stack.
#
# check-env -> build -> up -d (tunnel profile included) -> wait for health.
# The Cloudflare Tunnel sidecar runs under the `tunnel` profile; drills and
# CI pass --no-tunnel and reach web directly on 127.0.0.1:<HUK_WEB_PORT>.
#
# Usage: deploy/up.sh [--no-tunnel] [path-to-env-file]
set -eu

SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

NO_TUNNEL=0
if [ "${1:-}" = "--no-tunnel" ]; then
  NO_TUNNEL=1
  shift
fi
ENV_FILE=${1:-"$SELF_DIR/.env"}

[ -f "$ENV_FILE" ] || {
  echo "FAIL: env file not found: $ENV_FILE (copy deploy/.env.production.example first)" >&2
  exit 1
}

sh "$SELF_DIR/check-env.sh" "$ENV_FILE"

COMPOSE_FILE="$SELF_DIR/docker-compose.prod.yml"
c() {
  docker compose -p huk -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

PROFILES=""
[ "$NO_TUNNEL" = "1" ] || PROFILES="--profile tunnel"
# shellcheck disable=SC2086
c $PROFILES build
# shellcheck disable=SC2086
c $PROFILES up -d --wait --wait-timeout 300

# HUK_WEB_PORT from the env file (default 3100); simple trusted-file read.
PORT=$(awk -F= '$1 == "HUK_WEB_PORT" { gsub(/[",[:space:]]/, "", $2); print $2; exit }' "$ENV_FILE")
PORT=${PORT:-3100}

i=0
while [ "$i" -lt 60 ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" || true)
  [ "$code" = "200" ] && break
  i=$((i + 1))
  sleep 2
done
if [ "$code" != "200" ]; then
  echo "FAIL: /api/health did not answer 200 on 127.0.0.1:$PORT" >&2
  echo "      inspect: docker compose -p huk -f $COMPOSE_FILE logs web" >&2
  exit 1
fi

echo "HUK is up:"
echo "  local   http://127.0.0.1:$PORT  (health 200)"
if [ "$NO_TUNNEL" = "1" ]; then
  echo "  tunnel  not started (--no-tunnel)"
else
  echo "  public  via Cloudflare Tunnel (see docs/RUNBOOK.md)"
fi
