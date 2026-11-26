#!/usr/bin/env bash
# Stage E (FOUNDER-RUN): deploy the Square Hole stack to Sepolia, then finalize and verify its manifest.
# No agent runs this with a key: it broadcasts to a public network. `--simulate-only` needs no key and sends nothing.
#
#   ./scripts/deploy-sepolia.sh --simulate-only [--sender <address>]  steps 1-3; no key, nothing sent
#   DEPLOYER_PRIVATE_KEY=0x… ./scripts/deploy-sepolia.sh               steps 1-7 (asks to type "broadcast" first)
#   ./scripts/deploy-sepolia.sh --finalize-only                       steps 6-7 only (e.g. after `--resume`)
#
# Environment: SEPOLIA_RPC_URL (default https://ethereum-sepolia-rpc.publicnode.com; Tenderly fallback in
# .env.example), MAINNET_RPC_URL (collision guard; default https://eth.drpc.org), SH_CONFIRM=broadcast (no prompt),
# SH_LAUNCH_ORCHARD=true|false (overrides launches.ORCHARD.enabled in script/config/11155111.json; the finalizer
# follows whatever the broadcast plan contains), SH_METADATA_MANIFEST_<THE_MISFITS|ORCHARD> (manifest file paths).
# The key is read only from DEPLOYER_PRIVATE_KEY by script/Deploy.s.sol; this wrapper never prints or passes it on.
#
# 1. checks: chain id 11155111; git provenance of the whole worktree (SH_GIT_COMMIT = `git rev-parse HEAD`,
#    SH_GIT_DIRTY from `git status --porcelain`); a broadcast needs a clean tree (the finalizer refuses anything else);
# 2. simulation without --broadcast (as the deployer, or --sender) → deployments/dry-run/11155111.json ("simulated");
#    prints the gas estimate and a budget line: transactions, gas (eth_estimateGas, multiplier 1.0), the current gas
#    price, the cost ×1.0 and ×1.3 and the sender's balance (SH-E; the broadcast itself keeps forge's ×1.3 gas limits).
#    A broadcast also needs the committed metadata manifest files, each equal to its pinned manifestHash
#    (script/Deploy.s.sol refuses a missing file or one that differs from the pin);
# 3. mainnet-collision guard (docs/research/sepolia-infrastructure.md § 2.5, § 4.3): no address the deployment creates
#    may have code on Ethereum mainnet (the Uniswap app falls back to mainnet when testnet mode is off);
# 4. confirmation (type "broadcast");
# 5. forge script script/Deploy.s.sol --broadcast --slow: one transaction at a time, each only after the previous one
#    succeeded (the hook and launcher addresses are planned from the deployer's nonces); forge's local execution
#    writes only the plan deployments/pending/11155111.json;
# 6. script/WriteManifest.s.sol (read-only): checks the receipts and the plan against the chain and writes
#    deployments/11155111.json ("deployed") only if everything matches;
# 7. script/VerifyManifest.s.sol (read-only) and the mainnet-collision guard again, on the final addresses.
# Then commit deployments/11155111.json and verify the sources (Sourcify / Blockscout) with its constructor arguments.
set -euo pipefail

export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."
mkdir -p .e2e # logs (gitignored)

RPC="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
MAINNET_RPC="${MAINNET_RPC_URL:-https://eth.drpc.org}"
MODE="deploy"
SENDER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --simulate-only) MODE="simulate" ;;
    --finalize-only) MODE="finalize" ;;
    --sender) SENDER="$2"; shift ;;
    *) echo "usage: $0 [--simulate-only [--sender <address>] | --finalize-only]" >&2; exit 2 ;;
  esac
  shift
done

manifest_addresses() { # every address the deployment creates (not the canonical PoolManager, WETH or USDC)
  python3 -c 'import json, sys
d = json.load(open(sys.argv[1]))
out = []
for k in ("registry", "claimConverter", "hook", "coreDeployer", "collectionTokenDeployer", "fungibleTokenDeployer",
          "launcher", "USDT"):
    out.append(d["contracts"][k]["address"])
for launch in d["launches"].values():
    for c in launch["contracts"].values():
        out.append(c["address"])
print("\n".join(a for a in out if int(a, 16) != 0))' "$1"
}

mainnet_collision_guard() { # $1 = manifest
  local n=0
  for a in $(manifest_addresses "$1"); do
    size="$(cast codesize "$a" --rpc-url "$MAINNET_RPC")"
    [ "$size" = "0" ] || { echo "error: $a has code on Ethereum mainnet ($size bytes)" >&2; exit 1; }
    n=$((n + 1))
  done
  echo "mainnet-collision guard: $n addresses, none has code on Ethereum mainnet ($MAINNET_RPC)"
}

echo "== 1/7 checks"
[ "$(cast chain-id --rpc-url "$RPC")" = "11155111" ] || { echo "error: $RPC is not Sepolia" >&2; exit 1; }
SH_GIT_COMMIT="$(git rev-parse HEAD)"
SH_GIT_DIRTY="$([ -n "$(git status --porcelain)" ] && echo true || echo false)"
export SH_GIT_COMMIT SH_GIT_DIRTY
echo "Sepolia via $RPC; git $SH_GIT_COMMIT dirty=$SH_GIT_DIRTY"
if [ "$MODE" != "simulate" ] && [ "$SH_GIT_DIRTY" != "false" ]; then
  echo "error: commit or stash every change first; a public-chain deployment is recorded only from a clean tree" >&2
  exit 1
fi

if [ "$MODE" != "finalize" ]; then
  echo "== 2/7 simulation (no --broadcast)"
  if [ "$MODE" = "simulate" ]; then
    [ -n "$SENDER" ] || { echo "error: --simulate-only needs --sender <address>" >&2; exit 1; }
    env -u DEPLOYER_PRIVATE_KEY forge script script/Deploy.s.sol --rpc-url "$RPC" --sender "$SENDER" \
      --gas-estimate-multiplier 100 \
      2>&1 | tee .e2e/sepolia-simulation.log | grep -E "SQUAREHOLE_DEPLOY|Estimated|SIMULATION COMPLETE|Error|error" || true
  else
    [ -n "${DEPLOYER_PRIVATE_KEY:-}" ] || { echo "error: DEPLOYER_PRIVATE_KEY is not set" >&2; exit 1; }
    forge script script/Deploy.s.sol --rpc-url "$RPC" --gas-estimate-multiplier 100 \
      2>&1 | tee .e2e/sepolia-simulation.log | grep -E "SQUAREHOLE_DEPLOY|Estimated|SIMULATION COMPLETE|Error|error" || true
  fi
  grep -q "SIMULATION COMPLETE" .e2e/sepolia-simulation.log || { echo "error: simulation failed" >&2; exit 1; }

  # Budget line (SH-E): the simulation's eth_estimateGas per transaction (multiplier 1.0) at the current gas price.
  GAS_PRICE="$(cast gas-price --rpc-url "$RPC")"
  PLANNED_SENDER="$(python3 -c 'import json; print(json.load(open("deployments/dry-run/11155111.json"))["deployer"])')"
  BALANCE="$(cast balance "$PLANNED_SENDER" --rpc-url "$RPC")"
  python3 - "$GAS_PRICE" "$BALANCE" <<'PY' | tee .e2e/sepolia-budget.log
import json, sys
price, balance = int(sys.argv[1]), int(sys.argv[2])
run = json.load(open("broadcast/Deploy.s.sol/11155111/dry-run/run-latest.json"))
gas = sum(int(t["transaction"]["gas"], 16) for t in run["transactions"])
wei = lambda x: f"{x // 10**18}.{x % 10**18:018d}"
cost = gas * price
print(f"budget: {len(run['transactions'])} transactions, {gas:,} gas (eth_estimateGas, multiplier 1.0)")
print(f"budget: gas price {price:,} wei; cost x1.0 {wei(cost)} ETH, x1.3 {wei(cost * 13 // 10)} ETH")
print(f"budget: sender balance {wei(balance)} ETH; left after x1.3: {wei(max(balance - cost * 13 // 10, 0))} ETH")
PY

  echo "== 3/7 mainnet-collision guard on the plan"
  mainnet_collision_guard deployments/dry-run/11155111.json
  if [ "$MODE" = "simulate" ]; then
    echo "SIMULATE-ONLY OK: nothing was sent (plan in deployments/dry-run/11155111.json)"
    exit 0
  fi

  echo "== 4/7 confirmation"
  DEPLOYER="$(python3 -c 'import json; print(json.load(open("deployments/dry-run/11155111.json"))["deployer"])')"
  echo "About to BROADCAST the Square Hole deployment to Sepolia from $DEPLOYER (one transaction at a time)."
  if [ "${SH_CONFIRM:-}" != "broadcast" ]; then
    read -r -p 'Type "broadcast" to continue: ' answer
    [ "$answer" = "broadcast" ] || { echo "aborted; nothing was sent"; exit 1; }
  fi

  echo "== 5/7 broadcast (script/Deploy.s.sol --broadcast --slow)"
  forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --slow 2>&1 | tee .e2e/sepolia-broadcast.log \
    | grep -E "SQUAREHOLE_DEPLOY|ONCHAIN EXECUTION COMPLETE|Transaction Failure|Total Paid|Error|error" || true
  if ! grep -q "ONCHAIN EXECUTION COMPLETE & SUCCESSFUL" .e2e/sepolia-broadcast.log; then
    cat >&2 <<EOF
error: the broadcast did not complete. deployments/11155111.json was NOT written.
Inspect broadcast/Deploy.s.sol/11155111/run-latest.json (receipts) and .e2e/sepolia-broadcast.log. With --slow, forge
stops at the first failed or dropped transaction; the plan in deployments/pending/11155111.json stays valid.
- Out of funds, a dropped transaction, an RPC error: fix it, then resume the SAME sequence (no new simulation):
    SH_GIT_COMMIT=$SH_GIT_COMMIT SH_GIT_DIRTY=false forge script script/Deploy.s.sol \\
      --rpc-url "$RPC" --broadcast --slow --resume --interactives 1
- The hook's CREATE2 transaction reverted: an identical hook was deployed first from the mempool (front-run). The
  reverted transaction still used its nonce, so the plan holds: resume the same way; the finalizer checks the hook's
  code hash and records it as adopted.
Never re-run the deployment from scratch after a partial broadcast: it would plan a second system at new nonces.
Then: ./scripts/deploy-sepolia.sh --finalize-only
EOF
    exit 1
  fi
fi

echo "== 6/7 finalize (script/WriteManifest.s.sol, read-only)"
forge script script/WriteManifest.s.sol --rpc-url "$RPC" 2>&1 | tee .e2e/sepolia-finalize.log \
  | grep -E "SQUAREHOLE_|Error|error" || true
grep -q "SQUAREHOLE_FINALIZE manifest" .e2e/sepolia-finalize.log || { echo "error: finalization failed" >&2; exit 1; }

echo "== 7/7 verify (script/VerifyManifest.s.sol, read-only) and the mainnet-collision guard"
forge script script/VerifyManifest.s.sol --rpc-url "$RPC" 2>&1 | tee -a .e2e/sepolia-finalize.log \
  | grep -E "SQUAREHOLE_|Error|error" || true
grep -q "SQUAREHOLE_VERIFY OK" .e2e/sepolia-finalize.log || { echo "error: verification failed" >&2; exit 1; }
mainnet_collision_guard deployments/11155111.json
echo "DEPLOYED AND VERIFIED: commit deployments/11155111.json; next: source verification, the recorded external buy"
echo "through the Universal Router (routing TVL floor), app configuration (ADR-0011 §10, evidence SH-B2 Stage E)."
