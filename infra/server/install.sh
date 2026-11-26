#!/usr/bin/env bash
# Installs hosting plus the keeper/drand, burn-bot, reveal and CoW order poster and alpha services on the droplet, as root
# (ship.sh runs it; docs/runbooks/server.md):
#
#   sudo bash install.sh [--dry-run] <release tarball> <commit>
#
# Idempotent, in two parts. The checks come first and change nothing the running release reads: every run unpacks the
# release into /srv/squarehole/releases/<commit>, checks its landing files, reads its Sepolia manifest, builds its images,
# checks its Caddyfile with the built Caddy, its origin allowlist (origin-firewall.sh --check) and the enabled alpha
# sender's key. They make only what they need and is missing (the first run's folders and the Postgres password: openssl rand,
# into a root-only env file, never printed). A refused check puts back an image tag the build moved (the fixed
# squarehole-caddy tag, or every tag when the running commit ships again), and the last lines say what was put back.
# Then the switch, in this order: folder modes, owners and ACLs; the manifest into /srv/squarehole/manifests (never a
# placeholder over a deployed manifest); units, backup and firewall scripts and journald limits; the origin allowlist
# from its Caddyfile (only Cloudflare on 80 and 443); /srv/squarehole/current; the stack's (re)start; then the waits for
# the gateway's /healthz and the card service's /card/healthz. A failure at the switch says what changed and what did not.
# Nothing here prints a secret, and nothing creates /etc/squarehole/rpc.env: that slot is the founder's.
set -euo pipefail
umask 022

dry_run=false
if [[ ${1:-} == --dry-run ]]; then dry_run=true; shift; fi
tarball=${1:?usage: install.sh <release tarball> <commit>}
commit=${2:?usage: install.sh <release tarball> <commit>}
[[ $# -eq 2 ]] || { echo 'install.sh: unexpected arguments' >&2; exit 2; }
[[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo "install.sh: the commit must be 40 hex characters" >&2; exit 2; }
if $dry_run; then
  printf 'install.sh: dry run; release %s; build stack, preserve worker state, check hosting and seven workers and alpha-api; no changes\n' "$commit"
  exit 0
fi
[[ $(id -u) -eq 0 ]] || { echo "install.sh: run as root (sudo)" >&2; exit 2; }

base=/srv/squarehole
release=$base/releases/$commit
secrets=/etc/squarehole
log() { printf 'install.sh: %s\n' "$*"; }

# What this run did, for the last lines of a failed run (finish). Before the switch (phase check) nothing the running
# release reads changes: `made` lists what was missing and is there now, `images` and `image_ids` the tags the build
# writes and the images they named before it. At the switch (phase switch) each step is named as it starts.
phase=check step_index=0 previous='' tee_pid=''
made=() images=() image_ids=() changed=() same=()
steps=('folder modes, owners and ACLs' 'the Sepolia manifest' 'units, backup and firewall scripts, journald limits'
  'the origin allowlist' 'current' 'the stack and its timers')
if [[ -L $base/current ]]; then previous=$(readlink "$base/current"); previous=${previous##*/}; fi
# list, tag_states and finish run from the EXIT trap below (shellcheck does not follow a trap there).
# shellcheck disable=SC2329
list() { if (($# == 0)); then printf 'nothing'; return; fi; local text; printf -v text '%s; ' "$@"; printf '%s' "${text%; }"; }
# shellcheck disable=SC2329
tag_states() { # "<state> <index>" for each tag the build writes: moved, new, or unknown (Docker did not answer)
  local i now
  for i in "${!images[@]}"; do
    if now=$(docker image inspect --format '{{.Id}}' "${images[$i]}" 2>/dev/null); then
      if [[ -z ${image_ids[$i]} ]]; then echo "new $i"; elif [[ $now != "${image_ids[$i]}" ]]; then echo "moved $i"; fi
    elif [[ -n ${image_ids[$i]} ]]; then
      echo "unknown $i"
    fi
  done
}
# shellcheck disable=SC2329
finish() {
  local status=$? i now state states inputs apart='' way_back='' new=0 back=() stuck=() moved=() unknown=() kept=()
  # Once here, no second signal and no closed output stops the putting back.
  trap - EXIT; trap '' HUP INT TERM PIPE
  if ((status == 0)); then
    : # nothing to report
  elif [[ $phase == check ]]; then
    # First put back, then report: a cut connection must not stop the putting back. Every state is read before the
    # first tag is put back. A tag Docker could not read is put back too: retagging one that did not move changes nothing.
    states=$(tag_states)
    while read -r state i; do
      case $state in
        moved|unknown)
          if docker tag "${image_ids[$i]}" "${images[$i]}" >/dev/null 2>&1; then back+=("image tag ${images[$i]}")
          else stuck+=("image tag ${images[$i]} (by hand: docker tag ${image_ids[$i]} ${images[$i]})"); fi ;;
        new) new=$((new + 1)) ;;
      esac
    done <<<"$states"
    inputs="its manifest, folders, units, scripts, allowlist, current${previous:+ -> $previous}, stack and image tags"
    if ((${#made[@]})); then apart='apart from what was made because it was missing (below), '; fi
    if ((${#stuck[@]})); then
      log "refused before the switch; NOT put back: $(list "${stuck[@]}")"
      log "${apart}everything else the running release reads is as before"
    elif ((${#back[@]})); then
      log "refused before the switch; ${apart}everything the running release reads is as before ($inputs)"
    else
      log "refused before the switch; ${apart}nothing the running release reads changed ($inputs are as before)"
    fi
    if ((${#back[@]})); then log "put back to the image it named before the build: $(list "${back[@]}")"; fi
    if ((${#made[@]})); then log "made because it was missing: $(list "${made[@]}")"; fi
    if [[ -d $release ]]; then kept+=("the unpacked release"); fi
    if ((new)); then kept+=("$new new image tags from this build"); fi
    if ((${#kept[@]})); then log "kept for a retry: $(list "${kept[@]}")"; fi
    if [[ -e $release.new ]]; then log "kept for diagnosis: the interrupted unpack $release.new (the next run moves it aside)"; fi
  elif [[ $phase == switch ]]; then
    while read -r state i; do
      case $state in
        moved) moved+=("image tag ${images[$i]}") ;;
        unknown) unknown+=("image tag ${images[$i]}") ;;
      esac
    done < <(tag_states)
    log "stopped at the switch, during: ${steps[$step_index]} (it may be partly applied)"
    log "changed: $(list "${moved[@]}" "${changed[@]}")"
    log "not changed: $(list "${same[@]}" "${steps[@]:step_index+1}")"
    if ((${#unknown[@]})); then log "not known (Docker did not answer): $(list "${unknown[@]}")"; fi
    now=$(readlink "$base/current" 2>/dev/null) || now=''
    now=${now##*/}
    if ((step_index < 5)); then
      log "current points to ${now:-no release}; the stack was not (re)started: what runs is what ran before${previous:+ ($previous)}, with the changed inputs above"
    else
      log "current points to ${now:-no release}; the stack may not have (re)started: cd $base/current/infra/server && sudo docker compose ps"
    fi
    if [[ -n $previous && $previous != "$commit" ]]; then way_back=", or go back with infra/server/ship.sh $previous"; fi
    log "next: fix the cause and ship $commit again$way_back"
  else
    log "release $commit is installed and current, and the stack runs it; this check failed after the switch and nothing was rolled back"
    if [[ -n $previous && $previous != "$commit" ]]; then log "to go back: infra/server/ship.sh $previous"; fi
  fi
  # The switch's lines pass through tee (7): let it write them all before this script ends.
  if [[ -n $tee_pid ]]; then exec >&- 2>&-; wait "$tee_pid" || true; fi
  exit "$status"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# A cut SSH session (ship.sh runs ssh without a terminal) reaches this script as SIGPIPE at its next output line.
trap 'exit 141' PIPE

# 1. buildx for `docker compose build` (Ubuntu's own package, beside docker.io and docker-compose-v2).
if ! dpkg -s docker-buildx acl >/dev/null 2>&1; then
  log "installing docker-buildx and filesystem ACL tools"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-buildx acl >/dev/null
  made+=('the packages docker-buildx and acl')
fi

# 2. What the checks need, made only where it is missing (a first run): the folders the release is unpacked into and the
#    Caddy check mounts, and the root-only Postgres password Compose requires. The modes, owners and ACLs of folders
#    that exist are applied at the switch (7a), never here.
for dir in "$base" "$base/releases" "$base/app"; do
  if [[ ! -d $dir ]]; then install -d -m 0755 -o root -g root "$dir"; made+=("$dir"); fi
done
if [[ ! -d $secrets ]]; then install -d -m 0700 -o root -g root "$secrets"; made+=("$secrets"); fi
if [[ ! -s $secrets/db.env ]]; then
  (
    umask 077
    password=$(openssl rand -hex 32)
    printf 'POSTGRES_PASSWORD=%s\nPGPASSWORD=%s\n' "$password" "$password" >"$secrets/db.env.new"
    mv "$secrets/db.env.new" "$secrets/db.env"
  )
  log "made $secrets/db.env (root only, not printed)"
  made+=("$secrets/db.env")
fi

# 3. The release, unpacked once per commit.
if [[ ! -d $release ]]; then
  # Keep an interrupted unpack for diagnosis instead of deleting it.
  if [[ -e $release.new ]]; then mv "$release.new" "$release.interrupted.$(date -u +%Y%m%dT%H%M%S).$$"; fi
  mkdir -p "$release.new"
  tar -xzf "$tarball" -C "$release.new"
  mv "$release.new" "$release"
  log "unpacked $commit"
fi
# Replaced by a rename: on a ship of the running commit again, Compose there never reads a half-written file.
env_file=$release/infra/server/.env
printf 'SH_RELEASE=%s\n' "$commit" >"$env_file.new"
mv "$env_file.new" "$env_file"

# A bind mount alone would silently create an empty directory if the landing were missing from the archive.
# Refuse an incomplete release before updating the manifest, building images or switching current.
for file in index.html 404.html _headers styles.css; do
  [[ -s $release/apps/landing/public/$file ]] || { log "landing file missing: $file"; exit 1; }
done

# 4. The Sepolia manifest, read here (one that is not JSON is refused) and installed at the switch (7b), compared there
#    with the manifest the server has at that moment.
new_manifest=$release/packages/contracts/deployments/core-v1/11155111.json
live_manifest=$base/manifests/11155111.json
new_status=$(jq -r '.status' "$new_manifest")

# 5. Images, built here from the release (base images pinned by digest in the Dockerfiles), and the release's Caddyfile
#    checked by the Caddy just built: a refused Caddyfile stops the install here and changes nothing the running
#    release reads. The tags the build writes are read first: one the running release uses too (the fixed
#    squarehole-caddy tag, or every tag when the running commit ships again) is put back if a check refuses.
built=$(cd "$release/infra/server" && docker compose config --format json | jq -er '[.services[] | select(.build) | .image] | unique | .[]')
while IFS= read -r image; do
  # Empty: no such tag. A Docker error refuses the run here, before the build can move anything.
  tag_id=$(docker image ls -q --no-trunc "$image")
  images+=("$image")
  image_ids+=("$tag_id")
done <<<"$built"
(cd "$release/infra/server" && docker compose build --quiet)
log "images built: indexer, cards, keeper (including keeper-set, alpha-sender and agents), burn-bot, reveal, cow-poster at $commit; caddy:2.11.6-ratelimit"
#    The app folder is mounted as compose.yaml mounts it, so an activated app's imports (/srv/app/current/*.caddy) are
#    checked with the new Caddyfile too, not skipped as an empty glob.
if ! check=$(docker run --rm --network none \
  -v "$release/infra/server/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$release/apps/landing/public:/srv/landing:ro" \
  -v "$base/app:/srv/app:ro" \
  squarehole-caddy:2.11.6-ratelimit caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1); then
  printf '%s\n' "$check" | tail -5 >&2
  log "the release's Caddyfile was refused"
  exit 1
fi
log "Caddyfile valid"

# 6. The origin allowlist from this release's Caddyfile, checked by this release's origin-firewall.sh, which applies
#    nothing with --check: a refused list stops the install here. It is applied at the switch (7d), before current.
bash "$release/infra/server/origin-firewall.sh" --check "$release/infra/server/Caddyfile" | sed 's/^/install.sh: /'

# Enabled sender preflight. Read Compose's resolved raw environment without sourcing or logging secrets.
# A directory mount lets the disabled stack ship with no desk key. Even dry-run enablement requires bootstrap.
sender_enabled=$(cd "$release/infra/server" && docker compose config --format json | jq -er '.services["alpha-sender"].environment.SH_SERVICE_ENABLED // "0"')
if [[ $sender_enabled != 0 ]]; then
  if [[ $sender_enabled != 1 || ! -f $secrets/alpha-sender/desk.key || ! -s $secrets/alpha-sender/desk.key || -L $secrets/alpha-sender/desk.key ]] ||
     [[ $(stat -c '%u:%g:%a' "$secrets/alpha-sender/desk.key") != 0:0:600 ]]; then
    log "enabled alpha-sender requires the founder's root:root 0600 desk.key; see docs/runbooks/alpha-sender.md#key-and-float"
    exit 1
  fi
fi

# 7. The switch. From here the running release's inputs change, in the order they did when they came before the
#    checks: folders, manifest, units and scripts, allowlist, current, stack. A failure names what changed and what not.
phase=switch
# Once begun, the switch runs to its end without a reader: a cut session no longer stops it halfway. Its lines go on to
# the session while that lasts and to $base/install.log: root only (0600), written anew by each switch, so it holds the
# last switch's lines alone and never grows; the installer prints no secret. A refusal before the switch leaves it.
# If tee ends (no reader and no writable file; it then exits 1, which the inherited set -e must not act on), cat goes on
# reading, so no write here meets a closed pipe. A hangup (a manual run from a terminal that closes) is ignored until
# the switch has ended, as a cut ssh session is.
trap '' HUP
exec > >(umask 077; tee --output-error=warn-nopipe "$base/install.log" || :; exec cat >/dev/null) 2>&1
tee_pid=$!
log "the switch to $commit begins; its lines are kept in $base/install.log"

# 7a. Folders and the root-only secrets. landing-alpha holds the preview at alpha.squarehole.fun (compose.yaml mounts it,
#    ship-alpha.sh fills it) and app holds the activated app releases (compose.yaml mounts it, app/install.sh fills
#    it); both are made here, so neither mount finds its folder missing. withheld holds the withheld-pictures list
#    (docs/runbooks/withheld-pictures.md): compose.yaml mounts it read-only with create_host_path false, so it is made
#    here and never written here; only the operator commands write its list.
step_index=0
install -d -m 0700 -o root -g root "$secrets" /var/backups/squarehole
install -d -m 0755 -o root -g root "$base" "$base/releases" "$base/manifests" "$base/landing-alpha" "$base/app" "$base/withheld"
# Alpha exchange: root owns the folders; only the relevant writer gets an ACL. The shared 2103 group
# can read/traverse queue and receipts. Sender mounts queue read-only; API mounts receipts read-only.
# API UID/GID 2101, capability-free root sender, exchange readers GID 2103. No key is generated here.
install -d -m 0750 -o root -g 2103 "$base/alpha"
install -d -m 2750 -o root -g 2103 "$base/alpha/queue" "$base/alpha/receipts"
# Replace earlier named/default ACLs so a repeat install has the same readers and sole API writer.
setfacl -b -k "$base/alpha/queue" "$base/alpha/receipts"
setfacl -m u:2101:rwx "$base/alpha/queue"
install -d -m 2770 -o root -g 2101 "$base/alpha/state"
install -d -m 0700 -o root -g root "$secrets/alpha-api"
if [[ -e $secrets/alpha-api.env ]]; then
  chown root:root "$secrets/alpha-api.env"
  chmod 0600 "$secrets/alpha-api.env"
fi
# Mounted folders only; no service credentials or live-mode env is generated by installation. The CoW order poster
# holds no key and mounts no folder from here: only its optional env file, which may carry an RPC credential.
for worker in keeper keeper-set burn-bot reveal cow-poster alpha-sender agents; do
  if [[ $worker == alpha-sender || $worker == agents ]]; then install -d -m 0700 -o root -g root "$secrets/$worker";
  elif [[ $worker != cow-poster && ! -d $secrets/$worker ]]; then install -d -m 0750 -o root -g 1000 "$secrets/$worker"; fi
  if [[ -e $secrets/$worker.env ]]; then
    chown root:root "$secrets/$worker.env"
    chmod 0600 "$secrets/$worker.env"
  fi
done
# Agent outputs and the shared dry/live budget journal survive every release. No keys or env are generated.
install -d -m 0700 -o root -g root "$base/agents" "$base/agents/replies" "$base/agents/statements" "$base/agents/proposals" "$base/agents/state"
if [[ ! -d $base/reveal-art ]]; then install -d -m 0750 -o root -g 1000 "$base/reveal-art"; fi
chown root:root "$secrets/db.env"
chmod 0600 "$secrets/db.env"
if [[ -e $secrets/rpc.env ]]; then
  chown root:root "$secrets/rpc.env"
  chmod 0600 "$secrets/rpc.env"
  log "rpc.env present: its RPC URLs override the keyless defaults"
fi
changed+=("${steps[0]}")

# 7b. The manifest read in 4. A deployed manifest already here is never replaced by an awaiting-broadcast placeholder (an
#    older release); the copy is renamed into place so the indexer never reads half a file.
step_index=1
live_status=$( [[ -f $live_manifest ]] && jq -r '.status' "$live_manifest" || echo none )
if cmp -s "$new_manifest" "$live_manifest"; then
  log "manifest unchanged ($live_status)"
  same+=("${steps[1]} (unchanged)")
elif [[ $live_status == deployed && $new_status != deployed ]]; then
  log "kept the deployed manifest (this release carries status '$new_status')"
  same+=("${steps[1]} (kept the deployed one)")
else
  install -m 0644 "$new_manifest" "$base/manifests/.11155111.json.new"
  mv "$base/manifests/.11155111.json.new" "$live_manifest"
  log "manifest installed (status $live_status -> $new_status)"
  changed+=("${steps[1]} (status $live_status -> $new_status)")
fi

# 7c. Units, backup and firewall scripts, journald limits.
step_index=2
install -m 0644 "$release/infra/server/alpha-backup-flags.sh" /usr/local/sbin/squarehole-alpha-backup-flags.sh # before the wrapper that sources it
install -m 0755 "$release/infra/server/alpha-backup.sh" /usr/local/sbin/squarehole-alpha-backup
install -m 0755 "$release/infra/server/pg-backup.sh" /usr/local/sbin/squarehole-pg-backup
install -m 0755 "$release/infra/server/origin-firewall.sh" /usr/local/sbin/squarehole-origin-firewall
install -m 0644 "$release"/infra/server/systemd/squarehole-{stack.service,pg-backup.service,pg-backup.timer,origin-firewall.service} /etc/systemd/system/
install -m 0644 "$release"/infra/server/systemd/squarehole-indexer-heal.{service,timer} /etc/systemd/system/
install -d -m 0755 /etc/systemd/journald.conf.d
if ! cmp -s "$release/infra/server/journald.conf" /etc/systemd/journald.conf.d/50-squarehole.conf; then
  install -m 0644 "$release/infra/server/journald.conf" /etc/systemd/journald.conf.d/50-squarehole.conf
  systemctl restart systemd-journald
fi
systemctl daemon-reload
systemctl enable --quiet squarehole-stack.service squarehole-pg-backup.timer squarehole-origin-firewall.service
changed+=("${steps[2]}")

# 7d. The origin allowlist checked in 6, applied before switching to the release.
step_index=3
/usr/local/sbin/squarehole-origin-firewall "$release/infra/server/Caddyfile" | sed 's/^/install.sh: /'
changed+=("${steps[3]}")

# 7e. Switch to the release and start the stack, or apply it to the running one (`up` recreates only the containers
#    whose image or settings changed: Postgres keeps running across an indexer update).
step_index=4
ln -sfn "$release" "$base/.current.new"
mv -T "$base/.current.new" "$base/current"
changed+=("current -> $commit")
step_index=5
systemctl start squarehole-origin-firewall.service # the boot unit, now on this release (nothing new if already active)
if systemctl is-active --quiet squarehole-stack.service; then
  systemctl reload squarehole-stack.service
else
  systemctl start squarehole-stack.service
fi
systemctl start squarehole-pg-backup.timer
# The watchdog uses Node from this release's indexer image; the host needs no Node or monitor installation.
systemctl enable --now squarehole-indexer-heal.timer
changed+=("${steps[5]}")
phase=installed
trap 'exit 129' HUP
log "current -> $commit; stack up"

# Disabled workers report that state explicitly; enabled workers must complete a cycle. A failure reports the
# installed release without rolling back money journals or hiding an unhealthy process.
(cd "$release/infra/server" && bash ./smoke-services.sh all)

# 8. Wait for the card service (it draws a sample card before it listens) and the gateway (200 while idling on the
#    placeholder or following the chain).
for _ in $(seq 1 30); do
  if body=$(curl -fsS --max-time 3 http://127.0.0.1:5395/card/healthz 2>/dev/null); then
    log "cards: $body"
    break
  fi
  sleep 2
done
[[ -n ${body:-} ]] || log "the card service did not answer within a minute (link previews show the generic card meanwhile); see: docker compose -p squarehole logs cards"
for _ in $(seq 1 90); do
  if body=$(curl -fsS --max-time 3 http://127.0.0.1:5394/healthz 2>/dev/null); then
    log "healthz: $body"
    exit 0
  fi
  sleep 2
done
log "healthz did not answer 200 within 3 minutes; see: docker compose -p squarehole logs indexer"
curl -sS --max-time 3 http://127.0.0.1:5394/healthz || true
exit 1
