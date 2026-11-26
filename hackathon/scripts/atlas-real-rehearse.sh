#!/usr/bin/env bash
# SH-266: the operator tool's relay and pokes rehearsed on a fork of the real chain 97 as it stood just before the first
# real pokes (25 November, 19:35 +07): the setter already holds the lister role (the handover's own rehearsal is
# history). Nothing is sent to the real network. It asserts what it claims: the lister is the setter of the file, every
# send's receipt is a success (the tool stops otherwise), each poke's raise equals its quote (the tool checks), and the
# three raises after the pokes equal the ones recorded for the real pokes in deployments/bnb-testnet/97-atlas.json.
#   bash hackathon/scripts/atlas-real-rehearse.sh
set -euo pipefail
R=http://127.0.0.1:8583
REAL=https://bsc-testnet-rpc.publicnode.com
J=packages/contracts/deployments/bnb-testnet/97-atlas.json
field() { node -e 'const v = process.argv[2].split(".").reduce((o, k) => o[k], JSON.parse(require("fs").readFileSync(process.argv[1]))); process.stdout.write(String(v))' $J "$1"; }
LST=$(field listingRegistry)
SETTER=$(field setter)
BLOCK=$(cast receipt --rpc-url $REAL "$(field firstPokes.rows.0.hash)" blockNumber)
TS=$(cast block --rpc-url $REAL $BLOCK -f timestamp)
FORK=$((BLOCK - 1))
mkdir -p .cache/logs
anvil --fork-url $REAL --fork-block-number $FORK --port 8583 --no-storage-caching > .cache/logs/atlas-real-anvil.log 2>&1 &
A=$!
trap 'kill $A 2>/dev/null; wait $A 2>/dev/null; echo "anvil $A stopped"' EXIT
for _ in $(seq 1 60); do cast chain-id --rpc-url $R >/dev/null 2>&1 && break; sleep 1; done
# The fork's clock at the fork block (the next block follows it by a second), not the wall clock.
FTS=$(cast block --rpc-url $R latest -f timestamp)
cast rpc --rpc-url $R evm_setNextBlockTimestamp $((FTS + 1)) >/dev/null
cast rpc --rpc-url $R evm_mine >/dev/null
echo "fork at block $FORK (the real first poke was in $BLOCK at $TS); fork time $(cast block --rpc-url $R latest -f timestamp)"
LISTER=$(cast call --rpc-url $R $LST 'lister()(address)')
[ "$(echo $LISTER | tr A-F a-f)" = "$(echo $SETTER | tr A-F a-f)" ] || { echo "FAIL: the lister is $LISTER, not the setter $SETTER"; exit 1; }
echo "lister is the setter of the file: $LISTER"
cd packages/contracts
T() { node --experimental-transform-types script/bnb/atlas-real.mjs "$@" --fork $R; }
echo "== status"; T status
echo "== relay"; T relay
echo "== poke 0 2 3"; T poke 0 2 3
echo "== status"; T status
cd ../..
for i in 0 1 2; do
  ROW=$(field firstPokes.rows.$i.listingRow)
  WANT=$(field firstPokes.rows.$i.to)
  GOT=$(cast call --rpc-url $R $LST 'listing(uint32)((uint32,address,uint8,uint8,uint8,uint64,uint256,(uint256,uint256,uint256,uint256)))' $ROW | tr -d '()' | cut -d, -f7 | awk '{print $1}')
  [ "$GOT" = "$WANT" ] || { echo "FAIL: row $ROW raise $GOT, the real poke set $WANT"; exit 1; }
  echo "row $ROW: raise $GOT equals the real poke's"
done
echo "REHEARSAL OK"
