#!/usr/bin/env bash
# STEP 1 proof: the OpenFour kit, unchanged, on a LOCAL fork of BSC Testnet: a developer-owned copy brought up with
# the kit's fork-deploy tool, then the kit's own smoke script creates and trades its example presets; the
# transactions and gas of each stage are printed. Every transaction goes to the local anvil only.
# usage: scripts/kit-smoke-local.sh [port]      (default 8580)
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${1:-8580}
source scripts/local-fork.sh
export OPENFOUR_LOCAL_DEV=1
DEV=$(cast wallet address --mnemonic "test test test test test test test test test test test junk" --mnemonic-index "${OPENFOUR_LOCAL_DEV_INDEX:-4242}")
fund "$DEV"
B0=$(cast block-number --rpc-url "$RPC")
echo "== fork-deploy (the kit's fork-from-chain.js through scripts/kit.js)"
node -r ./scripts/signer-preload.js scripts/kit.js fork --expect-signer "$DEV"
echo "== fork-deploy cost: $(gas_since "$B0" "$(cast block-number --rpc-url "$RPC")")"
for P in ${SMOKE_PRESETS:-bondingV1 bondingTaxV1}; do
  B2=$(cast block-number --rpc-url "$RPC")
  echo "== create-test-preset PRESET=$P SELL=1 (the kit's smoke script)"
  PRESET=$P SELL=1 node -r ./scripts/signer-preload.js scripts/kit.js create-test-preset --expect-signer "$DEV"
  echo "== create-test-preset $P cost: $(gas_since "$B2" "$(cast block-number --rpc-url "$RPC")")"
done
echo "== done"
