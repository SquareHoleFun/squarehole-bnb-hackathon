#!/usr/bin/env bash
# The ship's failure drills, on the trial (hackathon/stack/test/trial.sh up <label> first), never on the serving stack
# (SH-259 review points 2, 4 and 8; re-read points 4, 5, 7 and 12). Every ship is started the way the runbook says,
# from the SERVING release's script. The second release is a copy under another commit label, so its images carry
# another tag; after each drill the trial must serve exactly the first release: the pointer, the gateway and the site,
# the indexer's and the web's images, and exactly one keeper of the first release's image in the mode keeper.env names.
#   bash hackathon/stack/test/drills.sh <label of the running trial release>
set -euo pipefail
label=${1:?label of the running trial release}
base="$HOME/bnb-trial"
srv="$base/srv"
project=sh259-trial
export SH_BNB_PROJECT=$project SH_BNB_ETC="$base/etc" SH_BNB_HEALTH_SECONDS=120
ship="$srv/current/hackathon/stack/ship.sh"
mode=$(sed -n 's/^SH_SERVICE_MODE=//p' "$base/etc/keeper.env" | tail -n 1)
[ "$(basename "$(readlink -f "$srv/current")")" = "$label" ] || { echo "drills: the trial does not serve $label" >&2; exit 2; }
results=()
note() { results+=("$1"); printf 'drills: %s\n' "$1"; }
image_of() { # image_of <service>: the image of its one running container, or "count=<n>"
  local ids; ids=$(docker ps --quiet --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$1")
  if [ "$(printf '%s\n' "$ids" | grep -c .)" != 1 ]; then echo "count=$(printf '%s\n' "$ids" | grep -c .)"; return; fi
  docker inspect --format '{{.Config.Image}}' "$ids"
}
keeper_mode() {
  local ids; ids=$(docker ps --quiet --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=keeper")
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$ids" 2>/dev/null | sed -n 's/^SH_SERVICE_MODE=//p'
}
serving() { # serving <label>: exactly that release serves, with exactly one keeper of it in the settings' mode
  local why=
  [ "$(basename "$(readlink -f "$srv/current")")" = "$1" ] || why="pointer"
  [ "$(curl -fsS --max-time 5 http://127.0.0.1:18582/healthz | jq -r .following)" = true ] || why="$why gateway"
  curl -fsS -o /dev/null --max-time 8 --insecure --resolve 127-0-0-1.sslip.io:18584:127.0.0.1 https://127-0-0-1.sslip.io:18584/ || why="$why site"
  for svc in indexer web keeper; do [ "$(image_of "$svc")" = "squarehole-bnb-$svc:$1" ] || why="$why $svc=$(image_of "$svc")"; done
  [ "$(keeper_mode)" = "$mode" ] || why="$why keeper-mode=$(keeper_mode)"
  # The keeper's own health record (what the ship reads): ok, in the settings' mode, fresh.
  local ids record
  ids=$(docker ps --quiet --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=keeper")
  record=$(docker exec "$ids" cat /tmp/service-health.json 2>/dev/null || true)
  jq -e --arg m "$mode" '(now * 1000) as $t | .service == "keeper" and .status == "ok" and .mode == $m and .at <= $t and ($t - .at) < 300000' \
    <<<"$record" >/dev/null 2>&1 || why="$why keeper-record=${record:-none}"
  [ -z "$why" ] || { printf 'drills: not serving %s:%s\n' "$1" "$why"; return 1; }
}
second=$(printf '%s' "$label" | sed 's/.$/f/')
[ "$second" != "$label" ] || second=$(printf '%s' "$label" | sed 's/.$/e/')
if [ ! -d "$srv/releases/$second" ]; then cp -a "$srv/releases/$label" "$srv/releases/$second"; fi
serving "$label" || { echo "drills: the trial is not in its starting state" >&2; exit 2; }

# 1. A candidate that fails its check: refused before promotion.
if SH_BNB_DRILL=candidate-fails bash "$ship" "$second" > "$base/drill1.log" 2>&1; then note "1 FAIL: the ship succeeded"
elif grep -q 'the serving release is unchanged' "$base/drill1.log" && serving "$label"; then note "1 PASS: candidate refused; $label serves, one keeper ($mode)"
else note "1 FAIL: $(tail -n 1 "$base/drill1.log")"; fi

# 2. A promotion that fails its check: the previous release, verified, with its keeper.
if SH_BNB_DRILL=promotion-fails bash "$ship" "$second" > "$base/drill2.log" 2>&1; then note "2 FAIL: the ship succeeded"
elif grep -q "the previous release $label serves again, verified" "$base/drill2.log" && serving "$label"; then
  note "2 PASS: promotion failed; $label serves again, one keeper ($mode)"
else note "2 FAIL: $(tail -n 1 "$base/drill2.log")"; fi

# 3. Two ships at once: the second refuses while the first holds the lock; the first's own result is the drill's.
SH_BNB_DRILL=candidate-fails bash "$ship" "$second" > "$base/drill3a.log" 2>&1 &
first=$!
sleep 3
if bash "$ship" "$second" > "$base/drill3b.log" 2>&1; then note "3 FAIL: the second ship ran"
elif grep -q 'another ship is running on' "$base/drill3b.log"; then
  if wait "$first"; then note "3 FAIL: the first ship succeeded"
  elif grep -q 'the serving release is unchanged' "$base/drill3a.log" && serving "$label"; then note "3 PASS: the second ship refused; $label serves"
  else note "3 FAIL: first ship: $(tail -n 1 "$base/drill3a.log")"; fi
else note "3 FAIL: $(tail -n 1 "$base/drill3b.log")"; wait "$first" || true; fi

# 4. A rehearsal manifest dressed with a real block, in the release itself: refused at the digests in the settings.
block=$(curl -fsS --max-time 20 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["finalized",false]}' https://bsc-testnet-rpc.publicnode.com)
target="$srv/releases/$second/packages/contracts/deployments/core-v1/97.json"
cp "$target" "$base/97.json.kept"
jq --arg n "$(( $(jq -r .result.number <<<"$block") ))" --arg h "$(jq -r .result.hash <<<"$block")" \
  '.evidence.block = {number: $n, hash: $h}' "$srv/releases/$second/hackathon/rehearsals/fork-real-97/core-v1/97.json" > "$target"
if bash "$ship" "$second" > "$base/drill4.log" 2>&1; then note "4 FAIL: the ship succeeded"
elif grep -q "are not exactly the approved ones ($base/etc/approved-97.sha256)" "$base/drill4.log" && serving "$label"; then
  note "4 PASS: the dressed rehearsal was refused at the settings' digests; $label serves"
else note "4 FAIL: $(tail -n 1 "$base/drill4.log")"; fi
cp "$base/97.json.kept" "$target"

# 5. A keeper whose own start check refuses (a wrong registry in the new release's derived settings): the ship rolls
#    back through the pointer switch, and the previous release's keeper runs again, verified.
if SH_BNB_DRILL=keeper-fails bash "$ship" "$second" > "$base/drill5.log" 2>&1; then note "5 FAIL: the ship succeeded"
elif grep -q "start refused: the registry is not the manifest's" "$base/drill5.log" \
  && grep -q "the previous release $label serves again, verified" "$base/drill5.log" && serving "$label"; then
  note "5 PASS: the new keeper refused its start (the registry is not the manifest's); $label serves again, one keeper ($mode)"
else note "5 FAIL: $(tail -n 1 "$base/drill5.log")"; fi

# 6. The incoming release's own script, and a ship of the serving commit: each refused before anything, on its own.
rm -f "$base/drill6a.log" "$base/drill6b.log"
six=PASS
if bash "$srv/releases/$second/hackathon/stack/ship.sh" "$second" > "$base/drill6a.log" 2>&1; then six="FAIL: the incoming script ran"
elif ! grep -q "run the serving release's script" "$base/drill6a.log"; then six="FAIL: $(tail -n 1 "$base/drill6a.log")"; fi
if bash "$ship" "$label" > "$base/drill6b.log" 2>&1; then six="FAIL: the serving commit was shipped again"
elif ! grep -q "already serves; a ship of the serving commit is refused" "$base/drill6b.log"; then six="FAIL: $(tail -n 1 "$base/drill6b.log")"; fi
serving "$label" || six="FAIL: $label does not serve afterwards"
if [ "$six" = PASS ]; then note "6 PASS: the incoming script and a re-ship of $label refused; $label serves"; else note "6 $six"; fi

# 7. keeper.env switched to live while the serving keeper is dry: refused before anything (a ship never changes the
#    keeper's mode; going live is its own step after a dry ship).
cp "$base/etc/keeper.env" "$base/keeper.env.kept"
sed -i 's/^SH_SERVICE_MODE=.*/SH_SERVICE_MODE=live/' "$base/etc/keeper.env"
if bash "$ship" "$second" > "$base/drill7.log" 2>&1; then note "7 FAIL: the ship ran"
elif grep -q "the serving keeper is $mode but keeper.env says live: a ship never changes the keeper's mode; nothing changed" "$base/drill7.log"; then
  cp "$base/keeper.env.kept" "$base/etc/keeper.env"
  if serving "$label"; then note "7 PASS: a mode change in a ship refused; $label serves, its keeper $mode"; else note "7 FAIL: $label does not serve"; fi
else note "7 FAIL: $(tail -n 1 "$base/drill7.log")"; fi
cp "$base/keeper.env.kept" "$base/etc/keeper.env"

printf '%s\n' "${results[@]}" | grep -q FAIL && exit 1
echo "drills: all seven passed"
