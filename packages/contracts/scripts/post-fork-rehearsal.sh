#!/usr/bin/env bash
# The Sepolia runbook (docs/runbooks/sepolia-core-v1.md) rehearsed end to end after Sepolia's Glamsterdam fork (F97) on
# LOCAL anvils that run the fork's rules (anvil 1.8.3 --hardfork amsterdam, chain id 11155111; on a fork anvil charges
# EIP-8037's state gas, a chain of its own does not: docs/evidence/SH-box0-final-candidate.md). The runbook's own sh
# blocks are pasted into zsh (scripts/glamsterdam-after-rehearsal.py writes the runners). NEVER broadcasts: Sepolia is
# only read (keyless public RPC); no key exists anywhere: every sender is an account the local anvil has unlocked.
#
#   scripts/post-fork-rehearsal.sh fork-warped [port]  A: a fork of Sepolia's latest block, its clock moved 20 minutes
#                                                      past the fork (1,791,294,816). The deploy script itself (Z1 =
#                                                      after), the runbook's testnet deployer and wallet 1 impersonated
#                                                      (nonce 13: Step 2's addresses), wallet 1's funding transfer,
#                                                      Steps 0-3, Step 4's record, Step 5; the life to graduation, G1,
#                                                      G5 and the keeper (G7), with the probes; drand's rounds for the
#                                                      fork's clock are not out yet, so G2, G3, G4 and G6 are left out
#   scripts/post-fork-rehearsal.sh devnet [port]       B: a fork of a fresh local anvil (chain id 11155111, its own
#                                                      blocks from 1) holding Sepolia's contracts the run reads, the
#                                                      real clock (drand's rounds exist), 12-second blocks.
#                                                      script/rehearsal/DeployCoreV1Devnet.s.sol (Sepolia's fork time 0),
#                                                      anvil's own test accounts 0 (WALLET, the keeper) and 1 (wallet 1)
#                                                      with the runbook's balances and nonce; every block of the runbook
#   scripts/post-fork-rehearsal.sh fork-live [port]    C: a fork of Sepolia past its fork (refused before), the real
#                                                      clock, 12-second blocks: the deploy script itself and every block
#
# devnet and fork-live also run R1's life (docs/evidence/SH-box0-r1.md): after G6 three fresh drawers have draws open at
# once, J different at each request, two opened; after G7 the third opens hours later and each drawer claims; every
# draw's start and credit checked against the exact model on the chain (scripts/post-fork-probes.py draws, draws-late).
#
# The platform (SH-SEP-BOX0-SAFE): the runbook's settings name the Sepolia platform Safe file
# (box0-spec.11155111.rehearsal.sepolia-safe.json), so before Step 0 a local 1-of-1 Safe stands in for the founder's: a
# real Safe 1.4.1 L2 proxy made through Sepolia's canonical SafeProxyFactory on the local chain (the devnet copies the
# factory, the singleton and the fallback handler from Sepolia first), owned by wallet 1 (W1). Its address goes into
# the rehearsal's Safe file (glamsterdam-after-rehearsal.py --platform-safe, as we commit the founder's Safe) and Step 0
# checks it on the chain. SH_POSTFORK_V2=1 (fork modes only): after Step 4, core v2's deploy (script/DeployCoreV2.s.sol,
# the mainnet build: FOUNDRY_PROFILE unset, docs/runbooks/sepolia-core-v2.md § 1, CORE_V2_BROADCAST=false, nothing
# sent) is simulated against the same chain with that Safe as CORE_V2_PLATFORM_SAFE and a local 2-of-3 FIT Safe: it must
# pass box 0's checks (no MissingBox0, no WrongPlatformSafe) and its Safe checks; with a second 1-of-1 Safe as platform
# it must stop at WrongPlatformSafe (v2-accepts.log, v2-other-safe.log).
#
# Ports (checked free first; 8553-8599, never 8552, or the workflow lanes' 5460-5469): fork-warped 8561, devnet 8562
# (its base chain the next port), fork-live 8564. Output in .s7-sim/post-fork-<mode>/ (gitignored): the runners,
# deploy.log, life.log, ledger.tsv, summary.txt. Every forge run against the local chains has
# FOUNDRY_NO_STORAGE_CACHING=true (the runners set it). SEPOLIA_PUBLIC_RPC (tried first) may be a local read-only relay
# (one upstream request at a time): then also ETH_RPC_TIMEOUT=900, so cast and forge wait for the fork's first reads.
set -Eeuo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."

MODE="${1:-}"
case "$MODE" in
fork-warped) PORT="${2:-8561}" ;;
devnet) PORT="${2:-8562}" ;;
fork-live) PORT="${2:-8564}" ;;
*) echo "usage: $0 fork-warped|devnet|fork-live [port]" >&2; exit 1 ;;
esac
OUT=".s7-sim/post-fork-$MODE"
RPC="http://127.0.0.1:$PORT"
GLAMSTERDAM_SEPOLIA=1791294816
TESTNET_DEPLOYER=0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE
WALLET1=0x5583f846B0dDC80f49ea0E89C51520bA341c6658
ANVIL0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
ANVIL1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
FUND=3.35
# Sepolia's canonical Safe 1.4.1 deployments (safe-global/safe-deployments; the founder's Safes come from the Safe app).
SAFE_FACTORY=0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
SAFE_SINGLETON_L2=0x29fcB43b46531BcA003ddC8FCB67FFE91900C762
SAFE_HANDLER=0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99

say() { echo "POSTFORK|$*"; }
die() {
  echo "POSTFORK|FAILED|$*" >&2
  exit 1
}
port_free() {
  case "$1" in 8552) return 1 ;; 855[3-9] | 85[6-9][0-9] | 546[0-9]) ;; *) return 1 ;; esac
  ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}
port_free "$PORT" || die "port $PORT is taken or outside 8553-8599 and 5460-5469 (never 8552)"
[ "$MODE" != devnet ] || port_free $((PORT + 1)) || die "port $((PORT + 1)) (the base chain) is taken or outside 8553-8599 and 5460-5469"
[ -z "${SH_POSTFORK_V2:-}" ] || [ "$MODE" != devnet ] || die "SH_POSTFORK_V2=1 needs a fork of Sepolia (core v2's CoW and Safe contracts)"

rm -rf "$OUT"
mkdir -p "$OUT"
exec > >(tee -a "$OUT/run.log") 2>&1
PIDS=()
cleanup() {
  local rc=$?
  for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; done
  say "stopped the local chains (${PIDS[*]-none}); exit $rc"
}
trap cleanup EXIT

SEPOLIA=""
# The Tenderly gateway first: publicnode resets a fork's connections under load (core-v1-life-run.sh; here too, Step 0's
# dry run of the first fork-warped run: `connection reset`).
for candidate in ${SEPOLIA_PUBLIC_RPC:-} https://sepolia.gateway.tenderly.co https://ethereum-sepolia-rpc.publicnode.com; do
  if [ "$(cast chain-id --rpc-url "$candidate" 2>/dev/null)" = 11155111 ]; then SEPOLIA="$candidate"; break; fi
done
[ -n "$SEPOLIA" ] || die "no Sepolia RPC answers"
SEP_BLOCK="$(cast block-number --rpc-url "$SEPOLIA")"
SEP_TIME="$(cast block "$SEP_BLOCK" --field timestamp --rpc-url "$SEPOLIA")"
say "tools|$(forge --version | head -n 1)|$(anvil --version | head -n 1)|zsh $(zsh --version | cut -d' ' -f2)"
say "sepolia|$SEPOLIA ($(cast rpc web3_clientVersion --rpc-url "$SEPOLIA" | tr -d '"'))|block $SEP_BLOCK|time $SEP_TIME|base fee $(cast base-fee --rpc-url "$SEPOLIA")|clock $(date -u +%s)"
if [ "$MODE" = fork-live ] && [ "$SEP_TIME" -lt "$GLAMSTERDAM_SEPOLIA" ]; then
  die "Sepolia's latest block ($SEP_TIME) is before its fork ($GLAMSTERDAM_SEPOLIA): fork-live waits for it"
fi

wait_rpc() {
  for _ in $(seq 1 1500); do cast chain-id --rpc-url "$1" >/dev/null 2>&1 && return 0; sleep 0.2; done
  die "no chain on $1"
}

# ------------------------------------------------------------------------------------------------ the chain
if [ "$MODE" = devnet ]; then
  BASE="http://127.0.0.1:$((PORT + 1))"
  anvil --port $((PORT + 1)) --chain-id 11155111 --hardfork amsterdam --gas-limit 60000000 --base-fee 1000000000 \
    >"$OUT/anvil-base.log" 2>&1 &
  PIDS+=($!)
  wait_rpc "$BASE"
  anvil --fork-url "$BASE" --port "$PORT" --hardfork amsterdam --gas-limit 60000000 --block-time 12 \
    --no-storage-caching >"$OUT/anvil.log" 2>&1 &
  PIDS+=($!)
  wait_rpc "$RPC"
  DEPLOYER=$ANVIL0 W1=$ANVIL1 SCRIPT=devnet CLOCK=real SKIP="" DRAWS=--draws
  # Sepolia's accounts the run reads (scripts/glamsterdam-devnet-genesis.py's list), as Sepolia has them now: code,
  # balance, nonce and the PoolManager's owner slot. Then anvil's test accounts 0 and 1 as the runbook's deployer (nonce
  # 13, its 0.186) and wallet 1 (its 4.968): the funding transfer below is the runbook's.
  python3 - "$SEPOLIA" "$SEP_BLOCK" "$RPC" "$DEPLOYER" "$W1" "$TESTNET_DEPLOYER" "$WALLET1" <<'PY' || die "the devnet's Sepolia accounts"
import json, subprocess, sys
sep, block, rpc, deployer, w1, testnet_deployer, wallet1 = sys.argv[1:8]
blk = hex(int(block))
def c(*a):
    return subprocess.run(["cast", *a], capture_output=True, text=True, check=True).stdout.strip()
accounts = {
    "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543": ["0x0"],  # PoolManager, its owner slot
    "0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe": [],  # PoolSwapTest
    "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14": [],  # WETH9
    "0x4e59b44847b379578588920cA78FbF26c0B4956C": [],  # the CREATE2 deployer
    testnet_deployer: [],  # the spec files' platform
    "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67": [],  # SafeProxyFactory 1.4.1 (the local platform Safe)
    "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762": [],  # SafeL2 1.4.1 singleton
    "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99": [],  # CompatibilityFallbackHandler 1.4.1
}
for addr, slots in accounts.items():
    code = c("code", addr, "--rpc-url", sep, "--block", block)
    bal = c("balance", addr, "--rpc-url", sep, "--block", block)
    nonce = c("nonce", addr, "--rpc-url", sep, "--block", block)
    if code != "0x":
        c("rpc", "anvil_setCode", addr, code, "--rpc-url", rpc)
    c("rpc", "anvil_setBalance", addr, hex(int(bal)), "--rpc-url", rpc)
    c("rpc", "anvil_setNonce", addr, hex(int(nonce)), "--rpc-url", rpc)
    for s in slots:
        v = c("storage", addr, s, "--rpc-url", sep, "--block", block)
        c("rpc", "anvil_setStorageAt", addr, "0x" + format(int(s, 16), "064x"), v, "--rpc-url", rpc)
    print(f"POSTFORK|devnet|{addr} from Sepolia block {block}: code {max(0, len(code) // 2 - 1)} bytes, balance {bal}, nonce {nonce}, slots {len(slots)}")
for addr, real in ((deployer, testnet_deployer), (w1, wallet1)):
    bal = c("balance", real, "--rpc-url", sep, "--block", block)
    nonce = c("nonce", real, "--rpc-url", sep, "--block", block)
    c("rpc", "anvil_setBalance", addr, hex(int(bal)), "--rpc-url", rpc)
    c("rpc", "anvil_setNonce", addr, hex(int(nonce)), "--rpc-url", rpc)
    print(f"POSTFORK|devnet|{addr} (anvil's test account) as {real}: balance {bal}, nonce {nonce}")
PY
  # One block over the copied state: a read at block 0 (Step 0's dry run forks the latest block) would not see it.
  cast rpc evm_mine --rpc-url "$RPC" >/dev/null
else
  # One dev account and a long fork timeout: through a throttled read-only relay (SEPOLIA_PUBLIC_RPC, one request at a
  # time) anvil's genesis reads of ten dev accounts at once outlast its default 45 s.
  anvil --fork-url "$SEPOLIA" --fork-block-number "$SEP_BLOCK" --port "$PORT" --hardfork amsterdam --no-storage-caching \
    --retries 10 --fork-retry-backoff 2000 --timeout 600000 --accounts 1 \
    $([ "$MODE" = fork-live ] && echo --block-time 12) >"$OUT/anvil.log" 2>&1 &
  PIDS+=($!)
  wait_rpc "$RPC"
  DEPLOYER=$TESTNET_DEPLOYER W1=$WALLET1 SCRIPT=real
  if [ "$MODE" = fork-warped ]; then
    CLOCK=fast SKIP=G2,G3,G4,G6 DRAWS=""
    WARP=$((GLAMSTERDAM_SEPOLIA + 1200))
    [ "$WARP" -gt "$SEP_TIME" ] || WARP=$((SEP_TIME + 12))
    cast rpc evm_setNextBlockTimestamp "$(cast to-hex "$WARP")" --rpc-url "$RPC" >/dev/null
    cast rpc evm_mine --rpc-url "$RPC" >/dev/null
    say "clock|moved to $WARP (the fork + $((WARP - GLAMSTERDAM_SEPOLIA)) s), $((WARP - $(date -u +%s))) s ahead of the clock"
  else
    CLOCK=real SKIP="" DRAWS=--draws
  fi
fi
[ "$(cast chain-id --rpc-url "$RPC")" = 11155111 ] || die "the chain on $RPC is not chain 11155111"
CHAIN_NOW="$(cast block latest --field timestamp --rpc-url "$RPC")"
# The ledger starts at the first block this run mines: a fork's own head block holds the forked chain's transactions
# (fork-live: Sepolia's, some of them failed on Sepolia), which are not the rehearsal's.
B0="$(($(cast block-number --rpc-url "$RPC") + 1))"
say "chain|$RPC|$MODE|block $B0|time $CHAIN_NOW|base fee $(cast base-fee --rpc-url "$RPC")|hardfork $(cast rpc anvil_nodeInfo --rpc-url "$RPC" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hardFork"])')"
# A CREATE costs EIP-8037's state gas here, or this chain does not rehearse the fork (a fresh anvil charges none).
PROBE_GAS="$(cast estimate --from "$DEPLOYER" --rpc-url "$RPC" --create 0x600a600c600039600a6000f3602a60005260206000f3)"
[ "$PROBE_GAS" -gt 200000 ] || die "a 10-byte CREATE estimates $PROBE_GAS gas: this chain charges no EIP-8037 state gas"
say "chain|a 10-byte CREATE estimates $PROBE_GAS gas (55,330 without EIP-8037)"

# ------------------------------------------------------------------------------------------------ the platform Safe
# make_safe <threshold> <salt nonce> <owner>...: a Safe 1.4.1 L2 proxy through the canonical factory, sent by W1
# (unlocked); prints its address.
make_safe() {
  local threshold="$1" nonce="$2" owners init safe
  shift 2
  owners="[$(IFS=,; echo "$*")]"
  init="$(cast calldata 'setup(address[],uint256,address,bytes,address,address,uint256,address)' "$owners" "$threshold" \
    0x0000000000000000000000000000000000000000 0x "$SAFE_HANDLER" 0x0000000000000000000000000000000000000000 0 \
    0x0000000000000000000000000000000000000000)"
  safe="$(cast call "$SAFE_FACTORY" 'createProxyWithNonce(address,bytes,uint256)(address)' "$SAFE_SINGLETON_L2" "$init" \
    "$nonce" --from "$W1" --rpc-url "$RPC")"
  cast rpc anvil_impersonateAccount "$W1" --rpc-url "$RPC" >/dev/null
  cast send "$SAFE_FACTORY" 'createProxyWithNonce(address,bytes,uint256)' "$SAFE_SINGLETON_L2" "$init" "$nonce" \
    --from "$W1" --unlocked --rpc-url "$RPC" >/dev/null
  [ "$(cast code "$safe" --rpc-url "$RPC")" != 0x ] || die "no Safe at $safe"
  echo "$safe"
}
# W1's nonce moves with these sends; the runbook's addresses follow WALLET's nonce (13), not W1's.
PLATFORM_SAFE="$(make_safe 1 "$(date -u +%s)" "$W1")"
say "platform safe|$PLATFORM_SAFE|1-of-1, owner $W1 (wallet 1, the founder's stand-in)|Safe $(cast call "$PLATFORM_SAFE" 'VERSION()(string)' --rpc-url "$RPC" | tr -d '"')|threshold $(cast call "$PLATFORM_SAFE" 'getThreshold()(uint256)' --rpc-url "$RPC")|code hash $(cast keccak "$(cast code "$PLATFORM_SAFE" --rpc-url "$RPC")")"

# ------------------------------------------------------------------------------------------------ the deploy
# SH_POSTFORK_OPEN_IN: seconds from the chain's time to Step 0's pick (default 1080; through a throttled relay Step 0's
# and Step 2's dry runs take minutes, and Step 3 must still be sent 15 minutes before the open: give 2400).
OPEN_IN="${SH_POSTFORK_OPEN_IN:-1080}"
case "$OPEN_IN" in '' | *[!0-9]*) die "SH_POSTFORK_OPEN_IN must be seconds" ;; esac
[ "$OPEN_IN" -ge 960 ] && [ "$OPEN_IN" -le 86400 ] || die "SH_POSTFORK_OPEN_IN must be 960 to 86400 seconds"
PICK_AT=$(((CHAIN_NOW + OPEN_IN + 59) / 60 * 60))
PICK="$(python3 -c 'import datetime, sys; print(datetime.datetime.fromtimestamp(int(sys.argv[1]), datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"))' "$PICK_AT")"
SPEC_DIR="script/config/rehearsal-runs/$PORT"
rm -rf "$SPEC_DIR"
FUND_ARGS=(--fund "$FUND")
python3 scripts/glamsterdam-after-rehearsal.py deploy --rpc "$RPC" --unlocked --deployer "$DEPLOYER" --wallet1 "$W1" \
  --script "$SCRIPT" --open-at "$PICK" --min-lead 900 "${FUND_ARGS[@]}" --platform-safe "$PLATFORM_SAFE" --out "$OUT" >/dev/null
say "deploy|the runbook's settings, unchanged block, Step 0 ($PICK), wallet 1's $FUND to WALLET, Step 1, Step 2 and Step 3, pasted into zsh"
env PS1= PS2= zsh -f -i +o promptcr +o promptsp <"$OUT/deploy-runner.zsh" >"$OUT/deploy.log" 2>&1 || true
if grep -nE "^zsh(: |:[0-9]+: )|command not found|parse error|unmatched|REFUSED" "$OUT/deploy.log"; then
  die "zsh or Step 0 reported the errors above (see $OUT/deploy.log)"
fi
grep -q 'REHEARSAL|done|deploy' "$OUT/deploy.log" || die "the deploy runner did not finish (see $OUT/deploy.log)"
grep -q 'SIMULATION COMPLETE' "$OUT/deploy.log" || die "Step 2's dry run did not complete (see $OUT/deploy.log)"
grep -q 'ONCHAIN EXECUTION COMPLETE & SUCCESSFUL' "$OUT/deploy.log" || die "Step 3 did not complete (see $OUT/deploy.log)"
STEP0_HASH="$(sed -n 's/^spec hash: \(0x[0-9a-f]\{64\}\)$/\1/p' "$OUT/deploy.log" | head -n 1)"
STEP0_HOOK="$(sed -n 's/^hook: \(0x[0-9a-fA-F]\{40\}\) .*/\1/p' "$OUT/deploy.log" | head -n 1)"
REGISTRY="$(sed -n 's/^ *registry: \(0x[0-9a-fA-F]\{40\}\).*/\1/p' "$OUT/deploy.log" | tail -n 1)"
[ -n "$REGISTRY" ] || die "Step 3 printed no registry (see $OUT/deploy.log)"
BOX="$(cast call "$REGISTRY" 'coordinatorOf(uint256)(address)' 0 --rpc-url "$RPC")"
HOOK="$(cast call "$BOX" 'hook()(address)' --rpc-url "$RPC")"
[ "$(echo "$HOOK" | tr 'A-F' 'a-f')" = "$(echo "$STEP0_HOOK" | tr 'A-F' 'a-f')" ] || die "box 0's hook $HOOK is not Step 0's $STEP0_HOOK"
say "deploy|registry $REGISTRY|box 0 $BOX|hook $HOOK (Step 0 predicted it)|Step 0's spec hash $STEP0_HASH"

# Step 4 (ours): the spec files recorded from the chain are the ones box 0 was deployed from, byte for byte.
RPC="$RPC" SH_SEPOLIA_SPEC_DIR="$SPEC_DIR/recorded" bash scripts/sepolia-open-at.sh --deployed "$REGISTRY" \
  >"$OUT/record-deployed.log" 2>&1 || die "Step 4's record refused (see $OUT/record-deployed.log)"
for f in box0-spec.11155111.rehearsal.json box0-spec.11155111.json box0-spec.11155111.safe.json \
  box0-spec.11155111.rehearsal.sepolia-safe.json; do
  cmp -s "$SPEC_DIR/$f" "$SPEC_DIR/recorded/$f" || die "Step 4's record: $f differs from the deployed one"
done
say "step 4|$(tail -n 2 "$OUT/record-deployed.log" | head -n 1)|the four files equal the deployed ones byte for byte"
FACTORY="$(cast call "$REGISTRY" 'factory()(address)' --rpc-url "$RPC")"
[ "$(cast call "$FACTORY" 'platformSafe()(address)' --rpc-url "$RPC")" = "$PLATFORM_SAFE" ] ||
  die "the factory's platform is not the local platform Safe $PLATFORM_SAFE"
[ "$(cast call "$(cast call "$BOX" 'receiver()(address)' --rpc-url "$RPC")" 'platformSafe()(address)' --rpc-url "$RPC")" = "$PLATFORM_SAFE" ] ||
  die "box 0's receiver does not name the local platform Safe $PLATFORM_SAFE"
[ "$(cast call "$(cast call "$BOX" 'collection()(address)' --rpc-url "$RPC")" 'owner()(address)' --rpc-url "$RPC")" = "$PLATFORM_SAFE" ] ||
  die "box 0's collection is not owned by the local platform Safe $PLATFORM_SAFE"
say "platform|factory $FACTORY, box 0's receiver and its collection's owner(): the local platform Safe $PLATFORM_SAFE"

# ------------------------------------------------------------------------------------------------ core v2 on this box 0
if [ -n "${SH_POSTFORK_V2:-}" ]; then
  FIT_SAFE="$(make_safe 2 "$(($(date -u +%s) + 1))" "$ANVIL1" "$W1" 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC)"
  OTHER_SAFE="$(make_safe 1 "$(($(date -u +%s) + 2))" "$W1")"
  v2() {
    # The mainnet build (docs/runbooks/sepolia-core-v2.md § 3: never a leftover FOUNDRY_PROFILE=rehearsal).
    env -u FOUNDRY_PROFILE FOUNDRY_NO_STORAGE_CACHING=true CORE_V2_BROADCAST=false CORE_V2_WRITE_MANIFEST=false \
      CORE_V2_DEPLOYER="$W1" CORE_V2_POOL_MANAGER=0xE03A1074c86CFeDd5C142C4F04F1a1536e203543 \
      CORE_V2_WETH=0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14 \
      CORE_V2_COMPOSABLE_COW=0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74 \
      CORE_V2_COW_SETTLEMENT=0x9008D19f58AAbD9eD0D60971565AA8510560ab41 CORE_V2_ROYALTY_MINIMUM_LOT=10000000000000000 \
      CORE_V2_V1_REGISTRY="$REGISTRY" CORE_V2_BOX0="$BOX" \
      CORE_V2_FIT_SAFE="$FIT_SAFE" CORE_V2_PINNED_FIT_SAFE="$FIT_SAFE" \
      CORE_V2_PLATFORM_SAFE="$1" CORE_V2_PINNED_PLATFORM_SAFE="$1" \
      CORE_V2_BOT="$ANVIL1" CORE_V2_FOUNDER="$W1" CORE_V2_BACKUP=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC \
      CORE_V2_SAFE_VERSION=1.4.1 CORE_V2_SAFE_SINGLETON="$SAFE_SINGLETON_L2" \
      CORE_V2_SAFE_SINGLETON_CODEHASH="$(cast keccak "$(cast code "$SAFE_SINGLETON_L2" --rpc-url "$RPC")")" \
      CORE_V2_SAFE_PROXY_CODEHASH="$(cast keccak "$(cast code "$FIT_SAFE" --rpc-url "$RPC")")" \
      CORE_V2_SAFE_GUARD=0x0000000000000000000000000000000000000000 CORE_V2_SAFE_HANDLER="$SAFE_HANDLER" \
      CORE_V2_PLATFORM_SAFE_VERSION=1.4.1 CORE_V2_PLATFORM_SAFE_SINGLETON="$SAFE_SINGLETON_L2" \
      CORE_V2_PLATFORM_SAFE_SINGLETON_CODEHASH="$(cast keccak "$(cast code "$SAFE_SINGLETON_L2" --rpc-url "$RPC")")" \
      CORE_V2_PLATFORM_SAFE_PROXY_CODEHASH="$(cast keccak "$(cast code "$1" --rpc-url "$RPC")")" \
      CORE_V2_PLATFORM_SAFE_GUARD=0x0000000000000000000000000000000000000000 CORE_V2_PLATFORM_SAFE_HANDLER="$SAFE_HANDLER" \
      forge script script/DeployCoreV2.s.sol:DeployCoreV2 --rpc-url "$RPC" --sender "$W1" --hardfork amsterdam \
      --gas-estimate-multiplier 110 -vvv
  }
  say "v2|core v2's deploy simulated on this box 0 (FIT Safe $FIT_SAFE 2-of-3; nothing sent)..."
  v2 "$PLATFORM_SAFE" >"$OUT/v2-accepts.log" 2>&1 || die "core v2's deploy refused this box 0 (see $OUT/v2-accepts.log)"
  grep -q 'SIMULATION COMPLETE' "$OUT/v2-accepts.log" || die "core v2's simulation did not complete (see $OUT/v2-accepts.log)"
  ! grep -qE 'MissingBox0|WrongPlatformSafe|UnsafeSafe|WrongSafe' "$OUT/v2-accepts.log" ||
    die "core v2's deploy log names a refusal (see $OUT/v2-accepts.log)"
  say "v2|accepted: box 0 $BOX, platform Safe $PLATFORM_SAFE (the simulated manifest's safes.platform)|$(grep -E '^factory: address' "$OUT/v2-accepts.log" | head -n 1)"
  if v2 "$OTHER_SAFE" >"$OUT/v2-other-safe.log" 2>&1; then die "core v2's deploy took another Safe ($OTHER_SAFE) as box 0's platform"; fi
  grep -q 'WrongPlatformSafe' "$OUT/v2-other-safe.log" || die "another Safe as platform did not stop at WrongPlatformSafe (see $OUT/v2-other-safe.log)"
  say "v2|refused another 1-of-1 Safe ($OTHER_SAFE) as box 0's platform: WrongPlatformSafe"
fi

# ------------------------------------------------------------------------------------------------ the life
python3 scripts/glamsterdam-after-rehearsal.py life --rpc "$RPC" --unlocked --deployer "$DEPLOYER" --wallet1 "$W1" \
  --registry "$REGISTRY" --clock "$CLOCK" --skip "$SKIP" --probes --keeper-start 280 --trade-at 450 \
  --ledger-from "$B0" ${DRAWS:+"$DRAWS"} --out "$OUT" >/dev/null
say "life|the runbook's blocks from § After the deploy pasted into zsh ($CLOCK clock${SKIP:+; left out: $SKIP}${DRAWS:+; with R1 draws})"
env PS1= PS2= zsh -f -i +o promptcr +o promptsp <"$OUT/life-runner.zsh" >"$OUT/life.log" 2>&1 || true
if grep -nE "^zsh(: |:[0-9]+: )|command not found|parse error|unmatched|bad pattern|no matches found|PROBE\|FAILED|--rpc must be" \
  "$OUT/life.log"; then
  die "zsh or a probe reported the errors above (see $OUT/life.log)"
fi
grep -q 'REHEARSAL|done|life' "$OUT/life.log" || die "the life runner did not finish (see $OUT/life.log)"
if [ -n "$DRAWS" ]; then
  grep -q '^PROBE|draws|PASSED' "$OUT/life.log" || die "R1's draws did not pass (see $OUT/life.log)"
  grep -q '^PROBE|draws-late|PASSED' "$OUT/life.log" || die "R1's late draw and claims did not pass (see $OUT/life.log)"
fi

# ------------------------------------------------------------------------------------------------ the checks
# The deployed verifier's own test count, from forge's list (57 since F143's three backed-source checks; 54 before).
VERIFIER_TESTS="$(forge test --list --match-contract BoxCoreConformanceDeployedTest --json 2>/dev/null |
  python3 -c 'import json, sys; print(sum(len(t) for c in json.load(sys.stdin).values() for t in c.values()))' || true)"
[ "${VERIFIER_TESTS:-0}" -gt 0 ] 2>/dev/null || die "forge lists no BoxCoreConformanceDeployedTest test"
VERIFIED="$(grep -cE "Suite result: ok\. $VERIFIER_TESTS passed; 0 failed" "$OUT/life.log" || true)"
FAILED_TXS="$(awk -F'\t' 'NR > 1 && $7 != 1' "$OUT/ledger.tsv" | wc -l | tr -d ' ')"
{
  echo "mode $MODE, chain $RPC (chain id 11155111, amsterdam), Sepolia block $SEP_BLOCK"
  echo "Step 0: $PICK, spec hash $STEP0_HASH, hook $STEP0_HOOK; registry $REGISTRY, box 0 $BOX"
  echo "verifier: $VERIFIED of 4 runs $VERIFIER_TESTS passed, 0 failed"
  echo "transactions: $(($(wc -l <"$OUT/ledger.tsv") - 1)) from block $B0, $FAILED_TXS not status 1"
  echo "phase $(cast call "$BOX" 'phase()(uint8)' --rpc-url "$RPC"), settled $(cast call "$(cast call "$BOX" 'receiver()(address)' --rpc-url "$RPC")" 'graduationSettled()(bool)' --rpc-url "$RPC"), last deepen block $(cast call "$HOOK" 'lastDeepenBlock()(uint256)' --rpc-url "$RPC")"
  grep -E '^PROBE\||^REHEARSAL\|(keeper|fund|skipped)|^[0-9]+ (poke|deepen|collect|payFit|payPlatform|buy-and-burn)' "$OUT/life.log" "$OUT/deploy.log" | sed 's/^[^:]*://'
} >"$OUT/summary.txt"
cat "$OUT/summary.txt"
[ "$VERIFIED" = 4 ] || die "the verifier did not pass $VERIFIER_TESTS of $VERIFIER_TESTS four times (see $OUT/life.log)"
[ "$FAILED_TXS" = 0 ] || die "$FAILED_TXS transactions did not succeed (see $OUT/ledger.tsv)"
[ "$(cast call "$BOX" 'phase()(uint8)' --rpc-url "$RPC")" = 5 ] || die "box 0 did not graduate"
say "PASSED|$MODE"
