#!/usr/bin/env bash
# Usage: [settings] script/rehearse.sh
# Rehearses the real run on a local fork of the BNB test network (anvil, port 8578) with the real run's flags
# (legacy transactions at 0.1 gwei, one at a time): deploys the two factories, creates a sale through
# Portal.newLauncher, buys, completes (the launch), claims, trades on the pool, dispatches the tax and redeems,
# sending from DEPLOYER (impersonated: no key is used; a fixture address unless DEPLOYER is given, e.g. the real
# run's address to rehearse its exact nonce). Prints the gas of every transaction,
# the sum, and the deployer's balance before and after. Nothing is sent to a real network; the outputs go to
# deployments/anvil-*.json.
# Settings (environment): TARGET_WEI and VIRTUAL_WEI (the sale, see CreateSale.s.sol), BUY_WEI (the first buy after
# creation), TRADE_WEI (each of three pool trades), FUND_WEI (set the deployer's balance first; unset = its real
# balance), FLAP_ZERO=1 (stand in for Flap: set our Launcher factory's floor multiplier to 0), WARP_SECONDS (wait
# between the launch and the trades, default 0).
cd "$(dirname "$0")/.." || exit 1
DEPLOYER=${DEPLOYER:-0x00000000000000000000000000000000000bEEF1}
BUY_WEI=${BUY_WEI:-1000000000000000000}
TRADE_WEI=${TRADE_WEI:-300000000000000000}
WARP_SECONDS=${WARP_SECONDS:-0}
PORTAL=0x000042108465206185A077Edc3F3fd2b49060000
RPC=http://127.0.0.1:8578
anvil --port 8578 --fork-url https://bsc-testnet-rpc.publicnode.com --auto-impersonate --silent &
APID=$!
for i in $(seq 1 30); do cast block-number -r $RPC >/dev/null 2>&1 && break; sleep 1; done
echo "anvil $APID up at block $(cast block-number -r $RPC)"
echo "deployer nonce $(cast nonce $DEPLOYER -r $RPC), balance (wei) $(cast balance $DEPLOYER -r $RPC)"
if [ -z "${FUND_WEI:-}" ] && [ "$(cast balance $DEPLOYER -r $RPC)" = 0 ]; then FUND_WEI=5000000000000000000; fi
[ -n "${FUND_WEI:-}" ] && cast rpc anvil_setBalance $DEPLOYER "$(cast to-hex "$FUND_WEI")" -r $RPC >/dev/null
B0=$(cast balance $DEPLOYER -r $RPC)
echo "balance at the start of the rehearsal (wei) $B0"
mkdir -p .cache/rehearse
export DEPLOYMENTS_FILE=deployments/anvil-97.json SALE_FILE=deployments/anvil-97-sale.json
F="--rpc-url $RPC --sender $DEPLOYER --unlocked --broadcast --slow --legacy --with-gas-price 100000000"
TOTAL=0
stop() { kill "$APID"; wait "$APID" 2>/dev/null; exit "$1"; }
step() { # step <label> <script> [ENV=VALUE ...]
  local label=$1 script=$2; shift 2
  if ! env "$@" forge script "script/$script" $F > ".cache/rehearse/$label.log" 2>&1; then
    echo "STEP $label FAILED"; grep -E "Error|revert|failed" ".cache/rehearse/$label.log" | head -n 8; stop 1
  fi
  local gas
  gas=$(node -e 'const r=require(process.argv[1]).receipts;let s=0n;for(const x of r)s+=BigInt(x.gasUsed);console.log(r.length+" tx, gas "+s)' "$PWD/broadcast/$script/97/run-latest.json")
  echo "STEP $label: $gas"
  TOTAL=$((TOTAL + ${gas##* }))
}
status() { ACTION=status forge script script/Sale.s.sol --rpc-url $RPC --sender $DEPLOYER > ".cache/rehearse/status-$1.log" 2>&1; grep -E "^  (phase|pile \(wei\)|my claimable|tax waiting|pile paid)" ".cache/rehearse/status-$1.log"; }
step deploy Deploy.s.sol
node -e 'const d=require(process.argv[1]),r=require(process.argv[2]).receipts;console.log("deployBlock "+d.deployBlock+", factories mined in blocks "+r.map(x=>BigInt(x.blockNumber)).join(" and "))' "$PWD/deployments/anvil-97.json" "$PWD/broadcast/Deploy.s.sol/97/run-latest.json"
if [ "${FLAP_ZERO:-0}" = 1 ]; then
  CLF=$(node -e 'console.log(require(process.argv[1]).curveLauncherFactory)' "$PWD/deployments/anvil-97.json")
  ADMIN=$(cast call 0x0000Ed588dfc01749C20bA69b5f8c77d706E0000 "owner()(address)" -r $RPC)
  cast send $PORTAL "setLauncherFactoryMultiplier(address,uint16,bool)" "$CLF" 0 true --from "$ADMIN" --unlocked -r $RPC > /dev/null || stop 1
  echo "stand-in for Flap: multiplier 0 for $CLF -> $(cast call $PORTAL 'launcherFactoryMultiplier(address)(bool,uint16)' "$CLF" -r $RPC | tr '\n' ' ')"
fi
step create CreateSale.s.sol
step buy Sale.s.sol ACTION=buy AMOUNT_WEI="$BUY_WEI"
step complete Sale.s.sol ACTION=complete
status completed
step claim Sale.s.sol ACTION=claim
status launched
if [ "$WARP_SECONDS" != 0 ]; then cast rpc evm_increaseTime "$WARP_SECONDS" -r $RPC >/dev/null && cast rpc evm_mine -r $RPC >/dev/null; fi
L=$(node -e 'console.log(require(process.argv[1]).launcher)' "$PWD/deployments/anvil-97-sale.json")
TOKEN=$(cast call "$L" "token()(address)" -r $RPC)
for r in 1 2 3; do
  bal0=$(cast call "$TOKEN" "balanceOf(address)(uint256)" $DEPLOYER -r $RPC | cut -d' ' -f1)
  step "pool-buy$r" Sale.s.sol ACTION=pool-buy AMOUNT_WEI="$TRADE_WEI"
  bal1=$(cast call "$TOKEN" "balanceOf(address)(uint256)" $DEPLOYER -r $RPC | cut -d' ' -f1)
  fill=$(node -e 'console.log(((BigInt(process.argv[1])-BigInt(process.argv[2]))/2n).toString())' "$bal1" "$bal0")
  echo "  round $r: bought $(node -e 'console.log((BigInt(process.argv[1])-BigInt(process.argv[2])).toString())' "$bal1" "$bal0") tokens, selling half"
  step "pool-sell$r" Sale.s.sol ACTION=pool-sell TOKENS_WEI="$fill"
done
status traded
step dispatch Sale.s.sol ACTION=dispatch
status dispatched
step redeem Sale.s.sol ACTION=redeem TOKENS_WEI=10000000000000000000000000
status redeemed
B1=$(cast balance $DEPLOYER -r $RPC)
echo "TOTAL gas: $TOTAL = $(node -e 'console.log((BigInt(process.argv[1])*100000000n).toString())' $TOTAL) wei at 0.1 gwei"
echo "deployer spent (wei, gas and BNB together): $(node -e 'console.log((BigInt(process.argv[1])-BigInt(process.argv[2])).toString())' "$B0" "$B1"), left $B1"
stop 0
