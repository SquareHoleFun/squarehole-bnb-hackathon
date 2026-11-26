#!/usr/bin/env bash
# A trial of the stack on a machine with Docker, as an ordinary user of the docker group, never root (SH-259 Part 4):
# the runbook's ship step on a `git archive` of this checkout, with settings made the way bootstrap.sh makes them,
# bound to 127.0.0.1 only (the name 127-0-0-1.sslip.io, which the web build takes as a public host, with Caddy's own
# certificate, SH_BNB_CADDY_TRIAL), on ports of its own (18582 to 18587), as a second compose project beside the real
# one. Its settings and secrets (a database password) live OUTSIDE every checkout, in ~/bnb-trial. It follows the real
# release on the real chain 97 with the approved files the checkout holds; the keeper runs dry and sends nothing.
#   bash hackathon/stack/test/trial.sh up <label>    builds and starts; <label> is a 40-character name for the release
#   bash hackathon/stack/test/trial.sh down          stops it and removes its containers, volumes and images
#   bash hackathon/stack/test/trial.sh ship <label>   ships the release <label> (unpacked beside the serving one) with
#                                                    the serving release's script
set -euo pipefail
root=$(readlink -f "$(git rev-parse --show-toplevel)")
base="$HOME/bnb-trial"
# By resolved paths: the trial's settings (a database password) never inside this or any checkout.
base_r=$(readlink -m "$base") probe=$(readlink -m "$base")
case "$base_r" in "$root"|"$root"/*) echo "trial: the trial folder must be outside the checkout" >&2; exit 1 ;; esac
while [ ! -d "$probe" ]; do probe=$(dirname "$probe"); done
if git -C "$probe" rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "trial: the trial folder lies inside a checkout" >&2; exit 1; fi
export SH_BNB_PROJECT=sh259-trial SH_BNB_ETC="$base/etc"
case "${1:-}" in
  down)
    export COMPOSE_PROFILES=sign
    release=
    if [ -L "$base/srv/current" ]; then release=$(readlink -f "$base/srv/current"); fi
    if [ -n "$release" ] && [ -f "$release/.derived.env" ]; then
      SH_RELEASE=$(basename "$release") docker compose --project-name sh259-trial --env-file "$base/etc/stack.env" \
        --env-file "$release/.derived.env" --file "$release/hackathon/stack/compose.yaml" down --volumes --rmi local
    fi
    # Also what a failed first ship leaves: its containers are gone, its volumes stay (the database's password among them).
    for project in sh259-trial sh259-trial-candidate; do
      mapfile -t volumes < <(docker volume ls -q --filter "label=com.docker.compose.project=$project")
      if [ "${#volumes[@]}" -gt 0 ]; then docker volume rm "${volumes[@]}" >/dev/null; fi
    done
    echo "trial: down; remove $base by its literal path"
    exit 0 ;;
  ship) bash "$base/srv/current/hackathon/stack/ship.sh" "${2:?label}"; exit $? ;;
  up) ;;
  *) echo "usage: trial.sh up <40-character label> | ship <label> | down" >&2; exit 2 ;;
esac
label=${2:-}
[[ $label =~ ^[0-9a-f]{40}$ ]] || { echo "trial: give a 40-character hex label" >&2; exit 2; }
[ ! -e "$base" ] || { echo "trial: $base exists; run down and remove it first" >&2; exit 1; }
if [ -n "$(docker volume ls -q --filter label=com.docker.compose.project=sh259-trial)" ]; then
  echo "trial: volumes of an earlier trial are left; run down first" >&2; exit 1
fi
release="$base/srv/releases/$label"
( umask 077; mkdir -p "$base/etc/keeper" "$base/srv/withheld" "$release" )
chmod 0755 "$base/srv" "$base/srv/withheld" "$base/srv/releases"
printf '[]\n' > "$base/srv/withheld/pictures.json"
git -C "$root" archive HEAD | tar -x -C "$release"
stack="$release/hackathon/stack"
sed -e 's|^SH_BNB_HOST=.*|SH_BNB_HOST=127-0-0-1.sslip.io|' -e "s|^SH_BNB_ETC=.*|SH_BNB_ETC=$base/etc|" -e "s|^SH_BNB_SRV=.*|SH_BNB_SRV=$base/srv|" \
  -e 's|^SH_BNB_LISTEN=.*|SH_BNB_LISTEN=127.0.0.1|' -e 's|^SH_BNB_HTTP_PORT=.*|SH_BNB_HTTP_PORT=18583|' \
  -e 's|^SH_BNB_HTTPS_PORT=.*|SH_BNB_HTTPS_PORT=18584|' -e 's|^SH_BNB_GATEWAY_PORT=.*|SH_BNB_GATEWAY_PORT=18582|' \
  -e 's|^SH_BNB_CANDIDATE_GATEWAY_PORT=.*|SH_BNB_CANDIDATE_GATEWAY_PORT=18585|' \
  -e 's|^SH_BNB_CANDIDATE_HTTP_PORT=.*|SH_BNB_CANDIDATE_HTTP_PORT=18586|' \
  -e 's|^SH_BNB_CANDIDATE_HTTPS_PORT=.*|SH_BNB_CANDIDATE_HTTPS_PORT=18587|' \
  "$stack/stack.env.example" > "$base/etc/stack.env"
printf 'SH_BNB_CADDY_TRIAL=local_certs\n' >> "$base/etc/stack.env"
sed -e 's|https://<SH_BNB_HOST>|https://127-0-0-1.sslip.io|' "$stack/indexer.env.example" > "$base/etc/indexer.env"
password=$(openssl rand -hex 32)
printf 'POSTGRES_PASSWORD=%s\nPGPASSWORD=%s\n' "$password" "$password" > "$base/etc/db.env"
unset password
sed -e 's|^SH_SERVICE_ENABLED=.*|SH_SERVICE_ENABLED=1|' \
  -e 's|^SH_KEEPER_ADDRESS=.*|SH_KEEPER_ADDRESS=0x920B1439BC0BF2f30f9E01B9Bb94d90A9ba35189|' "$stack/keeper.env.example" > "$base/etc/keeper.env"
chmod 0600 "$base/etc/"*.env
# The approved digests live in the settings folder (runbook step 3): the checkout's reference copies.
install -m 0444 "$stack/approved-97.sha256" "$base/etc/approved-97.sha256"
# The launch page's approval only when the checkout holds the page (an approval without it refuses the ship).
if [ -f "$release/bounties/app/package.json" ]; then install -m 0444 "$stack/approved-launch.sha256" "$base/etc/approved-launch.sha256"
else install -m 0444 /dev/null "$base/etc/approved-launch.sha256"; fi
install -m 0444 "$stack/approved-atlas.sha256" "$base/etc/approved-atlas.sha256"
# The signer runs when the checkout holds lane g's function; its folder stays empty here (no records: it answers 503).
if [ -f "$release/bounties/openfour/sign/service.js" ]; then
  printf 'SH_BNB_SIGN=1\n' >> "$base/etc/stack.env"
  mkdir -m 0750 "$base/etc/sign"
fi
bash "$stack/ship.sh" "$label"
