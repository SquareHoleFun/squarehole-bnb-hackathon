#!/usr/bin/env bash
# The Flap rail with the creator's RULES (SH-287), against a LOCAL FORK of BSC Testnet as it is (the real Portal, the
# real test USDT, the real native factories from public/addresses.json). In the fork: the token-quote pair (the Flap
# entry's DeployToken script) and both rules pairs (its DeployRules script, VARIANT=usdt and native), built in a copy
# outside this tree with Flap's repository as its library. Then e2e/flap-rules.spec.ts: launches with rules through
# both ways, a share-out and its three effects read on the page. anvil on port 8582; its development accounts stand in
# for the browser wallet. Nothing is sent to a real network.
# usage: FLAP_LIB=<Flap's repository at the entry's submodule commit> WORK=<a build folder> scripts/flap-rules-fork.sh [playwright args...]
set -u
cd "$(dirname "$0")/.." || exit 1
APP=$PWD
: "${FLAP_LIB:?set FLAP_LIB}" "${WORK:?set WORK}"
PORT=${FLAP_RULES_PORT:-8582}
RPC=http://127.0.0.1:$PORT
FORK_URL=${FORK_URL:-https://bsc-testnet-rpc.publicnode.com}
node scripts/make-addresses.mjs --check || exit 1

mkdir -p "$WORK/bounties"
rsync -a --delete --exclude lib --exclude out --exclude cache --exclude broadcast --exclude deployments ../flap/ "$WORK/bounties/flap/"
rsync -a --delete --exclude out --exclude cache ../core/ "$WORK/bounties/core/"
mkdir -p "$WORK/bounties/flap/lib" "$WORK/bounties/flap/deployments"
ln -sfn "$FLAP_LIB" "$WORK/bounties/flap/lib/flap-pool-launch"
cd "$WORK/bounties/flap" || exit 1
forge build > "$WORK/build.log" 2>&1 || { echo "forge build failed"; tail -n 20 "$WORK/build.log"; exit 1; }

anvil --port "$PORT" --fork-url "$FORK_URL" --auto-impersonate --silent &
APID=$!
trap 'kill "$APID" 2>/dev/null; wait "$APID" 2>/dev/null' EXIT
for _ in $(seq 1 60); do cast block-number -r "$RPC" > /dev/null 2>&1 && break; sleep 1; done
kill -0 "$APID" 2>/dev/null || { echo "the anvil this script started is not running (port taken?)"; exit 1; }
echo "fork of chain $(cast chain-id -r "$RPC") at block $(cast block-number -r "$RPC")"
SENDER=$(cast rpc eth_accounts -r "$RPC" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0]))')
DEPLOYMENTS_FILE=deployments/fork-97-usdt.json forge script script/DeployToken.s.sol --rpc-url "$RPC" --sender "$SENDER" --unlocked --broadcast --slow \
  > "$WORK/deploy-usdt.log" 2>&1 || { echo "deploy failed"; tail -n 20 "$WORK/deploy-usdt.log"; exit 1; }
for v in usdt native; do
  VARIANT=$v DEPLOYMENTS_FILE=deployments/fork-97-rules-$v.json forge script script/DeployRules.s.sol --rpc-url "$RPC" --sender "$SENDER" --unlocked --broadcast --slow \
    > "$WORK/deploy-rules-$v.log" 2>&1 || { echo "rules deploy ($v) failed"; tail -n 20 "$WORK/deploy-rules-$v.log"; exit 1; }
done

node -e '
const fs = require("fs"), path = require("path");
const [real, usdtFile, rulesU, rulesN, rpc, out] = process.argv.slice(1);
const a = JSON.parse(fs.readFileSync(real, "utf8"));
const u = JSON.parse(fs.readFileSync(usdtFile, "utf8"));
const ru = JSON.parse(fs.readFileSync(rulesU, "utf8")), rn = JSON.parse(fs.readFileSync(rulesN, "utf8"));
a.rpcUrl = rpc; a.rpcUrls = [rpc];
a.flap.tokenQuote = { quote: u.quote, label: "USDT (test)", launcherFactory: u.tokenCurveLauncherFactory, pileVaultFactory: u.tokenPileVaultFactory, sales: [] };
a.flap.rules = {
  token: { launcherFactory: ru.launcherFactory, rulesVaultFactory: ru.rulesVaultFactory },
  native: { launcherFactory: rn.launcherFactory, rulesVaultFactory: rn.rulesVaultFactory },
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(a, null, 2) + "\n");
console.log("rules pairs: token", JSON.stringify(a.flap.rules.token), "native", JSON.stringify(a.flap.rules.native));
' "$APP/public/addresses.json" "$PWD/deployments/fork-97-usdt.json" "$PWD/deployments/fork-97-rules-usdt.json" "$PWD/deployments/fork-97-rules-native.json" "$RPC" "$APP/public/local/addresses.json" || exit 1

cd "$APP" || exit 1
# FLAP_RULES_SPECS names other spec files.
# shellcheck disable=SC2086
PILE_RPC=$RPC npx playwright test --workers=1 ${FLAP_RULES_SPECS:-e2e/flap-rules.spec.ts} "$@"
