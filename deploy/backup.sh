#!/bin/sh
# deploy/backup.sh (H-504) — nightly pg_dump of the production database.
#
# Writes a custom-format dump into $HUK_BACKUP_DIR/daily (mode 600), verifies
# it with pg_restore --list, keeps 7 daily and 4 weekly copies (weekly copy on
# Sundays, UTC). Cron line (as root or a docker-group user):
#   10 4 * * * /srv/huk/deploy/backup.sh >> /var/log/huk-backup.log 2>&1
#
# Usage: deploy/backup.sh [path-to-env-file]
set -eu

SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE=${1:-"$SELF_DIR/.env"}
[ -f "$ENV_FILE" ] || { echo "FAIL: env file not found: $ENV_FILE" >&2; exit 1; }

read_val() {
  awk -F= -v k="$1" '$1 == k { v=$2; gsub(/[",[:space:]]/, "", v); print v; exit }' "$ENV_FILE"
}

PG_USER=$(read_val POSTGRES_USER); PG_USER=${PG_USER:-huk}
PG_DB=$(read_val POSTGRES_DB);     PG_DB=${PG_DB:-huk}
BACKUP_DIR=$(read_val HUK_BACKUP_DIR)
[ -n "$BACKUP_DIR" ] || { echo "FAIL: HUK_BACKUP_DIR is not set in $ENV_FILE" >&2; exit 1; }

COMPOSE_FILE="$SELF_DIR/docker-compose.prod.yml"
c() {
  docker compose -p huk -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

# Umask before creating anything: dumps must be mode 600 on the host.
umask 077
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

stamp=$(date -u +%Y%m%d-%H%M%S)
out="$BACKUP_DIR/daily/huk-$stamp.dump"

c exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "$out"
if [ ! -s "$out" ]; then
  rm -f "$out"
  echo "FAIL: pg_dump produced an empty file — backup aborted" >&2
  exit 1
fi
chmod 600 "$out"

# Verify the archive: pg_restore --list must be able to read its table of
# contents. The dump is streamed into the container's /tmp and removed after.
c exec -T postgres sh -c 'cat > /tmp/huk-verify.dump' < "$out"
if ! c exec -T postgres pg_restore --list /tmp/huk-verify.dump > /dev/null 2>&1; then
  c exec -T postgres rm -f /tmp/huk-verify.dump
  echo "FAIL: pg_restore --list could not read the dump — backup is corrupt" >&2
  rm -f "$out"
  exit 1
fi
c exec -T postgres rm -f /tmp/huk-verify.dump

# Rotation: keep 7 daily copies. Filenames are machine-generated
# (huk-<utcstamp>.dump), so mtime-sorted ls is exactly the intended order.
# shellcheck disable=SC2012
ls -1t "$BACKUP_DIR"/daily/*.dump 2>/dev/null | tail -n +8 | xargs -r rm -f
# Weekly copy on Sundays (UTC), keep 4.
if [ "$(date -u +%u)" = "7" ]; then
  cp "$out" "$BACKUP_DIR/weekly/huk-week-$stamp.dump"
  # shellcheck disable=SC2012
  ls -1t "$BACKUP_DIR"/weekly/*.dump 2>/dev/null | tail -n +5 | xargs -r rm -f
fi

echo "backup OK: $out ($(wc -c < "$out") bytes, verified)"
