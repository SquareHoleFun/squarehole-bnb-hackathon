#!/usr/bin/env bash
# Browser tests against a local chain: builds the test contracts, starts anvil (port 8581, chain id 97 so the page
# reads it as BSC Testnet), seeds it, runs Playwright (one worker, port 5471), stops anvil.
# usage: scripts/e2e-local.sh [playwright args...]
set -u
cd "$(dirname "$0")/.." || exit 1
PORT=${PILE_CHAIN_PORT:-8581}
(cd e2e/chain && forge build --offline > /dev/null) || { echo "forge build failed"; exit 1; }
anvil --port "$PORT" --chain-id 97 --silent &
APID=$!
trap 'kill "$APID" 2>/dev/null; wait "$APID" 2>/dev/null' EXIT
for _ in $(seq 1 30); do cast block-number -r "http://127.0.0.1:$PORT" > /dev/null 2>&1 && break; sleep 1; done
node scripts/seed-local.mjs "http://127.0.0.1:$PORT" || exit 1
PILE_RPC="http://127.0.0.1:$PORT" npx playwright test --workers=1 e2e/pile.spec.ts "$@"
