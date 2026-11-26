#!/usr/bin/env bash
# A rehearsal of the runbook's "The morning ship" on the trial (SH-259), never on the serving stack: the trial first
# serves a copy of the release that serves live today (its own old ship script, old-style settings: the keeper's fee
# lines in keeper.env, no approval files), then the page's steps run in order with the trial's paths, up to the dry
# ship and the checks after it, the card pictures and the signer's 503. The key and the live switch are NOT rehearsed:
# the trial never holds a key and never sends.
#   bash hackathon/stack/test/morning-rehearsal.sh <folder of the serving release to copy> <label of the old copy> <label of the new release>
# Labels are 40 hex characters that are no real commit (the trial's images carry them; never a live image's tag).
set -euo pipefail
old_src=${1:?the serving release folder to copy (on the build machine: the live 1cbb57a6)} old=${2:?label of the old copy} new=${3:?label of the new release}
for l in "$old" "$new"; do [[ $l =~ ^[0-9a-f]{40}$ ]] || { echo "rehearsal: labels are 40 hex characters" >&2; exit 2; }; done
root=$(readlink -f "$(git rev-parse --show-toplevel)")
base="$HOME/bnb-trial"
[ ! -e "$base" ] || { echo "rehearsal: $base exists; trial.sh down and remove it first" >&2; exit 1; }
export SH_BNB_PROJECT=sh259-trial SH_BNB_ETC="$base/etc"
ETC="$base/etc" SRV="$base/srv"
step() { printf '\nrehearsal: == %s\n' "$*"; }

step "0. the trial serves a copy of today's live release, shipped by its own script"
( umask 077; mkdir -p "$ETC/keeper" "$SRV/withheld" "$SRV/releases" )
chmod 0755 "$SRV" "$SRV/withheld" "$SRV/releases"
printf '[]\n' > "$SRV/withheld/pictures.json"
cp -a "$old_src" "$SRV/releases/$old"
rm -f "$SRV/releases/$old/.derived.env"
stack="$SRV/releases/$old/hackathon/stack"
sed -e 's|^SH_BNB_HOST=.*|SH_BNB_HOST=127-0-0-1.sslip.io|' -e "s|^SH_BNB_ETC=.*|SH_BNB_ETC=$ETC|" -e "s|^SH_BNB_SRV=.*|SH_BNB_SRV=$SRV|" \
  -e 's|^SH_BNB_LISTEN=.*|SH_BNB_LISTEN=127.0.0.1|' -e 's|^SH_BNB_HTTP_PORT=.*|SH_BNB_HTTP_PORT=18583|' \
  -e 's|^SH_BNB_HTTPS_PORT=.*|SH_BNB_HTTPS_PORT=18584|' -e 's|^SH_BNB_GATEWAY_PORT=.*|SH_BNB_GATEWAY_PORT=18582|' \
  -e 's|^SH_BNB_CANDIDATE_GATEWAY_PORT=.*|SH_BNB_CANDIDATE_GATEWAY_PORT=18585|' \
  -e 's|^SH_BNB_CANDIDATE_HTTP_PORT=.*|SH_BNB_CANDIDATE_HTTP_PORT=18586|' \
  -e 's|^SH_BNB_CANDIDATE_HTTPS_PORT=.*|SH_BNB_CANDIDATE_HTTPS_PORT=18587|' "$stack/stack.env.example" > "$ETC/stack.env"
printf 'SH_BNB_CADDY_TRIAL=local_certs\n' >> "$ETC/stack.env"
sed -e 's|https://<SH_BNB_HOST>|https://127-0-0-1.sslip.io|' "$stack/indexer.env.example" > "$ETC/indexer.env"
password=$(openssl rand -hex 32)
printf 'POSTGRES_PASSWORD=%s\nPGPASSWORD=%s\n' "$password" "$password" > "$ETC/db.env"
unset password
sed -e 's|^SH_SERVICE_ENABLED=.*|SH_SERVICE_ENABLED=1|' \
  -e 's|^SH_KEEPER_ADDRESS=.*|SH_KEEPER_ADDRESS=0x920B1439BC0BF2f30f9E01B9Bb94d90A9ba35189|' "$stack/keeper.env.example" > "$ETC/keeper.env"
chmod 0600 "$ETC/"*.env
bash "$stack/ship.sh" "$old" 2>&1 | grep '^ship:' | tail -n 2

step "1. settings clean-up: the keeper's two fee lines leave keeper.env"
sed -i '/^SH_KEEPER_PRIORITY_FEE_WEI=/d;/^SH_KEEPER_MAX_FEE_WEI=/d' "$ETC/keeper.env"
grep -c 'FEE_WEI' "$ETC/keeper.env" || true

step "2. unpack the new release (here: this checkout as the machine has it)"
t=$(mktemp -d "$SRV/releases/.incoming.XXXXXX"); git -C "$root" archive HEAD | tar -x -C "$t"; mv -T "$t" "$SRV/releases/$new"
REL="$SRV/releases/$new"

step "3. the approval files: computed from the release, compared with the approved lines (here the release's reference copies stand for main's), installed"
( cd "$REL" && sha256sum packages/contracts/deployments/core-v1/97.json packages/contracts/deployments/bnb-testnet/97-extras.json \
  packages/chain/src/trade-sepolia/coin-deployment-97.json \
  packages/chain/src/create-options/data/97/0xb954a0db33a6351e76e519b4830489531c39d4f0.json \
  hackathon/stack/keeper-fees-97.json ) > "$ETC/approved-97.sha256.new"
( cd "$REL" && sha256sum bounties/flap/deployments/97.json bounties/flap/deployments/97-sale.json bounties/flap/deployments/97-usdt.json \
  bounties/flap/deployments/97-usdt-sale.json bounties/openfour/deployments/97.json ) > "$ETC/approved-launch.sha256.new"
( cd "$REL" && sha256sum packages/contracts/deployments/bnb-testnet/97-atlas.json ) > "$ETC/approved-atlas.sha256.new"
cat "$REL/hackathon/stack/approved-97.sha256" "$REL/hackathon/stack/approved-launch.sha256" "$REL/hackathon/stack/approved-atlas.sha256" \
  | diff - <(cat "$ETC/approved-97.sha256.new" "$ETC/approved-launch.sha256.new" "$ETC/approved-atlas.sha256.new") && echo "SAME: the release holds the approved files"
for f in approved-97 approved-launch approved-atlas; do chmod 0444 "$ETC/$f.sha256.new"; mv "$ETC/$f.sha256.new" "$ETC/$f.sha256"; done
( cd "$REL" && sha256sum --check --strict "$ETC/approved-97.sha256" "$ETC/approved-launch.sha256" "$ETC/approved-atlas.sha256" )

step "4. the signer: its folder (here without records: it must answer 503) and SH_BNB_SIGN=1"
mkdir -m 0750 "$ETC/sign"
printf 'SH_BNB_SIGN=1\n' >> "$ETC/stack.env"

step "5. the dry ship: the transition invocation (the serving release predates the rule)"
SH_BNB_SHIP_FROM_INCOMING=$new bash "$REL/hackathon/stack/ship.sh" "$new" > "$base/morning-ship.log" 2>&1; echo "exit $?"
grep '^ship:' "$base/morning-ship.log" | tail -n 8

step "6. read after it"
basename "$(readlink -f "$SRV/current")"
docker inspect --format '{{.Config.Image}}' sh259-trial-keeper-1
docker exec sh259-trial-keeper-1 cat /tmp/service-health.json
docker logs sh259-trial-keeper-1 2>&1 | head -n 2 || true  # head closes the pipe early
O=https://127-0-0-1.sslip.io:18584; R=(--insecure --resolve 127-0-0-1.sslip.io:18584:127.0.0.1 -sS)
curl "${R[@]}" "$O/v2/feed" | jq -c '{chainId, block: .asOf.block, cards: (.cards | length)}'
curl "${R[@]}" -o /dev/null -w '/launches/ %{http_code}\n' "$O/launches/"
curl "${R[@]}" -w ' %{http_code}\n' "$O/launches/api/four/health"
rf="$O/v2/boxes/97/0x5539280794dd81763afe9dcaf326ef6c52327863/activity?limit=200"
label_types() { curl "${R[@]}" "$rf" | jq -c '[.items[] | select(.kind == "v2_event") | .data.source | type] | group_by(.) | map({(.[0]): length}) | add'; }
echo "Rent Free's activity labels, the rows the old release stored: $(label_types)"

step "6b. the history rewritten (M7b): hackathon/stack/history-rewrite.sh with Rent Free's two rows"
t0=$SECONDS
bash "$SRV/current/hackathon/stack/history-rewrite.sh" \
  --row 0x5539280794dd81763afe9dcaf326ef6c52327863 144768797-4 '{"source":"receiver","arg_source":1}' \
  --row 0x5539280794dd81763afe9dcaf326ef6c52327863 144768699-13 '{"source":"receiver","arg_source":3}' || echo "rehearsal: history-rewrite FAILED"
echo "rehearsal: the history rewrite took $((SECONDS - t0)) s"
echo "Rent Free's activity labels, rewritten: $(label_types)"

step "7. the card pictures"
mkdir -p "$base/cards" && cp -r "$root/examples/boxes/card-shop/test-cards/art/." "$base/cards/"
bash "$SRV/current/hackathon/stack/pictures.sh" "$base/cards" 2>&1 | tail -n 1
NODE_TLS_REJECT_UNAUTHORIZED=0 node "$root/hackathon/stack/test/cards-check.mjs" "$root/examples/boxes/card-shop/test-cards/catalog.json" \
  "$root/packages/contracts/deployments/bnb-testnet/97-cards.json" "$O" 2>&1 | tail -n 1
echo "rehearsal: done"
