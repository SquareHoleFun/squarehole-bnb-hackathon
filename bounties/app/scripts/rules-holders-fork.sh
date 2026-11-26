#!/usr/bin/env bash
# A Flap rules launch that pays the creator's stake (SH-281 step 3): lane f's stake stand (bounties/flap/script/
# stake-stand.sh, a fork of BSC Testnet on port 8622) run in a build copy outside this tree with Flap's repository as its
# library, then the page given the stand's rules pair and stake factory, then e2e/rules-holders.spec.ts and lane m's
# e2e/holders.spec.ts. Nothing is sent to a real network.
# usage: FLAP_LIB=<Flap's repository at the entry's submodule commit> WORK=<a build folder> scripts/rules-holders-fork.sh
set -u
cd "$(dirname "$0")/.." || exit 1
: "${FLAP_LIB:?set FLAP_LIB}" "${WORK:?set WORK}"
rsync -a --delete --exclude lib --exclude out --exclude cache --exclude broadcast --exclude deployments ../flap/ "$WORK/bounties/flap/"
rsync -a --delete --exclude out --exclude cache ../core/ "$WORK/bounties/core/"
mkdir -p "$WORK/bounties/flap/lib" "$WORK/bounties/flap/deployments"
ln -sfn "$FLAP_LIB" "$WORK/bounties/flap/lib/flap-pool-launch"
(cd "$WORK/bounties/flap" && forge build > "$WORK/build-stand.log" 2>&1) || { echo "forge build failed"; tail -5 "$WORK/build-stand.log"; exit 1; }
LOG=$WORK/stand.log
rm -f "$WORK/bounties/flap/deployments/anvil-97-stand.json"
(cd "$WORK/bounties/flap" && PORT=8622 KEEP=1 exec bash script/stake-stand.sh) > "$LOG" 2>&1 &
SPID=$!
for _ in $(seq 1 300); do grep -q "anvil stays up" "$LOG" 2>/dev/null && break; kill -0 "$SPID" 2>/dev/null || break; sleep 2; done
grep -q "anvil stays up" "$LOG" || { echo "the stand did not come up:"; tail -n 20 "$LOG"; kill "$SPID"; exit 1; }
grep -E "distributed|claimed|written" "$LOG"
APID=$(grep -o "anvil [0-9]* up" "$LOG" | awk '{print $2}')
node -e '
const fs = require("fs"), p = require("path");
const [src, stand, rules, out] = process.argv.slice(1);
const a = JSON.parse(fs.readFileSync(src, "utf8"));
const s = JSON.parse(fs.readFileSync(stand, "utf8"));
const r = JSON.parse(fs.readFileSync(rules, "utf8"));
a.rpcUrl = s.rpc; a.rpcUrls = [s.rpc]; a.railStake = s.railStake;
a.flap.rules = { token: { launcherFactory: r.launcherFactory, rulesVaultFactory: r.rulesVaultFactory } };
fs.mkdirSync(p.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(a, null, 2) + "\n");
fs.writeFileSync(p.join(p.dirname(out), "holders.json"), JSON.stringify(s, null, 2) + "\n");
console.log("rules pair", JSON.stringify(a.flap.rules.token), "stake factory", s.railStake.factory, "launcher", s.launcher);
' public/addresses.json "$WORK/bounties/flap/deployments/anvil-97-stand.json" "$WORK/bounties/flap/deployments/anvil-97-stand-rules.json" public/local/addresses.json || { kill "$SPID"; exit 1; }
PILE_RPC=http://127.0.0.1:8622 npx playwright test --workers=1 e2e/rules-holders.spec.ts e2e/holders.spec.ts "$@"
e=$?
# stop the stand this script started (its script and the anvil it reported), by number
kill "$SPID" 2>/dev/null; [ -n "$APID" ] && kill "$APID" 2>/dev/null; wait "$SPID" 2>/dev/null
exit $e
