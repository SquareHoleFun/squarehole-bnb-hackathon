#!/usr/bin/env bash
# Usage: [settings] script/rehearse-rules.sh
# Rehearses a rules launch in Flap's test dollar on a local fork of the BNB test network (anvil, port 8578) with the
# real run's flags: deploys the rules pair, mints test USDT, sets the rules and creates the sale (one script, two
# transactions in that order), buys, completes, claims, trades on the token/USD pool, dispatches the vault share to
# the splitter, distributes it among the rules and redeems from the pile, sending from DEPLOYER (impersonated, no key;
# a fixture address unless given). Prints every step's gas, the BNB spent and the three effects read from the chain.
# Settings: DEPLOYER, FUND_WEI (default 0.1 BNB for a fixture), PAYEE (default the deployer), CREATOR_BPS, PILE_BPS,
# BURN_BPS (defaults 2000, 5000, 3000), TRADE_WEI (each of three pool buys, default 100 USDT).
cd "$(dirname "$0")/.." || exit 1
DEPLOYER=${DEPLOYER:-0x00000000000000000000000000000000000bEEF1}
PAYEE=${PAYEE:-0x00000000000000000000000000000000000bEEF9}
TRADE_WEI=${TRADE_WEI:-100000000000000000000}
USD=0x190C989D5665a0e404B444b53CAE9AbCfb600157
DEAD=0x000000000000000000000000000000000000dEaD
RPC=http://127.0.0.1:8578
anvil --port 8578 --fork-url https://bsc-testnet-rpc.publicnode.com --auto-impersonate --silent &
APID=$!
for i in $(seq 1 30); do cast block-number -r $RPC >/dev/null 2>&1 && break; sleep 1; done
kill -0 "$APID" 2>/dev/null || { echo "the anvil this script started is not running (port taken?)"; exit 1; }
[ "$(cast chain-id -r $RPC)" = 97 ] || { echo "the node on $RPC is not a fork of chain 97"; kill "$APID"; exit 1; }
echo "anvil $APID up at block $(cast block-number -r $RPC)"
if [ "$(cast balance $DEPLOYER -r $RPC)" = 0 ]; then
  cast rpc anvil_setBalance $DEPLOYER "$(cast to-hex "${FUND_WEI:-100000000000000000}")" -r $RPC >/dev/null
fi
B0=$(cast balance $DEPLOYER -r $RPC)
echo "deployer nonce $(cast nonce $DEPLOYER -r $RPC), BNB at the start (wei) $B0"
mkdir -p .cache/rehearse-rules
export DEPLOYMENTS_FILE=deployments/anvil-97-rules-usdt.json RULES_FILE=deployments/anvil-97-rules-usdt.json
export SALE_FILE=deployments/anvil-97-rules-usdt-sale.json VARIANT=usdt PAYEE
F="--rpc-url $RPC --sender $DEPLOYER --unlocked --broadcast --slow --legacy --with-gas-price 100000000"
TOTAL=0
stop() { kill "$APID"; wait "$APID" 2>/dev/null; exit "$1"; }
step() { # step <label> <script> [ENV=VALUE ...]
  local label=$1 script=$2; shift 2
  local start
  start=$(date +%s)
  if ! env "$@" forge script "script/$script" $F > ".cache/rehearse-rules/$label.log" 2>&1; then
    echo "STEP $label FAILED"; grep -E "Error|revert|failed" ".cache/rehearse-rules/$label.log" | head -n 8; stop 1
  fi
  local gas
  gas=$(node -e 'const f=process.argv[1];let j;try{j=require(f)}catch(e){console.log("0 tx, gas 0");process.exit(0)}if(j.timestamp<Number(process.argv[2])){console.log("0 tx, gas 0");process.exit(0)}let s=0n;for(const x of j.receipts)s+=BigInt(x.gasUsed);console.log(j.receipts.length+" tx, gas "+s)' "$PWD/broadcast/$script/97/run-latest.json" "$start")
  echo "STEP $label: $gas"
  TOTAL=$((TOTAL + ${gas##* }))
}
read1() { cast call "$@" -r $RPC | cut -d' ' -f1; }
step deploy DeployRules.s.sol
step mint TokenSale.s.sol ACTION=mint AMOUNT_WEI=5000000000000000000000
step create CreateRulesSale.s.sol
L=$(node -e 'console.log(require(process.argv[1]).launcher)' "$PWD/deployments/anvil-97-rules-usdt-sale.json")
step buy TokenSale.s.sol ACTION=buy MAX_COST_WEI=300000000000000000000
step complete TokenSale.s.sol ACTION=complete
step claim TokenSale.s.sol ACTION=claim
TOKEN=$(cast call "$L" "token()(address)" -r $RPC)
SPLITTER=$(cast call "$L" "pileVault()(address)" -r $RPC)
RVF=$(cast call "$SPLITTER" "factory()(address)" -r $RPC)
PILE=$(cast call "$RVF" "pileOf(address)(address)" "$TOKEN" -r $RPC)
for r in 1 2 3; do
  t0=$(read1 "$TOKEN" "balanceOf(address)(uint256)" $DEPLOYER)
  step "pool-buy$r" TokenSale.s.sol ACTION=pool-buy AMOUNT_WEI="$TRADE_WEI"
  t1=$(read1 "$TOKEN" "balanceOf(address)(uint256)" $DEPLOYER)
  step "pool-sell$r" TokenSale.s.sol ACTION=pool-sell TOKENS_WEI="$(node -e 'console.log(((BigInt(process.argv[1])-BigInt(process.argv[2]))/2n).toString())' "$t1" "$t0")"
done
step dispatch RulesSale.s.sol ACTION=dispatch
PAY0=$(read1 $USD "balanceOf(address)(uint256)" $PAYEE)
PILE0=$(read1 "$PILE" "pile()(uint256)")
DEAD0=$(read1 "$TOKEN" "balanceOf(address)(uint256)" $DEAD)
PEND=$(read1 "$SPLITTER" "pending()(uint256)")
step distribute RulesSale.s.sol ACTION=distribute
PAY1=$(read1 $USD "balanceOf(address)(uint256)" $PAYEE)
PILE1=$(read1 "$PILE" "pile()(uint256)")
DEAD1=$(read1 "$TOKEN" "balanceOf(address)(uint256)" $DEAD)
d() { node -e 'console.log((BigInt(process.argv[1])-BigInt(process.argv[2])).toString())' "$1" "$2"; }
echo "distributed $PEND: payee +$(d "$PAY1" "$PAY0"), pile +$(d "$PILE1" "$PILE0"), tokens at the dead address +$(d "$DEAD1" "$DEAD0")"
step redeem RulesSale.s.sol ACTION=redeem TOKENS_WEI=10000000000000000000000000
echo "pile after the redemption $(read1 "$PILE" "pile()(uint256)"), paid out $(read1 "$PILE" "totalPaidOut()(uint256)")"
B1=$(cast balance $DEPLOYER -r $RPC)
echo "TOTAL gas: $TOTAL = $(node -e 'console.log((BigInt(process.argv[1])*100000000n).toString())' $TOTAL) wei at 0.1 gwei"
echo "BNB spent (gas and the salt-lock fee): $(d "$B0" "$B1") wei"
stop 0
