#!/usr/bin/env bash
# SH-280: the launch pages with the site's made wallet (Privy's stand-in in the development server), against a LOCAL
# FORK of BSC Testnet as it is (the real factories from public/addresses.json; reads only from the public endpoint).
# The made wallet's address is funded on the fork and sent for by anvil (--auto-impersonate), as Privy's service sends
# a made wallet's transactions. anvil on port 8622 (SH_MADE_FORK_PORT); the page on 5471 (playwright.config.ts).
# usage: scripts/made-wallet-fork.sh [playwright args...]
set -u
cd "$(dirname "$0")/.." || exit 1
PORT=${SH_MADE_FORK_PORT:-8622}
RPC=http://127.0.0.1:$PORT
FORK_URL=${FORK_URL:-https://bsc-testnet-rpc.publicnode.com}
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
PILE_PRIVY_STANDIN=1 PILE_RPC=$RPC npx playwright test --workers=1 e2e/made-wallet.spec.ts "$@"
