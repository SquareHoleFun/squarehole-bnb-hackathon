#!/usr/bin/env bash
# The Flap rail against a LOCAL FORK of BSC Testnet AS IT IS: the REAL factories and the real first sale (from
# public/addresses.json, which scripts/make-addresses.mjs writes from the entry's deployment files). Nothing is
# deployed: the page creates a new sale through Portal.newLauncher, buys, launches, claims, trades on the pool, sends
# the tax to the pile and redeems (e2e/flap.spec.ts with FLAP_REAL=1), then prints the gas of every write. anvil on
# port 8581 (reads only from the public endpoint); its development accounts stand in for the browser wallet.
# usage: scripts/flap-real-fork.sh [playwright args...]
set -u
cd "$(dirname "$0")/.." || exit 1
PORT=${FLAP_FORK_PORT:-8581}
RPC=http://127.0.0.1:$PORT
FORK_URL=${FORK_URL:-https://bsc-testnet-rpc.publicnode.com}
node scripts/make-addresses.mjs --check || exit 1
anvil --port "$PORT" --fork-url "$FORK_URL" --auto-impersonate --silent &
APID=$!
trap 'kill "$APID" 2>/dev/null; wait "$APID" 2>/dev/null' EXIT
for _ in $(seq 1 60); do cast block-number -r "$RPC" > /dev/null 2>&1 && break; sleep 1; done
echo "fork of chain $(cast chain-id -r "$RPC") at block $(cast block-number -r "$RPC")"
node -e '
const fs = require("fs");
const [src, rpc, out] = process.argv.slice(1);
const a = JSON.parse(fs.readFileSync(src, "utf8"));
a.rpcUrl = rpc; a.rpcUrls = [rpc];
fs.mkdirSync(require("path").dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(a, null, 2) + "\n");
' public/addresses.json "$RPC" public/local/addresses.json || exit 1
FLAP_REAL=1 PILE_RPC=$RPC npx playwright test --workers=1 e2e/flap.spec.ts "$@"
