#!/usr/bin/env bash
# The real run on BSC Testnet: the steps of scripts/steps.sh, in order, stopping at the first step that does not end
# with its expected "OK ..." line. Safe to rerun after a stop: finished steps print "done before" and send nothing; an
# interrupted one is finished from its records (see README.md, "The real run: checklist").
# usage: OPENFOUR_KEYSTORE=<file> OPENFOUR_KEYSTORE_PASSWORD_FILE=<file> scripts/real-run.sh <expected signer address>
set -euo pipefail
cd "$(dirname "$0")/.."
: "${OPENFOUR_KEYSTORE:?set OPENFOUR_KEYSTORE}" "${OPENFOUR_KEYSTORE_PASSWORD_FILE:?set OPENFOUR_KEYSTORE_PASSWORD_FILE}"
EXPECT=${1:?usage: scripts/real-run.sh <expected signer address>}
# A real run, never a rehearsal: the local-fork switch and a loopback endpoint are refused here outright.
if [ -n "${OPENFOUR_LOCAL_FORK+x}" ] || [ -n "${OPENFOUR_OUT_DIR+x}" ]; then echo "stopped: OPENFOUR_LOCAL_FORK or OPENFOUR_OUT_DIR is set: unset it for the real run"; exit 2; fi
export RPC_URL=${RPC_URL:-https://bsc-testnet-rpc.publicnode.com}
case "$RPC_URL" in *127.0.0.1*|*localhost*|*"[::1]"*) echo "stopped: RPC_URL is a loopback address: the real run uses the public endpoint"; exit 2 ;; esac
WBNB=0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd
TETH=0x860822580d4eb2529de0c74c3e2b1d6d7c183302
mkdir -p out
STEP_LOG=out/last-step.log
kit() { node -r ./scripts/signer-preload.js scripts/kit.js "$@" --expect-signer "$EXPECT"; }
pile() { node -r ./scripts/signer-preload.js scripts/pile.js "$@" --expect-signer "$EXPECT"; }
source scripts/steps.sh
# A fresh start (no out/fork-started.json yet) refuses a wallet that holds less than the whole run needs. A rerun after
# a stop is not checked: what was spent is already on chain.
if [ ! -e out/fork-started.json ]; then
  node -e '
const { ethers } = require("ethers");
(async () => {
  const [rpc, who, teth, needB, needT] = process.argv.slice(1);
  const p = new ethers.JsonRpcProvider(rpc);
  const b = await p.getBalance(who);
  const t = await new ethers.Contract(teth, ["function balanceOf(address) view returns (uint256)"], p).balanceOf(who);
  console.log(`wallet ${who}: ${ethers.formatEther(b)} tBNB (the run needs ${needB}), ${ethers.formatEther(t)} tETH (needs ${needT})`);
  if (b < ethers.parseEther(needB) || t < ethers.parseEther(needT)) {
    console.error("stopped: the wallet holds less than the run needs: fund it, then start again");
    process.exit(2);
  }
})().catch((e) => { console.error(`stopped: cannot read the wallet balances: ${e.shortMessage || e.message}`); process.exit(3); });
' "$RPC_URL" "$EXPECT" "$TETH" "$NEED_TBNB" "$NEED_TETH"
fi
npx hardhat compile --quiet
for entry in "${STEPS[@]}"; do
  expect=${entry%%|*}
  [[ "$expect" == REHEARSAL-* ]] && continue
  run_step "$expect" "${entry#*|}"
done
echo "== the real run is complete"
