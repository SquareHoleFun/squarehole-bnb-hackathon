#!/usr/bin/env bash
# A dress rehearsal of the real run, on a LOCAL fork only: the steps of scripts/steps.sh (the real run's list), in
# order, signed from an encrypted keystore through the same preload and preflight, with the same fail-fast rule. In
# place of tETH it uses a coin of its own. The keystore is a throwaway for a PUBLIC test key with a random password,
# both under .cache/ (never committed). Proofs added at the marked points (and at the start):
#   - the kit completed but the wrapper stopped before importing: recovered from the kit's file, nothing sent;
#   - a quote coin with 6 decimals is refused before anything is signed;
#   - a trade stopped after signing, after sending, after mining (before its checks); a redemption stopped after
#     sending and after mining; a graduation round stopped after mining; an approval of one action finished by
#     another command (which then refuses to run itself, exit 4): each rerun finishes the same action, and the
#     number of transactions on chain equals the number of intended actions;
#   - the handoff: scripts/check-real.js passes once before set-signer (Core's signer the run wallet) and once after
#     (the address set-signer recorded), then the signing service's proofs (scripts/service-proof.js).
# usage: scripts/rehearse-local.sh [port]   (default 8579)
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${1:-8579}
npx hardhat compile --quiet
KS_DIR=.cache/rehearsal-keystore
ADDR=$(node scripts/make-rehearsal-keystore.js "$KS_DIR" | tail -n 1)
ADDR=$(node -e 'console.log(require("ethers").getAddress(process.argv[1]))' "$ADDR")
source scripts/local-fork.sh
fund "$ADDR"
# What the real run sets instead: its own keystore and password file, the public endpoint, no local-fork switch.
export OPENFOUR_KEYSTORE=$KS_DIR/rehearsal.json OPENFOUR_KEYSTORE_PASSWORD_FILE=$KS_DIR/password
STEP_LOG=$OPENFOUR_OUT_DIR/last-step.log
kit() { node -r ./scripts/signer-preload.js scripts/kit.js "$@" --expect-signer "$ADDR"; }
pile() { node -r ./scripts/signer-preload.js scripts/pile.js "$@" --expect-signer "$ADDR"; }
source scripts/steps.sh
nonce() { cast nonce "$ADDR" --rpc-url "$RPC"; }
crash() { # crash <operation:stage> <command...>: must end with the simulated crash (exit 9)
  local at=$1 code=0; shift
  echo "== crash at $at: $*"
  OPENFOUR_TEST_CRASH=$at "$@" || code=$?
  [ "$code" = 9 ] || { echo "== STOP: expected the simulated crash at $at, got exit $code"; exit 1; }
}
count() { node scripts/count-calls.js "$RPC" "$OPENFOUR_OUT_DIR" "$ADDR" "$@"; }

# The kit completed, the import did not happen; the next run recovers it from the kit's file and sends nothing.
crash fork:before-import kit fork
n0=$(nonce)
run_step "OK fork" "kit fork"
grep -q "recovered the copy the kit completed earlier" "$STEP_LOG" || { echo "== STOP: not a recovery"; exit 1; }
[ "$(nonce)" = "$n0" ] || { echo "== STOP: the recovery sent a transaction"; exit 1; }
echo "== recovered with no transaction (nonce $n0)"
run_step "OK mock-quote" "pile mock-quote"
TETH=$(node -e 'console.log(require(process.argv[1]).quote)' "$PWD/$OPENFOUR_OUT_DIR/mock-quote.json")
WBNB=$(node -e 'console.log(require(process.argv[1]).addresses.wbnb)' "$PWD/$OPENFOUR_OUT_DIR/fork-deployment.json")

decimals_proof() {
  local six n code=0
  six=$(node -r ./scripts/signer-preload.js scripts/deploy-test-coin.js --expect-signer "$ADDR" | tail -n 1)
  n=$(nonce)
  QUOTE=$six pile create-tax > "$STEP_LOG" 2>&1 || code=$?
  cat "$STEP_LOG"
  grep -q "has 6 decimals: only 18-decimal quote coins are supported" "$STEP_LOG" && [ "$code" = 2 ] && [ "$(nonce)" = "$n" ] \
    || { echo "== STOP: the 6-decimal quote was not refused before signing"; exit 1; }
  echo "== a 6-decimal quote coin is refused before anything is signed (exit 2, nonce unchanged)"
}

crash_proofs() {
  local b0 stage rounds
  b0=$(( $(cast block-number --rpc-url "$RPC") + 1 )) # from the next block: the current one holds the step before
  for stage in signed sent mined; do
    crash "preset.crash-buy-$stage.buy:$stage" pile buy 1000000 --launch preset --action "crash-buy-$stage"
    run_step "OK preset.crash-buy-$stage" "pile buy 1000000 --launch preset --action crash-buy-$stage"
    run_step "OK preset.crash-buy-$stage" "pile buy 1000000 --launch preset --action crash-buy-$stage"
    grep -q "done before; nothing sent" "$STEP_LOG" || { echo "== STOP: the third run of the same action did something"; exit 1; }
  done
  count "$b0" core "buy(address,uint256,uint256,uint256,bytes)" 3
  for stage in sent mined; do
    crash "preset.crash-redeem-$stage.redeem:$stage" pile redeem 1000000 --launch preset --action "crash-redeem-$stage"
    run_step "OK preset.crash-redeem-$stage" "pile redeem 1000000 --launch preset --action crash-redeem-$stage"
  done
  count "$b0" preset-pile "redeem(uint256,uint256)" 2
  crash "preset.crash-sell.approve:mined" pile sell 1000000 --launch preset --action crash-sell
  local code=0
  pile status --launch preset > /dev/null
  pile redeem 1000000 --launch preset --action crash-other > "$STEP_LOG" 2>&1 || code=$?
  cat "$STEP_LOG"
  { [ "$code" = 4 ] && grep -q "finished and verified an earlier operation: preset.crash-sell.approve" "$STEP_LOG"; } \
    || { echo "== STOP: another command did not finish the open approval and stop with exit 4"; exit 1; }
  run_step "OK preset.crash-sell" "pile sell 1000000 --launch preset --action crash-sell"
  count "$b0" core "sell(address,uint256,uint256,uint256,bytes)" 1
  crash "preset.preset-grad-1.r1.buy:mined" pile graduate 0.3 --launch preset --action preset-grad-1
  run_step "OK preset.preset-grad-1" "pile graduate 0.3 --launch preset --action preset-grad-1"
  rounds=$(ls "$OPENFOUR_OUT_DIR"/actions/preset.preset-grad-1.r*.json | wc -l)
  count "$b0" core "buyByBudget(address,uint256,uint256,uint256,bytes)" "$rounds"
  echo "== crash proofs: every rerun finished the same action; transactions on chain = intended actions"
}

expect_exit() { # expect_exit <code> <text> <command...>: the command must end with that exit code and print that text
  local want=$1 text=$2 code=0; shift 2
  "$@" > "$STEP_LOG" 2>&1 || code=$?
  cat "$STEP_LOG"
  { [ "$code" = "$want" ] && grep -qF "$text" "$STEP_LOG"; } || { echo "== STOP: expected exit $want with \"$text\", got exit $code"; exit 1; }
}
records() { node -e "$1" "$PWD/$OPENFOUR_OUT_DIR"; }

create_crash() {
  local b0
  b0=$(( $(cast block-number --rpc-url "$RPC") + 1 ))
  QUOTE=$WBNB RAISE_AMOUNT=0.1 crash launch-tax.create:sent pile create-tax
  run_step "OK create-tax" "QUOTE=\$WBNB RAISE_AMOUNT=0.1 pile create-tax"
  count "$b0" core "createToken(bytes,bytes)" 1
}

foreign_proofs() {
  local d=$OPENFOUR_OUT_DIR
  # A deployment file of another copy (here: a copy of ours naming another Registry, consistently) is refused.
  mv "$d/fork-deployment.json" "$d/fork-deployment.json.mine"
  records 'const f=JSON.parse(require("fs").readFileSync(process.argv[1]+"/fork-deployment.json.mine", "utf8")); f.addresses.registry=f.addresses.tools; f.run.registry=f.addresses.tools; require("fs").writeFileSync(process.argv[1]+"/fork-deployment.json", JSON.stringify(f))'
  expect_exit 2 "is not this attempt's copy" kit fork
  mv "$d/fork-deployment.json.mine" "$d/fork-deployment.json"
  # A plan of another run (another endpoint in its identity) is refused, and nothing is sent.
  records 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1]+"/actions/tax.tax-buy-1.json")); p.run.endpoint="https://bsc-testnet.publicnode.com"; p.done=false; fs.writeFileSync(process.argv[1]+"/actions/tax.foreign-1.json", JSON.stringify(p))'
  local n
  n=$(nonce)
  expect_exit 2 "belongs to another run or copy" pile buy 50000000 --launch tax --action foreign-1
  [ "$(nonce)" = "$n" ] || { echo "== STOP: a foreign plan led to a transaction"; exit 1; }
  echo "== a foreign deployment file and a foreign plan are refused"
}

setup_proof() {
  # The module registration is mined, then the process stops before its readback: the record must say "mined".
  crash register.upsert-module:mined pile register
  records 'const r=require(process.argv[1]+"/ops/register.upsert-module.json"); if (r.status!=="mined") { console.error("stopped: status "+r.status); process.exit(1) } console.log("== interrupted before its readback, the module registration is \"mined\", not \"verified\"")'
  # Another command finishes it through its readback (the Registry's module), says so, and stops with exit 4.
  expect_exit 4 "finished and verified an earlier operation: register.upsert-module" pile mock-quote
  records 'const r=require(process.argv[1]+"/ops/register.upsert-module.json"); if (r.status!=="verified") process.exit(1)'
}

allowance_proof() {
  # A capped buy leaves a remainder; the revoke is mined and the process stops before the action completes. The
  # rerun sends no new approval and completes only with the allowance at zero.
  local b0 left
  b0=$(( $(cast block-number --rpc-url "$RPC") + 1 ))
  crash preset.crash-allow.revoke:mined pile buy 1000000 --launch preset --action crash-allow
  run_step "OK preset.crash-allow" "pile buy 1000000 --launch preset --action crash-allow"
  count "$b0" core "buy(address,uint256,uint256,uint256,bytes)" 1
  left=$(cast call "$TETH" "allowance(address,address)(uint256)" "$ADDR" "$(records 'console.log(require(process.argv[1]+"/fork-deployment.json").addresses.core)')" --rpc-url "$RPC")
  [ "$left" = 0 ] || { echo "== STOP: allowance left: $left"; exit 1; }
  echo "== after the restart the action completed with the allowance at 0"
}

check_real() { # check_real <label> <the signer line it must print>: the read-only check of the run, on the fork
  local log="$OPENFOUR_OUT_DIR-status-$1.log" out="$OPENFOUR_OUT_DIR-check-$1.log"
  { pile status --launch tax; pile status --launch preset; } > "$log" 2>&1 # the figures now; sends nothing
  echo "== check-real $1"
  node scripts/check-real.js "$OPENFOUR_OUT_DIR" "$log" 2>&1 | tee "$out" || true # judged by the lines below
  [ "$(tail -n 1 "$out")" = "OK check-real" ] && grep -qF "pass  Core's signer is $2" "$out" \
    || { echo "== STOP: check-real $1 did not pass with: Core's signer is $2"; exit 1; }
}

SVC_DIR="$OPENFOUR_OUT_DIR-service-key" SVC= # the service's key: a random one made in service_proof, in a folder of this run only
service_proof() {
  local dir="$SVC_DIR" svc
  svc=$(node scripts/make-rehearsal-keystore.js "$dir" random | tail -n 1)
  svc=$(node -e 'console.log(require("ethers").getAddress(process.argv[1]))' "$svc")
  SVC=$svc
  check_real before "the run wallet $ADDR (no completed set-signer operation in the records)"
  run_step "OK set-signer" "pile set-signer --keystore $dir/rehearsal.json --password-file $dir/password" # the real handoff's form
  grep -q "the service keystore's address: $svc" "$STEP_LOG" || { echo "== STOP: set-signer did not derive $svc from the keystore"; exit 1; }
  check_real after "$svc, the address of the last completed set-signer operation"
  node scripts/service-proof.js "$OPENFOUR_OUT_DIR" "$dir/rehearsal.json" "$dir/password" "$TETH" "$svc" "$KS_DIR/rehearsal.json" "$KS_DIR/password"
}

for entry in "${STEPS[@]}"; do
  expect=${entry%%|*}
  case "$expect" in
    REHEARSAL-DECIMALS-PROOF) decimals_proof ;;
    REHEARSAL-CRASH-PROOFS) allowance_proof; crash_proofs ;;
    REHEARSAL-CREATE-CRASH) create_crash ;;
    REHEARSAL-FOREIGN-PROOFS) foreign_proofs ;;
    REHEARSAL-SETUP-PROOF) setup_proof ;;
    REHEARSAL-SERVICE-PROOF) service_proof ;;
    *) b0=$(cast block-number --rpc-url "$RPC"); run_step "$expect" "${entry#*|}"; echo "== cost: $(gas_since "$b0" "$(cast block-number --rpc-url "$RPC")")" ;;
  esac
done
# SH-287: the rules launch, the day's steps after the run (scripts/rules-steps.sh), with the handover back to the run
# wallet and to the service's key again (round 2), check-real before and after, the dry mode, then the service's
# tax-rules kind through its production factory.
SERVICE_KEYSTORE=$SVC_DIR/rehearsal.json SERVICE_PASSWORD_FILE=$SVC_DIR/password
# The real launch's name, symbol and a made-up picture link of the real link's form and length (135 characters).
RULES_NAME=Snip RULES_SYMBOL=SNIP
RULES_TOKEN_URI="https://arweave.net/$(printf 'a%.0s' $(seq 43))#sha256=$(printf '0%.0s' $(seq 64))"
[ ${#RULES_TOKEN_URI} = 135 ] || { echo "== STOP: the rehearsal's link is not 135 characters"; exit 1; }
source scripts/rules-steps.sh
n=$(nonce)
dry=$(OPENFOUR_DRY=1 pile tax-rules-template 2>&1) || { echo "$dry"; echo "== STOP: the dry mode failed"; exit 1; }
echo "$dry"
[ "$(tail -n 1 <<< "$dry")" = "DRY tax-rules-template" ] && [ "$(nonce)" = "$n" ] && [ ! -e "$OPENFOUR_OUT_DIR/ops/tax-rules-template.json" ] \
  || { echo "== STOP: the dry mode sent or recorded something"; exit 1; }
echo "== dry mode: simulated, nothing sent, nothing recorded"
check_real rules-before "$SVC, the address of the last completed set-signer operation"
rehearsal_check() {
  case "$1" in
    window) check_real "rules-window-$ROUND" "$ADDR, the address of the last completed set-signer operation" ;;
    after) check_real "rules-after-$ROUND" "$SVC, the address of the last completed set-signer operation" ;;
  esac
}
# A stop inside the window: the handback, the creation stopped right after signing, the restore (its first try
# finishes the signed creation and stops with exit 4, the second sets the service's key), then the retry in round 3.
run_step "OK tax-rules-template" "pile tax-rules-template"
run_step "OK set-signer" "pile set-signer --back-to-wallet --round 2"
QUOTE=$WBNB RAISE_AMOUNT=0.1 RULES=2000,5000,3000 NAME="$RULES_NAME" SYMBOL="$RULES_SYMBOL" TOKEN_URI="$RULES_TOKEN_URI" crash launch-tax-rules.create:signed pile create-tax-rules
rules_restore || { echo "== STOP: the restore failed"; exit 1; }
rehearsal_check after
ROUND=3
run_rules rehearsal_check
# The created token carries the name, the symbol and the link: Core's TokenCreated (what the site reads) and the token.
node -e '
const { ethers } = require("ethers");
const fs = require("fs");
(async () => {
  const [rpc, dir, name, symbol, uri] = process.argv.slice(1);
  const p = new ethers.JsonRpcProvider(rpc);
  const l = JSON.parse(fs.readFileSync(dir + "/launch-tax-rules.json", "utf8"));
  const core = new ethers.Interface([require(process.cwd() + "/lib/openfour").ABI.core.find((x) => x.startsWith("event TokenCreated"))]);
  const rec = await p.getTransactionReceipt(l.createTx);
  const ev = rec.logs.map((x) => { try { return core.parseLog(x); } catch { return null; } }).find((e) => e);
  const t = new ethers.Contract(l.token, ["function name() view returns (string)", "function symbol() view returns (string)"], p);
  const got = [ev.args.name, ev.args.symbol, ev.args.tokenMetaUri, await t.name(), await t.symbol()];
  console.log(`== the rules launch ${l.token}: TokenCreated name "${got[0]}", symbol "${got[1]}", tokenMetaUri "${got[2]}" (${got[2].length} characters); token.name() "${got[3]}", token.symbol() "${got[4]}"`);
  if (JSON.stringify(got) !== JSON.stringify([name, symbol, uri, name, symbol])) { console.log("== STOP: the launch does not carry the name, symbol and link"); process.exit(1); }
})();' "$RPC" "$OPENFOUR_OUT_DIR" "$RULES_NAME" "$RULES_SYMBOL" "$RULES_TOKEN_URI"
run_step "OK set-signer" "pile set-signer --back-to-wallet --round 2" # a rerun after the round closed sends nothing
SERVICE_PROOF_RULES=1 node scripts/service-proof.js "$OPENFOUR_OUT_DIR" "$SVC_DIR/rehearsal.json" "$SVC_DIR/password" "$WBNB" "$SVC" "$KS_DIR/rehearsal.json" "$KS_DIR/password"
# What the run spent of its coins (the tETH stand-in includes the crash proofs' extra buys: an upper bound).
node -e '
const { ethers } = require("ethers");
(async () => {
  const [rpc, who, wbnb, teth] = process.argv.slice(1);
  const p = new ethers.JsonRpcProvider(rpc);
  const bal = (t) => new ethers.Contract(t, ["function balanceOf(address) view returns (uint256)"], p).balanceOf(who);
  console.log(`== left after the run: ${ethers.formatEther(await bal(wbnb))} of the 0.15 WBNB wrapped; ${ethers.formatEther(1000000n * 10n ** 18n - (await bal(teth)))} of the tETH stand-in spent`);
})();' "$RPC" "$ADDR" "$WBNB" "$TETH"
echo "== rehearsal done"
