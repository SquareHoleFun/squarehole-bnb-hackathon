#!/usr/bin/env bash
# SH-266: the PACKAGED keeper (infra/server/services/run.mjs keeper, the entry the stack starts) in DRY RUN on a fork of
# the real BNB Chain testnet, with Atlas on, then the same with Atlas off (the reviewed pins), to compare what it would do.
# Before the keeper starts: AtlasMirror, AtlasSource and AtlasRaiseSetter deployed, the keeper's first relay, the
# handover (all on the fork, impersonating the deployer and the keeper; nothing is sent to the real network).
# The fork's own copy of Atlas's BNB/USD feed stops at the fork block, so the keeper's fallback endpoint is the real test
# network: the reader judges each endpoint whole and takes the fresh answer from the second one.
#
#   bash hackathon/scripts/atlas-dry-run.sh [seconds per run, default 150]
# Output: .cache/atlas-dry/<time>/ (anvil and keeper logs, the monitor views, summary.txt). Anvil on 8583 is stopped.
set -u
secs=${1:-150}
root=$(pwd)
out="$root/.cache/atlas-dry/$(date +%s)"
mkdir -p "$out/state-atlas" "$out/state-pins"
R=http://127.0.0.1:8583
REAL97=https://bsc-testnet-rpc.publicnode.com
DEP=0x2EF9A78074bbf674bEA16f21154a30c821A3C576
KEEP=0x920B1439BC0BF2f30f9E01B9Bb94d90A9ba35189
LST=0xcCf0B8CC9257DB834d77F29EA9eB8e5554ba0170
REG=0xf77ef448bbc61d559ee8f657ce3a0b59f1af0daf
FROM=144754031
anvil --fork-url "$REAL97" --port 8583 --no-storage-caching --block-time 1 > "$out/anvil.log" 2>&1 &
anvil_pid=$!
keeper_pid=
cleanup() { [ -n "$keeper_pid" ] && kill "$keeper_pid" 2>/dev/null; kill "$anvil_pid" 2>/dev/null; wait "$anvil_pid" 2>/dev/null; echo "anvil $anvil_pid stopped" >> "$out/summary.txt"; }
trap cleanup EXIT
for _ in $(seq 1 60); do cast chain-id --rpc-url $R >/dev/null 2>&1 && break; sleep 1; done
echo "fork block $(cast block-number --rpc-url $R) time $(cast block --rpc-url $R latest -f timestamp)" | tee "$out/summary.txt"
for a in $DEP $KEEP; do cast rpc --rpc-url $R anvil_impersonateAccount $a >/dev/null; done
cast rpc --rpc-url $R anvil_setBalance $DEP 0x56BC75E2D63100000 >/dev/null
# The keeper's wallet as on the real network plus room for its simulations (lane b: anvil refuses an eth_call whose
# default gas at the fee is more than the balance).
cast rpc --rpc-url $R anvil_setBalance $KEEP 0x2386F26FC10000 >/dev/null
export FOUNDRY_LINT_LINT_ON_BUILD=false FOUNDRY_OFFLINE=true
( cd packages/contracts && forge script script/bnb/AtlasRaiseDeploy.s.sol:AtlasRaiseDeploy --sig 'run(address,address,uint256)' $LST $KEEP 1000000000000000000 \
  --rpc-url $R --unlocked --sender $DEP --broadcast --slow --legacy --with-gas-price 100000000 ) > "$out/deploy.log" 2>&1 || { echo "deploy failed" | tee -a "$out/summary.txt"; exit 1; }
MIRROR=$(grep -o 'BNB|atlasMirror|0x[0-9a-fA-F]*' "$out/deploy.log" | head -1 | cut -d'|' -f3)
SOURCE=$(grep -o 'BNB|atlasSource|0x[0-9a-fA-F]*' "$out/deploy.log" | head -1 | cut -d'|' -f3)
SETTER=$(grep -o 'BNB|atlasRaiseSetter|0x[0-9a-fA-F]*' "$out/deploy.log" | head -1 | cut -d'|' -f3)
echo "mirror $MIRROR source $SOURCE setter $SETTER" | tee -a "$out/summary.txt"
SNAPS="["; for f in 0xb3d1614Bf894E68ADd1EA50CA250C152BAd5256F 0x3eF39d6361EfA1E8Ca066751f438077dA81082A6 0xB3C87F255CE00b2692dc0eaf3e5985fBe2489764; do
  A=$(cast call --rpc-url $REAL97 --from $KEEP $f 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --json)
  SNAPS="$SNAPS$(node -e 'const a = JSON.parse(process.argv[1]); process.stdout.write(`(${a[1]},${a[2]},${a[3]}),`);' "$A")"
done; SNAPS="${SNAPS%,}]"
cast send --rpc-url $R --unlocked --from $KEEP --legacy --gas-price 100000000 $MIRROR 'push(bytes4[],(uint80,uint48,uint48)[])' '[0x00000279,0x000003a6,0x58415500]' "$SNAPS" > "$out/push.log" 2>&1 || { echo "first relay failed" | tee -a "$out/summary.txt"; exit 1; }
cast rpc --rpc-url $R evm_increaseTime 3 >/dev/null; cast rpc --rpc-url $R evm_mine >/dev/null
( cd packages/contracts && forge script script/bnb/AtlasRaiseDeploy.s.sol:AtlasRaiseDeploy --sig 'handover(address,address,address,uint256,address)' $LST $SETTER $KEEP 1000000000000000000 0x974d108cf896fb4b0981a13df759349d44296d27 \
  --rpc-url $R --unlocked --sender $DEP --broadcast --slow --legacy --with-gas-price 100000000 ) > "$out/handover.log" 2>&1 || { echo "handover failed" | tee -a "$out/summary.txt"; tail -5 "$out/handover.log" >> "$out/summary.txt"; exit 1; }
echo "lister $(cast call --rpc-url $R $LST 'lister()(address)')" | tee -a "$out/summary.txt"

# The stack's keeper settings (hackathon/stack/keeper.env.example), without the key file and the endpoints.
mapfile -t settings < <(grep -E '^SH_[A-Z_]+=[^<]*$' hackathon/stack/keeper.env.example | grep -v 'SH_KEEPER_KEY_FILE\|SH_KEEPER_RPC\|SH_SERVICE_')
run_keeper() {  # $1 name, then extra settings
  local name=$1; shift
  env -i PATH="$PATH" HOME="$HOME" "${settings[@]}" SH_SERVICE_ENABLED=1 SH_SERVICE_MODE=dry-run SH_KEEPER_RPC_URL=$R SH_KEEPER_RPC_FALLBACK_URL=$REAL97 \
    SH_KEEPER_ADDRESS=$KEEP SH_KEEPER_BOX_REGISTRY=$REG SH_KEEPER_FROM_BLOCK=$FROM SH_ATLAS_DRY_STATE="$out/state-$name" "$@" \
    node --import ./hackathon/scripts/atlas-state-redirect.mjs --experimental-transform-types --no-warnings=ExperimentalWarning \
      --import ./packages/keeper/scripts/register-ts.mjs infra/server/services/run.mjs keeper > "$out/keeper-$name.log" 2>&1 &
  keeper_pid=$!
  sleep "$secs"
  kill "$keeper_pid" 2>/dev/null; wait "$keeper_pid" 2>/dev/null; keeper_pid=
  {
    echo "== keeper, $name: $(wc -l < "$out/keeper-$name.log") log lines"
    grep -o 'keeper: atlas[^{]*' "$out/keeper-$name.log" | sort | uniq -c
    grep -o 'keeper: box=[0-9]* job=[a-zA-Z]* reason=[A-Z_]*' "$out/keeper-$name.log" | sort | uniq -c
    grep -m 3 'keeper: atlas: income valued\|keeper: atlas: no fresh\|keeper: atlas relay: would send' "$out/keeper-$name.log"
  } | tee -a "$out/summary.txt"
}
run_keeper atlas SH_KEEPER_ATLAS=1
run_keeper pins SH_KEEPER_ATLAS=0
cp "$out/state-atlas/monitor.json.dry" "$out/monitor-atlas.json" 2>/dev/null
cp "$out/state-pins/monitor.json.dry" "$out/monitor-pins.json" 2>/dev/null
echo "done $out" | tee -a "$out/summary.txt"
