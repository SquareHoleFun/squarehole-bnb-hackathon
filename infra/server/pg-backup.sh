#!/usr/bin/env bash
# Nightly dump of the history database, as root (installed as /usr/local/sbin/squarehole-pg-backup; run by
# squarehole-pg-backup.timer, or by hand). Custom format, written to a .partial file, checked readable with
# `pg_restore --list`, then renamed; dumps older than 7 days (SH_BACKUP_KEEP_DAYS) are removed. The folder is root only.
# Restore: docs/runbooks/server.md.
set -euo pipefail
umask 077

dir=/var/backups/squarehole
keep_days=${SH_BACKUP_KEEP_DAYS:-7}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="$dir/history-$stamp.dump"

install -d -m 0700 "$dir"
cd /srv/squarehole/current/infra/server
docker compose exec -T postgres pg_dump --username=squarehole --dbname=squarehole_history --format=custom >"$out.partial"
docker compose exec -T postgres pg_restore --list <"$out.partial" >/dev/null
mv "$out.partial" "$out"

find "$dir" -maxdepth 1 -type f -name 'history-*.dump' -mtime +"$((keep_days - 1))" -delete
find "$dir" -maxdepth 1 -type f -name 'history-*.dump.partial' -mmin +120 -delete
echo "squarehole-pg-backup: wrote $out ($(stat -c %s "$out") bytes); $(find "$dir" -maxdepth 1 -name 'history-*.dump' | wc -l) dump(s) kept"

# Alpha state and withholding are independent of Postgres. A failure fails the same nightly job.
/usr/local/sbin/squarehole-alpha-backup
