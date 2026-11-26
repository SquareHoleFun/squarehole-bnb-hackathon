#!/usr/bin/env bash
# Level 2 of the guide in one command: everything on your own computer, on local chains with chain id 97.
#   1. the pinned libraries and the packages (skipped when present);
#   2. the contracts the deployment driver needs, compiled alone (not the full contract build);
#   3. the deployment driver's rehearsal: the whole platform deployed step by step on a local chain 97, every receipt
#      read back, the chain's state written to a dump;
#   4. the three demo boxes, each created from its settings through the site's own launch code on a local chain
#      started from that dump, read back field by field and lived to its payouts;
# Each step prints its result; the script stops at the first step that fails. It sends nothing to any network: the
# chains are local (anvil).
#
# usage: bash hackathon/public/up.sh        (from the top folder of the copy)
# ports: SH_UP_CHAIN_PORT (default 8573) for step 3, SH_UP_BOX_PORT (default 8575) for step 4.
set -euo pipefail
cd "$(dirname "$0")/../.."
CHAIN_PORT=${SH_UP_CHAIN_PORT:-8573}
BOX_PORT=${SH_UP_BOX_PORT:-8575}
OUT=.cache/up
say() { printf '\n== %s (%s)\n' "$1" "$(date +%H:%M:%S)"; }

say "0. tools"
for tool in node pnpm forge anvil cast jq curl git; do command -v "$tool" > /dev/null || { echo "up: $tool is missing"; exit 1; }; done
node --version; pnpm --version; forge --version | head -1
for port in "$CHAIN_PORT" "$BOX_PORT"; do
  if curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$port" 2>/dev/null; then echo "up: port $port answers already"; exit 1; fi
done

say "1. libraries and packages"
[ -f packages/contracts/lib/forge-std/src/Test.sol ] || bash hackathon/public/fetch-libraries.sh
[ -d node_modules ] || pnpm install --frozen-lockfile

say "2. the contracts the deployment driver needs"
(cd packages/contracts && forge build script/bnb script/local/LocalQuoteMocks.sol lib/v4-core/src/PoolManager.sol \
  src/box-v2/modules/AlchemistFeeModuleV21.sol src/box-v2/set/SetFactoryV2.sol src/box/randomness/DrandSource.sol \
  test/research/hookgas/HookGasKit.sol)

say "3. the platform deployed by the deployment driver on a local chain 97 (port $CHAIN_PORT)"
rm -rf .cache/up/plain
(cd packages/contracts && node --experimental-transform-types script/bnb/bnb-testnet.mjs rehearse --mode plain \
  --port "$CHAIN_PORT" --out "../../$OUT/plain" --dump "../../$OUT/plain/anvil-state.json")
# The boxes start from this rehearsal: its chain dump and address files, and the create options of its factory (the
# release's configuration file, keyed by the factory's address, which the rehearsal does not write).
FILES=$OUT/files
rm -rf .cache/up/files
cp -r "$OUT/plain/files" "$FILES"
gzip -c "$OUT/plain/anvil-state.json" > "$FILES/anvil-state.json.gz"
factory=$(jq -r '.releases[0].factory.address' "$FILES/core-v1/97.json")
mkdir -p "$FILES/create-options/data/97"
cp "packages/chain/src/create-options/data/97/$factory.json" "$FILES/create-options/data/97/" \
  || { echo "up: no create options for the factory $factory"; exit 1; }
echo "up: the rehearsal's files are in $FILES (factory $factory)"

say "4. the three demo boxes, created and lived (port $BOX_PORT)"
if [ ! -f .cache/bnb-boxes/rent-free/rent-free-boxspec-v2.json ]; then
  node scripts/kits/bundle.mjs rent-free
  node packages/chain/scripts/bnb-boxes/settings.mjs rent-free --extras "$FILES/bnb-testnet/97-extras.json" \
    --out .cache/bnb-boxes/rent-free/rent-free-boxspec-v2.json --items-out .cache/bnb-boxes/rent-free/items
fi
for box in stock rentfree converter; do
  node packages/chain/scripts/bnb-boxes/local.mjs "$box" --port "$BOX_PORT" --files "$FILES" --out "$OUT/$box.json" 2>&1 | tail -3
done

say "done"
echo "up: GREEN: the platform deployed on a local chain 97, three demo boxes created and lived"
