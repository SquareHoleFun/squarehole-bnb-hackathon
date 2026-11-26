#!/usr/bin/env bash
# Usage: [PORT=8599] hackathon/rail-shop/rehearse.sh   (from the repository's top, on the machine)
# SH-288: plays hackathon/rail-shop/commands.txt on a local fork of the BNB test network (anvil on PORT, refused when the
# port already answers) in the step runner's order: per step the dry call, the send, the check against its `# expect`.
# The sends come from the real wallets' addresses, impersonated (no key is read): `--account <name> --password-file
# <file>` becomes `--unlocked --from <address>` for cast and `--unlocked` for forge (whose line names --sender). The
# wallets keep their real test BNB, so a wallet short of gas fails here as it would there. Before the file it plays
# lane f's step that the file needs (DeployRules.s.sol: the test dollar rules pair, deployments/97-rules-usdt.json).
# Prints per step the gas (the new blocks' gasUsed; anvil mines one transaction per block) and, at the end, what each
# wallet spent in test BNB. The deployment files it writes are the machine copy's own (never committed).
set -u
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 1
FILE=${FILE:-hackathon/rail-shop/commands.txt}
PORT=${PORT:-8599}
export RPC=http://127.0.0.1:$PORT
export SHOP_NAME=${SHOP_NAME:-Swap Deck} SHOP_SYMBOL=${SHOP_SYMBOL:-SDECK}
META_SHOP=${META_SHOP:-https://arweave.net/rehearsal#sha256=00}
declare -A ADDR=([hack-deployer]=0x2EF9A78074bbf674bEA16f21154a30c821A3C576 [hack-alice]=0x2908E3351ec8F20a8a6746773e42EA1D2FFb3c7F [hack-bob]=0xc979F6Cb8902f56f76b926358dC451cBF8f310F0)
if cast chain-id -r "$RPC" >/dev/null 2>&1; then echo "port $PORT already answers: not ours, refused"; exit 1; fi
anvil --port "$PORT" --fork-url https://bsc-testnet-rpc.publicnode.com --auto-impersonate --silent &
APID=$!
for _ in $(seq 1 30); do cast block-number -r "$RPC" >/dev/null 2>&1 && break; sleep 1; done
kill -0 "$APID" 2>/dev/null || { echo "the anvil this script started is not running"; exit 1; }
[ "$(cast chain-id -r "$RPC")" = 97 ] || { echo "not a fork of chain 97"; kill "$APID"; exit 1; }
stop() { kill "$APID"; wait "$APID" 2>/dev/null; exit "$1"; }
LOG=.cache/rail-shop-rehearsal; mkdir -p "$LOG"
echo "anvil $APID up at block $(cast block-number -r "$RPC")"
declare -A BAL0
for w in "${!ADDR[@]}"; do BAL0[$w]=$(cast balance "${ADDR[$w]}" -r "$RPC"); echo "$w ${ADDR[$w]}: $(cast from-wei "${BAL0[$w]}") tBNB"; done

gas_since() { # the gas of every block after $1
  local s=0 b
  for b in $(seq $(($1 + 1)) "$(cast block-number -r "$RPC")"); do s=$((s + $(cast block "$b" --field gasUsed -r "$RPC"))); done
  echo "$s"
}
unlock() { # the send line with the keystore flags replaced by impersonation
  local line=$1 w
  w=$(sed -nE 's/.*--account ([a-z-]+) .*/\1/p' <<<"$line")
  [ -n "$w" ] || { echo "$line"; return; }
  if [[ $line == *"forge script"* ]]; then
    sed -E "s# --account $w --password-file [^ )]+# --unlocked#" <<<"$line"
  else
    sed -E "s# --account $w --password-file [^ )]+# --unlocked --from ${ADDR[$w]}#" <<<"$line"
  fi
}
check() { # check <line>: run the read, compare with its expect
  local line=$1 cmd want got
  cmd=${line%%# expect*}; want=$(sed -nE 's/.*# expect (.*)$/\1/p' <<<"$line")
  got=$(bash -c "$cmd" 2>&1 | head -n 1 | cut -d' ' -f1)
  if [[ $want == '>='* ]]; then
    node -e 'process.exit(/^[0-9]+$/.test(process.argv[1]) && BigInt(process.argv[1]) >= BigInt(process.argv[2]) ? 0 : 1)' "$got" "${want#>=}" && { echo "$got"; return 0; }
  elif [ "${got,,}" = "${want,,}" ]; then echo "$got"; return 0; fi
  echo "WANTED $want, GOT $got"; return 1
}

# lane f's step before the file: the test dollar rules pair
B0=$(cast block-number -r "$RPC")
if ! (cd bounties/flap && DEPLOYMENTS_FILE=deployments/97-rules-usdt.json forge script script/DeployRules.s.sol --sender "${ADDR[hack-deployer]}" --rpc-url "$RPC" --legacy --with-gas-price 100000000 --slow --unlocked --broadcast) > "$LOG/0-rules.log" 2>&1; then
  echo "lane f's rules pair FAILED"; grep -E "Error|revert" "$LOG/0-rules.log" | head -n 5; stop 1
fi
echo "0 lane f's test dollar rules pair (before the file): gas $(gas_since "$B0")"

TOTAL=0; n=''; what=''; lines=()
run_step() {
  [ -n "$n" ] || return 0
  local dry=${lines[0]//<META_SHOP>/$META_SHOP} send=${lines[1]//<META_SHOP>/$META_SHOP} chk=${lines[2]}
  if ! bash -c "$dry" > "$LOG/$n-dry.log" 2>&1; then echo "STEP $n DRY CALL FAILED: $what"; grep -E "Error|revert" "$LOG/$n-dry.log" | head -n 5; stop 1; fi
  local b0; b0=$(cast block-number -r "$RPC")
  if ! bash -c "$(unlock "$send")" > "$LOG/$n-send.log" 2>&1; then echo "STEP $n SEND FAILED: $what"; grep -E "Error|revert" "$LOG/$n-send.log" | head -n 5; stop 1; fi
  local g; g=$(gas_since "$b0"); TOTAL=$((TOTAL + g))
  local got; if ! got=$(check "$chk"); then echo "STEP $n CHECK FAILED: $what: $got"; stop 1; fi
  echo "STEP $n gas $g, check $got: $what"
  if [ -n "${PROBE:-}" ]; then bash -c "$PROBE" 2>/dev/null; fi
}
while IFS= read -r line || [ -n "$line" ]; do
  if [[ $line =~ ^#\ ([0-9]+)\ (.*)$ ]]; then run_step; n=${BASH_REMATCH[1]}; what=${BASH_REMATCH[2]}; lines=(); continue; fi
  if [[ -n $n && -n $line && $line != \#* ]]; then lines+=("$line"); [ ${#lines[@]} -eq 3 ] && { run_step; n=''; }; continue; fi
  if [[ $line == "# The reads a page shows"* ]]; then break; fi
done < "$FILE"
echo "THE READS A PAGE SHOWS"
sed -n '/^# The reads a page shows/,$p' "$FILE" | grep '^cast call' | while IFS= read -r line; do
  if [[ $line == *"# expect"* ]]; then echo "  $(check "$line") <- ${line##*\'}"; else echo "  $(bash -c "${line%%#*}" 2>&1 | tr '\n' ' ') <- ${line##*# }"; fi
done
echo "TOTAL gas of the file: $TOTAL"
for w in "${!ADDR[@]}"; do echo "$w spent $(cast from-wei "$(node -e 'console.log((BigInt(process.argv[1])-BigInt(process.argv[2])).toString())' "${BAL0[$w]}" "$(cast balance "${ADDR[$w]}" -r "$RPC")")") tBNB"; done
SALE=bounties/flap/deployments/97-shop-rules-usdt-sale.json
echo "ADDRESSES: factory $(jq -r .factory bounties/core/deployments/97-rail-shop.json); $(jq -c . "$SALE")"
L=$(jq -r .launcher "$SALE"); T=$(jq -r .token "$SALE")
echo "rules vault $(cast call "$L" 'pileVault()(address)' -r "$RPC"); pile $(cast call "$(cast call "$L" 'pileVault()(address)' -r "$RPC")" 'factory()(address)' -r "$RPC" | xargs -I{} cast call {} 'pileOf(address)(address)' "$T" -r "$RPC"); pool $(cast call "$L" 'launchInfo()(address,address,address)' -r "$RPC" | sed -n 2p); token supply $(cast call "$T" 'totalSupply()(uint256)' -r "$RPC")"
stop 0
