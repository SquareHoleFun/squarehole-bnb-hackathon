#!/usr/bin/env bash
# Usage: [PORT=8598] script/rehearse-shop.sh
# SH-288: rehearses the real run of a Flap launch whose rules feed a card shop, on a local fork of the BNB test network
# (anvil on PORT, refused when the port already answers), with the real run's flags, sending from DEPLOYER
# (impersonated, no key): the shop factory (bounties/core/script/DeployRailShopFactory.s.sol), lane f's rules pair
# (DeployRules.s.sol, as script/rehearse-rules.sh does), the test dollar for the creator, the launch with a shop in its
# rules (CreateShopRulesSale.s.sol), a buy, the completion and the claim, then a second shop for the now existing
# token (bounties/core/script/CreateRailShop.s.sol). Two dry runs must stop on their reason: a cap above the launch's
# fixed supply, a give price above the token's supply. Prints every step's gas, then reads back the shop's rule, the
# shop and the factory's lists. The shop's whole life (share-out, refill, give, pick) is test/RailShop.fork.t.sol.
cd "$(dirname "$0")/.." || exit 1
PORT=${PORT:-8598}
DEPLOYER=${DEPLOYER:-0x00000000000000000000000000000000000bEEF1}
RPC=http://127.0.0.1:$PORT
if cast chain-id -r $RPC >/dev/null 2>&1; then echo "port $PORT already answers: not ours, refused"; exit 1; fi
anvil --port "$PORT" --fork-url https://bsc-testnet-rpc.publicnode.com --auto-impersonate --silent &
APID=$!
for i in $(seq 1 30); do cast block-number -r $RPC >/dev/null 2>&1 && break; sleep 1; done
kill -0 "$APID" 2>/dev/null || { echo "the anvil this script started is not running"; exit 1; }
[ "$(cast chain-id -r $RPC)" = 97 ] || { echo "not a fork of chain 97"; kill "$APID"; exit 1; }
echo "anvil $APID up at block $(cast block-number -r $RPC)"
cast rpc anvil_setBalance $DEPLOYER 0x16345785D8A0000 -r $RPC >/dev/null # 0.1 BNB on the fork
mkdir -p .cache/rehearse-shop
F="--rpc-url $RPC --sender $DEPLOYER --unlocked --broadcast --slow --legacy --with-gas-price 100000000"
TOTAL=0
stop() { kill "$APID"; wait "$APID" 2>/dev/null; exit "$1"; }
step() { # step <label> <dir> <script> [ENV=VALUE ...]
  local label=$1 dir=$2 script=$3; shift 3
  local start; start=$(date +%s)
  if ! (cd "$dir" && env "$@" forge script "script/$script" $F) > ".cache/rehearse-shop/$label.log" 2>&1; then
    echo "STEP $label FAILED"; grep -E "Error|revert|failed" ".cache/rehearse-shop/$label.log" | head -n 8; stop 1
  fi
  local gas
  gas=$(node -e 'const f=process.argv[1];let j;try{j=require(f)}catch(e){console.log("0 tx, gas 0");process.exit(0)}if(j.timestamp<Number(process.argv[2])){console.log("0 tx, gas 0");process.exit(0)}let s=0n;for(const x of j.receipts)s+=BigInt(x.gasUsed);console.log(j.receipts.length+" tx, gas "+s)' "$PWD/$dir/broadcast/$script/97/run-latest.json" "$start")
  echo "STEP $label: $gas"
  TOTAL=$((TOTAL + ${gas##* }))
}
refused() { # refused <label> <dir> <script> <reason> [ENV=VALUE ...]: a dry run that must stop with that reason
  local label=$1 dir=$2 script=$3 reason=$4; shift 4
  if (cd "$dir" && env "$@" forge script "script/$script" --rpc-url $RPC --sender $DEPLOYER) > ".cache/rehearse-shop/$label.log" 2>&1; then
    echo "REFUSAL $label MISSING"; stop 1
  fi
  if grep -q "$reason" ".cache/rehearse-shop/$label.log"; then echo "REFUSED $label: $reason"; else
    echo "REFUSAL $label FOR ANOTHER REASON"; grep -E "Error|revert" ".cache/rehearse-shop/$label.log" | head -n 5; stop 1
  fi
}
export DEPLOYMENTS_FILE=deployments/anvil-97-rules-usdt.json RULES_FILE=deployments/anvil-97-rules-usdt.json
export SALE_FILE=deployments/anvil-97-shop-rules-usdt-sale.json VARIANT=usdt
step factory ../core DeployRailShopFactory.s.sol RAIL_SHOP_FILE=deployments/anvil-97-rail-shop.json
FACTORY=$(node -e 'console.log(require(process.argv[1]).factory)' "$PWD/../core/deployments/anvil-97-rail-shop.json")
step rules . DeployRules.s.sol
step mint . TokenSale.s.sol ACTION=mint AMOUNT_WEI=5000000000000000000000
refused cap-above-supply . CreateShopRulesSale.s.sol "above the launch's fixed supply" RAIL_SHOP_FACTORY="$FACTORY" CAP=1000000000000
# The dry simulation (no --broadcast), as the real run's first command: it must list the buy and burn last.
(env RAIL_SHOP_FACTORY="$FACTORY" forge script script/CreateShopRulesSale.s.sol --rpc-url $RPC --sender $DEPLOYER) > .cache/rehearse-shop/dry.log 2>&1 \
  || { echo "DRY SIMULATION FAILED"; grep -E "Error|revert" .cache/rehearse-shop/dry.log | head -n 5; stop 1; }
echo "DRY SIMULATION: $(grep -E '^ *rule [0-9]' .cache/rehearse-shop/dry.log | tr -s ' ' | tr '\n' ';')"
grep -q "rule 3: kind 3, bps 2000" .cache/rehearse-shop/dry.log || { echo "the dry simulation does not put the buy and burn last"; stop 1; }
step create . CreateShopRulesSale.s.sol RAIL_SHOP_FACTORY="$FACTORY"
step buy . TokenSale.s.sol ACTION=buy MAX_COST_WEI=300000000000000000000
step complete . TokenSale.s.sol ACTION=complete
step claim . TokenSale.s.sol ACTION=claim
L=$(node -e 'console.log(require(process.argv[1]).launcher)' "$PWD/$SALE_FILE")
SHOP=$(node -e 'console.log(require(process.argv[1]).shop)' "$PWD/$SALE_FILE")
TOKEN=$(cast call "$L" "token()(address)" -r $RPC)
echo "the token's supply: $(cast call "$TOKEN" "totalSupply()(uint256)" -r $RPC)"
refused give-above-supply ../core CreateRailShop.s.sol "above the token's supply" TOKEN="$TOKEN" RAIL_SHOP_FILE=deployments/anvil-97-rail-shop.json GIVE_LEGENDARY=1000000000000000
step shop-existing ../core CreateRailShop.s.sol TOKEN="$TOKEN" RAIL_SHOP_FILE=deployments/anvil-97-rail-shop.json
echo "shops for the token: $(cast call "$FACTORY" "shopCount(address)(uint256)" "$TOKEN" -r $RPC), of this creator: $(cast call "$FACTORY" "shopCountBy(address,address)(uint256)" "$TOKEN" $DEPLOYER -r $RPC), the first: $(cast call "$FACTORY" "shopOfBy(address,address,uint256)(address)" "$TOKEN" $DEPLOYER 0 -r $RPC)"
VAULT=$(cast call "$L" "pileVault()(address)" -r $RPC)
echo "factory $FACTORY, shop $SHOP, token $TOKEN, rules vault $VAULT"
echo "the shop is the factory's: $(cast call "$FACTORY" "isShop(address)(bool)" "$SHOP" -r $RPC); its token: $(cast call "$SHOP" "token()(address)" -r $RPC)"
echo "rule 2, the shop (kind, bps, target): $(cast call "$VAULT" "rule(uint256)(uint8,uint16,address)" 2 -r $RPC | tr '\n' ' ')"
echo "rule 3, last (kind, bps, target): $(cast call "$VAULT" "rule(uint256)(uint8,uint16,address)" 3 -r $RPC | tr '\n' ' ')"
echo "the shop's waiting test dollars: $(cast call "$SHOP" "waiting()(uint256)" -r $RPC), cards: $(cast call "$SHOP" "cardCount()(uint256)" -r $RPC)"
echo "TOTAL gas: $TOTAL = $(node -e 'console.log((BigInt(process.argv[1])*100000000n).toString())' $TOTAL) wei at 0.1 gwei"
stop 0
