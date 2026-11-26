#!/usr/bin/env bash
# Usage: [settings] script/stake-stand.sh
# A stand for holder payouts on a local fork of the BNB test network (anvil, PORT, default 8622), built with the real
# run's scripts and flags from DEPLOYER (impersonated, no key; a fixture address unless given): the rules pair and
# the RailStakeFactory deployed, the creator's stake created for the token to come, a test-dollar sale with the rules
# creator 10%, pile 30%, buy and burn 20%, holders 40% (the stake), bought, completed and claimed; the deployer stakes
# half its tokens, pool rounds raise income, the share-out pays the stake, a sync streams it, half a period passes,
# the deployer claims. Prints every step's gas and writes the addresses to deployments/anvil-97-stand.json.
# Then, with KEEP=1 (the default), anvil stays up for a page (Ctrl-C stops it) and the commands for more income are
# printed; KEEP=0 stops it (the rehearsal).
# Settings: PORT, DEPLOYER, FUND_WEI (default 0.1 BNB for a fixture), STAKE_PERIOD (default 86400 s), KEEP.
cd "$(dirname "$0")/.." || exit 1
PORT=${PORT:-8622}
KEEP=${KEEP:-1}
DEPLOYER=${DEPLOYER:-0x00000000000000000000000000000000000bEEF1}
PAYEE=${PAYEE:-0x00000000000000000000000000000000000bEEF9}
STAKE_PERIOD=${STAKE_PERIOD:-86400}
USD=0x190C989D5665a0e404B444b53CAE9AbCfb600157
DEAD=0x000000000000000000000000000000000000dEaD
RPC=http://127.0.0.1:$PORT
# refuse a port another node already answers on: a probe would reach that node and the steps would land there
if cast block-number -r "$RPC" >/dev/null 2>&1; then echo "port $PORT is taken by another node; set PORT"; exit 1; fi
anvil --port "$PORT" --fork-url https://bsc-testnet-rpc.publicnode.com --auto-impersonate --silent &
APID=$!
stop() { kill "$APID" 2>/dev/null; wait "$APID" 2>/dev/null; exit "$1"; }
trap 'stop 130' INT TERM
for i in $(seq 1 30); do cast block-number -r "$RPC" >/dev/null 2>&1 && break; sleep 1; done
sleep 1
kill -0 "$APID" 2>/dev/null || { echo "the anvil this script started is not running (port $PORT taken?)"; exit 1; }
[ "$(cast chain-id -r "$RPC")" = 97 ] || { echo "the node on $RPC is not a fork of chain 97"; stop 1; }
echo "anvil $APID up on port $PORT at block $(cast block-number -r "$RPC")"
if [ "$(cast balance $DEPLOYER -r "$RPC")" = 0 ]; then
  cast rpc anvil_setBalance $DEPLOYER "$(cast to-hex "${FUND_WEI:-100000000000000000}")" -r "$RPC" >/dev/null
fi
B0=$(cast balance $DEPLOYER -r "$RPC")
mkdir -p .cache/stake-stand
export DEPLOYMENTS_FILE=deployments/anvil-97-stand-rules.json RULES_FILE=deployments/anvil-97-stand-rules.json
export SALE_FILE=deployments/anvil-97-stand-sale.json STAKE_FILE=deployments/anvil-97-stand-stake.json VARIANT=usdt
export PAYEE STAKE_PERIOD
F="--rpc-url $RPC --sender $DEPLOYER --unlocked --broadcast --slow --legacy --with-gas-price 100000000"
TOTAL=0
step() { # step <label> <script> [ENV=VALUE ...]
  local label=$1 script=$2; shift 2
  local start
  start=$(date +%s)
  if ! env "$@" forge script "script/$script" $F > ".cache/stake-stand/$label.log" 2>&1; then
    echo "STEP $label FAILED"; grep -E "Error|revert|failed" ".cache/stake-stand/$label.log" | head -n 8; stop 1
  fi
  local gas
  gas=$(node -e 'const f=process.argv[1];let j;try{j=require(f)}catch(e){console.log("0 tx, gas 0");process.exit(0)}if(j.timestamp<Number(process.argv[2])){console.log("0 tx, gas 0");process.exit(0)}let s=0n;for(const x of j.receipts)s+=BigInt(x.gasUsed);console.log(j.receipts.length+" tx, gas "+s)' "$PWD/broadcast/$script/97/run-latest.json" "$start")
  echo "STEP $label: $gas"
  TOTAL=$((TOTAL + ${gas##* }))
}
read1() { cast call "$@" -r "$RPC" | cut -d' ' -f1; }
d() { node -e 'console.log((BigInt(process.argv[1])-BigInt(process.argv[2])).toString())' "$1" "$2"; }
step deploy-rules DeployRules.s.sol
step deploy-stake DeployStake.s.sol
step mint TokenSale.s.sol ACTION=mint AMOUNT_WEI=5000000000000000000000
step create CreateRulesSale.s.sol CREATOR_BPS=1000 PILE_BPS=3000 BURN_BPS=2000 HOLDERS_BPS=4000
J() { node -e 'console.log(require(process.argv[1])[process.argv[2]])' "$PWD/$1" "$2"; }
L=$(J "$SALE_FILE" launcher)
STAKE=$(J "$SALE_FILE" stake)
FACTORY=$(J "$STAKE_FILE" factory)
step buy TokenSale.s.sol ACTION=buy MAX_COST_WEI=300000000000000000000
step complete TokenSale.s.sol ACTION=complete
step claim TokenSale.s.sol ACTION=claim
TOKEN=$(cast call "$L" "token()(address)" -r "$RPC")
SPLITTER=$(cast call "$L" "pileVault()(address)" -r "$RPC")
[ "$(cast call "$FACTORY" "stakeOf(address,address)(address)" $DEPLOYER "$TOKEN" -r "$RPC")" = "$STAKE" ] || { echo "stakeOf does not name the stake"; stop 1; }
HALF=$(node -e 'console.log((BigInt(process.argv[1])/2n).toString())' "$(read1 "$TOKEN" "balanceOf(address)(uint256)" $DEPLOYER)")
step stake Stake.s.sol STAKE="$STAKE" ACTION=stake TOKENS_WEI="$HALF"
for r in 1 2 3; do
  t0=$(read1 "$TOKEN" "balanceOf(address)(uint256)" $DEPLOYER)
  step "pool-buy$r" TokenSale.s.sol ACTION=pool-buy AMOUNT_WEI=100000000000000000000
  t1=$(read1 "$TOKEN" "balanceOf(address)(uint256)" $DEPLOYER)
  step "pool-sell$r" TokenSale.s.sol ACTION=pool-sell TOKENS_WEI="$(node -e 'console.log(((BigInt(process.argv[1])-BigInt(process.argv[2]))/2n).toString())' "$t1" "$t0")"
done
step dispatch RulesSale.s.sol ACTION=dispatch
PEND=$(read1 "$SPLITTER" "pending()(uint256)")
step distribute RulesSale.s.sol ACTION=distribute
echo "distributed $PEND; the stake holds $(read1 $USD "balanceOf(address)(uint256)" "$STAKE") unsynced $(read1 "$STAKE" "unsynced()(uint256)")"
step sync Stake.s.sol STAKE="$STAKE" ACTION=sync
cast rpc evm_increaseTime $((STAKE_PERIOD / 2)) -r "$RPC" >/dev/null && cast rpc evm_mine -r "$RPC" >/dev/null
U0=$(read1 $USD "balanceOf(address)(uint256)" $DEPLOYER)
step claim-stake Stake.s.sol STAKE="$STAKE" ACTION=claim
echo "half a period later the deployer (the only staker) claimed $(d "$(read1 $USD "balanceOf(address)(uint256)" $DEPLOYER)" "$U0"); still streaming $(read1 "$STAKE" "undistributed()(uint256)")"
B1=$(cast balance $DEPLOYER -r "$RPC")
echo "TOTAL gas: $TOTAL = $(node -e 'console.log((BigInt(process.argv[1])*100000000n).toString())' $TOTAL) wei at 0.1 gwei"
echo "BNB spent (gas and the salt-lock fee): $(d "$B0" "$B1") wei"
cat > deployments/anvil-97-stand.json <<JSON
{ "rpc": "$RPC", "railStake": { "factory": "$FACTORY" }, "token": "$TOKEN", "stake": "$STAKE", "launcher": "$L", "splitter": "$SPLITTER", "creator": "$DEPLOYER", "quote": "$USD" }
JSON
echo "written deployments/anvil-97-stand.json: factory $FACTORY token $TOKEN stake $STAKE"
[ "$KEEP" = 1 ] || stop 0
echo "anvil stays up on $RPC; Ctrl-C stops it. More income, a plain payment (Flap's test dollar mints openly):"
echo "  cast send $USD 'mint(address,uint256)' $STAKE 1000000000000000000000 --from $DEPLOYER --unlocked -r $RPC"
echo "then count it:  cast send $STAKE 'sync()' --from $DEPLOYER --unlocked -r $RPC"
echo "time:           cast rpc evm_increaseTime 3600 -r $RPC && cast rpc evm_mine -r $RPC"
wait "$APID"
