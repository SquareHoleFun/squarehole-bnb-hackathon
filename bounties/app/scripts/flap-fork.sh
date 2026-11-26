#!/usr/bin/env bash
# Browser tests of the Flap rail against a LOCAL FORK of BSC Testnet (anvil on port 8581 by default, reads only from the public
# endpoint): builds a copy of the Flap entry (../flap and ../core) with Flap's own repository as its library, deploys
# the two factories with the entry's own Deploy script, creates one short sale for the "missed deadline" case with the
# entry's CreateSale script, writes public/local/addresses.json, runs e2e/flap.spec.ts (one worker, port 5471), and
# stops anvil. Senders are anvil's unlocked development accounts: no key is read.
# usage: FLAP_LIB=<checkout of github.com/flap-sh/FlapPoolLaunchVaultExample at the entry's submodule commit,
#        with its submodules> WORK=<an empty build folder> scripts/flap-fork.sh [playwright args...]
set -u
cd "$(dirname "$0")/.." || exit 1
APP=$PWD
: "${FLAP_LIB:?set FLAP_LIB}" "${WORK:?set WORK}"
PORT=${FLAP_FORK_PORT:-8581}
RPC=http://127.0.0.1:$PORT
FORK_URL=${FORK_URL:-https://bsc-testnet-rpc.publicnode.com}

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
FROM=$(cast block-number -r "$RPC") || { echo "fork did not start"; exit 1; }
SENDER=$(cast rpc eth_accounts -r "$RPC" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0]))')
F="--rpc-url $RPC --sender $SENDER --unlocked --broadcast --slow"
export DEPLOYMENTS_FILE=deployments/fork-97.json
DEPLOYMENTS_FILE=$DEPLOYMENTS_FILE forge script script/Deploy.s.sol $F > "$WORK/deploy.log" 2>&1 || { echo "deploy failed"; tail -n 20 "$WORK/deploy.log"; exit 1; }
SALE_FILE=deployments/fork-97-miss.json NAME="Missed Curve" SYMBOL=MISS DURATION=300 SALT_SEED=miss \
  forge script script/CreateSale.s.sol $F > "$WORK/create-miss.log" 2>&1 || { echo "create failed"; tail -n 20 "$WORK/create-miss.log"; exit 1; }

node -e '
const fs = require("fs");
const [dep, miss, rpc, from, out] = process.argv.slice(1);
const d = JSON.parse(fs.readFileSync(dep, "utf8"));
const m = JSON.parse(fs.readFileSync(miss, "utf8"));
const a = { chainId: 97, rpcUrls: [rpc], explorer: "https://testnet.bscscan.com", fromBlock: from,
  flap: { portal: d.portal, tokenImpl: d.tokenImpl, pileVaultFactory: d.pileVaultFactory,
          curveLauncherFactory: d.curveLauncherFactory, sales: [{ launcher: m.launcher }] } };
fs.mkdirSync(require("path").dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(a, null, 2) + "\n");
console.log("factory", d.curveLauncherFactory, "missed sale", m.launcher, "from block", from);
' "$PWD/deployments/fork-97.json" "$PWD/deployments/fork-97-miss.json" "$RPC" "$FROM" "$APP/public/local/addresses.json" || exit 1

cd "$APP" || exit 1
PILE_RPC=$RPC npx playwright test --workers=1 e2e/flap.spec.ts "$@"
