#!/usr/bin/env bash
# Called by pg-backup.sh, with the nightly timer's retention. No keys or settings are mounted in the backup process.
set -euo pipefail
umask 077
cd /srv/squarehole/current/infra/server
# The flags file is installed next to this wrapper by install.sh, so a release switch or an install that stopped
# early cannot leave the wrapper without it. Sourced by absolute path, not from the current release.
# shellcheck source=infra/server/alpha-backup-flags.sh
source /usr/local/sbin/squarehole-alpha-backup-flags.sh
dir=/var/backups/squarehole
stamp=$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 0700 "$dir"
exec 9>"$dir/alpha-backup.lock"
flock -n 9 || exit 75
running=$(docker compose ps --status running --services)
restart=()
for service in alpha-api alpha-sender; do
  if [[ $'\n'"$running"$'\n' == *$'\n'"$service"$'\n'* ]]; then restart+=("$service"); fi
done
resume() {
  local status=$?
  trap - EXIT
  if ((${#restart[@]})) && ! docker compose start "${restart[@]}"; then
    printf '%s\n' 'alpha backup: service restart failed; run docker compose start alpha-api alpha-sender and check health' >&2
    status=1
  fi
  exit "$status"
}
trap resume EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
docker compose stop --timeout 60 alpha-api alpha-sender
for service in alpha-api alpha-sender; do
  if [[ -n $(docker compose ps --status running --quiet "$service") ]]; then exit 1; fi
done
# Resolve the actual image/volume from the installed service; no env contents or credentials are printed.
container=$(docker compose ps --all --quiet alpha-sender)
volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/state"}}{{.Name}}{{end}}{{end}}' "$container")
image=$(docker compose images --quiet alpha-api)
[[ -n $volume && -n $image ]]
docker run "${alpha_backup_flags[@]}" \
  --mount type=bind,src=/srv/squarehole/alpha,dst=/alpha \
  --mount type=volume,src="$volume",dst=/sender,readonly \
  --mount type=bind,src=/srv/squarehole/withheld,dst=/withheld \
  --mount type=bind,src="$dir",dst=/backup \
  "$image" infra/server/services/alpha/backup.mjs --services-stopped "/backup/alpha-$stamp"
# Incomplete copies remain for diagnosis; only complete snapshots expire automatically.
find "$dir" -maxdepth 1 -type d -name 'alpha-????????T??????Z' -mtime +"$((${SH_BACKUP_KEEP_DAYS:-7} - 1))" -exec find {} -depth -delete \;
