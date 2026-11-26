#!/usr/bin/env bash
# Usage: [settings] script/rehearse-usdt.sh
# Rehearses the token-quote run on a local fork of the BNB test network (anvil, port 8578) with the real run's flags
# (legacy transactions at 0.1 gwei, one at a time): deploys the two token-quote factories, mints the deployment's test
# USDT through its public mint, creates a sale through Portal.newLauncher, buys, sells back half, completes (the launch),
# claims, trades on the token/USD pool, dispatches and redeems, sending from DEPLOYER (impersonated: no key is used; a
# fixture address unless DEPLOYER is given). Prints every step's gas, the BNB and the test USDT spent, and the reads
# that prove each step. Nothing is sent to a real network; outputs go to deployments/anvil-*.json.
# A second buyer (ALICE) mints, buys and sells back half on the curve before the deployer completes.
# Settings: DEPLOYER, ALICE, FUND_WEI (BNB for a fixture deployer, default 0.1 BNB), MINT_WEI (default 5000 USDT),
# BUY_WEI (default 300 USDT), TRADE_WEI (each of three pool buys, default 100 USDT).
cd "$(dirname "$0")/.." || exit 1
DEPLOYER=${DEPLOYER:-0x00000000000000000000000000000000000bEEF1}
ALICE=${ALICE:-0x00000000000000000000000000000000000bEEF2}   # a second buyer
MINT_WEI=${MINT_WEI:-5000000000000000000000}
BUY_WEI=${BUY_WEI:-300000000000000000000}
TRADE_WEI=${TRADE_WEI:-100000000000000000000}
USD=0x190C989D5665a0e404B444b53CAE9AbCfb600157
RPC=http://127.0.0.1:8578
anvil --port 8578 --fork-url https://bsc-testnet-rpc.publicnode.com --auto-impersonate --silent &
APID=$!
for i in $(seq 1 30); do cast block-number -r $RPC >/dev/null 2>&1 && break; sleep 1; done
# only our own fork: the process we started is alive and the node answers chain 97, before any balance is set
kill -0 "$APID" 2>/dev/null || { echo "the anvil this script started is not running (port taken?)"; exit 1; }
[ "$(cast chain-id -r $RPC)" = 97 ] || { echo "the node on $RPC is not a fork of chain 97"; kill "$APID"; exit 1; }
echo "anvil $APID up at block $(cast block-number -r $RPC)"
if [ "$(cast balance $DEPLOYER -r $RPC)" = 0 ]; then
  cast rpc anvil_setBalance $DEPLOYER "$(cast to-hex "${FUND_WEI:-100000000000000000}")" -r $RPC >/dev/null
fi
B0=$(cast balance $DEPLOYER -r $RPC)
echo "deployer nonce $(cast nonce $DEPLOYER -r $RPC), BNB at the start (wei) $B0"
mkdir -p .cache/rehearse-usdt
export DEPLOYMENTS_FILE=deployments/anvil-97-usdt.json SALE_FILE=deployments/anvil-97-usdt-sale.json
F="--rpc-url $RPC --sender $DEPLOYER --unlocked --broadcast --slow --legacy --with-gas-price 100000000"
FA="--rpc-url $RPC --sender $ALICE --unlocked --broadcast --slow --legacy --with-gas-price 100000000"
if [ "$(cast balance $ALICE -r $RPC)" = 0 ]; then cast rpc anvil_setBalance $ALICE 0xb1a2bc2ec50000 -r $RPC >/dev/null; fi
TOTAL=0
stop() { kill "$APID"; wait "$APID" 2>/dev/null; exit "$1"; }
usd() { cast call $USD "balanceOf(address)(uint256)" "$1" -r $RPC | cut -d' ' -f1; }
step() { # step <label> <script> [ENV=VALUE ...]
  local label=$1 script=$2; shift 2
  local start
  start=$(date +%s)
  if ! env "$@" forge script "script/$script" $F > ".cache/rehearse-usdt/$label.log" 2>&1; then
    echo "STEP $label FAILED"; grep -E "Error|revert|failed" ".cache/rehearse-usdt/$label.log" | head -n 8; stop 1
  fi
  local gas
  # only a receipt file written by this step counts (a step that sends nothing leaves the previous one)
  gas=$(node -e 'const f=process.argv[1];let j;try{j=require(f)}catch(e){console.log("0 tx, gas 0");process.exit(0)}if(j.timestamp<Number(process.argv[2])){console.log("0 tx, gas 0");process.exit(0)}let s=0n;for(const x of j.receipts)s+=BigInt(x.gasUsed);console.log(j.receipts.length+" tx, gas "+s)' "$PWD/broadcast/$script/97/run-latest.json" "$start")
  echo "STEP $label: $gas"
  TOTAL=$((TOTAL + ${gas##* }))
}
status() { ACTION=status forge script script/TokenSale.s.sol --rpc-url $RPC --sender $DEPLOYER > ".cache/rehearse-usdt/status-$1.log" 2>&1; grep -E "^  (phase|my claimable|my quote allowance|my token allowance|tax waiting|pile \(quote\)|pile paid)" ".cache/rehearse-usdt/status-$1.log"; }
step deploy DeployToken.s.sol
step mint TokenSale.s.sol ACTION=mint AMOUNT_WEI="$MINT_WEI"
U0=$(usd $DEPLOYER)
step create CreateTokenSale.s.sol
L=$(node -e 'console.log(require(process.argv[1]).launcher)' "$PWD/deployments/anvil-97-usdt-sale.json")
step buy TokenSale.s.sol ACTION=buy MAX_COST_WEI="$BUY_WEI"
echo "-- the second buyer"
FSAVE=$F; F=$FA
step alice-mint TokenSale.s.sol ACTION=mint AMOUNT_WEI=1000000000000000000000
step alice-buy TokenSale.s.sol ACTION=buy MAX_COST_WEI=200000000000000000000
AHALF=$(node -e 'console.log((BigInt(process.argv[1])/2n).toString())' "$(cast call "$L" "tokensOf(address)(uint256)" $ALICE -r $RPC | cut -d' ' -f1)")
step alice-sell TokenSale.s.sol ACTION=sell TOKENS_WEI="$AHALF"
F=$FSAVE
echo "-- the deployer"
HALF=$(node -e 'console.log((BigInt(process.argv[1])/2n).toString())' "$(cast call "$L" "tokensOf(address)(uint256)" $DEPLOYER -r $RPC | cut -d' ' -f1)")
step sell TokenSale.s.sol ACTION=sell TOKENS_WEI="$HALF"
step complete TokenSale.s.sol ACTION=complete
status completed
step claim TokenSale.s.sol ACTION=claim
F=$FA; step alice-claim TokenSale.s.sol ACTION=claim; F=$FSAVE
TOKEN=$(cast call "$L" "token()(address)" -r $RPC)
for r in 1 2 3; do
  t0=$(cast call "$TOKEN" "balanceOf(address)(uint256)" $DEPLOYER -r $RPC | cut -d' ' -f1)
  step "pool-buy$r" TokenSale.s.sol ACTION=pool-buy AMOUNT_WEI="$TRADE_WEI"
  t1=$(cast call "$TOKEN" "balanceOf(address)(uint256)" $DEPLOYER -r $RPC | cut -d' ' -f1)
  step "pool-sell$r" TokenSale.s.sol ACTION=pool-sell TOKENS_WEI="$(node -e 'console.log(((BigInt(process.argv[1])-BigInt(process.argv[2]))/2n).toString())' "$t1" "$t0")"
done
status traded
PILE_BEFORE=$(cast call "$(cast call "$L" "pileVault()(address)" -r $RPC)" "pile()(uint256)" -r $RPC | cut -d' ' -f1)
step dispatch TokenSale.s.sol ACTION=dispatch PILE_BEFORE_WEI="$PILE_BEFORE"
status dispatched
step redeem TokenSale.s.sol ACTION=redeem TOKENS_WEI=10000000000000000000000000
status redeemed
B1=$(cast balance $DEPLOYER -r $RPC)
U1=$(usd $DEPLOYER)
echo "TOTAL gas: $TOTAL = $(node -e 'console.log((BigInt(process.argv[1])*100000000n).toString())' $TOTAL) wei at 0.1 gwei"
echo "BNB spent (gas and the salt-lock fee): $(node -e 'console.log((BigInt(process.argv[1])-BigInt(process.argv[2])).toString())' "$B0" "$B1") wei"
echo "test USDT spent after minting (out of the minted amount): $(node -e 'console.log((BigInt(process.argv[1])-BigInt(process.argv[2])).toString())' "$U0" "$U1") (base units)"
stop 0
