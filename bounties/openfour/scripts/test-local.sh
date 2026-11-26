#!/usr/bin/env bash
# The tests on a LOCAL fork of BSC Testnet: anvil on port $1 (default 8580), a developer-owned OpenFour copy brought
# up with the kit's own fork-deploy tool through scripts/kit.js (signer: a public test key, local fork only), then
# the Hardhat tests against it (TEST_FILES selects files). Stops anvil on exit. Nothing is sent to a real network.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${1:-8580}
source scripts/local-fork.sh
export OPENFOUR_LOCAL_DEV=1
DEV=$(cast wallet address --mnemonic "test test test test test test test test test test test junk" --mnemonic-index "${OPENFOUR_LOCAL_DEV_INDEX:-4242}")
fund "$DEV"
node -r ./scripts/signer-preload.js scripts/kit.js fork --expect-signer "$DEV" > "$OPENFOUR_OUT_DIR/fork.log" 2>&1 \
  || { tail -n 20 "$OPENFOUR_OUT_DIR/fork.log"; exit 1; }
export FORK_JSON=$OPENFOUR_OUT_DIR/fork-deployment.json
echo "== copy up: registry $(node -e 'console.log(require(process.argv[1]).addresses.registry)' "$PWD/$FORK_JSON")"
npx hardhat test --network localfork ${TEST_FILES:-}
