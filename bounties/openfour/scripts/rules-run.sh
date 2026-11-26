#!/usr/bin/env bash
# SH-287 on BSC Testnet: the rules launch (scripts/rules-steps.sh) on the real run's copy, from the real run's out/,
# in order, stopping at the first step that does not end with its expected "OK ..." line (rerun to finish: done steps
# send nothing). scripts/check-real.js runs before the first step and after the handover back to the service's key.
# The handover window (DARK in rules-steps.sh) runs back to back and its length is printed.
# usage: OPENFOUR_KEYSTORE=<run wallet keystore> OPENFOUR_KEYSTORE_PASSWORD_FILE=<its password file>
#        SERVICE_KEYSTORE=<the signing service's keystore> SERVICE_PASSWORD_FILE=<its password file>
#        CHECK_LOG=<the real run's log> scripts/rules-run.sh <run wallet address>
# Dry: OPENFOUR_DRY=1 with the same settings builds and simulates the next transaction of the first unfinished step,
# sends nothing, writes nothing, and ends with "DRY <operation>".
set -euo pipefail
cd "$(dirname "$0")/.."
: "${OPENFOUR_KEYSTORE:?set OPENFOUR_KEYSTORE}" "${OPENFOUR_KEYSTORE_PASSWORD_FILE:?set OPENFOUR_KEYSTORE_PASSWORD_FILE}"
: "${SERVICE_KEYSTORE:?set SERVICE_KEYSTORE}" "${SERVICE_PASSWORD_FILE:?set SERVICE_PASSWORD_FILE}" "${CHECK_LOG:?set CHECK_LOG (the real run log)}"
EXPECT=${1:?usage: scripts/rules-run.sh <run wallet address>}
if [ -n "${OPENFOUR_LOCAL_FORK+x}" ] || [ -n "${OPENFOUR_OUT_DIR+x}" ]; then echo "stopped: OPENFOUR_LOCAL_FORK or OPENFOUR_OUT_DIR is set: unset it for the real run"; exit 2; fi
export RPC_URL=${RPC_URL:-https://bsc-testnet-rpc.publicnode.com}
case "$RPC_URL" in *127.0.0.1*|*localhost*|*"[::1]"*) echo "stopped: RPC_URL is a loopback address: the real run uses the public endpoint"; exit 2 ;; esac
[ -e out/fork-deployment.json ] || { echo "stopped: no out/fork-deployment.json: run this in the real run's folder"; exit 2; }
WBNB=0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd
STEP_LOG=out/last-step.log
pile() { node -r ./scripts/signer-preload.js scripts/pile.js "$@" --expect-signer "$EXPECT"; }
source scripts/steps.sh
source scripts/rules-steps.sh
npx hardhat compile --quiet
if [ "${OPENFOUR_DRY:-}" = 1 ]; then
  for entry in "${STEPS_RULES[@]}"; do
    echo "== DRY: ${entry#*|}"
    out=$(eval "${entry#*|}" 2>&1) || { echo "$out"; exit 1; }
    echo "$out"
    case "$(tail -n 1 <<< "$out")" in DRY\ *) echo "== dry run ends at the first transaction to send"; exit 0 ;; esac
  done
  echo "== dry run: every step is done; nothing to send"
  exit 0
fi
node scripts/check-real.js out "$CHECK_LOG"
real_check() { [ "$1" = window ] || node scripts/check-real.js out "$CHECK_LOG"; } # nothing extra inside the window
run_rules real_check
echo "== the rules run is complete. Only now: the signing service may start with taxRules: true (sign/README.md, the ship order)"
