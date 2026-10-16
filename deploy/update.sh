#!/bin/sh
# deploy/update.sh <tag-or-sha> [--no-tunnel] [path-to-env-file]  (H-504)
#
# Rolls the stack to <tag-or-sha>:
#   - if the argument is a git ref reachable from this checkout, both images
#     are built from that ref in a temporary worktree (the running stack is
#     not touched until the build succeeds);
#   - otherwise it must be an existing local image tag for BOTH web and
#     worker (e.g. produced by an earlier build).
#
# After switching, web/worker must pass their healthchecks AND the local
# /api/health must answer 200; on any failure the previous tag is redeployed
# automatically (rollback), and the script exits 1.
set -eu

SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH='' cd -- "$SELF_DIR/.." && pwd)

TARGET=""
NO_TUNNEL=0
ENV_FILE=""
for a in "$@"; do
  case "$a" in
    --no-tunnel) NO_TUNNEL=1 ;;
    --*) echo "unknown flag: $a" >&2; exit 2 ;;
    *)
      if [ -z "$TARGET" ]; then TARGET=$a; else ENV_FILE=$a; fi
      ;;
  esac
done
[ -n "$TARGET" ] || { echo "usage: deploy/update.sh <tag-or-sha> [--no-tunnel] [env-file]" >&2; exit 2; }
case "$TARGET" in
  *[!A-Za-z0-9._-]*) echo "FAIL: tag must match [A-Za-z0-9._-] (got: $TARGET)" >&2; exit 2 ;;
esac
ENV_FILE=${ENV_FILE:-"$SELF_DIR/.env"}
[ -f "$ENV_FILE" ] || { echo "FAIL: env file not found: $ENV_FILE" >&2; exit 1; }

sh "$SELF_DIR/check-env.sh" "$ENV_FILE"

COMPOSE_FILE="$SELF_DIR/docker-compose.prod.yml"
c() {
  docker compose -p huk -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}
PROFILES=""
[ "$NO_TUNNEL" = "1" ] || PROFILES="--profile tunnel"

# Previous tag: the image of the running web container; fall back to the
# env file value, then to `latest`.
prev=$(docker inspect --format '{{.Config.Image}}' "$(c ps -q web)" 2>/dev/null |
  sed -n 's/.*huk-web:\(.*\)$/\1/p' || true)
[ -n "$prev" ] || prev=$(awk -F= '$1 == "HUK_IMAGE_TAG" { gsub(/[",[:space:]]/, "", $2); print $2; exit }' "$ENV_FILE")
[ -n "$prev" ] || prev=latest
if [ "$prev" = "$TARGET" ]; then
  echo "already running $TARGET — nothing to do"
  exit 0
fi

# Build from a git ref in a throwaway worktree, or require existing images.
if git -C "$ROOT" rev-parse --verify --quiet "${TARGET}^{commit}" >/dev/null 2>&1; then
  WT=$(mktemp -d)
  cleanup() {
    git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true
    rm -rf "$WT"
  }
  trap cleanup EXIT
  git -C "$ROOT" worktree add --detach "$WT" "$TARGET" >/dev/null
  echo "building images from git ref $TARGET ..."
  # shellcheck disable=SC2086
  ( cd "$WT" && HUK_IMAGE_TAG="$TARGET" docker compose -p huk \
      -f deploy/docker-compose.prod.yml --env-file "$ENV_FILE" $PROFILES build )
  cleanup
  trap - EXIT
else
  docker image inspect "huk/huk-web:$TARGET" >/dev/null 2>&1 ||
    { echo "FAIL: '$TARGET' is not a git ref here and image huk/huk-web:$TARGET does not exist" >&2; exit 1; }
  docker image inspect "huk/huk-worker:$TARGET" >/dev/null 2>&1 ||
    { echo "FAIL: image huk/huk-worker:$TARGET does not exist" >&2; exit 1; }
fi

rollback() {
  echo "update to $TARGET FAILED — rolling back to $prev" >&2
  # shellcheck disable=SC2086
  if HUK_IMAGE_TAG="$prev" c $PROFILES up -d --wait --wait-timeout 300; then
    echo "rolled back to $prev (stack healthy)"
  else
    echo "CRITICAL: rollback to $prev failed — inspect manually:" >&2
    echo "  docker compose -p huk -f $COMPOSE_FILE ps && docker compose -p huk -f $COMPOSE_FILE logs web" >&2
  fi
  exit 1
}

echo "rolling forward: $prev -> $TARGET"
# shellcheck disable=SC2086
if ! HUK_IMAGE_TAG="$TARGET" c $PROFILES up -d --wait --wait-timeout 300; then
  rollback
fi

# Health endpoint double check (catches "containers healthy but app broken").
PORT=$(awk -F= '$1 == "HUK_WEB_PORT" { gsub(/[",[:space:]]/, "", $2); print $2; exit }' "$ENV_FILE")
PORT=${PORT:-3100}
i=0
code=""
while [ "$i" -lt 60 ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" || true)
  [ "$code" = "200" ] && break
  i=$((i + 1))
  sleep 2
done
if [ "$code" != "200" ]; then
  echo "FAIL: /api/health did not answer 200 after the update" >&2
  rollback
fi

echo "update complete: $prev -> $TARGET (health 200 on 127.0.0.1:$PORT)"
