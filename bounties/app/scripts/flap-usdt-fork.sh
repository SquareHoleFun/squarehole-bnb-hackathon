#!/usr/bin/env bash
# The Flap rail with the TEST TOKEN as the quote, against a LOCAL FORK of BSC Testnet as it is (the real Portal, the
# real test USDT, the real native factories from public/addresses.json). The token-quote factories are deployed in the
# fork with the Flap entry's own DeployToken script (built in a copy outside this tree, with Flap's repository as its
# library), then e2e/flap-usdt.spec.ts runs the whole path from the page: mint the test token, create through
# Portal.newLauncher, buy, sell back, complete, claim, pool trades, the tax into the pile, redeem; it prints the gas of
# every write. anvil on port 8581; its development accounts stand in for the browser wallet. Nothing is sent to a
# real network.
# usage: FLAP_LIB=<Flap's repository at the entry's submodule commit> WORK=<a build folder> scripts/flap-usdt-fork.sh [playwright args...]
set -u
cd "$(dirname "$0")/.." || exit 1
APP=$PWD
: "${FLAP_LIB:?set FLAP_LIB}" "${WORK:?set WORK}"
PORT=${FLAP_FORK_PORT:-8581}
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
echo "fork of chain $(cast chain-id -r "$RPC") at block $(cast block-number -r "$RPC")"
SENDER=$(cast rpc eth_accounts -r "$RPC" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0]))')
DEPLOYMENTS_FILE=deployments/fork-97-usdt.json forge script script/DeployToken.s.sol --rpc-url "$RPC" --sender "$SENDER" --unlocked --broadcast --slow \
  > "$WORK/deploy-usdt.log" 2>&1 || { echo "deploy failed"; tail -n 20 "$WORK/deploy-usdt.log"; exit 1; }

node -e '
const fs = require("fs"), path = require("path");
const [real, usdtFile, rpc, out] = process.argv.slice(1);
const a = JSON.parse(fs.readFileSync(real, "utf8"));
const u = JSON.parse(fs.readFileSync(usdtFile, "utf8"));
a.rpcUrl = rpc; a.rpcUrls = [rpc];
a.flap.tokenQuote = { quote: u.quote, label: "USDT (test)", launcherFactory: u.tokenCurveLauncherFactory, pileVaultFactory: u.tokenPileVaultFactory, sales: [] };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(a, null, 2) + "\n");
console.log("token-quote factory", u.tokenCurveLauncherFactory, "quote", u.quote);
' "$APP/public/addresses.json" "$PWD/deployments/fork-97-usdt.json" "$RPC" "$APP/public/local/addresses.json" || exit 1

cd "$APP" || exit 1
# The whole path, then the races of a pending write (a fresh account each). FLAP_USDT_SPECS names other spec files.
# shellcheck disable=SC2086
PILE_RPC=$RPC npx playwright test --workers=1 ${FLAP_USDT_SPECS:-e2e/flap-usdt.spec.ts e2e/flap-picture.spec.ts e2e/races.spec.ts} "$@"
