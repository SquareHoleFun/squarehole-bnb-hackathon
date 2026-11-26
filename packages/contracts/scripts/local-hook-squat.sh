#!/usr/bin/env bash
# Review round B regression on a real anvil chain (chain 31337, port 8591), with the real `forge script --broadcast`:
#
# 1. a --broadcast without git provenance (SH_GIT_COMMIT / SH_GIT_DIRTY) is refused before any transaction is sent;
# 2. a third party (anvil account 9) reads the deployment plan from public data (a simulation as the deployer) and
#    pre-deploys the byte-identical hook through the public CREATE2 deployer at the planned address ("squatting");
# 3. the deployment still runs: it adopts the identical hook (code hash checked), consumes the hook's nonce with a
#    0-value no-op call (`registry.templateCount()` as a transaction), and the launcher lands where the hook expects it;
# 4. the read-only finalizer and verifier accept it (`contracts.hook.adopted` = true), then anvil stops.
#
# Keys: only anvil's PUBLIC default test keys, derived from its well-known mnemonic, on the local chain.
set -euo pipefail

export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."

PORT="${SH_SQUAT_PORT:-8591}"
RPC="http://127.0.0.1:${PORT}"
OUT="${SH_E2E_OUT:-.e2e}/hook-squat"
MNEMONIC="test test test test test test test test test test test junk" # anvil's public default mnemonic
CREATE2_DEPLOYER="0x4e59b44847b379578588920cA78FbF26c0B4956C"
mkdir -p "$OUT"

if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "error: something already answers on $RPC; stop it or set SH_SQUAT_PORT" >&2
  exit 1
fi
anvil --port "$PORT" --chain-id 31337 --mnemonic "$MNEMONIC" --enable-tx-gas-limit >"$OUT/anvil.log" 2>&1 &
ANVIL_PID=$!
cleanup() {
  kill "$ANVIL_PID" 2>/dev/null || true
  wait "$ANVIL_PID" 2>/dev/null || true
}
trap cleanup EXIT
for _ in $(seq 1 100); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.1
done

manifest() { # plain key-path lookup: manifest <file> <dot.separated.keys>
  python3 -c 'import json, sys
d = json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."):
    d = d[key]
print(d)' "$1" "$2"
}

DEPLOYER_KEY="$(cast wallet private-key "$MNEMONIC" 0)"
DEPLOYER="$(cast wallet address --private-key "$DEPLOYER_KEY")"
SQUATTER_KEY="$(cast wallet private-key "$MNEMONIC" 9)"
rm -f deployments/31337.json deployments/pending/31337.json deployments/dry-run/31337.json

echo "== 1/4 a broadcast without git provenance is refused before any transaction"
if env -u SH_GIT_COMMIT -u SH_GIT_DIRTY DEPLOYER_PRIVATE_KEY="$DEPLOYER_KEY" \
  forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --slow >"$OUT/1-no-provenance.log" 2>&1; then
  echo "error: the broadcast ran without provenance" >&2
  exit 1
fi
grep -o "provenance: SH_GIT_COMMIT must be the 40-hex commit[^\"]*" "$OUT/1-no-provenance.log" | head -1
[ "$(cast nonce "$DEPLOYER" --rpc-url "$RPC")" = "0" ] || { echo "error: a transaction was sent" >&2; exit 1; }
echo "deployer nonce still 0"

SH_GIT_COMMIT="$(git rev-parse HEAD)"
SH_GIT_DIRTY="$([ -n "$(git status --porcelain)" ] && echo true || echo false)"
export SH_GIT_COMMIT SH_GIT_DIRTY

echo "== 2/4 squatter: plan from public data (simulation as the deployer), then the identical hook first"
forge script script/Deploy.s.sol --rpc-url "$RPC" --sender "$DEPLOYER" >"$OUT/2-plan.log" 2>&1
PLAN=deployments/dry-run/31337.json
HOOK="$(manifest "$PLAN" contracts.hook.address)"
SALT="$(manifest "$PLAN" contracts.hook.salt)"
ARGS="$(manifest "$PLAN" contracts.hook.constructorArgs)"
INIT="$(forge inspect src/SquareHoleHook.sol:SquareHoleHook bytecode)"
cast send "$CREATE2_DEPLOYER" "${SALT}${INIT#0x}${ARGS#0x}" --private-key "$SQUATTER_KEY" --rpc-url "$RPC" \
  >"$OUT/2-squat.log" 2>&1
echo "squatted hook $HOOK: $(cast codesize "$HOOK" --rpc-url "$RPC") bytes of code, deployed by anvil account 9"

echo "== 3/4 the deployment adopts it (script/Deploy.s.sol --broadcast --slow)"
DEPLOYER_PRIVATE_KEY="$DEPLOYER_KEY" forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --slow \
  >"$OUT/3-deploy.log" 2>&1
grep -E "SQUAREHOLE_DEPLOY (hook|launcher)" "$OUT/3-deploy.log"
grep -q "ONCHAIN EXECUTION COMPLETE & SUCCESSFUL" "$OUT/3-deploy.log" || { echo "error: deployment failed" >&2; exit 1; }
grep -q "SQUAREHOLE_DEPLOY hook adopted true" "$OUT/3-deploy.log" || { echo "error: hook not adopted" >&2; exit 1; }
echo "deployer nonce $(cast nonce "$DEPLOYER" --rpc-url "$RPC") (17 = the same plan as without the squat)"

echo "== 4/4 finalize and verify (read-only)"
forge script script/WriteManifest.s.sol --rpc-url "$RPC" >"$OUT/4-finalize.log" 2>&1
forge script script/VerifyManifest.s.sol --rpc-url "$RPC" >>"$OUT/4-finalize.log" 2>&1
grep -q "SQUAREHOLE_VERIFY OK" "$OUT/4-finalize.log" || { echo "error: finalize/verify failed" >&2; exit 1; }
[ "$(manifest deployments/31337.json contracts.hook.adopted)" = "True" ] || { echo "error: manifest" >&2; exit 1; }
[ "$(manifest deployments/31337.json contracts.hook.address)" = "$HOOK" ] || { echo "error: hook address" >&2; exit 1; }
echo "manifest: status $(manifest deployments/31337.json status), hook adopted $(manifest deployments/31337.json contracts.hook.adopted), blocks $(manifest deployments/31337.json startBlock)-$(manifest deployments/31337.json endBlock)"
rm -f deployments/31337.json # this run's manifest describes the squat test chain, not the E2E one
echo "HOOK SQUAT OK (logs in $OUT/)"
