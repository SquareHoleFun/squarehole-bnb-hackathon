#!/usr/bin/env bash
# Slice S7 (docs/evidence/SH-S7-factory.md): dry runs of script/DeployCoreV1.s.sol. NEVER broadcasts: no key is read
# or passed, and `forge script` runs without --broadcast, so nothing is signed or sent to a public chain.
#
#   scripts/core-v1-simulate.sh local    a fresh local anvil (port $SH_S7_ANVIL_PORT, default 8552, 8550-8559) with chain id 1, so
#                                        the DrandSource pin and mainnet's constants apply; mainnet's PoolManager and
#                                        WETH9 runtime code (read keylessly from a public mainnet RPC) are placed at
#                                        their canonical addresses with anvil_setCode; the sender is anvil's public
#                                        default account 0 (its address only).
#   scripts/core-v1-simulate.sh sepolia [--sender <address>] [--spec <file>] [--platform <address>]
#                                        a fork of Sepolia inside forge (keyless public RPC), the sender $SH_S7_SENDER or
#                                        --sender (default: the testnet deployer of F08, a public address), the spec
#                                        file $SH_CORE_V1_SPEC_FILE or --spec (default: the fixture, which the script
#                                        never sends) and its platform address (default: the spec file's "platform").
#                                        Prints the deployer's nonce and balance, the base fee and the time left before
#                                        Sepolia's Glamsterdam fork first; the script itself fails if its guard would.
#   scripts/core-v1-simulate.sh sepolia-replay [same options] [--life]
#                                        docs/runbooks/sepolia-core-v1.md's rehearsal of the broadcast and of the
#                                        post-deploy verifier, all on a LOCAL anvil fork of Sepolia (port
#                                        $SH_S7_ANVIL_PORT, default 8554, 8550-8558 only): the dry run against the fork,
#                                        then every recorded transaction sent to the fork with the sender impersonated
#                                        (scripts/core-v1-replay.py; no key exists anywhere), then the verifier
#                                        (BoxCoreConformanceDeployedTest) on the deployed box before its open, in the
#                                        window's first block (the first 12-second slot at or after the hook's openAt,
#                                        F80) and again from the window's end (windowEndsAt, the first second of the
#                                        bonding curve); the fork's clock jumps to each time with one block
#                                        (evm_setNextBlockTimestamp). With --life, then box 0's life on the same fork
#                                        (scripts/core-v1-life.py: the curve filled through the Universal Router 2.1.2,
#                                        graduate(), the fee batch, FIT's buy-and-burn, deepen()'s conversion and pair)
#                                        and the verifier a fourth time on the graduated box. Nothing reaches Sepolia:
#                                        the fork only reads it. The fork runs Osaka's rules, so it is refused once
#                                        Sepolia is past its Glamsterdam fork (1,791,294,816, 2026-10-06 13:53:36 UTC):
#                                        the post-fork rehearsal runs on anvil --hardfork amsterdam and the geth devnet
#                                        (docs/evidence/SH-glamsterdam-after.md).
#
# --rehearsal (or SH_CORE_V1_BUILD=rehearsal): the rehearsal build (F78; FOUNDRY_PROFILE=rehearsal: the raise 0.4206980085
# ETH and the fixed ETH amounts at 1/10), every forge run (script and verifier) with that profile, and the sepolia
# modes' default spec file script/config/box0-spec.11155111.rehearsal.json. Not with `local` (chain id 1, which the
# rehearsal build refuses).
#
# Logs go to $SH_S7_OUT (default .s7-sim/, gitignored).
#
# Every forge run against a LOCAL anvil passes --no-storage-caching: forge's on-disk fork cache
# (~/.foundry/cache/rpc/<chain>/<block>) is keyed by chain id and block number, so without it a local fork's simulated
# state (a deployed factory, the deployer's nonce 28) is saved under real Sepolia block numbers, and a second run at the
# same block of the same anvil reads that saved state instead of the anvil's (SH-sepolia-prep, review finding 2). The
# verifier also runs one test at a time with forge's fork retries: in parallel, the public RPC behind the fork resets
# connections and five checks failed on RPC errors alone (review finding 3).
set -euo pipefail

export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."

MODE="${1:-local}"
shift || true
SENDER="${SH_S7_SENDER:-0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE}"
SPEC="${SH_CORE_V1_SPEC_FILE:-}"
PLATFORM="${SH_CORE_V1_PLATFORM_SAFE:-}"
BUILD="${SH_CORE_V1_BUILD:-mainnet}"
LIFE=false
while [ $# -gt 0 ]; do
  case "$1" in
  --sender) SENDER="$2"; shift 2 ;;
  --spec) SPEC="$2"; shift 2 ;;
  --platform) PLATFORM="$2"; shift 2 ;;
  --rehearsal) BUILD=rehearsal; shift ;;
  --life) LIFE=true; shift ;;
  *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done
# F78: the build profile. The rehearsal build is FOUNDRY_PROFILE=rehearsal (foundry.toml); every forge call below
# inherits it from the environment.
case "$BUILD" in
mainnet) unset FOUNDRY_PROFILE ;;
rehearsal)
  export FOUNDRY_PROFILE=rehearsal
  if [ "$MODE" = local ]; then
    echo "error: the rehearsal build refuses chain id 1 (the local mode's chain); use sepolia or sepolia-replay" >&2
    exit 1
  fi
  [ -n "$SPEC" ] || SPEC=script/config/box0-spec.11155111.rehearsal.json
  ;;
*) echo "error: unknown build $BUILD (mainnet or rehearsal)" >&2; exit 1 ;;
esac
echo "build profile: $BUILD (FOUNDRY_PROFILE=${FOUNDRY_PROFILE:-default})"
OUT="${SH_S7_OUT:-.s7-sim}"
mkdir -p "$OUT"
MAINNET_RPC="${MAINNET_PUBLIC_RPC:-https://eth.drpc.org}"
SEPOLIA_RPC="${SEPOLIA_PUBLIC_RPC:-https://ethereum-sepolia-rpc.publicnode.com}"
PM_MAINNET=0x000000000004444c5dc75cB358380D2e3dE08A90
WETH_MAINNET=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2

case "$MODE" in
local)
  PORT="${SH_S7_ANVIL_PORT:-8552}"
  case "$PORT" in 855[0-9]) ;; *) echo "error: the S7 anvil uses ports 8550-8559" >&2; exit 1 ;; esac
  RPC="http://127.0.0.1:${PORT}"
  if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
    echo "error: something already answers on $RPC; pick another SH_S7_ANVIL_PORT (8550-8559)" >&2
    exit 1
  fi
  anvil --port "$PORT" --chain-id 1 --enable-tx-gas-limit >"$OUT/anvil-local.log" 2>&1 &
  ANVIL_PID=$!
  cleanup() {
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  }
  trap cleanup EXIT
  for _ in $(seq 1 100); do
    cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
    sleep 0.1
  done
  [ "$(cast chain-id --rpc-url "$RPC")" = "1" ] || { echo "error: anvil did not start with chain id 1" >&2; exit 1; }
  # The canonical PoolManager's runtime holds its own address as NoDelegateCall's immutable, so it runs only at that
  # address: placed there, it behaves as on mainnet (owner zero: no protocol fee).
  cast rpc anvil_setCode "$PM_MAINNET" "$(cast code "$PM_MAINNET" --rpc-url "$MAINNET_RPC")" --rpc-url "$RPC" >/dev/null
  cast rpc anvil_setCode "$WETH_MAINNET" "$(cast code "$WETH_MAINNET" --rpc-url "$MAINNET_RPC")" --rpc-url "$RPC" >/dev/null
  # A box's hook marks itself initialised with its creation block (BoxHook.initialize: `_w`'s deployBlock), so no box
  # can be created in block 0, which only a fresh local chain is at: move past it first.
  cast rpc anvil_mine 0x64 --rpc-url "$RPC" >/dev/null
  SENDER="$(cast rpc eth_accounts --rpc-url "$RPC" | tr -d '[]" ' | cut -d, -f1)"
  echo "local anvil $(anvil --version | head -1) on $RPC (chain id 1), sender $SENDER"
  echo "CREATE2 deployer code bytes: $(cast codesize 0x4e59b44847b379578588920cA78FbF26c0B4956C --rpc-url "$RPC")"
  forge script script/DeployCoreV1.s.sol --rpc-url "$RPC" --sender "$SENDER" --no-storage-caching -vv 2>&1 |
    tee "$OUT/deploy-local.log"
  ;;
sepolia | sepolia-replay)
  if [ -n "$SPEC" ]; then
    [ -f "$SPEC" ] || { echo "error: no spec file $SPEC (paths are relative to packages/contracts)" >&2; exit 1; }
    [ -n "$PLATFORM" ] || PLATFORM="$(sed -n 's/.*"platform": "\(0x[0-9a-fA-F]\{40\}\)".*/\1/p' "$SPEC" | head -n 1)"
    export SH_CORE_V1_SPEC_FILE="$SPEC"
  fi
  [ -n "$PLATFORM" ] && export SH_CORE_V1_PLATFORM_SAFE="$PLATFORM"
  NOW="$(cast block latest --field timestamp --rpc-url "$SEPOLIA_RPC")"
  BASE="$(cast base-fee --rpc-url "$SEPOLIA_RPC")"
  GLAMSTERDAM=1791294816
  echo "Sepolia via $SEPOLIA_RPC: block $(cast block-number --rpc-url "$SEPOLIA_RPC"), time $NOW, base fee $BASE wei"
  echo "sender $SENDER: nonce $(cast nonce "$SENDER" --rpc-url "$SEPOLIA_RPC"), balance $(cast balance "$SENDER" --ether --rpc-url "$SEPOLIA_RPC") ETH"
  echo "spec ${SPEC:-<the fixture>}, platform ${PLATFORM:-<the script default>}"
  if [ "$NOW" -lt "$GLAMSTERDAM" ]; then
    LEFT=$((GLAMSTERDAM - NOW))
    echo "Glamsterdam on Sepolia in $((LEFT / 3600)) h $((LEFT % 3600 / 60)) min (2026-10-06 13:53:36 UTC)"
  else
    echo "Glamsterdam on Sepolia is ACTIVE: the script refuses without SH_CORE_V1_GLAMSTERDAM_ACK=true"
  fi
  if [ "$MODE" = sepolia ]; then
    forge script script/DeployCoreV1.s.sol --rpc-url "$SEPOLIA_RPC" --sender "$SENDER" -vv 2>&1 | tee "$OUT/deploy-sepolia.log"
    exit "${PIPESTATUS[0]}"
  fi
  PORT="${SH_S7_ANVIL_PORT:-8554}"
  case "$PORT" in 855[0-8]) ;; *) echo "error: the replay's anvil uses ports 8550-8558" >&2; exit 1 ;; esac
  RPC="http://127.0.0.1:${PORT}"
  if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
    echo "error: something already answers on $RPC; pick another SH_S7_ANVIL_PORT (8550-8558)" >&2
    exit 1
  fi
  # The fork is pinned at the block just read; the public RPC sometimes resets a connection (then run it again).
  FORK_BLOCK="$(cast block-number --rpc-url "$SEPOLIA_RPC")"
  FORK_TIME="$(cast block "$FORK_BLOCK" --field timestamp --rpc-url "$SEPOLIA_RPC")"
  if [ "$FORK_TIME" -ge "$GLAMSTERDAM" ]; then
    echo "error: Sepolia is past its Glamsterdam fork (block $FORK_BLOCK, time $FORK_TIME): this replay forks with Osaka's rules and would not rehearse it; the post-fork rehearsal runs on anvil --hardfork amsterdam and the geth devnet (docs/evidence/SH-glamsterdam-after.md)" >&2
    exit 1
  fi
  anvil --fork-url "$SEPOLIA_RPC" --fork-block-number "$FORK_BLOCK" --port "$PORT" --hardfork osaka \
    --enable-tx-gas-limit --retries 10 --fork-retry-backoff 2000 >"$OUT/anvil-sepolia.log" 2>&1 &
  ANVIL_PID=$!
  cleanup() {
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  }
  trap cleanup EXIT
  for _ in $(seq 1 300); do
    cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
    sleep 0.2
  done
  [ "$(cast chain-id --rpc-url "$RPC")" = "11155111" ] || { echo "error: the fork is not Sepolia" >&2; exit 1; }
  echo "local anvil fork of Sepolia on $RPC at block $(cast block-number --rpc-url "$RPC")"
  forge script script/DeployCoreV1.s.sol --rpc-url "$RPC" --sender "$SENDER" --no-storage-caching -vv 2>&1 |
    tee "$OUT/deploy-sepolia-fork.log"
  [ "${PIPESTATUS[0]}" = 0 ] || exit 1
  python3 scripts/core-v1-replay.py broadcast/DeployCoreV1.s.sol/11155111/dry-run/run-latest.json --rpc "$RPC" \
    --base-fee-wei "$BASE" --out "$OUT/replay-sepolia.json" | tee "$OUT/replay-sepolia.log"
  [ "${PIPESTATUS[0]}" = 0 ] || exit 1
  FACTORY="$(sed -n 's/^ *factory: \(0x[0-9a-fA-F]\{40\}\)$/\1/p' "$OUT/deploy-sepolia-fork.log" | head -n 1)"
  REGISTRY="$(cast call "$FACTORY" 'registry()(address)' --rpc-url "$RPC")"
  # The runbook's verifier flags (docs/runbooks/sepolia-core-v1.md Step 5).
  VERIFY_FLAGS=(-j 1 --fork-retries 5 --fork-retry-backoff 2000 --no-storage-caching)
  echo "factory $FACTORY, registry $REGISTRY: the verifier, before the open"
  SH_CORE_V1_REGISTRY="$REGISTRY" forge test --match-contract BoxCoreConformanceDeployedTest --fork-url "$RPC" \
    "${VERIFY_FLAGS[@]}" -vv 2>&1 | tee "$OUT/verify-upcoming.log"
  [ "${PIPESTATUS[0]}" = 0 ] || exit 1
  # The open is a clock time (F80): the hook's openAt() and windowEndsAt() are Unix seconds. The fork's clock jumps
  # to the window's first block (the first 12-second slot at or after openAt, as Sepolia's slots fall) and then to the
  # window's end, one mined block each (a fork mines slowly: each block reaches back to the public RPC).
  BOX0="$(cast call "$REGISTRY" 'coordinatorOf(uint256)(address)' 0 --rpc-url "$RPC")"
  HOOK="$(cast call "$BOX0" 'hook()(address)' --rpc-url "$RPC")"
  OPEN="$(cast call "$HOOK" 'openAt()(uint256)' --rpc-url "$RPC" | cut -d' ' -f1)"
  END="$(cast call "$HOOK" 'windowEndsAt()(uint256)' --rpc-url "$RPC" | cut -d' ' -f1)"
  mine_at() {
    local now
    now="$(cast block latest --field timestamp --rpc-url "$RPC")"
    if [ "$now" -lt "$1" ]; then
      cast rpc evm_setNextBlockTimestamp "$1" --rpc-url "$RPC" >/dev/null
      cast rpc evm_mine --rpc-url "$RPC" --rpc-timeout 600 >/dev/null
    fi
  }
  mine_at $(((OPEN + 11) / 12 * 12))
  echo "block $(cast block-number --rpc-url "$RPC") at $(cast block latest --field timestamp --rpc-url "$RPC") (open $OPEN): the verifier, in the window"
  SH_CORE_V1_REGISTRY="$REGISTRY" forge test --match-contract BoxCoreConformanceDeployedTest --fork-url "$RPC" \
    "${VERIFY_FLAGS[@]}" -vv 2>&1 | tee "$OUT/verify-window.log"
  [ "${PIPESTATUS[0]}" = 0 ] || exit 1
  mine_at "$END"
  echo "block $(cast block-number --rpc-url "$RPC") at $(cast block latest --field timestamp --rpc-url "$RPC") (window end $END): the verifier, after the window"
  SH_CORE_V1_REGISTRY="$REGISTRY" forge test --match-contract BoxCoreConformanceDeployedTest --fork-url "$RPC" \
    "${VERIFY_FLAGS[@]}" -vv 2>&1 | tee "$OUT/verify-after-window.log"
  [ "${PIPESTATUS[0]}" = 0 ] || exit 1
  [ "$LIFE" = true ] || exit 0
  # Box 0's life on the same fork (F78): sizes for the build (the rehearsal's are 1/10 of the mainnet build's).
  if [ "$BUILD" = rehearsal ]; then LIFE_ETH=(--fill-eth 0.43 --trade-eth 0.1 --gift-eth 0.005); else
    LIFE_ETH=(--fill-eth 4.3 --trade-eth 1 --gift-eth 0.05); fi
  python3 scripts/core-v1-life.py --rpc "$RPC" --registry "$REGISTRY" "${LIFE_ETH[@]}" --out "$OUT/life.json" |
    tee "$OUT/life.log"
  [ "${PIPESTATUS[0]}" = 0 ] || exit 1
  echo "after the life (block $(cast block-number --rpc-url "$RPC")): the verifier on the graduated box"
  SH_CORE_V1_REGISTRY="$REGISTRY" forge test --match-contract BoxCoreConformanceDeployedTest --fork-url "$RPC" \
    "${VERIFY_FLAGS[@]}" -vv 2>&1 | tee "$OUT/verify-after-life.log"
  exit "${PIPESTATUS[0]}"
  ;;
*)
  echo "usage: $0 local|sepolia|sepolia-replay [--rehearsal] [--sender <address>] [--spec <file>] [--platform <address>] [--life]" >&2
  exit 1
  ;;
esac
