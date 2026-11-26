#!/usr/bin/env bash
# SH-288: browser tests of the card shop's page against a LOCAL FORK of BSC Testnet (anvil, port 8581 by default; reads
# only from the public endpoint). Builds the shop and its factory from the shared core (bounties/core/src: RailShop.sol,
# IRailShop.sol, RailShopFactory.sol; SHOP_SRC names another folder holding them) and the page's plain test token
# (e2e/chain), seeds the fork (scripts/seed-shop.mjs: a token with a pool, a shop over the four test card collections of
# chain 97, cards minted by their owner impersonated on the fork, a budget, tax waiting), runs e2e/shop.spec.ts (one
# worker, port 5471) and stops anvil. Nothing is sent to a real network; no key is used.
# usage: WORK=<a build folder> [SHOP_SRC=<folder>] [SHOP_PICTURES=<https origin>] scripts/shop-fork.sh [playwright args...]
set -u
cd "$(dirname "$0")/.." || exit 1
APP=$PWD
: "${WORK:?set WORK}"
PORT=${SHOP_FORK_PORT:-8581}
SRC=${SHOP_SRC:-$APP/../core/src}
UPSTREAM=${SHOP_FORK_UPSTREAM:-https://bsc-testnet-rpc.publicnode.com}

mkdir -p "$WORK/shop/src"
for f in RailShop.sol IRailShop.sol RailShopFactory.sol; do cp "$SRC/$f" "$WORK/shop/src/$f" || { echo "no $SRC/$f"; exit 1; }; done
cat > "$WORK/shop/foundry.toml" <<'TOML'
[profile.default]
src = "src"
out = "out"
cache_path = "cache"
libs = []
solc_version = "0.8.24"
evm_version = "cancun"
optimizer = true
optimizer_runs = 200
[lint]
lint_on_build = false
TOML
(cd "$WORK/shop" && forge build --offline > "$WORK/shop-build.log" 2>&1) || { echo "shop build failed"; tail -n 20 "$WORK/shop-build.log"; exit 1; }
(cd e2e/chain && forge build --offline > /dev/null) || { echo "test token build failed"; exit 1; }

anvil --fork-url "$UPSTREAM" --port "$PORT" --chain-id 97 --silent &
APID=$!
trap 'kill "$APID" 2>/dev/null; wait "$APID" 2>/dev/null' EXIT
for _ in $(seq 1 60); do cast block-number -r "http://127.0.0.1:$PORT" > /dev/null 2>&1 && break; sleep 1; done
node scripts/seed-shop.mjs "http://127.0.0.1:$PORT" "$WORK/shop/out" "$APP/public/addresses.json" || exit 1
PILE_RPC="http://127.0.0.1:$PORT" npx playwright test --workers=1 e2e/shop.spec.ts "$@"
