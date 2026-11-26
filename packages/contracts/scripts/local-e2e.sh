#!/usr/bin/env bash
# SH-B2 Build B item 9, SH-E plan (F10): local end-to-end run of the Square Hole stack on anvil (chain 31337, port
# $SH_E2E_PORT, default 8546).
#
# 1. starts anvil (EIP-7825 per-transaction gas cap enabled, anvil's public default accounts),
# 2. script/Deploy.s.sol --broadcast --slow: Uniswap v4 PoolManager from the pinned source (local only), local
#    WETH/USDC, mock USDT, the Square Hole system, templates, The Misfits (T = FIT, 10,000 NFTs, WETH, R = Q), the FIT
#    template and ORCHARD (1,000 NFTs, quote FIT, R = T); forge's local execution writes only the plan
#    deployments/pending/31337.json,
# 3. script/WriteManifest.s.sol (read-only finalizer): checks the broadcast receipts and the plan against the chain and
#    writes deployments/31337.json; script/VerifyManifest.s.sol re-checks it (the same steps as Stage E),
# 4. script/LocalE2E.s.sol --broadcast: the external swap harness and every trade / fee / burn / claim step,
# 5. script/LocalE2EReport.s.sol (read-only): the reconciliation report against live chain state,
# 6. independent `cast` reads, then stops anvil (also on failure).
#
# Keys: only anvil's PUBLIC default test keys, derived from its well-known mnemonic, on the local chain. Nothing is
# sent to any other network. Logs: $SH_E2E_OUT (default .e2e/, gitignored).
set -euo pipefail

export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."

PORT="${SH_E2E_PORT:-8546}"
RPC="http://127.0.0.1:${PORT}"
OUT="${SH_E2E_OUT:-.e2e}"
MNEMONIC="test test test test test test test test test test test junk" # anvil's public default mnemonic
mkdir -p "$OUT"

if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "error: something already answers on $RPC; stop it or set SH_E2E_PORT" >&2
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
[ "$(cast chain-id --rpc-url "$RPC")" = "31337" ] || { echo "error: anvil did not start" >&2; exit 1; }
echo "anvil $(anvil --version | head -1) on $RPC (pid $ANVIL_PID), block $(cast block-number --rpc-url "$RPC")"

# anvil default account 0 is the deployer, registry admin and treasury of the local deployment.
DEPLOYER_PRIVATE_KEY="$(cast wallet private-key "$MNEMONIC" 0)"
export DEPLOYER_PRIVATE_KEY
# The trades, the report and the cast reads below cover both launches, so ORCHARD is always on here (whatever
# launches.ORCHARD.enabled in 31337.json or an inherited SH_LAUNCH_ORCHARD says).
export SH_LAUNCH_ORCHARD=true
# Git provenance of the whole worktree (a dirty tree is allowed on the local chain and recorded as such).
SH_GIT_COMMIT="$(git rev-parse HEAD)"
SH_GIT_DIRTY="$([ -n "$(git status --porcelain)" ] && echo true || echo false)"
export SH_GIT_COMMIT SH_GIT_DIRTY
echo "git $SH_GIT_COMMIT dirty=$SH_GIT_DIRTY"
rm -f deployments/31337.json deployments/pending/31337.json

echo "== 1/5 deploy (script/Deploy.s.sol --broadcast --slow; writes only the plan deployments/pending/31337.json)"
forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --slow 2>&1 | tee "$OUT/1-deploy.log" \
  | grep -E "SQUAREHOLE_DEPLOY|Script ran successfully|ONCHAIN EXECUTION COMPLETE|Total Paid|Error|error" || true
grep -q "ONCHAIN EXECUTION COMPLETE & SUCCESSFUL" "$OUT/1-deploy.log" || { echo "error: deployment failed" >&2; exit 1; }
unset DEPLOYER_PRIVATE_KEY

echo "== 2/5 finalize (script/WriteManifest.s.sol, read-only) and verify (script/VerifyManifest.s.sol, read-only)"
forge script script/WriteManifest.s.sol --rpc-url "$RPC" 2>&1 | tee "$OUT/2-finalize.log" | grep -E "SQUAREHOLE_|Error|error" || true
[ -f deployments/31337.json ] || { echo "error: the finalizer wrote no manifest" >&2; exit 1; }
forge script script/VerifyManifest.s.sol --rpc-url "$RPC" 2>&1 | tee -a "$OUT/2-finalize.log" | grep -E "SQUAREHOLE_|Error|error" || true
grep -q "SQUAREHOLE_VERIFY OK" "$OUT/2-finalize.log" || { echo "error: manifest verification failed" >&2; exit 1; }

echo "== 3/5 external-style trades, fees, burns and claims (script/LocalE2E.s.sol --broadcast)"
forge script script/LocalE2E.s.sol --rpc-url "$RPC" --broadcast --slow 2>&1 | tee "$OUT/3-trades.log" \
  | grep -E "^  [0-9]{2} |^    |E2E harness|ONCHAIN EXECUTION COMPLETE|Total Paid|Error|error" || true
grep -q "ONCHAIN EXECUTION COMPLETE & SUCCESSFUL" "$OUT/3-trades.log" || { echo "error: trades failed" >&2; exit 1; }

echo "== 4/5 reconciliation report (script/LocalE2EReport.s.sol, read-only)"
forge script script/LocalE2EReport.s.sol --rpc-url "$RPC" 2>&1 | tee "$OUT/4-report.log" | sed -n '/== Logs ==/,$p'
grep -q "RECONCILIATION OK" "$OUT/4-report.log" || { echo "error: reconciliation failed" >&2; exit 1; }

echo "== 5/5 independent cast reads"
# Plain key-path lookup in the manifest (dot-separated keys; no evaluation of the argument).
manifest() {
  python3 -c 'import json, sys
d = json.load(open("deployments/31337.json"))
for key in sys.argv[1].split("."):
    d = d[key]
print(d)' "$1"
}
REGISTRY="$(manifest contracts.registry.address)"
MISFITS="$(manifest launches.THE_MISFITS.contracts.token.address)"
MIRROR="$(manifest launches.THE_MISFITS.contracts.mirror.address)"
ORCHARD="$(manifest launches.ORCHARD.contracts.token.address)"
ORCHARD_MIRROR="$(manifest launches.ORCHARD.contracts.mirror.address)"
HOOK="$(manifest contracts.hook.address)"
{
  echo "registry pairCount: $(cast call "$REGISTRY" 'pairCount()(uint256)' --rpc-url "$RPC")"
  echo "The Misfits name / symbol: $(cast call "$MISFITS" 'name()(string)' --rpc-url "$RPC") / $(cast call "$MISFITS" 'symbol()(string)' --rpc-url "$RPC")"
  echo "The Misfits totalSupply: $(cast call "$MISFITS" 'totalSupply()(uint256)' --rpc-url "$RPC")"
  echo "The Misfits unit (raw per NFT): $(cast call "$MISFITS" 'unit()(uint256)' --rpc-url "$RPC")"
  echo "The Misfits NFTs in existence: $(cast call "$MIRROR" 'totalSupply()(uint256)' --rpc-url "$RPC")"
  echo "The Misfits baseURI: $(cast call "$MISFITS" 'baseURI()(string)' --rpc-url "$RPC")"
  echo "ORCHARD name / symbol: $(cast call "$ORCHARD" 'name()(string)' --rpc-url "$RPC") / $(cast call "$ORCHARD" 'symbol()(string)' --rpc-url "$RPC")"
  echo "ORCHARD totalSupply: $(cast call "$ORCHARD" 'totalSupply()(uint256)' --rpc-url "$RPC")"
  echo "ORCHARD NFTs in existence: $(cast call "$ORCHARD_MIRROR" 'totalSupply()(uint256)' --rpc-url "$RPC")"
  echo "hook address low 14 bits: $(python3 -c "print(hex(int('$HOOK', 16) & 0x3FFF))")"
  echo "manifest status: $(manifest status), blocks $(manifest startBlock)-$(manifest endBlock), The Misfits createdAtBlock $(manifest launches.THE_MISFITS.createdAtBlock), ORCHARD $(manifest launches.ORCHARD.createdAtBlock)"
  echo "blocks mined: $(cast block-number --rpc-url "$RPC")"
} | tee "$OUT/5-cast.log"

echo "== gas per transaction (anvil receipts, broadcast/*/31337/run-latest.json)"
python3 - <<'PY' | tee "$OUT/6-gas.log"
import json
for name in ("Deploy.s.sol", "LocalE2E.s.sol"):
    run = json.load(open(f"broadcast/{name}/31337/run-latest.json"))
    total = 0
    print(name)
    for tx, receipt in zip(run["transactions"], run["receipts"]):
        gas = int(receipt["gasUsed"], 16)
        total += gas
        assert receipt["status"] == "0x1", tx
        label = tx.get("function") or ("new " + (tx.get("contractName") or "PoolManager (pinned source)"))
        print(f"  {gas:>10,}  {label.split('(')[0]:<32} {tx.get('contractName') or tx['transaction'].get('to')}")
    print(f"  {total:>10,}  total ({len(run['receipts'])} transactions)")
PY

echo "E2E OK (logs in $OUT/)"
