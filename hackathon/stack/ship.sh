#!/usr/bin/env bash
# Ships one release of the BNB Chain testnet stack (SH-259 Part 4; runbook "Ship"). Run as the stack's user after
# bootstrap.sh, with the release unpacked at <SH_BNB_SRV>/releases/<full commit>, FROM THE SERVING RELEASE:
#   SH_BNB_ETC=<etc> bash <SH_BNB_SRV>/current/hackathon/stack/ship.sh <commit>
# The serving release's script, its chain check and its indexer image verify the incoming release; the incoming
# release's own code runs only after its deployment files matched the digests in <etc> (outside every release).
# A first ship (no current) runs the incoming release's script; so does the one transition ship whose commit is named
# in SH_BNB_SHIP_FROM_INCOMING (the script that brought this rule).
#
# In order, and nothing that serves changes before step 6:
#   1. One ship per deployment root: a lock on the folder <SH_BNB_SRV> itself, held to the end (a second ship refuses).
#      The serving commit is never shipped again (its rollback would have nothing to return to).
#   2. The release's four deployment files and the keeper's fee file (hackathon/stack/keeper-fees-97.json), checksummed
#      here, equal <etc>/approved-97.sha256 line for line; when <etc>/approved-launch.sha256 approves the launch page,
#      the release must hold it and its generator, and the five files the generator reads equal that list line for line.
#   3. The keeper's chain, registry, start block, fee floor and ceiling (and the Atlas switch) are DERIVED from the
#      approved files into the release's .derived.env; keeper.env may set none of them; every keeper start checks them
#      again (keeper-start/).
#   4. The release's images are built; the serving containers keep running.
#   5. The manifest is checked on the real chain 97 by the serving release's check script in the serving release's
#      indexer image (the incoming one on a first ship).
#   6. A candidate stack of the release, WITHOUT its keeper, on 127.0.0.1 and its own volumes, must follow the chain
#      and serve the site (and /launches/ with its addresses file, as lane h's generator makes it from the five approved files); it is removed afterwards.
#   7. Promotion, the way back armed from here to the end: the keeper is stopped (and confirmed gone); the release's
#      other services start and are verified (health, one container each, the release's images); current is switched;
#      then exactly one keeper starts and is verified by its own health record (the state keeper.env names, within
#      180 s; its image; one container; keeper.env unchanged since step 1). Any failure (or an interrupt) rolls back:
#      keeper stopped, the previous release's services with its .derived.env, verified, current pointed back, and its
#      keeper exactly as it was before the ship (absent stays absent), verified the same way. A stop Docker cannot
#      confirm is reported as UNKNOWN, never as stopped.
#   Step 1 also compares the serving keeper's own health record with keeper.env and refuses a difference: a ship never
#   changes the keeper's mode; the live switch is its own step after a dry ship (runbook "Going live").
# Drills only (runbook "Drills"): SH_BNB_DRILL=candidate-fails or promotion-fails points that step's health check at
# a port where nothing listens, so the failure path runs for real; keeper-fails starts the new keeper under a wrong
# registry so its own start check refuses.
set -Eeuo pipefail

log() { printf 'ship: %s\n' "$*"; }
die() { printf 'ship: %s\n' "$*" >&2; exit 1; }

[ "$#" -eq 1 ] || die "usage: ship.sh <full release commit>"
commit=$1
[[ $commit =~ ^[0-9a-f]{40}$ ]] || die "give the full 40-character commit"
drill=${SH_BNB_DRILL:-}
# How long each health check waits (seconds; the drills shorten it).
wait_s=${SH_BNB_HEALTH_SECONDS:-300}
[[ $wait_s =~ ^[1-9][0-9]*$ ]] || die "SH_BNB_HEALTH_SECONDS is a number of seconds"
case "$drill" in ''|candidate-fails|promotion-fails|keeper-fails) ;; *) die "SH_BNB_DRILL is candidate-fails, promotion-fails or keeper-fails" ;; esac
etc=${SH_BNB_ETC:-/etc/squarehole-bnb}
settings="$etc/stack.env"
[ -r "$settings" ] || die "no $settings: run bootstrap.sh first"
value() { sed -n "s/^$1=//p" "$settings" | tail -n 1; }
srv=$(value SH_BNB_SRV)
host=$(value SH_BNB_HOST)
gateway=$(value SH_BNB_GATEWAY_PORT); gateway=${gateway:-5494}
https_port=$(value SH_BNB_HTTPS_PORT); https_port=${https_port:-443}
c_gateway=$(value SH_BNB_CANDIDATE_GATEWAY_PORT); c_gateway=${c_gateway:-5495}
c_http=$(value SH_BNB_CANDIDATE_HTTP_PORT); c_http=${c_http:-5496}
c_https=$(value SH_BNB_CANDIDATE_HTTPS_PORT); c_https=${c_https:-5497}
if [ -z "$srv" ] || [ -z "$host" ]; then die "SH_BNB_SRV and SH_BNB_HOST must be set in $settings"; fi
case "$host" in *'<'*) die "fill SH_BNB_HOST in $settings" ;; esac
project=${SH_BNB_PROJECT:-squarehole-bnb}
node_image=node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
# The Four.meme signer (hackathon/stack/sign/) runs only with SH_BNB_SIGN=1 and its folder <etc>/sign.
services=(postgres indexer kubo ipfs-art web)
if [ "$(value SH_BNB_SIGN)" = 1 ]; then services+=(sign); export COMPOSE_PROFILES=sign; fi
# SH-275: the alpha's sign-in and starter sender (alpha.compose.yaml, a second --file) only with SH_BNB_ALPHA=1, its two
# settings files and the sender's key folder <etc>/alpha-sender; started at promotion, never in the candidate.
alpha=$(value SH_BNB_ALPHA)
alpha_services=()
case "${alpha:-0}" in
  0) alpha=0 ;;
  1) alpha_services=(alpha-api alpha-sender); export COMPOSE_PROFILES=${COMPOSE_PROFILES:+$COMPOSE_PROFILES,}alpha ;;
  *) die "SH_BNB_ALPHA in $settings is 0 or 1" ;;
esac
[[ $project =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "SH_BNB_PROJECT is a compose project name"
release="$srv/releases/$commit"
[ -f "$release/hackathon/stack/compose.yaml" ] || die "no release at $release (unpack it there first)"
for file in indexer.env keeper.env db.env approved-97.sha256 approved-atlas.sha256; do [ -r "$etc/$file" ] || die "no $etc/$file (runbook step 3)"; done
if [[ ,${COMPOSE_PROFILES:-}, == *,sign,* ]] && [ ! -d "$etc/sign" ]; then die "SH_BNB_SIGN=1 needs the folder $etc/sign (runbook, the signer)"; fi
if [ "$alpha" = 1 ]; then
  for file in alpha-api.env alpha-sender.env; do [ -r "$etc/$file" ] || die "SH_BNB_ALPHA=1 needs $etc/$file (runbook, the alpha)"; done
  [ -d "$etc/alpha-sender" ] && [ ! -L "$etc/alpha-sender" ] || die "SH_BNB_ALPHA=1 needs the folder $etc/alpha-sender (runbook, the alpha)"
  [ -f "$release/hackathon/stack/alpha.compose.yaml" ] || die "SH_BNB_ALPHA=1 but the release has no hackathon/stack/alpha.compose.yaml"
  if grep -qx 'SH_ALPHA_ENABLED=1' "$etc/alpha-api.env" && grep -q '^[^#]*<' "$etc/alpha-api.env"; then
    die "alpha-api is enabled: fill the <...> placeholders in $etc/alpha-api.env"
  fi
  if grep -qx 'SH_SERVICE_ENABLED=1' "$etc/alpha-sender.env" && grep -q '^[^#]*<' "$etc/alpha-sender.env"; then
    die "alpha-sender is enabled: fill the <...> placeholders in $etc/alpha-sender.env"
  fi
fi
if grep -q '^[^#]*<' "$etc/indexer.env"; then die "fill the <...> placeholders in $etc/indexer.env"; fi
if grep -qx 'SH_SERVICE_ENABLED=1' "$etc/keeper.env" && grep -q '^[^#]*<' "$etc/keeper.env"; then
  die "the keeper is enabled: fill the <...> placeholders in $etc/keeper.env"
fi

# Every Docker call of the keeper's handling is bounded (seconds; keeper_runs passes what its deadline has left).
dk() { local s=${DK_SECONDS:-30}; [ "$s" -ge 1 ] || s=1; timeout --kill-after=5 "$s" docker "$@"; }
containers() { # containers <service>: the project's containers of that service, running or not (fails with Docker)
  dk ps --all --quiet --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$1"
}
# keeper_state: what the keeper itself says in its health record: absent (Docker confirms no container, or one it
# confirms is not running), disabled/<mode>, dry-run, live, or unknown (Docker or the record cannot tell; a keeper still
# starting; a record from the future or older than the service's own 300 s).
keeper_state() {
  local ids running record
  ids=$(containers keeper) || { echo unknown; return; }
  [ -n "$ids" ] || { echo absent; return; }
  [ "$(printf '%s\n' "$ids" | grep -c .)" = 1 ] || { echo unknown; return; }
  running=$(dk inspect --format '{{.State.Running}}' "$ids" 2>/dev/null) || { echo unknown; return; }
  case "$running" in false) echo absent; return ;; true) ;; *) echo unknown; return ;; esac
  record=$(dk exec "$ids" cat /tmp/service-health.json 2>/dev/null) || { echo unknown; return; }
  jq -r '(now * 1000) as $t | if .service != "keeper" or (.at | type) != "number" or .at > $t or ($t - .at) > 300000 then "unknown"
    elif (.mode != "dry-run" and .mode != "live") then "unknown"
    elif .status == "disabled" then "disabled/" + .mode
    elif .status == "ok" then .mode else "unknown" end' <<<"$record" 2>/dev/null || echo unknown
}

# 1. One ship per deployment root (a lock on the folder itself: a refused ship writes nothing), never the serving
#    commit, from the serving release, and the serving keeper as the settings folder names it.
exec 9<"$srv"
flock -n 9 || die "another ship is running on $srv; nothing changed"
serving=$(readlink -f "$srv/current" 2>/dev/null || true)
[ -n "$serving" ] && [ -d "$serving" ] || serving=
[ "$serving" != "$(readlink -f "$release")" ] || die "$commit already serves; a ship of the serving commit is refused"
self=$(readlink -f "${BASH_SOURCE[0]}")
if [ -n "$serving" ] && [ "$self" != "$serving/hackathon/stack/ship.sh" ]; then
  # The transition, once: only while the serving release predates this rule (it has no keeper-start/).
  if [ "${SH_BNB_SHIP_FROM_INCOMING:-}" != "$commit" ] || [ "$self" != "$(readlink -f "$release")/hackathon/stack/ship.sh" ] \
    || [ -e "$serving/hackathon/stack/keeper-start" ]; then
    die "run the serving release's script: bash $srv/current/hackathon/stack/ship.sh $commit"
  fi
  log "the transition ship: this script is the incoming release's ($commit), as named"
fi
if [ -n "$serving" ] && [ ! -s "$serving/.derived.env" ]; then
  die "the serving release has no .derived.env: its rollback could not start; nothing changed"
fi
# The keeper's settings as this ship reads them, once: a snapshot, checked here and used by both keeper starts below
# (promotion and rollback). Refused: any assignment that does not begin in column one (compose's parser takes leading
# spaces, the shell's reading would not), a name assigned twice, and any spelling of a value the ship derives.
snapshot="$etc/.keeper.env.ship"
( umask 077; cp "$etc/keeper.env" "$snapshot.new" ) && mv -f "$snapshot.new" "$snapshot"
keeper_env_digest=$(sha256sum < "$snapshot" | cut -d' ' -f1)
bad=$(awk '/^[[:space:]]*$/ || /^#/ { next }
  !/^[A-Z][A-Z0-9_]*=/ { print "line " NR " is not NAME=value from column one (no space, no lower case, no export)"; next }
  { n = substr($0, 1, index($0, "=") - 1); if (seen[n]++) print n " is assigned twice" }
  n ~ /^SH_KEEPER_(CHAIN_ID|BOX_REGISTRY|FROM_BLOCK|PRIORITY_FEE_WEI|MAX_FEE_WEI|ATLAS)$/ { print n " is derived by the ship: remove it" }' "$snapshot")
[ -z "$bad" ] || die "$etc/keeper.env: $(head -n 1 <<<"$bad"); nothing changed"
mode=$(sed -n 's/^SH_SERVICE_MODE=//p' "$snapshot")
case "$mode" in dry-run|live) ;; *) die "$etc/keeper.env must set SH_SERVICE_MODE to dry-run or live" ;; esac
enabled=$(sed -n 's/^SH_SERVICE_ENABLED=//p' "$snapshot")
case "$enabled" in 0) want=disabled/$mode ;; 1) want=$mode ;; *) die "$etc/keeper.env must set SH_SERVICE_ENABLED to 0 or 1" ;; esac
export SH_BNB_KEEPER_ENV=$snapshot
# The serving keeper's actual state against the settings: a ship never changes the keeper's mode (the live switch is its
# own step after a dry ship), and a rollback restores exactly this state.
prior=$(keeper_state)
case "$prior" in
  unknown) die "the serving keeper's state is unknown (Docker or its health record cannot tell); nothing changed" ;;
  absent) [ "$want" != live ] || die "keeper.env says live but no keeper runs: ship dry first, then switch to live as its own step; nothing changed" ;;
  *) [ "$prior" = "$want" ] || die "the serving keeper is $prior but keeper.env says $want: a ship never changes the keeper's mode; nothing changed" ;;
esac
log "the serving keeper: $prior (keeper.env: $want)"

# 2. The approved files, by the digests in <etc>: the release's files are checksummed here, by a fixed list of paths,
#    and the lines must equal the approved lines EXACTLY (no name is matched by a pattern).
approved_exactly() { # approved_exactly <approval file> <path>...: the release's checksum lines are that file's lines
  local file=$1 computed; shift
  computed=$(cd "$release" && sha256sum -- "$@" 2>/dev/null) || return 1
  [ "$computed" = "$(cat "$file")" ]
}
manifest="$release/packages/contracts/deployments/core-v1/97.json"
# SH-300: the create-options file of EVERY release the manifest names (by its factory, in the manifest's order), so a
# second release's file is approved by its own line right after the first's; the first release stays the one this
# stack's keeper serves (step 3). One release: exactly the five files as before.
mapfile -t release_factories < <(jq -r '.releases[]?.factory.address // empty | ascii_downcase' "$manifest" 2>/dev/null)
[ "${#release_factories[@]}" -ge 1 ] && [ "${release_factories[0]}" = 0xb954a0db33a6351e76e519b4830489531c39d4f0 ] \
  || die "the manifest's first release is not the factory 0xb954a0db33a6351e76e519b4830489531c39d4f0; nothing serving changed"
create_options=()
for f in "${release_factories[@]}"; do
  [[ $f =~ ^0x[0-9a-f]{40}$ ]] || die "the manifest names a malformed factory; nothing serving changed"
  create_options+=("packages/chain/src/create-options/data/97/$f.json")
done
# By name: a release's file without its approval line, or an approval line for a create-options file of no release.
for p in "${create_options[@]}"; do
  awk -v f="$p" '$2 == f { found = 1 } END { exit !found }' "$etc/approved-97.sha256" \
    || die "the manifest names a release whose $p has no line in $etc/approved-97.sha256; nothing serving changed"
done
while read -r _ p; do
  case " ${create_options[*]} " in *" $p "*) ;; *) die "$etc/approved-97.sha256 approves $p but the release's manifest names no such release; nothing serving changed" ;; esac
done < <(awk '$2 ~ /^packages\/chain\/src\/create-options\/data\/97\//' "$etc/approved-97.sha256")
approved_exactly "$etc/approved-97.sha256" packages/contracts/deployments/core-v1/97.json packages/contracts/deployments/bnb-testnet/97-extras.json \
  packages/chain/src/trade-sepolia/coin-deployment-97.json "${create_options[@]}" \
  hackathon/stack/keeper-fees-97.json \
  || die "the release's deployment files are not exactly the approved ones ($etc/approved-97.sha256); nothing serving changed"
if [ "${#release_factories[@]}" -eq 1 ]; then log "the four deployment files and the keeper's fee file are the approved ones"
else log "the deployment files of ${#release_factories[@]} releases and the keeper's fee file are the approved ones (the keeper serves the first)"; fi
# The launch page: approved (a non-empty <etc>/approved-launch.sha256) means it MUST be in the release, with its
# generator; a release holding it needs the approval.
launch=no
launch_files=(bounties/flap/deployments/97.json bounties/flap/deployments/97-sale.json bounties/flap/deployments/97-usdt.json
  bounties/flap/deployments/97-usdt-sale.json bounties/openfour/deployments/97.json)
# SH-299: four more deployment files the launch page maps once they exist (lane h's generator, make-addresses.mjs: the
# rules pairs `rules.native` and `rules.token`, the holders' stake factory `railStake.factory`, the card shops' factory
# `shops.factory`). Each one the release holds needs its own line in approved-launch.sha256, after the five and in this
# order; a line for one the release lacks is refused too. None in the release: everything below is as before.
launch_optional=(bounties/flap/deployments/97-rules-native.json bounties/flap/deployments/97-rules-usdt.json
  bounties/flap/deployments/97-stake.json bounties/core/deployments/97-rail-shop.json)
launch_present=()
for f in "${launch_optional[@]}"; do if [ -e "$release/$f" ]; then launch_present+=("$f"); fi; done
approves() { awk -v f="$2" '$2 == f { found = 1 } END { exit !found }' "$1"; } # approves <approval file> <path>
if [ -s "$etc/approved-launch.sha256" ]; then
  if [ ! -f "$release/bounties/app/package.json" ] || [ ! -f "$release/bounties/app/scripts/make-addresses.mjs" ]; then
    die "the launch page is approved but not in this release (no bounties/app or its generator); nothing serving changed"
  fi
  for f in "${launch_optional[@]}"; do
    if [ -e "$release/$f" ] && ! approves "$etc/approved-launch.sha256" "$f"; then
      die "the release holds $f but $etc/approved-launch.sha256 has no line for it; nothing serving changed"
    fi
    if [ ! -e "$release/$f" ] && approves "$etc/approved-launch.sha256" "$f"; then
      die "$etc/approved-launch.sha256 approves $f but the release does not hold it; nothing serving changed"
    fi
  done
  approved_exactly "$etc/approved-launch.sha256" "${launch_files[@]}" "${launch_present[@]}" \
    || die "the launch page's deployment files are not exactly the approved ones ($etc/approved-launch.sha256); nothing serving changed"
  launch=yes
  if [ "${#launch_present[@]}" -eq 0 ]; then log "the launch page's five deployment files are the approved ones"
  else log "the launch page's five deployment files and ${launch_present[*]} are the approved ones"; fi
elif [ -e "$release/bounties/app" ]; then
  die "the release holds the launch page but $etc/approved-launch.sha256 approves nothing; nothing serving changed"
fi

# 3. The keeper's chain, registry and start block, from the approved manifest.
read -r chain registry start < <(jq -r '[.chainId, .releases[0].registry.address, .releases[0].startBlock] | map(tostring) | join(" ")' "$manifest")
if [ "$chain" != 97 ] || [[ ! $registry =~ ^0x[0-9a-fA-F]{40}$ ]] || [[ ! $start =~ ^[0-9]+$ ]]; then
  die "the manifest's chain, registry or start block is malformed"
fi
for name in SH_KEEPER_CHAIN_ID SH_KEEPER_BOX_REGISTRY SH_KEEPER_FROM_BLOCK SH_KEEPER_PRIORITY_FEE_WEI SH_KEEPER_MAX_FEE_WEI \
  SH_KEEPER_ATLAS; do
  if grep -q "^$name=" "$etc/keeper.env"; then die "$etc/keeper.env sets $name: remove it; the ship derives it from the approved manifest"; fi
done
# The keeper's fee floor and ceiling, from the approved hackathon/stack/keeper-fees-97.json (pinned in <etc>).
read -r fee_chain price ceiling < <(jq -r '[.chainId, .floorWei, .ceilingWei] | map(tostring) | join(" ")' "$release/hackathon/stack/keeper-fees-97.json")
if [ "$fee_chain" != 97 ] || [[ ! $price =~ ^[1-9][0-9]{0,29}$ ]] || [[ ! $ceiling =~ ^[1-9][0-9]{0,29}$ ]]; then
  die "the keeper's fee file is malformed"
fi
derived="$release/.derived.env"
drill_registry=$registry
if [ "$drill" = keeper-fails ]; then drill_registry=0x000000000000000000000000000000000000dEaD; fi
# SH-266's prices (lane i: read only, the keeper sends nothing for them): on, for the keeper and the indexer, once
# <etc>/approved-atlas.sha256 approves the release's 97-atlas.json (one line); while that file is empty, off.
atlas=0
if [ -s "$etc/approved-atlas.sha256" ]; then
  approved_exactly "$etc/approved-atlas.sha256" packages/contracts/deployments/bnb-testnet/97-atlas.json \
    || die "the release's 97-atlas.json is not exactly the approved one ($etc/approved-atlas.sha256); nothing serving changed"
  [ "$(jq -r .chainId "$release/packages/contracts/deployments/bnb-testnet/97-atlas.json")" = 97 ] || die "the Atlas file is not for chain 97"
  atlas=1
  log "Atlas prices: on (the approved 97-atlas.json)"
else
  log "Atlas prices: off ($etc/approved-atlas.sha256 is empty)"
fi
printf 'SH_BNB_KEEPER_CHAIN_ID=%s\nSH_BNB_KEEPER_REGISTRY=%s\nSH_BNB_KEEPER_FROM_BLOCK=%s\nSH_BNB_KEEPER_PRIORITY_FEE_WEI=%s\nSH_BNB_KEEPER_MAX_FEE_WEI=%s\n' \
  "$chain" "$drill_registry" "$start" "$price" "$ceiling" > "$derived.new"
printf 'SH_BNB_KEEPER_ATLAS=%s\nSH_BNB_CORE_ATLAS=%s\n' "$atlas" "$atlas" >> "$derived.new"
mv -f "$derived.new" "$derived"
log "keeper: chain $chain, registry $registry, start block $start, fee floor $price wei, ceiling $ceiling wei, $want"

# Every compose command names its project, both settings files and the release's .derived.env; the SH_BNB_KEEPER_*
# values come from that file only (an exported one in this shell is dropped).
unset SH_BNB_KEEPER_CHAIN_ID SH_BNB_KEEPER_REGISTRY SH_BNB_KEEPER_FROM_BLOCK SH_BNB_KEEPER_PRIORITY_FEE_WEI SH_BNB_KEEPER_MAX_FEE_WEI \
  SH_BNB_KEEPER_ATLAS SH_BNB_CORE_ATLAS
compose_of() { # compose_of <project> <release dir>: the compose command line, one word a line
  printf '%s\n' env "SH_RELEASE=${2##*/}" docker compose --project-name "$1" --env-file "$settings" --env-file "$2/.derived.env" \
    --file "$2/hackathon/stack/compose.yaml"
  # SH-275: the alpha's addition, when switched on and the release has it.
  if [ "$alpha" = 1 ] && [ -f "$2/hackathon/stack/alpha.compose.yaml" ]; then printf '%s\n' --file "$2/hackathon/stack/alpha.compose.yaml"; fi
}
mapfile -t compose < <(compose_of "$project" "$release")
"${compose[@]}" config --quiet

# 4. The images.
log "building the images of $commit"
"${compose[@]}" build --quiet

# 5. The chain check: the serving release's script in its indexer image (the incoming one on a first ship).
checker=$release
[ -z "$serving" ] || checker=$serving
log "checking the manifest on the real chain 97 (checker: $(basename "$checker"))"
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$manifest,dst=/release/97.json,readonly" \
  --mount "type=bind,src=$checker/packages/indexer/scripts/check-release-97.ts,dst=/app/packages/indexer/scripts/check-release-97.ts,readonly" \
  --entrypoint node "squarehole-bnb-indexer:$(basename "$checker")" \
  --experimental-transform-types --no-warnings=ExperimentalWarning --import ./scripts/register-ts.mjs \
  scripts/check-release-97.ts /release/97.json || die "the manifest does not match the real chain 97; nothing serving changed"

healthy() { # healthy <gateway port> <https port> <seconds>: the gateway follows the chain and the site answers
  local deadline=$((SECONDS + $3)) follows
  while [ "$SECONDS" -lt "$deadline" ]; do
    follows=$(curl -fsS --max-time 4 "http://127.0.0.1:$1/healthz" 2>/dev/null | jq -r '.following // false' 2>/dev/null || true)
    if [ "$follows" = true ] && curl -fsS -o /dev/null --max-time 8 --insecure --resolve "$host:$2:127.0.0.1" "https://$host:$2/" 2>/dev/null; then
      return 0
    fi
    sleep 5
  done
  return 1
}
serves() { # serves <commit> <gateway port> <seconds> <service>...: health, one running container each, the release's images
  local svc ids image
  healthy "$2" "$https_port" "$3" || { log "health check failed"; return 1; }
  for svc in "${@:4}"; do
    ids=$(containers "$svc")
    [ "$(printf '%s\n' "$ids" | grep -c .)" = 1 ] || { log "$svc: not exactly one container"; return 1; }
    [ "$(docker inspect --format '{{.State.Running}}' "$ids")" = true ] || { log "$svc: not running"; return 1; }
    image=$(docker inspect --format '{{.Config.Image}}' "$ids")
    case "$image" in squarehole-bnb-*) [ "$image" = "${image%%:*}:$1" ] || { log "$svc: image $image, not $1"; return 1; } ;; esac
  done
}
keeper_runs() { # keeper_runs <commit> <state>: one keeper of the release's image whose own health record says <state>
  local ids state deadline=$((SECONDS + 180))
  [ "$(sha256sum < "$etc/keeper.env" | cut -d' ' -f1)" = "$keeper_env_digest" ] || { log "keeper.env changed during the ship"; return 1; }
  while [ "$SECONDS" -lt "$deadline" ]; do
    DK_SECONDS=$((deadline - SECONDS))
    ids=$(containers keeper) || ids=
    if [ "$(printf '%s\n' "$ids" | grep -c .)" = 1 ]; then
      [ "$(dk inspect --format '{{.Config.Image}}' "$ids")" = "squarehole-bnb-keeper:$1" ] || { log "keeper: not the image of $1"; DK_SECONDS=30; return 1; }
      state=$(keeper_state)
      if [ "$state" = "$2" ] && [ "$(dk inspect --format '{{.RestartCount}}' "$ids")" = 0 ]; then
        log "keeper: one container, squarehole-bnb-keeper:$1, its health record says $2"
        DK_SECONDS=30
        return 0
      fi
    fi
    sleep 5
  done
  DK_SECONDS=10
  log "keeper: its health record did not say $2 within 180 s$(dk logs --tail 5 "$ids" 2>&1 | grep -o 'start refused: .*' | head -n 1 | sed 's/^/ (/; s/$/)/')"
  DK_SECONDS=30
  return 1
}
# start_keeper <state> <compose command...>: creates the keeper STOPPED, reads the enabled flag and the mode the created
# container would run with, refuses (and removes it) on any difference from <state>, and only then starts it.
start_keeper() {
  local state=$1 ids env en md want_en want_md
  shift
  case "$state" in disabled/*) want_en=0 want_md=${state#disabled/} ;; *) want_en=1 want_md=$state ;; esac
  "$@" up --no-start --no-deps keeper || return 1
  ids=$(containers keeper) || return 1
  [ "$(printf '%s\n' "$ids" | grep -c .)" = 1 ] || { log "keeper: not exactly one container created"; return 1; }
  env=$(dk inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$ids") || return 1
  en=$(sed -n 's/^SH_SERVICE_ENABLED=//p' <<<"$env"); md=$(sed -n 's/^SH_SERVICE_MODE=//p' <<<"$env")
  if [ "$en" != "$want_en" ] || [ "$md" != "$want_md" ]; then
    log "keeper: the created container would run enabled=$en mode=$md, not $state; removed before it ran"
    dk rm --force "$ids" >/dev/null || true
    return 1
  fi
  dk start "$ids" >/dev/null
}
# stop_keeper: stops (SIGTERM, its 60 s grace, so it releases its state lock) and removes every keeper container, and
# succeeds only when Docker then lists none.
stop_keeper() {
  local found left ids
  found=$(containers keeper) || return 1
  if [ -n "$found" ]; then
    mapfile -t ids <<<"$found"
    DK_SECONDS=90 dk stop --time 60 "${ids[@]}" >/dev/null && dk rm "${ids[@]}" >/dev/null || return 1
  fi
  left=$(containers keeper) && [ -z "$left" ]
}
point() { ln -sfn "$1" "$srv/current.new" && mv -T "$srv/current.new" "$srv/current"; }

# 6. The candidate: the release without its keeper, on 127.0.0.1, with its own volumes and Caddy's own certificate.
mapfile -t candidate < <(compose_of "$project-candidate" "$release")
in_candidate() { SH_BNB_LISTEN=127.0.0.1 SH_BNB_GATEWAY_PORT=$c_gateway SH_BNB_HTTP_PORT=$c_http SH_BNB_HTTPS_PORT=$c_https \
  SH_BNB_CADDY_TRIAL=local_certs "${candidate[@]}" "$@"; }
cleanup_candidate() { in_candidate down --volumes --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup_candidate EXIT
log "starting the candidate (no keeper) on 127.0.0.1:$c_gateway and 127.0.0.1:$c_https"
in_candidate up --detach "${services[@]}"
probe=$c_gateway probe_s=$wait_s
if [ "$drill" = candidate-fails ]; then probe=9 probe_s=30; fi
if ! healthy "$probe" "$c_https" "$probe_s"; then
  die "the candidate did not follow the chain and serve the site within ${probe_s} s; the serving release is unchanged"
fi
if [ "$launch" = yes ]; then
  at="https://$host:$c_https/launches/"
  page=$(curl -fsS --max-time 8 --insecure --resolve "$host:$c_https:127.0.0.1" -o /dev/null -w '%{http_code} %{content_type}' "$at" || true)
  case "$page" in "200 text/html"*) ;; *) die "the candidate's /launches/ answered '$page'; the serving release is unchanged" ;; esac
  # Its addresses file must be exactly what lane h's generator makes from the five approved files (run here, offline,
  # read-only, on those files and nothing else).
  served=$(curl -fsS --max-time 8 --insecure --resolve "$host:$c_https:127.0.0.1" "${at}addresses.json") \
    || die "the candidate's /launches/addresses.json did not download; the serving release is unchanged"
  # SH-299: the optional files the release holds (approved above) under the generator's own names; none, none passed.
  want_addresses=$(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
    --env "LAUNCH_PRESENT=${launch_present[*]}" \
    --mount "type=bind,src=$release/bounties,dst=/b,readonly" --entrypoint node "$node_image" --input-type=module -e '
      import fs from "node:fs";
      const { addressesFor } = await import("/b/app/scripts/make-addresses.mjs");
      const read = (p) => JSON.parse(fs.readFileSync("/b/" + p, "utf8"));
      const present = new Set((process.env.LAUNCH_PRESENT || "").split(" ").filter(Boolean).map((p) => p.replace(/^bounties\//, "")));
      const optional = { rulesNative: "flap/deployments/97-rules-native.json", rulesUsdt: "flap/deployments/97-rules-usdt.json",
        stake: "flap/deployments/97-stake.json", shops: "core/deployments/97-rail-shop.json" };
      const more = Object.fromEntries(Object.entries(optional).filter(([, p]) => present.has(p)).map(([k, p]) => [k, read(p)]));
      process.stdout.write(JSON.stringify(addressesFor({ flap: read("flap/deployments/97.json"), sale: read("flap/deployments/97-sale.json"),
        usdt: read("flap/deployments/97-usdt.json"), usdtSale: read("flap/deployments/97-usdt-sale.json"), openfour: read("openfour/deployments/97.json"), ...more })));') \
    || die "lane h's generator did not run on the approved files; the serving release is unchanged"
  # Each must be exactly one whole JSON document; any jq failure fails the ship.
  one_document() { jq -cS -s 'if length == 1 then .[0] else error("not one JSON document") end'; }
  served_doc=$(one_document <<<"$served") || die "the candidate's /launches/addresses.json is not one JSON document; the serving release is unchanged"
  want_doc=$(one_document <<<"$want_addresses") || die "the generator's output is not one JSON document; the serving release is unchanged"
  [ "$served_doc" = "$want_doc" ] \
    || die "the candidate's /launches/addresses.json is not what the generator makes from the approved files; the serving release is unchanged"
  log "the candidate's /launches/ answers ($page) and its addresses file is what the approved files give"
fi
cleanup_candidate
trap - EXIT
log "the candidate followed the chain and served the site; promoting"

# 7. Promotion, with the way back armed to the end.
keeper_unknown() { die "$1; the keeper's state is UNKNOWN (Docker could not confirm it stopped): look at it before anything else"; }
rollback() {
  trap - ERR INT TERM
  set +e
  stop_keeper || keeper_unknown "the new release failed"
  if [ -z "$serving" ]; then
    "${compose[@]}" down --remove-orphans
    die "the first release failed its check; the stack is stopped"
  fi
  local prev; prev=$(basename "$serving")
  log "promotion failed: starting the previous release $prev again (its .derived.env, the same keeper.env), its keeper $prior"
  mapfile -t back < <(compose_of "$project" "$serving")
  local back_services=(postgres indexer kubo ipfs-art web)
  if [[ ,${COMPOSE_PROFILES:-}, == *,sign,* ]] && grep -q '^  sign:$' "$serving/hackathon/stack/compose.yaml"; then back_services+=(sign); fi
  if [ "$alpha" = 1 ] && [ -f "$serving/hackathon/stack/alpha.compose.yaml" ]; then back_services+=("${alpha_services[@]}"); fi
  if "${back[@]}" up --detach --remove-orphans "${back_services[@]}" && serves "$prev" "$gateway" "$wait_s" "${back_services[@]}" \
    && point "$serving"; then
    # The keeper as it was: absent stays absent (confirmed by Docker); otherwise created stopped, checked, started, and
    # its own health record must say what it said before.
    local left
    if { [ "$prior" = absent ] && left=$(containers keeper) && [ -z "$left" ]; } \
      || { [ "$prior" != absent ] && start_keeper "$prior" "${back[@]}" && keeper_runs "$prev" "$prior"; }; then
      die "the new release failed; the previous release $prev serves again, verified (keeper $prior)"
    fi
  fi
  stop_keeper || keeper_unknown "ROLLBACK FAILED: the previous release $prev did not come back verified"
  die "ROLLBACK FAILED: the previous release $prev did not come back verified; the keeper is stopped; look at the logs"
}
trap rollback ERR INT TERM
log "stopping the keeper"
stop_keeper || keeper_unknown "the serving keeper did not stop; nothing else changed"
"${compose[@]}" up --detach --remove-orphans "${services[@]}" "${alpha_services[@]}"
probe=$gateway probe_s=$wait_s
if [ "$drill" = promotion-fails ]; then probe=9 probe_s=30; fi
serves "$commit" "$probe" "$probe_s" "${services[@]}" "${alpha_services[@]}" || rollback
point "$release"
log "current is $commit; starting its keeper ($want)"
start_keeper "$want" "${compose[@]}" || rollback
keeper_runs "$commit" "$want" || rollback
trap - ERR INT TERM
target="https://$host/"; [ "$https_port" = 443 ] || target="https://$host:$https_port/"
log "up: $target ($commit)"
