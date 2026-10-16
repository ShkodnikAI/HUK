#!/bin/sh
# deploy/restore.sh <dump-file> [--force-live]  (H-504)
#
# Restores a backup for the drill. WITHOUT the flag it creates a SCRATCH
# database (huk_restore_<timestamp>) and restores there — the live database
# is never touched, so the drill can run any time. With --force-live it
# restores OVER the live database (destructive, irreversible — AGENTS §3;
# the flag exists so the step is never implicit).
#
# Prints per-table row counts of the restored database so the drill can
# compare them with the live database.
#
# Usage: deploy/restore.sh <dump-file> [--force-live] [path-to-env-file]
set -eu

SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

DUMP=""
FORCE=0
ENV_FILE=""
for a in "$@"; do
  case "$a" in
    --force-live) FORCE=1 ;;
    --*) echo "unknown flag: $a" >&2; exit 2 ;;
    *)
      if [ -z "$DUMP" ]; then DUMP=$a; else ENV_FILE=$a; fi
      ;;
  esac
done
[ -n "$DUMP" ] || { echo "usage: deploy/restore.sh <dump-file> [--force-live] [env-file]" >&2; exit 1; }
[ -f "$DUMP" ] || { echo "FAIL: dump file not found: $DUMP" >&2; exit 1; }
ENV_FILE=${ENV_FILE:-"$SELF_DIR/.env"}
[ -f "$ENV_FILE" ] || { echo "FAIL: env file not found: $ENV_FILE" >&2; exit 1; }

read_val() {
  awk -F= -v k="$1" '$1 == k { v=$2; gsub(/[",[:space:]]/, "", v); print v; exit }' "$ENV_FILE"
}
PG_USER=$(read_val POSTGRES_USER); PG_USER=${PG_USER:-huk}
PG_DB=$(read_val POSTGRES_DB);     PG_DB=${PG_DB:-huk}

COMPOSE_FILE="$SELF_DIR/docker-compose.prod.yml"
c() {
  docker compose -p huk -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

if [ "$FORCE" = "1" ]; then
  TARGET_DB=$PG_DB
  echo "WARNING: restoring OVER THE LIVE DATABASE $TARGET_DB (explicit --force-live)"
  RESTORE_FLAGS="--clean --if-exists"
else
  TARGET_DB="huk_restore_$(date -u +%Y%m%d-%H%M%S)"
  RESTORE_FLAGS=""
  c exec -T postgres dropdb -U "$PG_USER" --if-exists "$TARGET_DB" 2>/dev/null || true
  c exec -T postgres createdb -U "$PG_USER" "$TARGET_DB"
fi

# Stream the dump into the container and restore from there.
c exec -T postgres sh -c 'cat > /tmp/huk-restore.dump' < "$DUMP"
# $RESTORE_FLAGS is a fixed literal set (empty or "--clean --if-exists"); the
# intended word split is the only way to expand it in POSIX sh (no arrays).
# shellcheck disable=SC2086
c exec -T postgres pg_restore -U "$PG_USER" -d "$TARGET_DB" --no-owner $RESTORE_FLAGS /tmp/huk-restore.dump
c exec -T postgres rm -f /tmp/huk-restore.dump

# Per-table row counts of the restored database.
echo "row counts in $TARGET_DB:"
c exec -T postgres psql -U "$PG_USER" -d "$TARGET_DB" -At \
  -c "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1" |
while IFS= read -r t; do
  [ -n "$t" ] || continue
  n=$(c exec -T postgres psql -U "$PG_USER" -d "$TARGET_DB" -At -c "SELECT count(*) FROM \"$t\"")
  printf '%s\t%s\n' "$t" "$n"
done

if [ "$FORCE" = "1" ]; then
  echo "restore over live database $TARGET_DB complete"
else
  echo "restored into database $TARGET_DB (scratch; live database untouched)"
fi
