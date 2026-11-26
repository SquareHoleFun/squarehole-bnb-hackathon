#!/usr/bin/env bash
# Step 0 of docs/runbooks/sepolia-core-v1.md (DECISION-LOG F80 (4)): the founder picks box 0's opening time.
#
#   scripts/sepolia-open-at.sh 2026-10-06T11:00Z      from packages/contracts, after the runbook's settings and build
#   scripts/sepolia-open-at.sh --deployed <registry>  after the deploy (ours, Step 4): records box 0's openAt (below)
#
# 1. Reads the time: UTC only, written YYYY-MM-DDTHH:MMZ (seconds optional: 2026-10-06T11:00:30Z). Anything else is
#    refused, never guessed: no local time, no offset, no Unix seconds, no day that does not exist.
# 2. Checks the settings and that Node and the repository's packages are there (before Sepolia is read or anything is
#    written), then refuses the time unless it lies at least 45 minutes and at most 14 days after Sepolia's latest block.
#    The 45 minutes leave room for this command's dry run, Step 1, Step 2's dry run, the 15 transactions of Step 3 (3 to
#    6 minutes) and the verifier of Step 5 before the open (the deploy script's own floor is 15 minutes: OpenAtTooSoon).
#    The factory refuses an opening time more than 14 days after box 0's creation (OpenAtTooFar). Nothing is written
#    when it refuses.
# 3. Writes the four Sepolia spec files for that time with their generator (packages/box-spec/src/
#    sepolia-box0-spec.test.ts, as `pnpm sepolia-spec:write` does): $SPEC (the runbook's: the rehearsal build's file with
#    the Sepolia platform Safe, script/config/box0-spec.11155111.rehearsal.sepolia-safe.json), the rehearsal build's file
#    with the testnet deployer (box0-spec.11155111.rehearsal.json) and the two full-size files, all with the same openAt.
#    With the Safe file (SH-SEP-BOX0-SAFE; core v2 is deployed only on a box 0 whose platform is its 1-of-1 platform
#    Safe, DeployCoreV2's WrongPlatformSafe) it first checks the platform on $RPC, read-only, before anything is written:
#    not the generator's example (the committed file's platform until the founder's Safe is written into it), code, a
#    threshold of 1 and one owner, VERSION 1.4.1 or 1.5.0, no module, no guard (core v2's own checks, CoreV2SafeChecks,
#    pin the rest: proxy and singleton code, handler). The platform is SH_SEPOLIA_PLATFORM_SAFE when set, else the
#    file's.
# 4. Runs Step 2's dry run of script/DeployCoreV1.s.sol against $RPC from $WALLET (read-only: forge simulates, nothing
#    is signed or sent, no key is read) and prints the spec hash and the hook it predicts. Box 0's hook address follows
#    the time (its CREATE2 salt is mined over init code that holds openAt), and the wallet's nonce (13 keeps the
#    runbook's other addresses). From Sepolia's Glamsterdam fork on (its latest block at or after 1791294816,
#    2026-10-06 13:53:36 UTC) the dry run simulates the fork's rules, `--hardfork amsterdam`, as Step 2 does for
#    Z1 = after (the deploy script refuses a post-fork run without them, and a pre-fork run with them); the spec hash
#    and the hook do not depend on them.
#
# --deployed <registry> (review of sh-open-at-final, finding 1): once box 0 exists, the repository's spec files must hold
# its openAt, or the verifier (Step 5: "the registry's spec matches no committed spec file") and `pnpm verify` (Step 2's
# row) fail on any checkout but the founder's. Read-only on $RPC (Sepolia): box 0's openAt from its hook, the spec hash
# from the registry's entry and the platform from the factory; the generator writes the four files for that openAt
# (SH_SEPOLIA_OPEN_AT_DEPLOYED=1: no lead check, the time may have passed; the Safe file with the factory's platform
# when that has code) into a scratch folder, and they replace the
# ones in script/config (or SH_SEPOLIA_SPEC_DIR) only if one of them has the registry's spec hash and the factory's
# platform; otherwise nothing is written.
#
# Environment: the runbook's settings blocks (RPC, WALLET, SPEC, FOUNDRY_PROFILE, SH_CORE_V1_GLAMSTERDAM_ACK); with
# --deployed only RPC. Needs forge and cast (Foundry), python3, Node ^22.23.4, ^24.22.1 or >=26.12.1 (the repository's
# engines, enforced by engine-strict; nvm's 24.22.1 is used when it is installed) and the repository's packages, installed
# once from packages/contracts with `(cd ../.. && PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH" pnpm install --frozen-lockfile)`
# (a default Node 23 is refused by that install: ERR_PNPM_UNSUPPORTED_ENGINE).
# Knobs for rehearsals and tests only (the runbook sets none):
#   SH_OPEN_AT_MIN_LEAD    seconds instead of 2700 (45 minutes), at least 900 (the deploy script's 15 minutes)
#   SH_SEPOLIA_SPEC_DIR    write the four files into this folder under packages/contracts instead of script/config
#                          (scripts/core-v1-life-run.sh: script/config/rehearsal-runs/<port>, gitignored); $SPEC must
#                          be the file there
#   SH_OPEN_AT_CHECK_ONLY=1  steps 1 and 2 only, the time check (nothing written, no dry run; not with --deployed)
#   SH_OPEN_AT_NOW         Unix seconds to check against instead of the latest block's time: only with
#                          SH_OPEN_AT_CHECK_ONLY=1, so a spec file is only ever written against Sepolia's own clock
#   SH_SEPOLIA_PLATFORM_SAFE  the Safe file's platform instead of the file's own (a rehearsal's local Safe; checked as
#                          above; the founder's comes in the committed file); refused with any other SPEC
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."

refuse() {
  echo "REFUSED: $*" >&2
  exit 1
}

# The four Sepolia spec files the generator writes (packages/box-spec/src/sepolia-box0-spec.test.ts).
SAFE_FILE=box0-spec.11155111.rehearsal.sepolia-safe.json
SPEC_FILES=(box0-spec.11155111.rehearsal.json box0-spec.11155111.json box0-spec.11155111.safe.json "$SAFE_FILE")
# The Safe file's platform until the founder's Safe is written into it (the generator's EXAMPLE_SEPOLIA_PLATFORM_SAFE).
EXAMPLE_SAFE=0x00000000000000000000000000000000005aFE01
GUARD_SLOT=0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8
lower() { echo "$1" | tr 'A-F' 'a-f'; }

MIN_LEAD="${SH_OPEN_AT_MIN_LEAD:-2700}"
MAX_AHEAD=1209600
TAX_STEP=12
WINDOW=384
DEPLOY_FLOOR=900
case "$MIN_LEAD" in '' | *[!0-9]*) refuse "SH_OPEN_AT_MIN_LEAD must be a number of seconds" ;; esac
[ "$MIN_LEAD" -ge "$DEPLOY_FLOOR" ] ||
  refuse "SH_OPEN_AT_MIN_LEAD=$MIN_LEAD is under the deploy script's 15 minutes ($DEPLOY_FLOOR seconds)"
CHECK_ONLY="${SH_OPEN_AT_CHECK_ONLY:-}"
if [ -n "${SH_OPEN_AT_NOW:-}" ] && [ "$CHECK_ONLY" != 1 ]; then
  refuse "SH_OPEN_AT_NOW (a clock other than Sepolia's) is taken only with SH_OPEN_AT_CHECK_ONLY=1: the spec files are written only against Sepolia's latest block"
fi
MODE=pick
if [ "${1:-}" = --deployed ]; then
  MODE=deployed
  [ $# -eq 2 ] || {
    echo "usage: scripts/sepolia-open-at.sh --deployed <the registry Step 3 printed>" >&2
    exit 1
  }
  REGISTRY="$2"
  [[ "$REGISTRY" =~ ^0x[0-9a-fA-F]{40}$ ]] || refuse "\"$REGISTRY\" is not an address (0x and 40 hex digits): give the registry Step 3 printed"
  [ -z "$CHECK_ONLY" ] && [ -z "${SH_OPEN_AT_NOW:-}" ] ||
    refuse "--deployed records what the chain holds: not with SH_OPEN_AT_CHECK_ONLY or SH_OPEN_AT_NOW"
fi
[ "$MODE" = deployed ] || [ $# -eq 1 ] || {
  echo "usage: scripts/sepolia-open-at.sh <the opening time in UTC, like 2026-10-06T11:00Z>" >&2
  echo "       scripts/sepolia-open-at.sh --deployed <the registry Step 3 printed>" >&2
  exit 1
}

# utc <unix> <strftime format>
utc() {
  python3 -c 'import datetime, sys; print(datetime.datetime.fromtimestamp(int(sys.argv[1]), datetime.timezone.utc).strftime(sys.argv[2]))' "$1" "$2"
}
# span <seconds>: "2 h 4 min", "45 min", "14 days"
span() {
  python3 -c '
import sys
s = int(sys.argv[1])
d, r = divmod(s, 86400)
h, r = divmod(r, 3600)
m, r = divmod(r, 60)
parts = [f"{d} days" if d != 1 else "1 day"] if d else []
parts += [f"{h} h"] if h else []
parts += [f"{m} min"] if m or not parts else []
parts += [f"{r} s"] if r else []
print(" ".join(parts))' "$1"
}
# lead_text: "45 minutes", or seconds when not whole minutes
if [ $((MIN_LEAD % 60)) -eq 0 ]; then LEAD_TEXT="$((MIN_LEAD / 60)) minutes"; else LEAD_TEXT="$MIN_LEAD seconds"; fi

# node_ready: Node for the generator and the repository's packages, before Sepolia is read or anything written (review
# of sh-open-at-final, finding 4). nvm's 24.22.1 when installed (the founder's default terminal has Node 23.11.1, which
# the repository's engines refuse: ^22.23.4 || ^24.22.1 || >=26.12.1 with engine-strict), else the first Node on PATH.
# The engines' floors are the Node.js security release of 2026-10-21 (SH-NODE-24-22-1).
ROOT="$(cd ../.. && pwd)"
NVM24="$HOME/.nvm/versions/node/v24.22.1/bin"
ENGINES='Node ^22.23.4, ^24.22.1 or >=26.12.1'
# node_in_engines major minor patch: the repository's engines, ^22.23.4 || ^24.22.1 || >=26.12.1.
node_in_engines() {
  local m p
  case "$1" in 22) m=23 p=4 ;; 24) m=22 p=1 ;; 26) m=12 p=1 ;; *) [ "$1" -gt 26 ]; return ;; esac
  [ "$2" -gt "$m" ] || { [ "$2" -eq "$m" ] && [ "$3" -ge "$p" ]; }
}
node_ready() {
  local install v major minor patch
  if [ -d "$NVM24" ]; then
    export PATH="$NVM24:$PATH"
    install='(cd ../.. && PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH" pnpm install --frozen-lockfile)'
  else
    install="(cd ../.. && pnpm install --frozen-lockfile), with $ENGINES first on PATH"
  fi
  command -v node >/dev/null 2>&1 || refuse "Node is needed to write the spec files: $ENGINES (nvm install 24.22.1)"
  v="$(node -v 2>/dev/null || true)"
  IFS=. read -r major minor patch <<<"${v#v}"
  case "$major.$minor.$patch" in *[!0-9.]* | .* | *. | *..* | *.*.*.*) refuse "node -v printed \"$v\": $ENGINES is needed (nvm install 24.22.1)" ;; esac
  if ! node_in_engines "$major" "$minor" "$patch"; then
    refuse "Node $v is outside the repository's engines ($ENGINES): nvm install 24.22.1, then this again"
  fi
  [ -x "$ROOT/node_modules/.bin/vitest" ] ||
    refuse "the repository's packages are not installed: from packages/contracts, run $install once ($ENGINES: a default Node 23 is refused, ERR_PNPM_UNSUPPORTED_ENGINE), then this again"
}
# sepolia_rpc: $RPC set and answering for Sepolia.
sepolia_rpc() {
  [ -n "${RPC:-}" ] || refuse "RPC is not set: paste the runbook's settings blocks first (Z0-Z4, then the unchanged block)"
  CHAIN="$(cast chain-id --rpc-url "$RPC" 2>/dev/null)" || refuse "no answer from $RPC: try again, or another Sepolia RPC"
  [ "$CHAIN" = 11155111 ] || refuse "RPC answers for chain $CHAIN, not Sepolia (11155111)"
}

if [ "$MODE" = deployed ]; then
  [ -n "${RPC:-}" ] || refuse "RPC is not set: export RPC=<a keyless Sepolia RPC> first"
  node_ready
  sepolia_rpc
  DIR="${SH_SEPOLIA_SPEC_DIR:-script/config}"
  [ "$(cast code "$REGISTRY" --rpc-url "$RPC")" != 0x ] ||
    refuse "no code at $REGISTRY on Sepolia: not deployed yet, or not the registry Step 3 printed. Nothing was written."
  COUNT="$(cast call "$REGISTRY" 'boxCount()(uint256)' --rpc-url "$RPC" | sed -n '1{s/ .*//;p;}')"
  [ "$COUNT" -ge 1 ] 2>/dev/null || refuse "the registry $REGISTRY holds no box yet (createBox is Step 3's last transaction). Nothing was written."
  CHAIN_HASH="$(cast call "$REGISTRY" 'entry(uint256)(address,uint256,bytes32,bytes32,bytes32)' 0 --rpc-url "$RPC" | sed -n '4p')"
  BOX="$(cast call "$REGISTRY" 'coordinatorOf(uint256)(address)' 0 --rpc-url "$RPC")"
  HOOK="$(cast call "$BOX" 'hook()(address)' --rpc-url "$RPC")"
  T="$(cast call "$HOOK" 'openAt()(uint256)' --rpc-url "$RPC" | sed -n '1{s/ .*//;p;}')"
  FACTORY_PLATFORM="$(cast call "$(cast call "$REGISTRY" 'factory()(address)' --rpc-url "$RPC")" 'platformSafe()(address)' --rpc-url "$RPC")"
  # The Safe file is regenerated with the factory's platform when that has code (a Safe: SH-SEP-BOX0-SAFE); an address
  # without code (the testnet deployer, the mainnet Safe's) has a file of its own, and the Safe file keeps its platform.
  RECORD_SAFE=""
  [ "$(cast code "$FACTORY_PLATFORM" --rpc-url "$RPC")" = 0x ] || RECORD_SAFE="$FACTORY_PLATFORM"
  case "$CHAIN_HASH" in 0x[0-9a-f]*) ;; *) refuse "the registry's entry(0) gave no spec hash (\"$CHAIN_HASH\")" ;; esac
  echo "box 0 of registry $REGISTRY: opens at $(utc "$T" '%Y-%m-%d %H:%M:%S UTC') (openAt $T), spec hash $CHAIN_HASH, platform $FACTORY_PLATFORM"
  TMP_ROOT="${TMPDIR:-/tmp}"
  LOGS="$(mktemp -d "${TMP_ROOT%/}/sepolia-open-at.XXXXXX")"
  SCRATCH="script/config/rehearsal-runs/deployed.$$"
  rm -rf "$SCRATCH"
  trap 'rm -rf "$SCRATCH"' EXIT
  (cd "$ROOT" && SH_SEPOLIA_OPEN_AT="$T" SH_SEPOLIA_OPEN_AT_DEPLOYED=1 SH_SEPOLIA_SPEC_DIR="$SCRATCH" SH_WRITE_VECTORS= \
    SH_SEPOLIA_PLATFORM_SAFE="$RECORD_SAFE" \
    node_modules/.bin/vitest run packages/box-spec/src/sepolia-box0-spec.test.ts >"$LOGS/spec-files.log" 2>&1) ||
    refuse "the spec files for openAt $T were not made (see $LOGS/spec-files.log). Nothing was written."
  MATCH=""
  for f in "${SPEC_FILES[@]}"; do
    read -r FILE_HASH FILE_PLATFORM < <(python3 -c '
import json, sys
f = json.load(open(sys.argv[1]))
print(f["specHash"], f["platform"])' "$SCRATCH/$f")
    if [ "$FILE_HASH" = "$CHAIN_HASH" ]; then
      MATCH="$f"
      [ "$(echo "$FILE_PLATFORM" | tr 'A-F' 'a-f')" = "$(echo "$FACTORY_PLATFORM" | tr 'A-F' 'a-f')" ] ||
        refuse "$f has the registry's spec hash but names platform $FILE_PLATFORM, the factory $FACTORY_PLATFORM. Nothing was written."
    fi
  done
  [ -n "$MATCH" ] || refuse "the registry's spec hash $CHAIN_HASH is none of the four Sepolia spec files for openAt $T: box 0 was not created from this checkout's spec files (see $LOGS/spec-files.log). Nothing was written."
  mkdir -p "$DIR"
  for f in "${SPEC_FILES[@]}"; do
    cp "$SCRATCH/$f" "$DIR/$f"
  done
  echo "recorded: $DIR/$MATCH is box 0's spec (the registry's spec hash); the four Sepolia spec files in $DIR now hold openAt $T"
  echo "commit them: the verifier (Step 5) and pnpm verify read them"
  exit 0
fi

# 1. The time, UTC only.
T="$(python3 - "$1" <<'PY'
import datetime, re, sys
m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?Z", sys.argv[1])
if not m:
    sys.exit(1)
y, mo, d, h, mi, s = (int(x) if x is not None else 0 for x in m.groups())
try:
    t = datetime.datetime(y, mo, d, h, mi, s, tzinfo=datetime.timezone.utc)
except ValueError:
    sys.exit(1)
print(int(t.timestamp()))
PY
)" || refuse "\"$1\" is not a UTC time: write it like 2026-10-06T11:00Z (UTC, with the Z; seconds optional: 2026-10-06T11:00:30Z)"

# 2. The settings, Node and the packages first (nothing to read or write without them), then the time against
#    Sepolia's latest block (or, to check only, the clock given).
if [ "$CHECK_ONLY" != 1 ]; then
  [ -n "${WALLET:-}" ] || refuse "WALLET is not set: paste the runbook's settings blocks first"
  [ -n "${SPEC:-}" ] || refuse "SPEC is not set: paste the runbook's settings blocks first"
  NAME="$(basename "$SPEC")"
  case "$NAME" in
  box0-spec.11155111.rehearsal.json | "$SAFE_FILE") BUILD=rehearsal ;;
  box0-spec.11155111.json | box0-spec.11155111.safe.json) BUILD=default ;;
  *) refuse "SPEC=$SPEC is not one of the four Sepolia spec files" ;;
  esac
  [ "${FOUNDRY_PROFILE:-default}" = "$BUILD" ] ||
    refuse "SPEC=$SPEC is the $BUILD build's file, but FOUNDRY_PROFILE is ${FOUNDRY_PROFILE:-unset}: paste Z0-Z4 again"
  # The generator writes SH_SEPOLIA_PLATFORM_SAFE into the Safe file whatever SPEC is; it is checked only with the Safe
  # file as SPEC (below), so with another SPEC it would land in the Safe file unchecked.
  [ -z "${SH_SEPOLIA_PLATFORM_SAFE:-}" ] || [ "$NAME" = "$SAFE_FILE" ] ||
    refuse "SH_SEPOLIA_PLATFORM_SAFE is set, but SPEC=$SPEC is not the Safe file ($SAFE_FILE), so the Safe would be written unchecked: unset SH_SEPOLIA_PLATFORM_SAFE, or use the Safe file. Nothing was written."
  DIR="${SH_SEPOLIA_SPEC_DIR:-script/config}"
  [ "$SPEC" = "$DIR/$NAME" ] || refuse "SPEC=$SPEC is not where the files are written ($DIR/$NAME)"
  node_ready
fi
if [ -n "${SH_OPEN_AT_NOW:-}" ]; then
  case "$SH_OPEN_AT_NOW" in *[!0-9]*) refuse "SH_OPEN_AT_NOW must be Unix seconds" ;; esac
  NOW="$SH_OPEN_AT_NOW"
  CLOCK="the clock given"
else
  sepolia_rpc
  NOW="$(cast block latest --field timestamp --rpc-url "$RPC")"
  CLOCK="Sepolia's latest block"
fi
LEAD=$((T - NOW))
if [ "$LEAD" -lt "$MIN_LEAD" ]; then
  if [ "$LEAD" -le 0 ]; then WHEN="has passed: $(utc "$NOW" '%Y-%m-%d %H:%M:%S UTC') at $CLOCK"
  else WHEN="is only $(span "$LEAD") after $CLOCK ($(utc "$NOW" '%Y-%m-%d %H:%M:%S UTC'))"; fi
  refuse "$(utc "$T" '%Y-%m-%d %H:%M:%S UTC') $WHEN. Pick a time at least $LEAD_TEXT ahead, so the dry run, the 15 transactions and the verifier come before the open. Nothing was written."
fi
if [ "$LEAD" -gt "$MAX_AHEAD" ]; then
  refuse "$(utc "$T" '%Y-%m-%d %H:%M:%S UTC') is $(span "$LEAD") after $CLOCK ($(utc "$NOW" '%Y-%m-%d %H:%M:%S UTC')). Pick a time at most 14 days ahead (the factory refuses box 0 otherwise: OpenAtTooFar). Nothing was written."
fi
# Sepolia's slots fall every 12 seconds from its beacon genesis (1,655,733,600, a whole minute): the window opens in the
# first block at or after openAt and ends 384 seconds after openAt (32 steps of 12 seconds).
GENESIS=1655733600
SLOT=$((GENESIS + (T - GENESIS + 11) / 12 * 12))
echo "opening time: $(utc "$T" '%Y-%m-%d %H:%M:%S UTC') (openAt $T), $(span "$LEAD") after $CLOCK ($(utc "$NOW" '%Y-%m-%d %H:%M:%S UTC'))"
echo "window: $(utc "$T" '%H:%M:%S') to $(utc $((T + WINDOW)) '%H:%M:%S') UTC ($((WINDOW / TAX_STEP)) steps of $TAX_STEP seconds); its first block: Sepolia's slot at $(utc "$SLOT" '%H:%M:%S')"
echo "send Step 3 before $(utc $((T - DEPLOY_FLOOR)) '%H:%M:%S') UTC (the deploy script refuses an opening time less than 15 minutes away: OpenAtTooSoon)"
if [ "$CHECK_ONLY" = 1 ]; then
  echo "check only (SH_OPEN_AT_CHECK_ONLY=1): nothing written, no dry run"
  exit 0
fi

# The Sepolia platform Safe (the Safe file only; SH-SEP-BOX0-SAFE), read-only on $RPC, before anything is written.
SAFE=""
if [ "$NAME" = "$SAFE_FILE" ]; then
  SAFE="${SH_SEPOLIA_PLATFORM_SAFE:-}"
  if [ -z "$SAFE" ]; then
    [ -f "$SPEC" ] || refuse "$SPEC is missing and SH_SEPOLIA_PLATFORM_SAFE is not set: no platform Safe to check. Nothing was written."
    SAFE="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["platform"])' "$SPEC")"
  fi
  [[ "$SAFE" =~ ^0x[0-9a-fA-F]{40}$ ]] || refuse "the platform Safe \"$SAFE\" is not an address (0x and 40 hex digits). Nothing was written."
  [ "$(lower "$SAFE")" != "$(lower "$EXAMPLE_SAFE")" ] ||
    refuse "$SPEC names $SAFE, the generator's example, not your Sepolia platform Safe: we write yours into the file (SH_SEPOLIA_PLATFORM_SAFE=<your Safe> pnpm sepolia-spec:write) and send you that commit; check it out and run this again. Nothing was written."
  [ "$(cast code "$SAFE" --rpc-url "$RPC")" != 0x ] ||
    refuse "the platform $SAFE has no code on Sepolia: not a Safe (make the 1-of-1 platform Safe first, then give us its address). Nothing was written."
  SAFE_THRESHOLD="$(cast call "$SAFE" 'getThreshold()(uint256)' --rpc-url "$RPC" | sed -n '1{s/ .*//;p;}')" ||
    refuse "the platform $SAFE answers no getThreshold(): not a Safe. Nothing was written."
  SAFE_OWNERS="$(cast call "$SAFE" 'getOwners()(address[])' --rpc-url "$RPC")" ||
    refuse "the platform $SAFE answers no getOwners(): not a Safe. Nothing was written."
  SAFE_VERSION="$(cast call "$SAFE" 'VERSION()(string)' --rpc-url "$RPC" | tr -d '"')" ||
    refuse "the platform $SAFE answers no VERSION(): not a Safe. Nothing was written."
  SAFE_MODULES="$(cast call "$SAFE" 'getModulesPaginated(address,uint256)(address[],address)' \
    0x0000000000000000000000000000000000000001 1 --rpc-url "$RPC" | sed -n '1p')" ||
    refuse "the platform $SAFE answers no getModulesPaginated(): not a Safe 1.4.1 or 1.5.0. Nothing was written."
  SAFE_GUARD="$(cast storage "$SAFE" "$GUARD_SLOT" --rpc-url "$RPC")"
  OWNER_COUNT="$(python3 -c 'import re, sys; print(len(re.findall(r"0x[0-9a-fA-F]{40}", sys.argv[1])))' "$SAFE_OWNERS")"
  [ "$SAFE_THRESHOLD" = 1 ] || refuse "the platform Safe $SAFE has threshold $SAFE_THRESHOLD: box 0's platform Safe is 1-of-1 (you alone). Nothing was written."
  [ "$OWNER_COUNT" = 1 ] || refuse "the platform Safe $SAFE has $OWNER_COUNT owners ($SAFE_OWNERS): box 0's platform Safe is 1-of-1 (you alone). Nothing was written."
  case "$SAFE_VERSION" in 1.4.1 | 1.5.0) ;; *) refuse "the platform Safe $SAFE is version $SAFE_VERSION: core v2 takes Safe 1.4.1 or 1.5.0. Nothing was written." ;; esac
  [ "$SAFE_MODULES" = "[]" ] || refuse "the platform Safe $SAFE has a module enabled ($SAFE_MODULES): core v2 refuses it (UnsafeSafe). Nothing was written."
  [[ "$SAFE_GUARD" =~ ^0x0{64}$ ]] || refuse "the platform Safe $SAFE has a guard set ($SAFE_GUARD): core v2 refuses one it was not given (UnsafeSafe). Nothing was written."
  echo "platform Safe: $SAFE (1-of-1, owner ${SAFE_OWNERS//[\[\] ]/}, Safe $SAFE_VERSION, no modules, no guard)"
fi

# 3. The spec files (the settings, Node and the packages were checked in 2).
TMP_ROOT="${TMPDIR:-/tmp}"
LOGS="$(mktemp -d "${TMP_ROOT%/}/sepolia-open-at.XXXXXX")"
(cd "$ROOT" && SH_SEPOLIA_OPEN_AT="$T" SH_SEPOLIA_OPEN_AT_DEPLOYED= SH_WRITE_VECTORS=1 node_modules/.bin/vitest run \
  packages/box-spec/src/sepolia-box0-spec.test.ts >"$LOGS/spec-files.log" 2>&1) ||
  refuse "the spec files were not written (see $LOGS/spec-files.log)"
read -r FILE_OPEN FILE_HASH PLATFORM < <(python3 -c '
import json, sys
f = json.load(open(sys.argv[1]))
print(f["openAt"], f["specHash"], f["platform"])' "$SPEC")
[ "$FILE_OPEN" = "$T" ] || refuse "$SPEC holds openAt $FILE_OPEN, not $T (see $LOGS/spec-files.log)"
[ -z "$SAFE" ] || [ "$(lower "$PLATFORM")" = "$(lower "$SAFE")" ] ||
  refuse "$SPEC names platform $PLATFORM, not the Safe checked above ($SAFE): nothing was sent; run this again"
echo "spec files: $SPEC (and the other Sepolia files beside it), openAt $T"

# 4. Step 2's dry run: the spec hash and the hook, from the wallet's nonce today; after the fork under its rules.
GLAMSTERDAM_SEPOLIA=1791294816
HARDFORK=()
if [ "$NOW" -ge "$GLAMSTERDAM_SEPOLIA" ]; then HARDFORK=(--hardfork amsterdam); fi
echo "dry run against Sepolia from $WALLET (read-only: nothing is signed or sent; about a minute) ${HARDFORK[*]+${HARDFORK[*]}}..."
if ! SH_CORE_V1_SPEC_FILE="$SPEC" SH_CORE_V1_PLATFORM_SAFE="$PLATFORM" forge script script/DeployCoreV1.s.sol \
  --rpc-url "$RPC" --sender "$WALLET" --no-storage-caching ${HARDFORK[@]+"${HARDFORK[@]}"} >"$LOGS/dry-run.log" 2>&1 ||
  ! grep -q 'SIMULATION COMPLETE' "$LOGS/dry-run.log"; then
  grep -E 'Error|error:|revert' "$LOGS/dry-run.log" | tail -n 5 >&2 || true
  refuse "the dry run stopped (see $LOGS/dry-run.log). The spec files hold the new time; nothing was sent."
fi
DRY_HASH="$(sed -n 's/^ *spec hash: \(0x[0-9a-f]\{64\}\)$/\1/p' "$LOGS/dry-run.log" | head -n 1)"
HOOK_LINE="$(sed -n 's/^ *hook: \(0x[0-9a-fA-F]\{40\}\) salt: \(0x[0-9a-f]\{64\}\)$/\1 \2/p' "$LOGS/dry-run.log" | head -n 1)"
NONCE="$(sed -n '/== DeployCoreV1 plan (chain id, deployer, nonce) ==/{n;s/^ *11155111 0x[0-9a-fA-F]\{40\} \([0-9]*\)$/\1/p;}' "$LOGS/dry-run.log" | head -n 1)"
DRY_OPEN="$(sed -n 's/^ *openAt (Unix seconds, UTC): \([0-9]*\)$/\1/p' "$LOGS/dry-run.log" | head -n 1)"
[ "$DRY_HASH" = "$FILE_HASH" ] || refuse "the dry run's spec hash $DRY_HASH is not the file's $FILE_HASH (see $LOGS/dry-run.log)"
[ "$DRY_OPEN" = "$T" ] || refuse "the dry run read openAt $DRY_OPEN, not $T (see $LOGS/dry-run.log)"
[ -n "$HOOK_LINE" ] || refuse "the dry run printed no hook (see $LOGS/dry-run.log)"
echo "spec hash: $FILE_HASH"
echo "hook: ${HOOK_LINE% *} (salt ${HOOK_LINE#* }; predicted for $WALLET at nonce ${NONCE:-?}: another nonce moves it)"
echo "Step 2's dry run must print the same spec hash and hook. Logs: $LOGS"
