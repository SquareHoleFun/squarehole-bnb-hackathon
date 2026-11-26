#!/usr/bin/env bash
# Usage: script/fork-test.sh [forge test arguments]
# Runs the flap fork tests against an anvil fork of the BNB test network on port 8578, then stops that anvil.
cd "$(dirname "$0")/.." || exit 1
anvil --port 8578 --fork-url https://bsc-testnet-rpc.publicnode.com --silent &
APID=$!
for i in $(seq 1 30); do cast block-number -r http://127.0.0.1:8578 >/dev/null 2>&1 && break; sleep 1; done
echo "anvil $APID up at block $(cast block-number -r http://127.0.0.1:8578)"
FORK_URL=http://127.0.0.1:8578 forge test --match-path "test/*.fork.t.sol" -vv "$@"
e=$?
kill "$APID"
wait "$APID" 2>/dev/null
echo "done exit=$e"
exit "$e"
