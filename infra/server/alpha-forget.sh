#!/usr/bin/env bash
# Run in a root maintenance shell with history disabled. No restart on failure.
set -euo pipefail
umask 077
fail() { printf 'alpha-forget: %s\n' "$*" >&2; exit 1; }
[[ $# == 2 && $1 =~ ^[1-9][0-9]{0,19}$ && $2 =~ ^[A-Za-z0-9_]{1,15}$ ]] || fail 'usage: alpha-forget.sh <x-id> <handle>'
x_id=$1 handle=$2
cd /srv/squarehole/current/infra/server
phase='before stops'
restart=() timer=inactive started=() counts=
report() {
  local status=$?
  trap - EXIT
  if ((status)); then
    printf 'alpha-forget: stopped at %s; no automatic restart.\n' "$phase" >&2
    printf 'alpha-forget: previously active services: %s; backup timer: %s.\n' "${restart[*]:-none}" "$timer" >&2
    printf 'alpha-forget: services started by this run: %s.\n' "${started[*]:-none}" >&2
    if [[ $phase != 'before stops' ]]; then
      printf '%s\n' 'alpha-forget: keep both services and the timer stopped until deletion completes. Check docker compose ps --all alpha-api alpha-sender.' >&2
      printf '%s\n' 'alpha-forget: next: bash ./alpha-forget.sh <x-id> <handle> (same selector). Prior activity is saved in /var/backups/squarehole/alpha-forget.restore.' >&2
    fi
  fi
  exit "$status"
}
trap report EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
# Share the existing backup lock. Do not wait beside a backup whose exit trap restarts services.
exec 9>/var/backups/squarehole/alpha-backup.lock
flock -n 9 || fail 'backup or another forget is running'
backup=$(systemctl show --property=ActiveState --value squarehole-pg-backup.service)
[[ $backup == inactive || $backup == failed ]] || fail 'backup service is running'
phase='before stops'
container=$(docker compose ps --all --quiet alpha-sender)
volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/state"}}{{.Name}}{{end}}{{end}}' "$container")
image=$(docker compose images --quiet alpha-sender)
[[ $volume =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ && $image =~ ^(sha256:)?[a-f0-9]{64}$ ]] || fail 'sender volume or image is unknown'
flags=(--rm --network none --read-only --user 0:2101 --group-add 2103
  --cap-drop ALL --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER --security-opt no-new-privileges
  --mount type=bind,src=/var/backups/squarehole,dst=/forget-restore
  --mount type=bind,src=/srv/squarehole/alpha,dst=/alpha
  --mount "type=volume,src=$volume,dst=/sender,volume-nocopy" --entrypoint node)
command=(infra/server/services/alpha/forget-tester.mjs --x-id "$x_id" --handle "$handle"
  --api-db /alpha/state/alpha.sqlite --queue /alpha/queue --receipts /alpha/receipts --sender-state /sender)
phase='before stops'
plan=$(docker run "${flags[@]}" "$image" "${command[@]}")
if [[ $plan == '{"absent":true}' && ! -e /var/backups/squarehole/alpha-forget.restore ]]; then
  printf '%s\n' 'alpha-forget: tester is absent; services unchanged'
  exit 0
fi
# The private, temporary restore record binds a random operation to this exact selector.
selector=$(printf '%s\n%s\n' "$x_id" "${handle,,}" | sha256sum)
selector=${selector%% *}
if [[ -e /var/backups/squarehole/alpha-forget.restore ]]; then
  mapfile -t saved < /var/backups/squarehole/alpha-forget.restore
  [[ ( ${#saved[@]} == 5 || ${#saved[@]} == 6 ) && ${saved[3]} =~ ^[a-f0-9-]{36}$ && ${saved[4]} =~ ^[a-f0-9]{64}$ && ${saved[0]} =~ ^(active|inactive)$ && ${saved[1]} =~ ^(active|inactive)$ && ${saved[2]} =~ ^(active|inactive)$ ]] || fail 'saved activity is invalid; inspect it before retrying'
  [[ ${saved[4]} == "$selector" ]] || fail 'saved operation belongs to another selector; rerun the original selector'
  timer=${saved[0]}; restart=(); operation=${saved[3]}; counts=${saved[5]:-}
  [[ ${saved[1]} == inactive ]] || restart+=(alpha-api)
  [[ ${saved[2]} == inactive ]] || restart+=(alpha-sender)
else
  running=$(docker compose ps --status running --services)
  timer=$(systemctl show --property=ActiveState --value squarehole-pg-backup.timer)
  [[ $timer == active || $timer == inactive ]] || fail 'backup timer state is unknown'
  for service in alpha-api alpha-sender; do
    if [[ $'\n'"$running"$'\n' == *$'\n'"$service"$'\n'* ]]; then restart+=("$service"); fi
  done
  operation=$(cat /proc/sys/kernel/random/uuid)
  api=inactive sender=inactive
  for service in "${restart[@]}"; do
    if [[ $service == alpha-api ]]; then api=active; else sender=active; fi
  done
  printf '%s\n' "$timer" "$api" "$sender" "$operation" "$selector" > /var/backups/squarehole/alpha-forget.restore.prepare
  sync -f /var/backups/squarehole/alpha-forget.restore.prepare
  mv /var/backups/squarehole/alpha-forget.restore.prepare /var/backups/squarehole/alpha-forget.restore
  sync -f /var/backups/squarehole
fi
if [[ $plan != '{"absent":true}' ]]; then
  phase='stopping timer and services'
  systemctl stop squarehole-pg-backup.timer
  [[ $(systemctl show --property=ActiveState --value squarehole-pg-backup.timer) == inactive ]] || fail 'backup timer did not stop'
  backup=$(systemctl show --property=ActiveState --value squarehole-pg-backup.service)
  [[ $backup == inactive || $backup == failed ]] || fail 'backup started while stopping the timer'
  docker compose stop --timeout 60 alpha-api alpha-sender
  for service in alpha-api alpha-sender; do
    container=$(docker compose ps --all --quiet "$service")
    [[ -n $container && $container != *$'\n'* ]] || fail 'expected one container per service'
    gone=false
    for _ in {1..60}; do
      state=$(docker inspect --format '{{.State.Running}} {{.State.Pid}} {{.State.Restarting}}' "$container")
      if [[ $state == 'false 0 false' ]]; then gone=true; break; fi
      sleep 1
    done
    $gone || fail 'service processes did not exit'
  done
  printf '%s\n' "$plan"
  masked='***'
  if ((${#handle} > 4)); then masked="${handle:0:2}***${handle: -2}"; fi
  printf 'Type the handle again to execute %s [%s]: ' "$masked" "${selector:0:8}" >&2
  IFS= read -rs confirmation || fail 'confirmation was not read'
  [[ $confirmation == "$handle" ]] || fail 'confirmation did not match'
  phase='services and timer stopped; execute'
  counts=$(docker run "${flags[@]}" "$image" "${command[@]}" --execute --services-stopped --operation "$operation" --completion /forget-restore/alpha-forget.restore)
fi
phase='services and timer stopped; completion check'
# Check inside the same mounts. Accept only the command's count fields, never arbitrary container output.
counts=$(docker run "${flags[@]}" "$image" -e '
try {
  const fs = require("node:fs");
  for (const p of ["/alpha/receipts/forget-tester.json", "/alpha/receipts/forget-tester.json.prepare"]) if (fs.existsSync(p)) throw Error();
  const receipt = JSON.parse(fs.readFileSync("/forget-restore/alpha-forget.restore", "utf8").trimEnd().split("\n")[5]);
  if (receipt.v !== 1 || receipt.operation !== process.argv[1]) throw Error();
  const r = receipt.counts;
  const keys = "challenges,claims,decisions,returning_browsers,sessions,signins,signups";
  if (Object.keys(r).sort().join() !== "executed,files,journals,rows" || r.executed !== true || Object.keys(r.rows).sort().join() !== keys) throw Error();
  if (![r.files, r.journals, ...Object.values(r.rows)].every(n => Number.isSafeInteger(n) && n >= 0)) throw Error();
  process.stdout.write(JSON.stringify(r));
} catch { console.error("alpha-forget: incomplete deletion or invalid counts; keep services stopped"); process.exit(1); }
' "$operation")
phase='deletion complete; restoring prior services'
for service in "${restart[@]}"; do
  docker compose start "$service" >/dev/null
  started+=("$service")
  bash ./smoke-services.sh "$service" >/dev/null
done
phase='deletion complete; restoring prior timer'
if [[ $timer == active ]]; then systemctl start squarehole-pg-backup.timer; fi
# Activity and completion share one atomic record, removed only after restoration.
unlink /var/backups/squarehole/alpha-forget.restore
sync -f /var/backups/squarehole
printf '%s\n' "$counts"
