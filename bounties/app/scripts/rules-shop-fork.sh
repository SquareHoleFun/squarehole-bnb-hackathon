#!/usr/bin/env bash
# A Flap rules launch whose rules pay a card shop (SH-281 step 3): lane e's rehearsal (bounties/flap/script/
# rehearse-shop.sh, a fork of BSC Testnet on port 8598: the shop factory, the rules pair, the launch with a shop in its
# rules, bought, completed, claimed) run in a build copy outside this tree with Flap's repository as its library, kept
# up at its end (the copy's last line waits instead of stopping), then the page given the stand's rules pair and shop
# factory, then e2e/rules-shop.spec.ts. Nothing is sent to a real network.
# usage: FLAP_LIB=<Flap's repository at the entry's submodule commit> WORK=<a build folder> scripts/rules-shop-fork.sh
set -u
cd "$(dirname "$0")/.." || exit 1
: "${FLAP_LIB:?set FLAP_LIB}" "${WORK:?set WORK}"
PORT=8598
mkdir -p "$WORK/bounties"
rsync -a --delete --exclude lib --exclude out --exclude cache --exclude broadcast --exclude deployments ../flap/ "$WORK/bounties/flap/"
rsync -a --delete --exclude out --exclude cache --exclude broadcast --exclude deployments ../core/ "$WORK/bounties/core/"
mkdir -p "$WORK/bounties/flap/lib" "$WORK/bounties/flap/deployments" "$WORK/bounties/core/deployments"
ln -sfn "$FLAP_LIB" "$WORK/bounties/flap/lib/flap-pool-launch"
F=$WORK/bounties/flap
# the rehearsal, kept up: its closing "stop 0" becomes a record of the stand and a wait on its anvil
node -e '
const fs = require("fs");
const [src, out] = process.argv.slice(1);
let s = fs.readFileSync(src, "utf8");
const end = s.lastIndexOf("stop 0");
if (end < 0) throw new Error("the rehearsal has no closing stop 0");
s = s.slice(0, end) + `echo "{\\"rpc\\": \\"$RPC\\", \\"launcher\\": \\"$L\\", \\"shop\\": \\"$SHOP\\", \\"token\\": \\"$TOKEN\\", \\"factory\\": \\"$FACTORY\\", \\"creator\\": \\"$DEPLOYER\\"}" > deployments/anvil-97-shop-stand.json
echo "anvil stays up on $RPC"
wait "$APID"
` + s.slice(end + "stop 0".length);
fs.writeFileSync(out, s);
' "$F/script/rehearse-shop.sh" "$F/script/rehearse-shop-kept.sh" || exit 1
LOG=$WORK/shop-stand.log
rm -f "$F/deployments/anvil-97-shop-stand.json"
# the core build reads forge-std through the flap library, which lives outside the copy here: allow it by path
(cd "$F" && FOUNDRY_ALLOW_PATHS="[\"$(readlink -f "$FLAP_LIB")\",\"$WORK/bounties/flap\"]" PORT=$PORT exec bash script/rehearse-shop-kept.sh) > "$LOG" 2>&1 &
SPID=$!
for _ in $(seq 1 400); do grep -q "anvil stays up" "$LOG" 2>/dev/null && break; kill -0 "$SPID" 2>/dev/null || break; sleep 2; done
grep -q "anvil stays up" "$LOG" || { echo "the stand did not come up:"; tail -n 20 "$LOG"; kill "$SPID" 2>/dev/null; exit 1; }
grep -E "the shop is|rule 2|written" "$LOG"
APID=$(grep -o "anvil [0-9]* up" "$LOG" | awk '{print $2}')
node -e '
const fs = require("fs"), p = require("path");
const [src, stand, rules, out] = process.argv.slice(1);
const a = JSON.parse(fs.readFileSync(src, "utf8"));
const s = JSON.parse(fs.readFileSync(stand, "utf8"));
const r = JSON.parse(fs.readFileSync(rules, "utf8"));
a.rpcUrl = s.rpc; a.rpcUrls = [s.rpc]; a.shops = { factory: s.factory };
a.flap.rules = { token: { launcherFactory: r.launcherFactory, rulesVaultFactory: r.rulesVaultFactory } };
fs.mkdirSync(p.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(a, null, 2) + "\n");
fs.writeFileSync(p.join(p.dirname(out), "shop-stand.json"), JSON.stringify(s, null, 2) + "\n");
console.log("rules pair", JSON.stringify(a.flap.rules.token), "shop factory", s.factory, "launcher", s.launcher, "shop", s.shop);
' public/addresses.json "$F/deployments/anvil-97-shop-stand.json" "$F/deployments/anvil-97-rules-usdt.json" public/local/addresses.json || { kill "$SPID"; exit 1; }
PILE_RPC=http://127.0.0.1:$PORT npx playwright test --workers=1 e2e/rules-shop.spec.ts "$@"
e=$?
# stop the stand this script started (its script and the anvil it reported), by number
kill "$SPID" 2>/dev/null; [ -n "$APID" ] && kill "$APID" 2>/dev/null; wait "$SPID" 2>/dev/null
exit $e
