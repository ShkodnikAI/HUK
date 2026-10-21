#!/bin/sh
# k8s/base/scripts/backup.sh — nightly pg_dump for the Kubernetes stack.
# Mounted into the huk-backup CronJob as the huk-backup-script ConfigMap and
# run as `sh /scripts/backup.sh` inside the postgres:16 image.
#
# Writes a custom-format dump into /backups/daily (mode 600), verifies it with
# pg_restore --list, keeps 7 daily and 4 weekly copies (weekly copy on
# Sundays, UTC). Dumps land on the backup-data PVC; copy them off-box with
# k8s/jobs/backup-export.yaml (RUNBOOK §9).
set -eu

# psql/pg_dump in this pod talk to the huk-postgres Service over TCP, so the
# password must be handed to libpq explicitly (the compose stack exec'd into
# the postgres container over the local socket instead).
export PGPASSWORD="$POSTGRES_PASSWORD"
PGUSER_OPT="-U $POSTGRES_USER"
PGDB="${POSTGRES_DB:-huk}"

umask 077
mkdir -p /backups/daily /backups/weekly

stamp=$(date -u +%Y%m%d-%H%M%S)
out="/backups/daily/huk-$stamp.dump"

pg_dump $PGUSER_OPT -d "$PGDB" -Fc > "$out"
if [ ! -s "$out" ]; then
  rm -f "$out"
  echo "FAIL: pg_dump produced an empty file — backup aborted" >&2
  exit 1
fi
chmod 600 "$out"

# Verify the archive: pg_restore --list must be able to read its table of
# contents. The dump is copied into the pod's /tmp and removed after.
cp "$out" /tmp/huk-verify.dump
if ! pg_restore --list /tmp/huk-verify.dump > /dev/null 2>&1; then
  rm -f /tmp/huk-verify.dump
  echo "FAIL: pg_restore --list could not read the dump — backup is corrupt" >&2
  rm -f "$out"
  exit 1
fi
rm -f /tmp/huk-verify.dump

# Rotation: keep 7 daily copies. Filenames are machine-generated
# (huk-<utcstamp>.dump), so mtime-sorted ls is exactly the intended order.
# shellcheck disable=SC2012
ls -1t /backups/daily/*.dump 2>/dev/null | tail -n +8 | xargs -r rm -f
# Weekly copy on Sundays (UTC), keep 4.
if [ "$(date -u +%u)" = "7" ]; then
  cp "$out" "/backups/weekly/huk-week-$stamp.dump"
  # shellcheck disable=SC2012
  ls -1t /backups/weekly/*.dump 2>/dev/null | tail -n +5 | xargs -r rm -f
fi

echo "backup OK: $out ($(wc -c < "$out") bytes, verified)"
