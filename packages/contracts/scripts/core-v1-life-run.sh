#!/usr/bin/env bash
# BC-071's life run of box 0 on core v1, rehearsed on a LOCAL anvil fork of Sepolia (docs/runbooks/sepolia-core-v1.md
# § After the deploy, § After graduation; docs/evidence/SH-life-run-rehearsal.md). NEVER broadcasts: no key exists
# anywhere; every sender (the testnet deployer as the keeper, and the founder's one buying wallet, wallet 1, which
# does every buy, the placeholder, the draw and the trades: F80) is impersonated on the local anvil
# (anvil_impersonateAccount, `cast send --unlocked`), as scripts/core-v1-simulate.sh sepolia-replay does. Sepolia
# itself is only read (the fork, keyless); drand rounds are read from api.drand.sh.
#
#   scripts/core-v1-life-run.sh             the life run below (steps 1-7)
#   scripts/core-v1-life-run.sh --runbook   step 1 with the runbook's own settings, build and Step 0 blocks (not
#                                           Step 0's install block, for a checkout without its packages; Step 0
#                                           pasted three times: refused at its 45 minutes, refused 14 days and a minute
#                                           ahead, then written for SH_LIFE_OPEN_IN with that lead; box 0's hook must be
#                                           the one it predicted), then the runbook's own code blocks (§ After the
#                                           deploy, § After graduation) as written, with the fork as RPC, the senders
#                                           impersonated instead of `--private-key "$(key …)"` (a `key` that refuses
#                                           replaces the runbook's), the waits it names mined (and one block per pass of
#                                           a chain-time wait and of the keeper's wait for the next block), the gate checked in a block at exactly openAt - 1 before
#                                           F1 (gate.sh: two real buys must fail), the window's tax checked at every step
#                                           edge to the second before F3 (steps.sh), the verifier at the points below
#                                           (BC-023's two checks required); then step 7
# Both modes, after the deploy: Step 4's record (scripts/sepolia-open-at.sh --deployed: the spec files recorded from the
# chain must be the ones box 0 was deployed from, byte for byte); after step 7: the site's manifest written by
# packages/chain's read-only writer as for Sepolia (refused without --platform-eoa, written with it).
#   scripts/core-v1-life-run.sh --check-runbook   only the check below (no fork, no RPC)
#   --rehearsal (before either mode)        F78's rehearsal build (FOUNDRY_PROFILE=rehearsal, its spec file
#                                           script/config/box0-spec.11155111.rehearsal.json, raise 0.4206980085 ETH)
#                                           with every SepETH size at 1/10 (the knobs' defaults below); without it the
#                                           full-size (mainnet) build. --runbook refuses a build other than the one the
#                                           runbook's Z0 line chooses (`export FOUNDRY_PROFILE=rehearsal`, or none).
#
# --runbook first refuses a runbook whose sh blocks (all of them, not only the two sections) hold a `#` outside quotes
# or leave a quote open: the founder pastes them into zsh, where `#` is not a comment unless interactivecomments is
# set (it is off by default and in his config), so a trailing note becomes arguments and an apostrophe in it opens a
# quote. It also refuses a postRound that does not first wait (an `until` line after the round's `NAME=`) for the chain
# to reach the round's time: a draw's round has the next slot's time, and a gas estimate at Sepolia's latest block (no
# block tag or `latest`; cast 1.8.3's `cast send` asks for `pending`, other versions and tools may not) refuses the post
# until that block is out (RoundNotYet); anvil estimates on its pending block, so the fork run itself cannot show that
# refusal (review of sh-sepolia-base). It then runs the blocks the way a paste reads them: fed to an interactive
# `zsh -f` (SH_LIFE_RUNBOOK_SHELL=zsh, the default) or to bash (SH_LIFE_RUNBOOK_SHELL=bash).
#
# 1. Fork Sepolia on 127.0.0.1:$SH_LIFE_ANVIL_PORT (default 8556; 8550-8558 only), with Osaka's rules: refused once
#    Sepolia's latest block is past its Glamsterdam fork (1,791,294,816, 2026-10-06 13:53:36 UTC; the deploy script's
#    GLAMSTERDAM_SEPOLIA), since such a run no longer rehearses Sepolia (F97's post-fork rehearsal runs the deploy on
#    anvil --hardfork amsterdam and box 0's life on the geth devnet: SH-glamsterdam-after, scripts/
#    glamsterdam-after-rehearsal.py). The spec files written for an open
#    SH_LIFE_OPEN_IN seconds after the fork's time (default 1,080: 18 minutes; F80: openAt is a clock time, and the
#    deploy script takes one at least 15 minutes ahead) into script/config/rehearsal-runs/<port>/ (gitignored) by the
#    generator (`SH_SEPOLIA_SPEC_DIR`; the committed files keep the founder's deploy-day time, which would put the
#    fork's clock days ahead of drand's published rounds); the dry run of script/DeployCoreV1.s.sol against the fork
#    and the replay of its 15 transactions (the runbook's Step 2 and Step 3).
#    The post-deploy verifier (BoxCoreConformanceDeployedTest, the runbook's Step 5) runs on the box before the open,
#    after the window (windowEndsAt), after graduation and at the end (step 7), in both modes: verify-<label>.log.
# 2. The open (waited for in real time: the fork's clock follows the machine's and stays with drand's): a refused buy
#    before it; a taxed launch-router buy in the window (wallet 1) and a placeholder taken; a direct buy refused in the
#    window; D1 shown on a snapshot (an overshooting router buy in the window's last step, from openAt + 372 s: partial
#    fill and refund), then reverted.
# 3. From the window's end (windowEndsAt, openAt + 384 s): the router refuses (WindowClosed); wallet 1 buys SH_LIFE_BUY1 through Uniswap's PoolSwapTest
#    on Sepolia (a direct PoolManager caller) with P1 as the price limit; wallet 1 then sends SH_LIFE_FILL with the
#    same limit: the swap stops at P1 (the curve closes in that swap, D1) and PoolSwapTest returns the unspent ETH.
# 4. graduate() by the keeper (the deployer) in its own transaction (a limit below the four follow-ups' budget is
#    refused, GasTooLow); the D6 reward claimed; sweep, payFit, payPlatform.
# 5. The graduation word (real quicknet round, posted), the placeholder opened with the test set's reveal; a draw with
#    its bounty, its round posted, settled and opened (both items wallet 1's); a few trades, a fee batch, one
#    per-Misfit stream claim for both items.
# 6. The keeper hours (12-second blocks, one at a time), as F95 R19U ("Deepen every hour, collect every 2 hours, never
#    collect right before deepen") and F96 R19G (the keeper pokes every block while the price is more than 1% from its
#    latest sample) order them: each block a poke of FIT's executor (box 0's price average) while the pool's tick is
#    100 ticks or more from its latest sample; deepen() every 300 blocks (from graduation, then from the last deepen),
#    sent when its preview adds or converts; collect() 600 blocks after the last batch, held while a deepen is due or
#    due within 25 blocks; FIT's executor `execute(1)` every 25 blocks after the first deepen, ten times or until it
#    stops buying; in the second hour wallet 1 buys, holds 10 blocks (the price is then off its latest sample, so
#    R19G's pokes run) and sells the tokens back, so the 2-hour batch has fees.
# 7. The post-deploy verifier (BoxCoreConformanceDeployedTest) on the graduated box.
#
# Every transaction and every state goes to $SH_LIFE_OUT (default .s7-sim/life-run, gitignored): life-run.log (all
# output), txs.tsv (step, sender, gas used, block), states.tsv (the box's phase and figures at each step).
#
# Knobs: SH_LIFE_OPEN_IN (seconds from the fork's time to the open, default 1080, at least 900), SH_LIFE_WALLET1
# (default the founder's 0x5583…6658, the one buying wallet), SH_LIFE_FAUCET (wallet 1's funds
# on the fork, default 5 ether; 0.5 with --rehearsal: what the runbook says it needs at most, below the 4.97 it holds),
# SH_LIFE_WINDOW_BUY (0.03 ether; 0.003), SH_LIFE_BUY1 (2.4 ether; 0.24), SH_LIFE_FILL (2 ether; 0.2), SH_LIFE_TRADE
# (0.55 ether; 0.055),
# SH_LIFE_RUNBOOK_SHELL (--runbook only: zsh, the default, or bash), SEPOLIA_PUBLIC_RPC (tried first; then the
# Tenderly gateway and publicnode, the first that answers: publicnode reset connections under the prep's
# replays, so Tenderly is preferred).
#
# Every forge run against the local anvil passes --no-storage-caching (SH-sepolia-prep, review finding 2).
set -Eeuo pipefail
# The last failing command, printed if the run stops on it (set -e).
LAST_ERR=""
trap 'LAST_ERR="line $LINENO: $BASH_COMMAND"' ERR

export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."

MODE=life
BUILD=mainnet
if [ "${1:-}" = --rehearsal ]; then
  BUILD=rehearsal
  shift
fi
case "${1:-}" in
"") ;;
--runbook) MODE=runbook ;;
--check-runbook) MODE=check ;;
*) echo "usage: $0 [--rehearsal] [--runbook | --check-runbook]" >&2; exit 1 ;;
esac
# F78: the build profile (foundry.toml). Every forge call below inherits FOUNDRY_PROFILE from the environment.
if [ "$BUILD" = rehearsal ]; then export FOUNDRY_PROFILE=rehearsal; else unset FOUNDRY_PROFILE; fi

RUNBOOK=../../docs/runbooks/sepolia-core-v1.md
# check_runbook: every sh block of the runbook must paste into zsh as it reads in bash. Refuses a `#` outside quotes
# (zsh without interactivecomments, the default, passes it and the rest of the line to the command), a quote left
# open at the end of a block (an apostrophe in such a note: zsh then waits at `quote>` and swallows the next lines)
# and a `<word>` placeholder outside quotes (a redirection from the file `word`: zsh stops at `no such file or
# directory`, and `zsh -n` parses it; Step 5's `<registry>`, review of the merge of main).
check_runbook() {
  python3 - "$RUNBOOK" <<'PY'
import re, shutil, subprocess, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text()
problems, blocks, zsh_missing = [], 0, False
# Read as bash reads it (a `#` starting a word comments out the rest of the line, quotes in it included), so every
# such note is reported on its own line; any other `#` outside quotes is refused too.
for m in re.finditer(r"^```(?:sh|bash|zsh|shell)\n(.*?)^```", text, re.M | re.S):
    blocks += 1
    first = text.count("\n", 0, m.start(1)) + 1
    line, quote, opened, escaped, comment, prev = first, None, first, False, False, "\n"
    body = m.group(1)
    for i, ch in enumerate(body):
        if comment:
            comment = ch != "\n"
        elif escaped:
            escaped = False
        elif quote == "'":
            quote = None if ch == "'" else quote
        elif ch == "\\":
            escaped = True
        elif quote == '"':
            quote = None if ch == '"' else quote
        elif ch in "'\"":
            quote, opened = ch, line
        elif ch == "#":
            comment = prev in " \t\n;&|()"
            what = "a note after '#' (zsh passes it on as arguments)" if comment else "a '#' outside quotes (quote it)"
            problems.append(f"runbook line {line}: {what}")
        elif ch == "<":
            ph = re.match(r"<[A-Za-z][A-Za-z0-9_.-]*>", body[i:])
            if ph:
                problems.append(f"runbook line {line}: a placeholder '{ph.group(0)}' outside quotes "
                                "(zsh reads it as a redirection)")
        if ch == "\n":
            line += 1
        prev = ch
    if quote:
        problems.append(f"runbook line {opened}: a {quote} quote is never closed in its block")
    # Every postRound waits first, after its round's NAME=, for the chain to reach the round's time (review of
    # sh-sepolia-base): a draw's round has the next slot's time, and an estimate at the latest block refuses it before.
    lines = m.group(1).split("\n")
    for i, ln in enumerate(lines):
        if "postRound(" not in ln:
            continue
        nm = re.search(r"'postRound\(uint256,bytes\)' \$([A-Za-z_][A-Za-z0-9_]*) ", ln)
        if not nm:
            problems.append(f"runbook line {first + i}: postRound's round is not a $NAME the block sets and waits for")
            continue
        name = nm.group(1)
        wait_re = re.compile(
            r'^until \[ "\$\(cast block latest --field timestamp --rpc-url \$RPC\)" -ge '
            r'"\$\(python3 scripts/drand-round\.py --time \$' + name + r'\)" \]; do sleep [1-9][0-9]?; done$')
        sets = [j for j in range(i) if lines[j].startswith(name + "=")]
        waits = [j for j in range(i) if wait_re.match(lines[j])]
        if not waits or (sets and waits[-1] < sets[-1]):
            problems.append(f"runbook line {first + i}: postRound without a wait for the chain to reach round "
                            f"${name}'s time after {name}= "
                            "(an estimate at the latest block refuses it: RoundNotYet)")
    # zsh's own parser on the block, as a paste reads it (interactive, its defaults, -n: parsed, never run).
    if shutil.which("zsh"):
        r = subprocess.run(["zsh", "-f", "-i", "-n"], input=m.group(1), capture_output=True, text=True)
        for msg in re.findall(r"zsh: [^\n%]*", r.stderr):
            problems.append(f"runbook block at line {first}: {msg.strip()}")
    else:
        zsh_missing = True
if zsh_missing:
    print("LIFE|runbook check|zsh is not installed: its parse check was skipped")
for p in problems:
    print(f"LIFE|runbook check|{p}")
print(f"LIFE|runbook check|{blocks} sh blocks, {len(problems)} problems")
sys.exit(1 if problems else 0)
PY
}
if [ "$MODE" = check ]; then
  check_runbook || exit 1
  exit 0
fi
if [ "$MODE" = runbook ]; then
  check_runbook || { echo "LIFE|FAILED|the runbook's sh blocks do not paste into zsh as written (above)" >&2; exit 1; }
  # The runbook's Z0 line chooses its build; its commands' sizes and P1 are that build's (the box-spec test
  # src/sepolia-runbook.test.ts checks them). Run its blocks only against the same build.
  RUNBOOK_BUILD="$(python3 - "$RUNBOOK" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
blocks = [b for b in re.findall(r"^```sh\n(.*?)^```", text, re.M | re.S) if re.search(r"^export SPEC=", b, re.M)]
m = re.search(r"^export FOUNDRY_PROFILE=(\S+)$", blocks[0], re.M) if len(blocks) == 1 else None
print("rehearsal" if m and m.group(1) == "rehearsal" else "mainnet")
PY
)"
  if [ "$RUNBOOK_BUILD" != "$BUILD" ]; then
    echo "LIFE|FAILED|the runbook's Z0 chooses the $RUNBOOK_BUILD build; run with$([ "$RUNBOOK_BUILD" = rehearsal ] && echo "" || echo "out") --rehearsal" >&2
    exit 1
  fi
fi
PORT="${SH_LIFE_ANVIL_PORT:-8556}"
case "$PORT" in 855[0-8]) ;; *) echo "error: the life run's anvil uses ports 8550-8558" >&2; exit 1 ;; esac
RUNBOOK_SHELL="${SH_LIFE_RUNBOOK_SHELL:-zsh}"
case "$RUNBOOK_SHELL" in zsh | bash) ;; *) echo "error: SH_LIFE_RUNBOOK_SHELL is zsh or bash" >&2; exit 1 ;; esac
if [ "$MODE" = runbook ] && ! command -v "$RUNBOOK_SHELL" >/dev/null; then
  echo "error: $RUNBOOK_SHELL is not installed" >&2
  exit 1
fi
RPC="http://127.0.0.1:${PORT}"
OUT="${SH_LIFE_OUT:-.s7-sim/life-run$([ "$MODE" = runbook ] && echo "-runbook-$RUNBOOK_SHELL")}"
# The keyless public RPCs of the repository's .env.example, first the one that answers.
SEPOLIA_RPC=""
for candidate in ${SEPOLIA_PUBLIC_RPC:-} https://sepolia.gateway.tenderly.co https://ethereum-sepolia-rpc.publicnode.com; do
  if [ "$(cast chain-id --rpc-url "$candidate" 2>/dev/null)" = "11155111" ]; then
    SEPOLIA_RPC="$candidate"
    break
  fi
done
[ -n "$SEPOLIA_RPC" ] || { echo "error: no Sepolia RPC answers" >&2; exit 1; }
if [ "$BUILD" = rehearsal ]; then SPEC_NAME=box0-spec.11155111.rehearsal.json; else SPEC_NAME=box0-spec.11155111.json; fi
SPEC="script/config/$SPEC_NAME"
OPEN_IN="${SH_LIFE_OPEN_IN:-1080}"
[ "$OPEN_IN" -ge 900 ] || { echo "error: SH_LIFE_OPEN_IN must be at least 900 (the deploy script's 15 minutes)" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "error: pnpm (node 24) is needed to write the rehearsal's spec files" >&2; exit 1; }

DEPLOYER=0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE
W1="${SH_LIFE_WALLET1:-0x5583f846B0dDC80f49ea0E89C51520bA341c6658}"
# Every SepETH size at the build's scale (F78: the rehearsal build's curve holds 1/10 of the raise).
if [ "$BUILD" = rehearsal ]; then
  FAUCET="${SH_LIFE_FAUCET:-0.5ether}"
  WINDOW_BUY="${SH_LIFE_WINDOW_BUY:-0.003ether}"
  BUY1="${SH_LIFE_BUY1:-0.24ether}"
  FILL="${SH_LIFE_FILL:-0.2ether}"
  TRADE="${SH_LIFE_TRADE:-0.055ether}"
  D1_BUY=1ether
  PROBE=0.001ether
else
  FAUCET="${SH_LIFE_FAUCET:-5ether}"
  WINDOW_BUY="${SH_LIFE_WINDOW_BUY:-0.03ether}"
  BUY1="${SH_LIFE_BUY1:-2.4ether}"
  FILL="${SH_LIFE_FILL:-2ether}"
  TRADE="${SH_LIFE_TRADE:-0.55ether}"
  D1_BUY=10ether
  PROBE=0.01ether
fi

# Uniswap v4 on Sepolia: the PoolManager box 0's spec pins, and Uniswap's PoolSwapTest router on it (lib/v4-core
# src/test/PoolSwapTest.sol; it pays the PoolManager from msg.value and sends the unspent ETH back to the caller).
POOL_MANAGER=0xE03A1074c86CFeDd5C142C4F04F1a1536e203543
SWAPTEST=0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe
SWAP_SIG='swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes)'
REVEAL_TYPE='(uint128,bytes32,bytes32,bytes32,bytes32,bytes32[])'
MIN_SQRT_PLUS_1=4295128740
MAX_SQRT_MINUS_1=1461446703485210103287273052203988822378723970341

mkdir -p "$OUT"
LOG="$OUT/life-run.log"
: >"$LOG"
exec > >(tee -a "$LOG") 2>&1
printf 'step\tlabel\tfrom\tgas_used\tblock\tstatus\ttx\n' >"$OUT/txs.tsv"
printf 'label\tblock\ttimestamp\tphase\tdetail\n' >"$OUT/states.tsv"

say() { echo "LIFE|$*"; }
die() {
  echo "LIFE|FAILED|$*" >&2
  exit 1
}

if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  die "something already answers on $RPC; pick another SH_LIFE_ANVIL_PORT (8550-8558)"
fi

# ------------------------------------------------------------------------------------------------ the fork
BASE_FEE="$(cast base-fee --rpc-url "$SEPOLIA_RPC")"
FORK_BLOCK="$(cast block-number --rpc-url "$SEPOLIA_RPC")"
FORK_TIME="$(cast block "$FORK_BLOCK" --field timestamp --rpc-url "$SEPOLIA_RPC")"
say "Sepolia via $SEPOLIA_RPC: block $FORK_BLOCK (time $FORK_TIME), base fee $BASE_FEE wei; deployer nonce $(cast nonce "$DEPLOYER" --rpc-url "$SEPOLIA_RPC")"
# The fork runs Osaka (anvil --hardfork osaka below). Past Sepolia's Glamsterdam fork (script/DeployCoreV1.s.sol
# GLAMSTERDAM_SEPOLIA) that is no longer Sepolia's rules, so this run would not rehearse Sepolia: refused.
GLAMSTERDAM_SEPOLIA=1791294816
[ "$FORK_TIME" -lt "$GLAMSTERDAM_SEPOLIA" ] ||
  die "Sepolia is past its Glamsterdam fork (block $FORK_BLOCK, time $FORK_TIME >= $GLAMSTERDAM_SEPOLIA): this Osaka fork would not rehearse it; the post-fork rehearsal runs the deploy on anvil --hardfork amsterdam and box 0's life on the geth devnet (docs/evidence/SH-glamsterdam-after.md, scripts/glamsterdam-after-rehearsal.py)"
anvil --fork-url "$SEPOLIA_RPC" --fork-block-number "$FORK_BLOCK" --port "$PORT" --hardfork osaka \
  --enable-tx-gas-limit --retries 10 --fork-retry-backoff 2000 >"$OUT/anvil.log" 2>&1 &
ANVIL_PID=$!
cleanup() {
  local rc=$?
  kill "$ANVIL_PID" 2>/dev/null || true
  wait "$ANVIL_PID" 2>/dev/null || true
  [ "$rc" = 0 ] || echo "LIFE|STOPPED|exit $rc|last failing command: $LAST_ERR" >&2
}
trap cleanup EXIT
for _ in $(seq 1 300); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.2
done
[ "$(cast chain-id --rpc-url "$RPC")" = "11155111" ] || die "the fork is not Sepolia"
say "local anvil fork of Sepolia on $RPC at block $(cast block-number --rpc-url "$RPC") (pid $ANVIL_PID)"

# ------------------------------------------------------------------------------------------------ helpers
STEP=0
LAST_JSON=""

# The error selectors this run expects, for readable reverts.
ERRORS_TSV="$OUT/errors.tsv"
: >"$ERRORS_TSV"
for e in 'WrappedError(address,bytes4,bytes,bytes)' 'NotOpen(uint256)' 'WindowClosed(uint256)' \
  'TradingNotOpen(uint256)' 'BuyThroughLaunchRouter(address,uint256)' 'CurveIsClosed(uint256)' 'CurveIsClosed()' \
  'BatchTooSmall(uint256,uint256)' 'NotClosed()' 'GasTooLow(uint256,uint256)' 'RoundNotYet(uint256,uint256)' \
  'WordNotReady()' 'NotSettled(uint256)' 'BountyTooLow(uint256,uint256)' 'InsufficientOutput(uint256,uint256)' \
  'Expired(uint256)' 'NotGraduated()' 'NothingToSweep()' 'HookCallFailed()' 'BelowCurveFloor(uint160)'; do
  printf '%s\t%s\n' "$(cast sig "$e")" "$e" >>"$ERRORS_TSV"
done

# why <text>: the revert names found in a cast error message (the outer error, then a wrapped hook's reason).
why() {
  python3 - "$ERRORS_TSV" "$1" <<'PY'
import re, sys
names = dict(line.rstrip("\n").split("\t") for line in open(sys.argv[1]) if line.strip())
# `cast call` prints data: "0x…"; `cast send --json` escapes the quotes (data: \"0x…\").
m = re.search(r'data: \\?"0x([0-9a-fA-F]*)', sys.argv[2])
if not m:
    print("no revert data: " + sys.argv[2].strip().splitlines()[-1][:200]); sys.exit(0)
d = m.group(1).lower()


def arg(word):
    v = int(word, 16)
    return f"0x{v:040x}" if v >= 1 << 64 else str(v)


found = []
outer = "0x" + d[:8]
first = d[8:72]
found.append(names.get(outer, outer) + (f" [{arg(first)}]" if len(first) == 64 and outer != "0x90bfb865" else ""))
# A wrapped reason (v4's WrappedError) sits at a 32-byte boundary of the encoding: scan for known selectors there.
for pos in range(8, len(d) - 8, 64):
    sel = "0x" + d[pos:pos + 8]
    if sel in names and sel != outer:
        found.append(names[sel] + (f" [{arg(word)}]" if len(word := d[pos + 8:pos + 72]) == 64 else ""))
print(" -> ".join(found))
PY
}

# send <label> <from> <value|-> <to> <signature> [args...]: one impersonated transaction, recorded.
send() {
  local label="$1" from="$2" value="$3" to="$4" sig="$5"
  shift 5
  local extra=()
  [ "$value" != "-" ] && extra+=(--value "$value")
  [ -n "${GAS_LIMIT:-}" ] && extra+=(--gas-limit "$GAS_LIMIT")
  [ -n "${GAS_PRICE:-}" ] && extra+=(--gas-price "$GAS_PRICE")
  local nonce0 out attempt
  nonce0="$(cast nonce "$from" --rpc-url "$RPC")"
  STEP=$((STEP + 1))
  LAST_JSON="$OUT/tx-$(printf '%02d' "$STEP")-$label.json"
  for attempt in 1 2 3; do
    out="$(cast send "$to" "$sig" "$@" --from "$from" --unlocked --rpc-url "$RPC" --rpc-timeout 600 --json \
      ${extra[@]+"${extra[@]}"} 2>&1 || true)"
    printf '%s\n' "$out" >"$LAST_JSON"
    if python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if "status" in r else 1)' \
      "$LAST_JSON" 2>/dev/null; then
      break
    fi
    # Not mined (an RPC error under the fork, or a revert in the estimate): retry only if the nonce did not move.
    [ "$(cast nonce "$from" --rpc-url "$RPC")" = "$nonce0" ] || break
    if [ "$attempt" = 3 ] || ! printf '%s' "$out" | grep -qiE 'connection|error sending request|timed out|database'; then
      die "$label: $(why "$out")"
    fi
    sleep 3
  done
  python3 - "$LAST_JSON" "$STEP" "$label" "$from" "$OUT/txs.tsv" <<'PY' || die "$label: mined with status 0"
import json, sys
r = json.load(open(sys.argv[1]))
status, gas, block = int(r["status"], 16), int(r["gasUsed"], 16), int(r["blockNumber"], 16)
with open(sys.argv[5], "a") as f:
    f.write(f"{sys.argv[2]}\t{sys.argv[3]}\t{sys.argv[4]}\t{gas}\t{block}\t{status}\t{r['transactionHash']}\n")
print(f"LIFE|tx|{sys.argv[2]}|{sys.argv[3]}|from {sys.argv[4]}|gas used {gas:,}|block {block}|status {status}")
sys.exit(0 if status == 1 else 1)
PY
}

# refused <label> <from> <value|-> <to> <signature> [args...]: an eth_call that must revert; prints why.
refused() {
  local label="$1" from="$2" value="$3" to="$4" sig="$5"
  shift 5
  local extra=()
  [ "$value" != "-" ] && extra+=(--value "$value")
  local out
  if out="$(cast call "$to" "$sig" "$@" --from "$from" --rpc-url "$RPC" ${extra[@]+"${extra[@]}"} 2>&1)"; then
    die "$label: expected a revert, got $out"
  fi
  say "refused|$label|block $(cast block-number --rpc-url "$RPC")|$(why "$out")"
}

# The first value of a `cast call` (drops cast's "[1.2e3]" annotation).
val() { cast call "$@" --rpc-url "$RPC" | sed -n '1{s/ .*//;p;}'; }

# data words of the first log a contract emitted with topic0 = keccak(event) in the last transaction
logwords() {
  python3 - "$LAST_JSON" "$1" "$(cast keccak "$2")" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
for l in r["logs"]:
    if l["address"].lower() == sys.argv[2].lower() and l["topics"][0] == sys.argv[3]:
        d = l["data"][2:]
        print(" ".join(str(int(d[i:i + 64], 16)) for i in range(0, len(d), 64)))
        break
PY
}

eth() { python3 -c "import sys; print(f'{int(sys.argv[1]) / 1e18:.9f}')" "$1"; }
tok() { python3 -c "import sys; print(f'{int(sys.argv[1]) / 1e18:,.6f}')" "$1"; }
wei() { cast to-wei "${1%ether}" ether; }

PHASES=(None Upcoming Window Bonding Closed Graduated)
state() {
  local label="$1" detail="${2:-}"
  local b ts ph
  b="$(cast block-number --rpc-url "$RPC")"
  ts="$(cast block latest --field timestamp --rpc-url "$RPC")"
  ph="$(val "$BOX" 'phase()(uint8)')"
  printf '%s\t%s\t%s\t%s\t%s\n' "$label" "$b" "$ts" "${PHASES[$ph]}" "$detail" >>"$OUT/states.tsv"
  say "state|$label|block $b|phase ${PHASES[$ph]}|$detail"
}

# wait_until <unix time>: waits in real time until then, then mines one block at that time at the latest (F80: the open
# and the window's end are times). The fork's clock follows the machine's (anvil stamps new blocks with it, a few
# seconds behind: it starts from the forked block's time), so it stays with drand's published rounds, which the draws
# after graduation need: the run waits for the open as the founder does, instead of moving the fork's clock ahead of
# drand; only the few seconds the fork lags are set with evm_setNextBlockTimestamp.
wait_until() {
  local at="$1" now
  now="$(date +%s)"
  while [ "$now" -lt "$at" ]; do
    sleep $(((at - now) > 30 ? 30 : (at - now)))
    now="$(date +%s)"
  done
  if [ "$(cast block latest --field timestamp --rpc-url "$RPC")" -lt "$at" ]; then
    cast rpc evm_setNextBlockTimestamp "$(cast to-hex "$at")" --rpc-url "$RPC" >/dev/null
  fi
  cast rpc evm_mine --rpc-url "$RPC" --rpc-timeout 600 >/dev/null
}

# mine_to <block> <seconds per block>: 16 blocks a call (a fork mines slowly: each block reads back to the RPC).
mine_to() {
  local target="$1" interval="$2" n k
  n="$(cast block-number --rpc-url "$RPC")"
  while [ "$n" -lt "$target" ]; do
    k=$((target - n))
    [ "$k" -gt 16 ] && k=16
    cast rpc anvil_mine "$(cast to-hex "$k")" "$(cast to-hex "$interval")" --rpc-url "$RPC" --rpc-timeout 600 \
      >/dev/null || sleep 3
    n="$(cast block-number --rpc-url "$RPC")"
  done
}

deadline() { echo $(($(cast block latest --field timestamp --rpc-url "$RPC") + 600)); }

# post_round <round>: waits for the real quicknet round on api.drand.sh and posts it (the keeper).
post_round() {
  local round="$1" sig
  say "drand|round $round (time $(python3 scripts/drand-round.py --time "$round"), fork time $(cast block latest --field timestamp --rpc-url "$RPC"), now $(date +%s))"
  sig="$(python3 scripts/drand-round.py "$round" --wait)" || die "drand round $round not published"
  # The fork's clock must have reached the round's time too (postRound refuses earlier: RoundNotYet).
  local at
  at="$(python3 scripts/drand-round.py --time "$round")"
  if [ "$(cast block latest --field timestamp --rpc-url "$RPC")" -lt "$at" ]; then
    cast rpc evm_setNextBlockTimestamp "$(cast to-hex "$at")" --rpc-url "$RPC" >/dev/null
  fi
  send "postRound-$round" "$DEPLOYER" - "$DRAND" 'postRound(uint256,bytes)' "$round" "$sig"
}

reveal_of() {
  forge script script/SepoliaBox0Reveal.s.sol --sig 'run(uint256)' "$1" 2>/dev/null | sed -n 's/^ *REVEAL|//p'
}

# ------------------------------------------------------------------------------------------------ 1. deploy (replay)
# The spec files for an open OPEN_IN seconds after the fork's time, written into script/config/rehearsal-runs/<port>/
# (F80; gitignored: the committed files keep the founder's deploy-day time). Without --runbook: by the generator, on
# Sepolia's 12-second slot grid. With --runbook: by the runbook's own Step 0 (scripts/sepolia-open-at.sh), pasted into
# zsh after the runbook's settings blocks and its build, for the next whole minute at least OPEN_IN after the fork's
# time (as the founder types a time); the fork is the RPC and SH_SEPOLIA_SPEC_DIR the run's folder (the runbook sets
# neither). Step 0 is pasted three times: at the runbook's own 45-minute guard (refused: the pick is only OPEN_IN
# ahead), 14 days and a minute ahead (refused), then with the rehearsal's lead, SH_OPEN_AT_MIN_LEAD=OPEN_IN (written;
# its dry run predicts the hook, which box 0 must then have).
SPEC_DIR="script/config/rehearsal-runs/$PORT"
SPEC="$SPEC_DIR/$SPEC_NAME"
FORK_NOW="$(cast block latest --field timestamp --rpc-url "$RPC")"
utc_text() {
  python3 -c 'import datetime, sys; print(datetime.datetime.fromtimestamp(int(sys.argv[1]), datetime.timezone.utc).strftime(sys.argv[2]))' "$1" "$2"
}
if [ "$MODE" = runbook ]; then
  OPEN_PICK=$(((FORK_NOW + OPEN_IN + 59) / 60 * 60))
  FAR_PICK=$(((FORK_NOW + 14 * 86400 + 60 + 59) / 60 * 60))
  PICK_TEXT="$(utc_text "$OPEN_PICK" '%Y-%m-%dT%H:%MZ')"
  FAR_TEXT="$(utc_text "$FAR_PICK" '%Y-%m-%dT%H:%MZ')"
  rm -rf "$SPEC_DIR"
  mkdir -p "$SPEC_DIR"
  # The committed file first, so the runbook's "unchanged" block reads its platform as on the founder's machine; Step
  # 0 then rewrites it (and must leave it as it is when it refuses).
  cp "script/config/$SPEC_NAME" "$SPEC"
  COMMITTED_OPEN="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["openAt"])' "$SPEC")"
  PRE="$OUT/runbook-deploy-run.sh"
  python3 - "$RUNBOOK" "$PRE" "$RPC" "$SPEC" "$PICK_TEXT" "$FAR_TEXT" "$OPEN_IN" <<'PY' || die "could not read the runbook's settings, build and Step 0 blocks"
import re, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text()
part = text[text.index("## The settings"):text.index("## Step 1")]
rpc, spec, pick, far, lead = sys.argv[3:8]
blocks = re.findall(r"^```sh\n(.*?)^```", part, re.M | re.S)
# Step 0's install block runs only if Step 0 says the packages are not installed; this checkout has them (Step 0's
# vitest), so it is left out, never pasted.
installs = [b for b in blocks if "pnpm install" in b]
if len(installs) != 1 or not re.fullmatch(r"\(cd \.\./\.\. && [^\n]* pnpm install --frozen-lockfile\)\n", installs[0]):
    sys.exit(f"expected one install block before Step 0 (found {len(installs)})")
blocks = [b for b in blocks if b is not installs[0]]
picks = [b for b in blocks if "sepolia-open-at.sh" in b]
if len(blocks) != 4 or len(picks) != 1 or not re.fullmatch(r"scripts/sepolia-open-at\.sh \S+\n", picks[0]):
    sys.exit(f"expected the settings, unchanged, build and Step 0 blocks (found {len(blocks)}, Step 0 {len(picks)})")
out = []
for b in blocks:
    if b is picks[0]:
        continue
    b = re.sub(r"^export RPC=\S+", f"export RPC={rpc}", b, flags=re.M)
    b = re.sub(r"^export SPEC=\S+", f"export SPEC={spec}", b, flags=re.M)
    if "--private-key" in b or "$(key " in b:
        sys.exit("a key use in the settings blocks")
    out.append(b)


def step0(t):
    return re.sub(r"^(scripts/sepolia-open-at\.sh) \S+$", lambda m: f"{m.group(1)} {t}", picks[0], flags=re.M)


openat = """echo "LIFE|pick|spec file openAt $(grep -o '"openAt": [0-9]*' "$SPEC" | grep -o '[0-9]*$')"\n"""
for label, t, env in (("soon", pick, ""), ("far", far, ""), ("rehearsal", pick, f"export SH_OPEN_AT_MIN_LEAD={lead}\n")):
    out.append(f'{env}echo "LIFE|pick|attempt {label}|{t}|SH_OPEN_AT_MIN_LEAD=${{SH_OPEN_AT_MIN_LEAD:-unset}}"\n')
    out.append(step0(t))
    out.append('echo "LIFE|pick|exit $?"\n' + openat)
Path(sys.argv[2]).write_text("".join(out))
PY
  say "step 0|the runbook's settings, build and Step 0 pasted into zsh: $PICK_TEXT (the fork's time $FORK_NOW + $((OPEN_PICK - FORK_NOW)) s), then $FAR_TEXT"
  env PS1= PS2= SH_SEPOLIA_SPEC_DIR="$SPEC_DIR" zsh -f -i +o promptcr +o promptsp <"$PRE" >"$OUT/runbook-deploy-run.log" 2>&1 ||
    die "the runbook's deploy blocks stopped in zsh (see $OUT/runbook-deploy-run.log)"
  if grep -nE "^zsh(: |:[0-9]+: )|command not found|parse error|unmatched" "$OUT/runbook-deploy-run.log"; then
    die "zsh reported the errors above in the runbook's deploy blocks (see $OUT/runbook-deploy-run.log)"
  fi
  STEP0="$(python3 - "$OUT/runbook-deploy-run.log" "$COMMITTED_OPEN" "$OPEN_PICK" <<'PY'
import re, sys
log = open(sys.argv[1]).read()
committed, pick = sys.argv[2], sys.argv[3]
parts = re.split(r"^LIFE\|pick\|attempt ", log, flags=re.M)[1:]
if len(parts) != 3:
    sys.exit(f"expected three Step 0 attempts, found {len(parts)}")
want = (("soon", "1", "at least 45 minutes", committed), ("far", "1", "at most 14 days", committed),
        ("rehearsal", "0", "spec hash:", pick))
found = []
for part, (label, code, says, openat) in zip(parts, want):
    got = re.search(r"^LIFE\|pick\|exit (\d+)$", part, re.M)
    file_open = re.search(r"^LIFE\|pick\|spec file openAt (\d+)$", part, re.M)
    if not part.startswith(label) or not got or got.group(1) != code or says not in part:
        sys.exit(f"Step 0 {label}: expected exit {code} and {says!r}:\n{part[-1500:]}")
    if not file_open or file_open.group(1) != openat:
        sys.exit(f"Step 0 {label}: the spec file holds openAt {file_open and file_open.group(1)}, expected {openat}")
    first = next((ln for ln in part.splitlines() if ln.startswith(("REFUSED", "opening time"))), "")
    print(f"LIFE|step 0|{label}|exit {code}|spec file openAt {file_open.group(1)}|{first}", file=sys.stderr)
    if label == "rehearsal":
        found = [re.search(r"^spec hash: (0x[0-9a-f]{64})$", part, re.M).group(1),
                 re.search(r"^hook: (0x[0-9a-fA-F]{40}) ", part, re.M).group(1)]
print(" ".join(found))
PY
)" || die "Step 0 did not refuse and accept as the runbook says (see $OUT/runbook-deploy-run.log)"
  read -r PICK_HASH PICK_HOOK <<<"$STEP0"
  say "step 0|written for $PICK_TEXT: spec hash $PICK_HASH, predicted hook $PICK_HOOK"
else
  OPEN_PICK=$(((FORK_NOW + OPEN_IN + 11) / 12 * 12))
  SPEC_LOG="$(cd "$OUT" && pwd)/spec-files.log"
  (cd ../.. && SH_SEPOLIA_OPEN_AT="$OPEN_PICK" SH_SEPOLIA_SPEC_DIR="$SPEC_DIR" \
    pnpm -s sepolia-spec:write >"$SPEC_LOG" 2>&1) || die "the spec files (see $SPEC_LOG)"
fi
export SH_CORE_V1_SPEC_FILE="$SPEC"
say "spec|$SPEC|openAt $OPEN_PICK ($(date -u -r "$OPEN_PICK" '+%Y-%m-%d %H:%M:%S UTC' 2>/dev/null || date -u -d "@$OPEN_PICK" '+%Y-%m-%d %H:%M:%S UTC'))|spec hash $(sed -n 's/.*"specHash": "\(0x[0-9a-f]*\)".*/\1/p' "$SPEC")"
PLATFORM="$(sed -n 's/.*"platform": "\(0x[0-9a-fA-F]\{40\}\)".*/\1/p' "$SPEC" | head -n 1)"
say "deploy|the runbook's Step 2 against the fork (dry run), then Step 3 replayed with the deployer impersonated"
SH_CORE_V1_SPEC_FILE="$SPEC" SH_CORE_V1_PLATFORM_SAFE="$PLATFORM" forge script script/DeployCoreV1.s.sol \
  --rpc-url "$RPC" --sender "$DEPLOYER" --no-storage-caching -vv >"$OUT/deploy-dry-run.log" 2>&1 ||
  die "dry run (see $OUT/deploy-dry-run.log)"
grep -q 'SIMULATION COMPLETE' "$OUT/deploy-dry-run.log" || die "dry run did not complete"
python3 scripts/core-v1-replay.py broadcast/DeployCoreV1.s.sol/11155111/dry-run/run-latest.json --rpc "$RPC" \
  --base-fee-wei "$BASE_FEE" --out "$OUT/replay.json" >"$OUT/replay.log" 2>&1 || die "replay (see $OUT/replay.log)"
grep '^REPLAY|total\|^REPLAY|at base fee' "$OUT/replay.log" | sed 's/^/LIFE|deploy|/'

FACTORY="$(sed -n 's/^ *factory: \(0x[0-9a-fA-F]\{40\}\)$/\1/p' "$OUT/deploy-dry-run.log" | head -n 1)"
REGISTRY="$(val "$FACTORY" 'registry()(address)')"
BOX="$(val "$REGISTRY" 'coordinatorOf(uint256)(address)' 0)"
HOOK="$(val "$BOX" 'hook()(address)')"
T="$(val "$BOX" 'token()(address)')"
VAULT="$(val "$BOX" 'vault()(address)')"
COLLECTION="$(val "$BOX" 'collection()(address)')"
RECEIVER="$(val "$BOX" 'receiver()(address)')"
ROUTER="$(val "$BOX" 'launchRouter()(address)')"
TICKETS="$(val "$BOX" 'tickets()(address)')"
STREAM="$(val "$BOX" 'itemStream()(address)')"
EXECUTOR="$(val "$BOX" 'executor()(address)')"
# F143: box 0's randomness() is its BoxBackedSource, which holds its requests and words; rounds are posted and bounties
# withdrawn on the DrandSource its DRAND() names (the runbook's once-per-terminal block reads them the same way).
SOURCE="$(val "$BOX" 'randomness()(address)')"
DRAND="$(val "$SOURCE" 'DRAND()(address)')"
[[ "$DRAND" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "box 0's source $SOURCE answered no DRAND() address ('$DRAND'): rounds would not be posted on a DrandSource"
[ "$(val "$SWAPTEST" 'manager()(address)')" = "$POOL_MANAGER" ] || die "PoolSwapTest does not serve the PoolManager"
POOL_KEY="(0x0000000000000000000000000000000000000000,$T,10000,60,$HOOK)"
read -r TICK_LOWER TICK_UPPER _ < <(cast call "$HOOK" 'curve()(int24,int24,uint128)' --rpc-url "$RPC" | cut -d' ' -f1 | paste -sd' ' -)
# √P1: the curve's lower tick (ETH is currency0, so a buy lowers the tick and the curve ends at tickLower), as v4's
# TickMath.getSqrtPriceAtTick computes it.
SQRT_P1="$(python3 - "$TICK_LOWER" <<'PY'
import sys
C = [0xfff97272373d413259a46990580e213a, 0xfff2e50f5f656932ef12357cf3c7fdcc, 0xffe5caca7e10e4e61c3624eaa0941cd0,
     0xffcb9843d60f6159c9db58835c926644, 0xff973b41fa98c081472e6896dfb254c0, 0xff2ea16466c96a3843ec78b326b52861,
     0xfe5dee046a99a2a811c461f1969c3053, 0xfcbe86c7900a88aedcffc83b479aa3a4, 0xf987a7253ac413176f2b074cf7815e54,
     0xf3392b0822b70005940c7a398e4b70f3, 0xe7159475a2c29b7443b29c7fa6e889d9, 0xd097f3bdfd2022b8845ad8f792aa5825,
     0xa9f746462d870fdf8a65dc1f90e061e5, 0x70d869a156d2a1b890bb3df62baf32f7, 0x31be135f97d08fd981231505542fcfa6,
     0x9aa508b5b7a84e1c677de54f3e99bc9, 0x5d6af8dedb81196699c329225ee604, 0x2216e584f5fa1ea926041bedfe98,
     0x48a170391f7dc42444e8fa2]
t = int(sys.argv[1]); a = abs(t)
p = 0xfffcb933bd6fad37aa2d162d1a594001 if a & 1 else 1 << 128
for i, c in enumerate(C):
    if a & (2 << i):
        p = (p * c) >> 128
if t > 0:
    p = ((1 << 256) - 1) // p
print((p + (1 << 32) - 1) >> 32)
PY
)"
OPEN="$(val "$HOOK" 'openAt()(uint256)')"
END="$(val "$HOOK" 'windowEndsAt()(uint256)')"
CREATED="$(cast block-number --rpc-url "$RPC")"
[ "$OPEN" = "$OPEN_PICK" ] || die "box 0 opens at $OPEN, not at the spec's $OPEN_PICK"
[ "$END" = $((OPEN + 384)) ] || die "box 0's window ends at $END, not at openAt + 384"
if [ "$MODE" = runbook ]; then
  [ "$(echo "$HOOK" | tr 'A-F' 'a-f')" = "$(echo "$PICK_HOOK" | tr 'A-F' 'a-f')" ] ||
    die "box 0's hook is $HOOK; Step 0 predicted $PICK_HOOK"
  DRY_HASH="$(sed -n 's/^ *spec hash: \(0x[0-9a-f]\{64\}\)$/\1/p' "$OUT/deploy-dry-run.log" | head -n 1)"
  [ "$DRY_HASH" = "$PICK_HASH" ] || die "Step 2's dry run printed spec hash $DRY_HASH, Step 0 $PICK_HASH"
  say "step 0|box 0's hook is the one Step 0 predicted ($HOOK); Step 2's dry run printed Step 0's spec hash"
fi
say "box 0|registry $REGISTRY|coordinator $BOX|hook $HOOK|token $T|launch router $ROUTER|tickets $TICKETS|stream $STREAM|executor $EXECUTOR|source $SOURCE|drand $DRAND"
# Step 4's record (ours; review of sh-open-at-final, finding 1): `scripts/sepolia-open-at.sh --deployed <registry>`
# reads box 0's openAt from the chain and writes the three spec files for it, kept only if one has the registry's spec
# hash; they must be the run's own Step 0 files, byte for byte (on deploy day the founder's are only in his checkout).
RECORDED="$SPEC_DIR/recorded"
rm -rf "$RECORDED"
RPC="$RPC" SH_SEPOLIA_SPEC_DIR="$RECORDED" bash scripts/sepolia-open-at.sh --deployed "$REGISTRY" >"$OUT/record-deployed.log" 2>&1 ||
  die "Step 4's record (scripts/sepolia-open-at.sh --deployed) refused (see $OUT/record-deployed.log)"
sed 's/^/LIFE|step 4|record|/' "$OUT/record-deployed.log"
for f in box0-spec.11155111.rehearsal.json box0-spec.11155111.json box0-spec.11155111.safe.json; do
  cmp -s "$SPEC_DIR/$f" "$RECORDED/$f" || die "Step 4's record: $RECORDED/$f is not the run's $SPEC_DIR/$f"
done
say "step 4|record|the three spec files recorded from the chain are the ones the box was deployed from, byte for byte ($RECORDED)"
say "box 0|build $BUILD|curve ticks $TICK_LOWER..$TICK_UPPER|sqrt P1 $SQRT_P1|raise $(eth "$(val "$BOX" 'raise()(uint256)')") ETH|open time $OPEN, window end $END (created at block $CREATED, time $(cast block latest --field timestamp --rpc-url "$RPC"))"
if [ "$BUILD" = rehearsal ]; then EXPECTED_RAISE=420698008500000000; else EXPECTED_RAISE=4206980085000000000; fi
[ "$(val "$BOX" 'raise()(uint256)')" = "$EXPECTED_RAISE" ] || die "box 0's raise is not the $BUILD build's"
state created "open time $OPEN"

for a in "$DEPLOYER" "$W1"; do
  cast rpc anvil_impersonateAccount "$a" --rpc-url "$RPC" >/dev/null
done
# The one buying wallet holds exactly SH_LIFE_FAUCET on the fork (on Sepolia it holds more: read above the fork).
say "wallets|wallet 1 on Sepolia: $(cast balance "$W1" --ether --rpc-url "$SEPOLIA_RPC") SepETH, nonce $(cast nonce "$W1" --rpc-url "$SEPOLIA_RPC")"
cast rpc anvil_setBalance "$W1" "$(cast to-hex "$(wei "$FAUCET")")" --rpc-url "$RPC" >/dev/null
say "wallets|deployer (the keeper) $DEPLOYER $(cast balance "$DEPLOYER" --ether --rpc-url "$RPC") ETH|wallet 1 $W1 $FAUCET on the fork"

# The post-deploy verifier, as the runbook's Step 5 runs it (FOUNDRY_PROFILE from the build above), as a script of its
# own so the --runbook runner calls it between blocks too: verify.sh <label> writes verify-<label>.log.
VERIFY="$OUT/verify.sh"
cat >"$VERIFY" <<VERIFY_SH
#!/usr/bin/env bash
set -uo pipefail
cd "$PWD"
export PATH="\$HOME/.foundry/bin:\$PATH"
label="\$1"
echo "LIFE|verifier|\$label|block \$(cast block-number --rpc-url $RPC)|phase \$(cast call $BOX 'phase()(uint8)' --rpc-url $RPC) (1 upcoming, 3 bonding, 5 graduated)|FOUNDRY_PROFILE=\${FOUNDRY_PROFILE:-default}"
if SH_CORE_V1_REGISTRY=$REGISTRY forge test --match-contract BoxCoreConformanceDeployedTest --fork-url $RPC \\
  -j 1 --fork-retries 5 --fork-retry-backoff 2000 --no-storage-caching -vv >"$OUT/verify-\$label.log" 2>&1; then
  grep -E 'Suite result|DEPLOYED\|build profile' "$OUT/verify-\$label.log" | sed "s/^/LIFE|verifier|\$label|/"
  grep -E 'test_BC023_' "$OUT/verify-\$label.log" | sed "s/^ */LIFE|verifier|\$label|/"
  grep -qE '\[PASS\] test_BC023_windowOpensAtTheSpecsTime' "$OUT/verify-\$label.log" &&
    grep -qE '\[PASS\] test_BC023_aMiswiredOpenFailsTheCheck' "$OUT/verify-\$label.log" ||
    { echo "LIFE|FAILED|BC-023 (the open to the second, and its miswire check) did not pass at \$label" >&2; exit 1; }
else
  grep -E 'Suite result|FAIL' "$OUT/verify-\$label.log" | sed "s/^/LIFE|verifier|\$label|/"
  echo "LIFE|FAILED|the verifier failed at \$label (see $OUT/verify-\$label.log)" >&2
  exit 1
fi
VERIFY_SH
chmod +x "$VERIFY"

# --runbook (F80): the gate in the second before the open, and the window's tax steps to the second, as scripts of their
# own that the runner calls with the setup block's variables (gate.sh before F1, steps.sh after F2, before F3). Both wait
# in real time and mine a block at exactly the second they check, so the fork's clock stays with the machine's (and
# drand's); helpers.sh carries the RPC, this run's error table and the run's own why and wait_until.
{
  echo "cd \"$PWD\""
  echo "export PATH=\"\$HOME/.foundry/bin:\$PATH\""
  echo "RPC=$RPC"
  echo "ERRORS_TSV=$ERRORS_TSV"
  echo "OUT=$OUT"
  declare -f why wait_until
  echo 'say() { echo "LIFE|$*"; }'
  echo 'fail() { echo "LIFE|FAILED|$*" >&2; exit 1; }'
} >"$OUT/helpers.sh"
GATE="$OUT/gate.sh"
cat >"$GATE" <<'GATE_SH'
#!/usr/bin/env bash
# gate.sh <router> <swaptest> <pool key> <P1> <wallet 1> <openAt> <hook> <amount in wei>: waits in real time until
# openAt - 1, then mines ONE block at exactly openAt - 1 holding two real buys from wallet 1 (the launch router's, and a
# direct one through PoolSwapTest, which the hook gates). Both must fail on chain (status 0), with NotOpen and the hook's
# TradingNotOpen; the same buy as a call at that block, and the router's quote, refuse alike; the hook's phase there is
# Upcoming. Then the block at exactly openAt: the phase is Window, the quote is step 0's (taxFor(amount, 0)), and the
# router's buy as a call at that block goes through.
set -euo pipefail
. "$(dirname "$0")/helpers.sh"
ROUTER="$1" SWAPTEST="$2" KEY="$3" P1="$4" W1="$5" OPEN="$6" HOOK="$7" AMT="$8"
SWAP='swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes)'
BUY='buy(uint256,uint256,address,uint256)'
AT=$((OPEN - 1))
[ "$(cast block latest --field timestamp --rpc-url "$RPC")" -lt "$AT" ] || fail "gate: the fork is already at openAt - 1 or later"
say "gate|waiting until openAt - 1 = $AT ($((AT - $(date +%s))) s from now)"
now="$(date +%s)"
while [ "$now" -lt "$AT" ]; do
  sleep $(((AT - now) > 30 ? 30 : (AT - now)))
  now="$(date +%s)"
done
N="$(cast nonce "$W1" --rpc-url "$RPC")"
trap 'cast rpc evm_setAutomine true --rpc-url "$RPC" >/dev/null 2>&1 || true' EXIT
cast rpc evm_setAutomine false --rpc-url "$RPC" >/dev/null
H1="$(cast send "$ROUTER" "$BUY" "$AMT" 1 "$W1" $((OPEN + 600)) --value "$AMT" --from "$W1" --unlocked \
  --gas-limit 1000000 --nonce "$N" --async --rpc-url "$RPC")"
H2="$(cast send "$SWAPTEST" "$SWAP" "$KEY" "(true,-$AMT,$P1)" "(false,false)" 0x --value "$AMT" --from "$W1" \
  --unlocked --gas-limit 1000000 --nonce $((N + 1)) --async --rpc-url "$RPC")"
cast rpc evm_setNextBlockTimestamp "$(cast to-hex "$AT")" --rpc-url "$RPC" >/dev/null
cast rpc evm_mine --rpc-url "$RPC" >/dev/null
cast rpc evm_setAutomine true --rpc-url "$RPC" >/dev/null
B="$(cast block-number --rpc-url "$RPC")"
TS="$(cast block "$B" --field timestamp --rpc-url "$RPC")"
[ "$TS" = "$AT" ] || fail "gate: block $B is at $TS, not openAt - 1 ($AT)"
for pair in "router buy|$H1" "direct buy through PoolSwapTest|$H2"; do
  what="${pair%%|*}"
  h="${pair#*|}"
  read -r status bn gas < <(cast receipt "$h" --json --rpc-url "$RPC" |
    python3 -c 'import json, sys; r = json.load(sys.stdin); print(int(r["status"], 16), int(r["blockNumber"], 16), int(r["gasUsed"], 16))')
  [ "$bn" = "$B" ] || fail "gate: the $what landed in block $bn, not $B"
  [ "$status" = 0 ] || fail "gate: the $what went through at openAt - 1"
  data="$(cast rpc debug_traceTransaction "$h" '{"tracer":"callTracer"}' --rpc-url "$RPC" |
    python3 -c 'import json, sys; print(json.load(sys.stdin).get("output", ""))')"
  say "gate|$what of $AMT wei by wallet 1, mined in block $B at $TS = openAt - 1|status 0, gas used $gas|$(why "data: \"$data\"")|tx $h"
done
if out="$(cast call "$ROUTER" "$BUY" "$AMT" 1 "$W1" $((OPEN + 600)) --value "$AMT" --from "$W1" --block "$B" \
  --rpc-url "$RPC" 2>&1)"; then
  fail "gate: the router's buy as a call at block $B went through: $out"
fi
say "gate|the router's buy as a call at block $B (openAt - 1)|$(why "$out")"
if out="$(cast call "$ROUTER" 'quote(uint256)(uint256,uint256)' "$AMT" --block "$B" --rpc-url "$RPC" 2>&1)"; then
  fail "gate: the router quoted at openAt - 1: $out"
fi
say "gate|the router's quote at block $B (openAt - 1)|$(why "$out")"
PH="$(cast call "$HOOK" 'phase()(uint8)' --block "$B" --rpc-url "$RPC")"
[ "$PH" = 1 ] || fail "gate: the hook's phase at openAt - 1 is $PH, not 1 (Upcoming)"
wait_until "$OPEN"
B2="$(cast block-number --rpc-url "$RPC")"
TS2="$(cast block "$B2" --field timestamp --rpc-url "$RPC")"
[ "$TS2" = "$OPEN" ] || fail "gate: block $B2 is at $TS2, not openAt ($OPEN)"
PH2="$(cast call "$HOOK" 'phase()(uint8)' --block "$B2" --rpc-url "$RPC")"
[ "$PH2" = 2 ] || fail "gate: the hook's phase at openAt is $PH2, not 2 (Window)"
read -r TAX SWAPIN < <(cast call "$ROUTER" 'quote(uint256)(uint256,uint256)' "$AMT" --block "$B2" --rpc-url "$RPC" |
  cut -d' ' -f1 | paste -sd' ' -)
WANT="$(cast call "$ROUTER" 'taxFor(uint256,uint256)(uint256)' "$AMT" 0 --rpc-url "$RPC" | cut -d' ' -f1)"
[ "$TAX" = "$WANT" ] || fail "gate: the quote at openAt taxes $TAX, step 0's tax is $WANT"
TOKENS="$(cast call "$ROUTER" "$BUY(uint256)" "$AMT" 1 "$W1" $((OPEN + 600)) --value "$AMT" --from "$W1" --block "$B2" \
  --rpc-url "$RPC" | cut -d' ' -f1)" || fail "gate: the router's buy as a call at openAt was refused"
say "gate|block $B at openAt - 1: phase 1 (Upcoming), both buys refused|block $B2 at openAt ($OPEN): phase 2 (Window), the quote is step 0's (tax $TAX of $AMT wei = taxFor(amount, 0)), the router's buy as a call there gives $TOKENS tokens"
GATE_SH
STEPS="$OUT/steps.sh"
cat >"$STEPS" <<'STEPS_SH'
#!/usr/bin/env bash
# steps.sh <router> <hook> <openAt> <windowEndsAt> <amount in wei>: the window's tax steps to the second. For every step
# boundary still ahead (openAt + 12 k, k = 1 … 32), a block at its last second (openAt + 12 k - 1) and one at the next
# step's first second, each mined at exactly that second after waiting for it in real time. At each: the hook's phase,
# and the router's quote for <amount> against taxFor(amount, step) with step = (t - openAt) / 12, its tax falling at
# every boundary; at windowEndsAt (openAt + 384) the phase is Bonding and the router refuses (WindowClosed).
# window-steps.tsv holds every row.
set -euo pipefail
. "$(dirname "$0")/helpers.sh"
ROUTER="$1" HOOK="$2" OPEN="$3" END="$4" AMT="$5"
[ "$END" = $((OPEN + 384)) ] || fail "steps: windowEndsAt $END is not openAt + 384"
TSV="$OUT/window-steps.tsv"
printf 'block\ttimestamp\tseconds after openAt\tstep\tphase\ttax (wei)\ttaxFor(amount, step)\ttaxPips(step)\n' >"$TSV"
n=0
drops=0
prev=""
for k in $(seq 1 32); do
  for t in $((OPEN + 12 * k - 1)) $((OPEN + 12 * k)); do
    if [ "$(cast block latest --field timestamp --rpc-url "$RPC")" -ge "$t" ]; then
      prev=""
      continue
    fi
    wait_until "$t"
    B="$(cast block-number --rpc-url "$RPC")"
    TS="$(cast block "$B" --field timestamp --rpc-url "$RPC")"
    [ "$TS" = "$t" ] || fail "steps: block $B is at $TS, not $t"
    PH="$(cast call "$HOOK" 'phase()(uint8)' --block "$B" --rpc-url "$RPC")"
    if [ "$t" -lt "$END" ]; then
      S=$(((t - OPEN) / 12))
      [ "$PH" = 2 ] || fail "steps: phase $PH at openAt + $((t - OPEN)) s, not 2 (Window)"
      read -r TAX SWAPIN < <(cast call "$ROUTER" 'quote(uint256)(uint256,uint256)' "$AMT" --block "$B" --rpc-url "$RPC" |
        cut -d' ' -f1 | paste -sd' ' -)
      WANT="$(cast call "$ROUTER" 'taxFor(uint256,uint256)(uint256)' "$AMT" "$S" --rpc-url "$RPC" | cut -d' ' -f1)"
      PIPS="$(cast call "$ROUTER" 'taxPips(uint256)(uint256)' "$S" --rpc-url "$RPC" | cut -d' ' -f1)"
      [ "$TAX" = "$WANT" ] || fail "steps: at openAt + $((t - OPEN)) s the quote taxes $TAX; step $S's tax is $WANT"
      [ "$(python3 -c 'import sys; print(int(sys.argv[1]) + int(sys.argv[2]))' "$TAX" "$SWAPIN")" = "$AMT" ] ||
        fail "steps: tax and swapped part do not add up to the amount at block $B"
      if [ $(((t - OPEN) % 12)) = 0 ] && [ -n "$prev" ]; then
        [ "$(python3 -c 'import sys; print(int(int(sys.argv[1]) < int(sys.argv[2])))' "$TAX" "$prev")" = 1 ] ||
          fail "steps: the tax did not fall from step $((S - 1)) to step $S ($prev to $TAX)"
        drops=$((drops + 1))
      fi
      prev="$TAX"
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$B" "$TS" "$((t - OPEN))" "$S" "$PH" "$TAX" "$WANT" "$PIPS" >>"$TSV"
    else
      [ "$PH" = 3 ] || fail "steps: phase $PH at windowEndsAt, not 3 (Bonding)"
      if out="$(cast call "$ROUTER" 'quote(uint256)(uint256,uint256)' "$AMT" --block "$B" --rpc-url "$RPC" 2>&1)"; then
        fail "steps: the router quoted at windowEndsAt: $out"
      fi
      CLOSED="$(why "$out")"
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$B" "$TS" "$((t - OPEN))" "-" "$PH" "$CLOSED" "-" "-" >>"$TSV"
    fi
    n=$((n + 1))
  done
done
[ -n "${CLOSED:-}" ] || fail "steps: no block at windowEndsAt"
say "steps|$n blocks, each at its second (the last of a step and the first of the next, openAt + 12 k - 1 and + 12 k): every quote is its step's taxFor(amount, (t - openAt) / 12), the tax falls at all $drops boundaries seen, the phase is Window to openAt + 383 s|at windowEndsAt ($END): phase 3 (Bonding), the router refuses: $CLOSED|rows: $TSV"
STEPS_SH
chmod +x "$GATE" "$STEPS"

bash "$VERIFY" upcoming || die "the verifier failed before the open"

if [ "$MODE" = life ]; then
# ------------------------------------------------------------------------------------------------ 2. the open and the window
refused "router buy before the open" "$W1" "$WINDOW_BUY" "$ROUTER" 'buy(uint256,uint256,address,uint256)(uint256)' \
  "$(wei "$WINDOW_BUY")" 1 "$W1" "$(deadline)"
refused "direct buy before the open" "$W1" "$WINDOW_BUY" "$SWAPTEST" "$SWAP_SIG" "$POOL_KEY" \
  "(true,-$(wei "$WINDOW_BUY"),$SQRT_P1)" "(false,false)" 0x
# Until openAt in real time (F80; about SH_LIFE_OPEN_IN after the fork's start); the next transactions land in step 0.
say "wait|until the open, $OPEN ($((OPEN - $(date +%s))) s from now)"
wait_until "$OPEN"
state "open" "the latest block at openAt + $(($(cast block latest --field timestamp --rpc-url "$RPC") - OPEN)) s (step 0)"
read -r QTAX QSWAP < <(cast call "$ROUTER" 'quote(uint256)(uint256,uint256)' "$(wei "$WINDOW_BUY")" --rpc-url "$RPC" | cut -d' ' -f1 | paste -sd' ' -)
say "quote|window buy $WINDOW_BUY at this block: tax $(eth "$QTAX") ETH, swapped $(eth "$QSWAP") ETH"
send window-buy "$W1" "$WINDOW_BUY" "$ROUTER" 'buy(uint256,uint256,address,uint256)' "$(wei "$WINDOW_BUY")" 1 "$W1" "$(deadline)"
read -r OFF QIN TAX TOUT REFUND < <(logwords "$ROUTER" 'TaxedBuy(address,address,uint256,uint256,uint256,uint256,uint256)') || die "no such event in the last transaction"
say "window buy|step $OFF|paid $(eth "$QIN") ETH|tax $(eth "$TAX") ETH|tokens $(tok "$TOUT")|refund $(eth "$REFUND")"
state window "launch tax held $(eth "$(val "$ROUTER" 'totalTaxCollected()(uint256)')") ETH"

read -r TP TF < <(cast call "$VAULT" 'quoteTake(uint256)(uint256,uint256)' 1 --rpc-url "$RPC" | cut -d' ' -f1 | paste -sd' ' -)
MAX_TAKE="$(python3 -c "import sys; print(int(sys.argv[1]) + int(sys.argv[2]))" "$TP" "$TF")"
send approve-tickets-w1 "$W1" - "$T" 'approve(address,uint256)' "$TICKETS" "$(cast max-uint)"
send take-placeholder "$W1" - "$TICKETS" 'take(uint256,uint256,uint256)' 1 "$MAX_TAKE" "$(deadline)"
say "placeholder|#1 to wallet 1 for $(tok "$TP") + $(tok "$TF") (fee) tokens"
refused "direct buy in the window" "$W1" "$WINDOW_BUY" "$SWAPTEST" "$SWAP_SIG" "$POOL_KEY" \
  "(true,-$(wei "$WINDOW_BUY"),$SQRT_P1)" "(false,false)" 0x

# D1 in the window's last step (from openAt + 372 s), on a snapshot: an overshooting router buy keeps its partial fill,
# the router refunds the unspent input and its tax in the same call, the curve closes. Reverted afterwards (not the
# founder's path).
wait_until $((OPEN + 372))
SNAP="$(cast rpc evm_snapshot --rpc-url "$RPC" | tr -d '"')"
D1=0x3000000000000000000000000000000000000003
cast rpc anvil_impersonateAccount "$D1" --rpc-url "$RPC" >/dev/null
cast rpc anvil_setBalance "$D1" "$(cast to-hex "$(python3 -c "import sys; print(int(sys.argv[1]) * 11 // 10)" "$(wei "$D1_BUY")")")" --rpc-url "$RPC" >/dev/null
send d1-overshoot-snapshot "$D1" "$D1_BUY" "$ROUTER" 'buy(uint256,uint256,address,uint256)' "$(wei "$D1_BUY")" 1 "$D1" "$(deadline)"
read -r OFF QIN TAX TOUT REFUND < <(logwords "$ROUTER" 'TaxedBuy(address,address,uint256,uint256,uint256,uint256,uint256)') || die "no such event in the last transaction"
say "D1 (snapshot)|step $OFF|sent $(eth "$QIN") ETH|into the curve $(eth "$(python3 -c "print($QIN - $TAX - $REFUND)")") ETH|tax $(eth "$TAX") ETH|refund $(eth "$REFUND") ETH|closed $(val "$HOOK" 'closed()(bool)')"
state "d1-snapshot" "the curve closed by the router buy; reverted next"
cast rpc evm_revert "$SNAP" --rpc-url "$RPC" >/dev/null
[ "$(val "$HOOK" 'closed()(bool)')" = "false" ] || die "the snapshot was not reverted"
say "D1 (snapshot)|reverted: block $(cast block-number --rpc-url "$RPC"), curve open"

# ------------------------------------------------------------------------------------------------ 3. after the window: the fill
wait_until "$END"
state bonding "window over (windowEndsAt $END)"
bash "$VERIFY" after-window || die "the verifier failed after the window"
refused "router buy after the window" "$W1" "$WINDOW_BUY" "$ROUTER" 'buy(uint256,uint256,address,uint256)(uint256)' \
  "$(wei "$WINDOW_BUY")" 1 "$W1" "$(deadline)"

buy_direct() { # <label> <wallet> <value>: exact input, P1 as the price limit
  local label="$1" who="$2" value="$3" b0 t0
  b0="$(cast balance "$who" --rpc-url "$RPC")"
  t0="$(val "$T" 'balanceOf(address)(uint256)' "$who")"
  say "preview|$label: $(cast call "$SWAPTEST" "$SWAP_SIG" "$POOL_KEY" "(true,-$(wei "$value"),$SQRT_P1)" "(false,false)" 0x --value "$value" --from "$who" --rpc-url "$RPC") (BalanceDelta: ETH in the high 128 bits, tokens in the low)"
  send "$label" "$who" "$value" "$SWAPTEST" "$SWAP_SIG" "$POOL_KEY" "(true,-$(wei "$value"),$SQRT_P1)" "(false,false)" 0x
  local gas price spent got
  gas="$(python3 -c "import json,sys; r=json.load(open(sys.argv[1])); print(int(r['gasUsed'],16)*int(r['effectiveGasPrice'],16))" "$LAST_JSON")"
  spent="$(python3 -c "import sys; print(int(sys.argv[1]) - int(sys.argv[2]) - int(sys.argv[3]))" "$b0" "$(cast balance "$who" --rpc-url "$RPC")" "$gas")"
  got="$(python3 -c "import sys; print(int(sys.argv[1]) - int(sys.argv[2]))" "$(val "$T" 'balanceOf(address)(uint256)' "$who")" "$t0")"
  say "$label|sent $value|spent $(eth "$spent") ETH|returned $(eth "$(python3 -c "print($(wei "$value") - $spent)")") ETH|tokens $(tok "$got")|closed $(val "$HOOK" 'closed()(bool)')"
}
buy_direct buy-wallet1 "$W1" "$BUY1"
state "bonding-after-buy1" "curve open"
buy_direct fill-wallet1 "$W1" "$FILL"
[ "$(val "$HOOK" 'closed()(bool)')" = "true" ] || die "the fill did not close the curve"
state closed "closed at block $(val "$HOOK" 'closedAtBlock()(uint256)'); D6 reserve $(eth "$(val "$BOX" 'reserve()(uint256)')") ETH"
refused "any swap before graduate()" "$W1" "$PROBE" "$SWAPTEST" "$SWAP_SIG" "$POOL_KEY" \
  "(true,-$(wei "$PROBE"),$MIN_SQRT_PLUS_1)" "(false,false)" 0x

# ------------------------------------------------------------------------------------------------ 4. graduation
say "graduate|estimate $(cast estimate "$BOX" 'graduate()' --from "$DEPLOYER" --rpc-url "$RPC") gas"
# Too little gas for the four follow-ups' budget (each is handed exactly POKE_GAS, 2,600,000 since F95) is refused,
# not a silently failed poke: graduate() reverts GasTooLow, so the gas limit here is a limit, not a cost. Since F95 the
# least is about 3.45M before Glamsterdam (3,000,000 is refused), about 6.2M after it, and about 12.9M with every poke
# burning its budget (SH-box0-stream-gas): 15,000,000 covers all of them and stays under EIP-7825's 16,777,216.
if out="$(cast call "$BOX" 'graduate()' --from "$DEPLOYER" --gas-limit 1500000 --rpc-url "$RPC" 2>&1)"; then
  die "graduate() with a 1,500,000 gas limit: expected a revert, got $out"
fi
say "refused|graduate() with a 1,500,000 gas limit|$(why "$out")"
GAS_LIMIT=15000000 send graduate "$DEPLOYER" - "$BOX" 'graduate()'
FAILED_POKES="$(python3 -c "
import json,sys; r=json.load(open(sys.argv[1]))
print(sum(1 for l in r['logs'] if l['topics'][0]==sys.argv[2]))" "$LAST_JSON" "$(cast keccak 'PokeFailed(address,bytes4)')")"
REWARD="$(val "$BOX" 'rewardOf(address)(uint256)' "$DEPLOYER")"
state graduated "graduate() by the keeper: reward $(eth "$REWARD") ETH; failed pokes $FAILED_POKES; vault gate $(val "$VAULT" 'gateOpen()(bool)'); stream started $(val "$STREAM" 'started()(bool)')"
[ "$FAILED_POKES" = 0 ] || die "a graduation poke failed"
bash "$VERIFY" graduated || die "the verifier failed after graduation"
send claimReward "$DEPLOYER" - "$BOX" 'claimReward(address)' "$DEPLOYER"
say "depth|before sweep $(cast call "$HOOK" 'depthBudget()(uint256,uint256)' --rpc-url "$RPC" | cut -d' ' -f1 | tr '\n' ' ')"
send sweep "$DEPLOYER" - "$ROUTER" 'sweep()'
say "depth|after sweep (Q, T claims of the hook) $(cast call "$HOOK" 'depthBudget()(uint256,uint256)' --rpc-url "$RPC" | cut -d' ' -f1 | tr '\n' ' ')"
send payFit "$DEPLOYER" - "$RECEIVER" 'payFit()'
P0="$(cast balance "$DEPLOYER" --rpc-url "$RPC")"
send payPlatform "$DEPLOYER" - "$RECEIVER" 'payPlatform()'
say "fees|FIT executor budget $(eth "$(val "$EXECUTOR" 'budget()(uint256)')") ETH"
refused "collect() right after graduation" "$DEPLOYER" - "$RECEIVER" 'collect(address)' "$DEPLOYER"

# ------------------------------------------------------------------------------------------------ 5. the word and a draw
read -r REQ_AT ROUND0 < <(cast call "$SOURCE" 'requestOf(address,uint256)(uint64,uint64)' "$TICKETS" 0 --rpc-url "$RPC" | cut -d' ' -f1 | paste -sd' ' -)
say "word|requested at $REQ_AT by graduate()'s poke: quicknet round $ROUND0"
post_round "$ROUND0"
send acceptGraduationWord "$DEPLOYER" - "$TICKETS" 'acceptGraduationWord()'
ITEM1="$(val "$TICKETS" 'numberOf(uint256)(uint256)' 1)"
state word "graduation word $(val "$TICKETS" 'graduationWord()(bytes32)'); placeholder #1 -> item $ITEM1"
send open-placeholder "$W1" - "$TICKETS" "open(uint256,$REVEAL_TYPE)" 1 "$(reveal_of "$ITEM1")"
[ "$(val "$COLLECTION" 'ownerOf(uint256)(address)' "$ITEM1")" = "$W1" ] || die "item $ITEM1 is not wallet 1's"
say "open|item $ITEM1 revealed to wallet 1"

read -r TP TF < <(cast call "$VAULT" 'quoteTake(uint256)(uint256,uint256)' 1 --rpc-url "$RPC" | cut -d' ' -f1 | paste -sd' ' -)
MAX_DRAW="$(python3 -c "import sys; print(int(sys.argv[1]) + int(sys.argv[2]))" "$TP" "$TF")"
# Wallet 1 approved the tickets for the placeholder (a max allowance the token never lowers): no second approve.
# The draw's block at Sepolia's base fee, so its bounty (600,000 x the base fee) is the real figure.
cast rpc anvil_setNextBlockBaseFeePerGas "$(cast to-hex "$BASE_FEE")" --rpc-url "$RPC" >/dev/null
GAS_PRICE=$((2 * BASE_FEE)) send draw "$W1" 0.002ether "$TICKETS" 'draw(uint256,uint256)' "$MAX_DRAW" "$(deadline)"
read -r DPRINC DFEE DROUND DBOUNTY < <(logwords "$TICKETS" 'DrawRequested(uint256,address,uint256,uint256,uint256,uint256)') || die "no such event in the last transaction"
say "draw|ticket 1|price $(tok "$DPRINC") + $(tok "$DFEE") tokens|round $DROUND|bounty paid $(eth "$DBOUNTY") ETH of the 0.002 sent"
post_round "$DROUND"
send settle "$DEPLOYER" - "$TICKETS" 'settle(uint256)' 1
ITEM2="$(cast call "$TICKETS" 'drawTicket(uint256)((address,uint8,uint256,uint256,uint256))' 1 --rpc-url "$RPC" | python3 -c "import sys; print(sys.stdin.read().split(',')[3].strip().split(' ')[0])")"
send openDraw "$W1" - "$TICKETS" "openDraw(uint256,address,$REVEAL_TYPE)" 1 0x0000000000000000000000000000000000000000 "$(reveal_of "$ITEM2")"
[ "$(val "$COLLECTION" 'ownerOf(uint256)(address)' "$ITEM2")" = "$W1" ] || die "item $ITEM2 is not wallet 1's"
send withdrawBounty "$DEPLOYER" - "$DRAND" 'withdrawBounty(address)' "$DEPLOYER"
state drawn "draw ticket 1 -> item $ITEM2, revealed to wallet 1; stream outside slots $(val "$STREAM" 'outsideCount()(uint256)')"

# A few trades: wallet 1 buys and sells the tokens back (Q fees for a batch, T fees for the stream).
B0="$(val "$T" 'balanceOf(address)(uint256)' "$W1")"
send trade-buy "$W1" "$TRADE" "$SWAPTEST" "$SWAP_SIG" "$POOL_KEY" "(true,-$(wei "$TRADE"),$MIN_SQRT_PLUS_1)" "(false,false)" 0x
SOLD="$(python3 -c "import sys; print(int(sys.argv[1]) - int(sys.argv[2]))" "$(val "$T" 'balanceOf(address)(uint256)' "$W1")" "$B0")"
send approve-swaptest-w1 "$W1" - "$T" 'approve(address,uint256)' "$SWAPTEST" "$(cast max-uint)"
send trade-sell "$W1" - "$SWAPTEST" "$SWAP_SIG" "$POOL_KEY" "(false,-$SOLD,$MAX_SQRT_MINUS_1)" "(false,false)" 0x
send collect "$DEPLOYER" - "$RECEIVER" 'collect(address)' "$DEPLOYER"
block_of_last() { python3 -c 'import json, sys; print(int(json.load(open(sys.argv[1]))["blockNumber"], 16))' "$LAST_JSON"; }
COLLECT_AT="$(block_of_last)"
read -r CQ CT CRES CTIP < <(logwords "$RECEIVER" 'Collected(address,address,uint256,uint256,uint256,uint256)' | cut -d' ' -f2-) || die "no such event in the last transaction"
say "collect|batch Q $(eth "$CQ") ETH|T $(tok "$CT")|tip $(eth "$CTIP") ETH|stream index $(tok "$(val "$STREAM" 'index()(uint256)')") tokens per outside item"
send payFit-2 "$DEPLOYER" - "$RECEIVER" 'payFit()'
send payPlatform-2 "$DEPLOYER" - "$RECEIVER" 'payPlatform()'
# Both items are wallet 1's: one claim for the two.
b0="$(val "$T" 'balanceOf(address)(uint256)' "$W1")"
send stream-claim "$W1" - "$STREAM" 'claim(uint256[],address)' "[$ITEM1,$ITEM2]" "$W1"
say "stream|items $ITEM1 and $ITEM2's owner (wallet 1) claimed $(tok "$(python3 -c "import sys; print(int(sys.argv[1]) - int(sys.argv[2]))" "$(val "$T" 'balanceOf(address)(uint256)' "$W1")" "$b0")") tokens"
state traded "depth (Q, T) $(cast call "$HOOK" 'depthBudget()(uint256,uint256)' --rpc-url "$RPC" | cut -d' ' -f1 | tr '\n' ' ')"

# ------------------------------------------------------------------------------------------------ 6. the keeper hours
# F95 R19U and F96 R19G (the header's step 6), one 12-second block a pass. R19G: a poke of FIT's executor (box 0's
# price average) while the pool's tick is 100 ticks or more from its latest sample (1.0001^100 > 1.01 > 1.0001^99:
# "more than 1%"; deepen() refuses a sample more than 99 ticks from spot, AverageNotCaughtUp). R19U: deepen() every 300
# blocks (its cooldown), from graduation and then from the last one; collect() 600 blocks after the last batch, held
# while a deepen is due or due within 25 blocks, so it comes right after that deepen. A waiting preview (skip 2-5 or 7:
# the cooldown, the average not ready, not caught up or off the price, a conversion with only a sliver of room) is
# previewed again the next block, at most 300 blocks; a preview with nothing to add (skip 6) is not sent. FIT's
# executor buys and burns every 25 blocks after the first deepen (deepen before the first execute, as the runbook's
# G7). Wallet 1 buys in the second hour and sells the tokens back 10 blocks later. The hours end after the second
# deepen mark and the 2-hour collect.
POOL_SLOT="$(cast keccak "$(cast abi-encode 'f(bytes32,uint256)' "$(val "$HOOK" 'poolId()(bytes32)')" 6)")"
spot_tick() { # the pool's tick: slot0 of the PoolManager's pool state (StateLibrary's layout at 46c68346)
  python3 -c 'import sys; t = (int(sys.argv[1], 16) >> 160) & 0xFFFFFF; print(t - (1 << 24) if t >= 1 << 23 else t)' \
    "$(cast call "$POOL_MANAGER" 'extsload(bytes32)(bytes32)' "$POOL_SLOT" --rpc-url "$RPC")"
}
MIGRATED="$(val "$HOOK" 'migratedAtBlock()(uint256)')"
DEEPEN_DUE=$((MIGRATED + 300))
COLLECT_DUE=$((COLLECT_AT + 600))
TRADE_AT=$((MIGRATED + 450))
DEEPENS=0 COLLECTS=0 EXECUTES=0 POKES=0 NEXT_EXECUTE=0 EXECUTING=true WAITED=0 HELD=0 SELL_AT=0
STOPS=(MaxChunks BlockLimit BudgetSpent AtCeiling AtReserve NoLiquidity TwapNotReady NotGraduated BelowBatch)
say "keeper|hours from block $(cast block-number --rpc-url "$RPC"): graduation at $MIGRATED, the first deepen due at $DEEPEN_DUE, the 2-hour collect at $COLLECT_DUE (the last batch at $COLLECT_AT), a trade at $TRADE_AT"
while [ "$DEEPENS" -lt 2 ] || [ "$COLLECTS" -lt 1 ]; do
  cast rpc anvil_mine 0x1 0xc --rpc-url "$RPC" --rpc-timeout 600 >/dev/null || sleep 3
  KB="$(cast block-number --rpc-url "$RPC")"
  [ "$KB" -le $((MIGRATED + 1500)) ] || die "keeper hours: two deepen marks and the 2-hour collect not done 1,500 blocks after graduation"
  # R19G: the latest sample follows the price, at most 100 ticks a poke.
  SPOT="$(spot_tick)"
  SAMPLE="$(val "$EXECUTOR" 'latestSampleTick()(int24)')"
  GAP=$((SPOT > SAMPLE ? SPOT - SAMPLE : SAMPLE - SPOT))
  if [ "$GAP" -ge 100 ]; then
    send "poke-$KB" "$DEPLOYER" - "$EXECUTOR" 'poke()'
    POKES=$((POKES + 1))
    say "keeper|block $KB|R19G poke: spot $SPOT, latest sample $SAMPLE ($GAP ticks), now $(val "$EXECUTOR" 'latestSampleTick()(int24)')"
  fi
  # Wallet 1's trade in the second hour: a buy, held 10 blocks while the keeper's pokes follow the price, then sold.
  if [ "$TRADE_AT" -gt 0 ] && [ "$KB" -ge "$TRADE_AT" ]; then
    B0="$(val "$T" 'balanceOf(address)(uint256)' "$W1")"
    send trade-buy-2 "$W1" "$TRADE" "$SWAPTEST" "$SWAP_SIG" "$POOL_KEY" "(true,-$(wei "$TRADE"),$MIN_SQRT_PLUS_1)" "(false,false)" 0x
    SELL_AT=$((KB + 10)) TRADE_AT=0
    say "keeper|block $KB|wallet 1 bought $TRADE: spot $(spot_tick), latest sample $(val "$EXECUTOR" 'latestSampleTick()(int24)'); sold back at block $SELL_AT"
  elif [ "$SELL_AT" -gt 0 ] && [ "$KB" -ge "$SELL_AT" ]; then
    SOLD="$(python3 -c "import sys; print(int(sys.argv[1]) - int(sys.argv[2]))" "$(val "$T" 'balanceOf(address)(uint256)' "$W1")" "$B0")"
    send trade-sell-2 "$W1" - "$SWAPTEST" "$SWAP_SIG" "$POOL_KEY" "(false,-$SOLD,$MAX_SQRT_MINUS_1)" "(false,false)" 0x
    SELL_AT=0
    say "keeper|block $KB|wallet 1 sold the tokens back: spot $(spot_tick), latest sample $(val "$EXECUTOR" 'latestSampleTick()(int24)') (fees for the 2-hour batch)"
  fi
  # R19U: deepen every hour.
  if [ "$DEEPENS" -lt 2 ] && [ "$KB" -ge "$DEEPEN_DUE" ]; then
    PREVIEW="$(cast call "$HOOK" 'deepen(address)(uint8,uint8,uint256,uint256,uint256)' "$DEPLOYER" --from "$DEPLOYER" --rpc-url "$RPC" | cut -d' ' -f1 | tr '\n' ' ')"
    case "$PREVIEW" in
    "2 0 "* | "1 0 "*)
      say "deepen preview|block $KB|kind skip qUsed tUsed tip = $PREVIEW|due at $DEEPEN_DUE, waited $WAITED blocks|average $(cast call "$EXECUTOR" 'twap()(bool,int24,uint32)' --rpc-url "$RPC" | cut -d' ' -f1 | tr '\n' ' ')"
      DEEPENS=$((DEEPENS + 1))
      send "deepen-$DEEPENS" "$DEPLOYER" - "$HOOK" 'deepen(address)' "$DEPLOYER"
      DEEPEN_DUE=$(($(block_of_last) + 300)) WAITED=0
      [ "$NEXT_EXECUTE" -gt 0 ] || NEXT_EXECUTE=$((KB + 25))
      state "deepened-$DEEPENS" "kind $(echo "$PREVIEW" | cut -d' ' -f1) (1 pair, 2 conversion); depth now (Q, T) $(cast call "$HOOK" 'depthBudget()(uint256,uint256)' --rpc-url "$RPC" | cut -d' ' -f1 | tr '\n' ' ')"
      ;;
    "0 2 "* | "0 3 "* | "0 4 "* | "0 5 "* | "0 7 "*)
      [ $((WAITED % 25)) != 0 ] || say "deepen preview|block $KB|kind skip qUsed tUsed tip = $PREVIEW: waiting (due at $DEEPEN_DUE)|spot $SPOT, latest sample $SAMPLE|average $(cast call "$EXECUTOR" 'twap()(bool,int24,uint32)' --rpc-url "$RPC" | cut -d' ' -f1 | tr '\n' ' ')"
      WAITED=$((WAITED + 1))
      if [ "$WAITED" -gt 300 ]; then
        [ "$DEEPENS" -gt 0 ] || die "the first deepen() still waits 300 blocks after it was due: $PREVIEW"
        say "deepen preview|block $KB|$PREVIEW for 300 blocks: this hour's deepen not sent"
        DEEPENS=$((DEEPENS + 1)) DEEPEN_DUE=$((KB + 300)) WAITED=0
      fi
      ;;
    *)
      [ "$DEEPENS" -gt 0 ] || die "the first deepen() has nothing to add: $PREVIEW"
      say "deepen preview|block $KB|kind skip qUsed tUsed tip = $PREVIEW: nothing to add this hour, not sent"
      DEEPENS=$((DEEPENS + 1)) DEEPEN_DUE=$((KB + 300)) WAITED=0
      ;;
    esac
  fi
  # R19U: collect every 2 hours, never right before a deepen.
  if [ "$COLLECTS" -lt 1 ] && [ "$KB" -ge "$COLLECT_DUE" ]; then
    if [ $((DEEPEN_DUE - KB)) -le 25 ]; then
      [ "$HELD" -gt 0 ] || say "keeper|block $KB|collect due (the last batch at $COLLECT_AT), held: a deepen is due at $DEEPEN_DUE"
      HELD=$((HELD + 1))
    else
      if out="$(cast call "$RECEIVER" 'collect(address)(uint256,uint256,uint256,uint256)' "$DEPLOYER" --from "$DEPLOYER" --rpc-url "$RPC" 2>&1)"; then
        send collect-2h "$DEPLOYER" - "$RECEIVER" 'collect(address)' "$DEPLOYER"
        read -r CQ CT CRES CTIP < <(logwords "$RECEIVER" 'Collected(address,address,uint256,uint256,uint256,uint256)' | cut -d' ' -f2-) || die "no such event in the last transaction"
        say "collect|block $KB|2 hours after the last batch (held $HELD blocks for a deepen)|batch Q $(eth "$CQ") ETH|T $(tok "$CT")|tip $(eth "$CTIP") ETH"
      else
        say "refused|collect() 2 hours after the last batch|block $KB|$(why "$out")"
      fi
      COLLECTS=$((COLLECTS + 1)) COLLECT_DUE=$((KB + 600))
    fi
  fi
  # FIT's buy-and-burn, every 25 blocks after the first deepen.
  if [ "$EXECUTING" = true ] && [ "$NEXT_EXECUTE" -gt 0 ] && [ "$KB" -ge "$NEXT_EXECUTE" ]; then
    EXECUTES=$((EXECUTES + 1))
    send "execute-$EXECUTES" "$DEPLOYER" - "$EXECUTOR" 'execute(uint256)' 1
    read -r CH ETHS BOUGHT BURNED TW FL REASON < <(logwords "$EXECUTOR" 'Executed(uint256,uint256,uint256,uint256,int24,uint160,uint8)') || die "no such event in the last transaction"
    say "FIT executor|block $KB|chunks $CH|ETH $(eth "$ETHS")|FIT burned $(tok "$BURNED")|stop ${STOPS[$REASON]}|budget left $(eth "$(val "$EXECUTOR" 'budget()(uint256)')")"
    case "${STOPS[$REASON]}" in BelowBatch | BudgetSpent | NotGraduated) EXECUTING=false ;; esac
    [ "$EXECUTES" -lt 10 ] || EXECUTING=false
    NEXT_EXECUTE=$((KB + 25))
  fi
done
[ "$(val "$HOOK" 'lastDeepenBlock()(uint256)')" != 0 ] || die "keeper hours: deepen() never added or converted"
say "keeper|hours done at block $KB ($((KB - MIGRATED)) after graduation)|R19G pokes $POKES|deepen marks $DEEPENS, the last add at block $(val "$HOOK" 'lastDeepenBlock()(uint256)')|2-hour collects $COLLECTS|executes $EXECUTES"
state "keeper-hours" "FIT burned in all $(tok "$(val "$EXECUTOR" 'totalBurned()(uint256)')"); T supply $(tok "$(val "$T" 'totalSupply()(uint256)')")"

else
# ------------------------------------------------------------------------------------------------ --runbook
# The runbook's own commands (§ After the deploy, § After graduation), each code block as written, with only these
# changes: the RPC is this fork, `--private-key "$(key $X_KEYFILE)"` becomes `--from $X --unlocked` (impersonated),
# and `key` itself is replaced by a function that refuses, so no key file is ever read; the chain-time wait before a
# postRound mines one block per pass of its loop (the fork makes none of its own). Between blocks the fork is
# mined to where the runbook says to wait, and the verifier runs after the window and after graduation (verify.sh;
# before the open it ran above). The blocks passed check_runbook above.
BLOCKS="$OUT/runbook-blocks"
rm -rf "$BLOCKS"
mkdir -p "$BLOCKS"
python3 - "$RUNBOOK" "$BLOCKS" "$RPC" "$SPEC" <<'PY' || die "could not read the runbook's blocks"
import re, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text()
start = text.index("## After the deploy: filling the curve")
part = text[start:]
out = Path(sys.argv[2])
heading, n = "setup", 0
for m in re.finditer(r"^### ([^\n]+)$|^```sh\n(.*?)^```", part, re.M | re.S):
    if m.group(1):
        heading = m.group(1)
        continue
    body = m.group(2)
    body = re.sub(r'--private-key "\$\(key \$([A-Z0-9]+)_KEYFILE\)"', r"--from $\1 --unlocked", body)
    body = re.sub(r"^export RPC=\S+", f"export RPC={sys.argv[3]}", body, flags=re.M)
    body = re.sub(r"^export SPEC=\S+", f"export SPEC={sys.argv[4]}", body, flags=re.M)
    body = re.sub(r"^key\(\) \{.*\}$", 'key() { echo "refused: no key in the rehearsal" >&2; return 1; }', body, flags=re.M)
    if "$(key " in body or "--private-key" in body:
        sys.exit(f"a key use is left in block {heading!r}")
    # The chain-time wait before a postRound: the fork makes a block only when asked (Sepolia makes one every 12 s), so
    # each pass of the wait's loop mines one after its sleep, and says so.
    body, waits = re.subn(
        r'^(until \[ "\$\(cast block latest --field timestamp --rpc-url \$RPC\)" -ge "[^\n]*" \]; do sleep [0-9]+);( done)$',
        lambda w: (f"{w.group(1)}; cast rpc evm_mine --rpc-url {sys.argv[3]} >/dev/null; echo \"LIFE|runbook|chain wait|"
                   f"mined block $(cast block-number --rpc-url {sys.argv[3]}) at $(cast block latest --field timestamp "
                   f"--rpc-url {sys.argv[3]})\";{w.group(2)}"),
        body, flags=re.M)
    if body.count("postRound(") > waits:
        sys.exit(f"block {heading!r} posts a round without the chain-time wait (see --check-runbook)")
    # The keeper's block (G7, F95 R19U and F96 R19G) waits for each next block: here each pass mines one 12-second
    # block instead (one block per pass of the keeper, as on Sepolia).
    body, nexts = re.subn(
        r'^(\s*until NB=\$\(cast block-number --rpc-url \$RPC\) && \[ "\$NB" -gt "\$N" \]; do )sleep [0-9]+(; done)$',
        lambda w: f"{w.group(1)}cast rpc anvil_mine 0x1 0xc --rpc-url {sys.argv[3]} >/dev/null{w.group(2)}",
        body, flags=re.M)
    if heading.startswith("G7") and nexts != 1:
        sys.exit(f"block {heading!r}: expected the keeper's one wait for the next block, found {nexts}")
    if re.search(r"\bW2\b|CHANGE_ME_WALLET", body):
        sys.exit(f"block {heading!r} names a second buying wallet (F80: wallet 1 does every buy)")
    n += 1
    tag = heading.split(" ")[0] if heading != "setup" else "setup"
    (out / f"{n:02d}-{tag}.sh").write_text(body)
print(f"{n} blocks")
PY
ls "$BLOCKS" | sed 's/^/LIFE|runbook|block /'

# The runner: one shell, so the setup's variables carry from block to block; the waits the runbook names in between
# (wait_until before F1: the open; before F3: the window's end, F80's times; mine_to before G7: 280 blocks after
# graduation, where the keeper's block starts its 900 blocks), the verifier after the
# window (before F3) and after graduation (after F5), and graduate()'s gas estimate before F5. No `#` in it either:
# zsh reads it as a paste.
RUNNER="$OUT/runbook-run.sh"
{
  echo "set -euo pipefail"
  echo 'export PATH="$HOME/.foundry/bin:$PATH"'
  declare -f mine_to
  declare -f wait_until
  for f in "$BLOCKS"/*.sh; do
    case "$(basename "$f")" in
    *-F1.sh)
      echo "bash $GATE \"\$ROUTER\" \"\$SWAPTEST\" \"\$KEY\" \"\$P1\" \"\$W1\" \"\$OPEN\" \"\$HOOK\" $(wei "$WINDOW_BUY")"
      echo "wait_until \$OPEN"
      ;;
    *-F3.sh)
      echo "bash $STEPS \"\$ROUTER\" \"\$HOOK\" \"\$OPEN\" \"\$END\" $(wei "$WINDOW_BUY")"
      echo "wait_until \$END"
      echo "bash $VERIFY after-window"
      ;;
    *-F5.sh) echo "echo \"LIFE|runbook|graduate estimate \$(cast estimate \$BOX 'graduate()' --from \$KEEPER --rpc-url $RPC) gas\"" ;;
    *-G7.sh) echo "mine_to \$((\$(c \$HOOK 'migratedAtBlock()(uint256)') + 280)) 12" ;;
    esac
    echo "echo \"LIFE|runbook|$(basename "$f") at block \$(cast block-number --rpc-url $RPC)\""
    cat "$f"
    case "$(basename "$f")" in
    *-F5.sh) echo "bash $VERIFY graduated" ;;
    esac
  done
} >"$RUNNER"
say "runbook|running $RUNNER in $RUNBOOK_SHELL (the blocks above, in order)"
if [ "$RUNBOOK_SHELL" = zsh ]; then
  # A paste: an interactive zsh reading the lines from its input, without the user's startup files (-f: zsh's own
  # defaults, interactivecomments off as in the founder's terminal), its prompts blanked for the log. set -e in the
  # runner ends it at the first failing command; a quote left open ends it with `unmatched`.
  RUN_SHELL=(env PS1= PS2= zsh -f -i +o promptcr +o promptsp)
else
  RUN_SHELL=(bash)
fi
"${RUN_SHELL[@]}" <"$RUNNER" >"$OUT/runbook-run.log" 2>&1 || {
  tail -n 20 "$OUT/runbook-run.log"
  die "a runbook block failed in $RUNBOOK_SHELL (see $OUT/runbook-run.log)"
}
# A shell error that did not stop the run (a word zsh could not run, a parse error, a `#` passed on) still fails it.
if grep -nE "^(zsh|bash)(: |:[0-9]+: )|: command not found|parse error|unmatched|bad pattern|no matches found" \
  "$OUT/runbook-run.log"; then
  die "runbook: $RUNBOOK_SHELL reported the errors above (see $OUT/runbook-run.log)"
fi
grep '^LIFE|' "$OUT/runbook-run.log" || true
# What the blocks must have done.
ITEM1="$(val "$TICKETS" 'numberOf(uint256)(uint256)' 1 2>/dev/null || echo 0)"
[ "$(val "$BOX" 'phase()(uint8)')" = 5 ] || die "runbook: not graduated"
[ "$(val "$ROUTER" 'totalSwept()(uint256)')" != 0 ] || die "runbook: the launch tax was not swept"
[ "$(val "$TICKETS" 'graduationWord()(bytes32)')" != 0x0000000000000000000000000000000000000000000000000000000000000000 ] ||
  die "runbook: no graduation word"
[ "$(cast call "$TICKETS" 'drawTicket(uint256)((address,uint8,uint256,uint256,uint256))' 1 --rpc-url "$RPC" | cut -d, -f2 | tr -d ' ')" = 3 ] ||
  die "runbook: the draw is not opened"
[ "$(val "$HOOK" 'lastDeepenBlock()(uint256)')" != 0 ] || die "runbook: deepen() did not add or convert"
read -r SC _ < <(cast call "$STREAM" 'totals()(uint256,uint256)' --rpc-url "$RPC" | cut -d' ' -f1 | paste -sd' ' -)
[ "$SC" != 0 ] || die "runbook: no stream claim paid"
state "runbook-done" "word, placeholder opened, draw opened, stream paid $(tok "$SC"), deepen at block $(val "$HOOK" 'lastDeepenBlock()(uint256)'), FIT burned $(tok "$(val "$EXECUTOR" 'totalBurned()(uint256)')")"
# F1's buy as the router logged it (F80: its 12-second step from openAt, its tax).
cast logs --from-block "$CREATED" --address "$ROUTER" 'TaxedBuy(address,address,uint256,uint256,uint256,uint256,uint256)' \
  --rpc-url "$RPC" --json | python3 -c '
import json, sys
logs = json.load(sys.stdin)
for l in logs:
    d = l["data"][2:]
    step, q, tax, out, refund = (int(d[i:i + 64], 16) for i in range(0, 320, 64))
    bn = int(l["blockNumber"], 16)
    print(f"LIFE|runbook|F1 TaxedBuy|block {bn}|step {step}|sent {q / 1e18:.6f}|tax {tax / 1e18:.9f} ({tax * 100 / q:.4f}%)|tokens {out / 1e18:,.2f}|refund {refund}")
if len(logs) != 1:
    sys.exit(f"expected one TaxedBuy (F1), found {len(logs)}")' || die "runbook: F1's TaxedBuy"
fi

# ------------------------------------------------------------------------------------------------ 7. the verifier
say "verifier|BoxCoreConformanceDeployedTest on the graduated box after its life (the runbook's Step 5 flags)"
bash "$VERIFY" end || die "the verifier failed at the end"

# The site's manifest (Step 4, ours; review of sh-open-at-final, finding 2): the read-only writer against the fork as
# for Sepolia (finalized block, network sepolia), into the run's folder. The platform (the testnet deployer, Z3's
# default) has no code: refused without --platform-eoa, written with it.
MANIFEST="$(cd "$OUT" && pwd)/core-manifest-11155111.json"
WRITER=(pnpm --dir ../chain -s core-manifest:write --rpc "$RPC" --factory "$FACTORY" --network sepolia --out "$MANIFEST")
if "${WRITER[@]}" >"$OUT/core-manifest-without-flag.log" 2>&1; then
  die "the manifest writer took a platform without code without --platform-eoa (see $OUT/core-manifest-without-flag.log)"
fi
grep -q -- 'needs --platform-eoa' "$OUT/core-manifest-without-flag.log" ||
  die "the manifest writer's refusal does not name --platform-eoa (see $OUT/core-manifest-without-flag.log)"
say "manifest|without --platform-eoa: $(grep -o 'the platform 0x[0-9a-fA-F]* has no code at block [0-9]*' "$OUT/core-manifest-without-flag.log" | head -n 1)"
"${WRITER[@]}" --platform-eoa >"$OUT/core-manifest.log" 2>&1 || die "the manifest writer (see $OUT/core-manifest.log)"
python3 - "$MANIFEST" "$DEPLOYER" "$REGISTRY" "$FACTORY" "$(cast call "$REGISTRY" 'entry(uint256)(address,uint256,bytes32,bytes32,bytes32)' 0 --rpc-url "$RPC" | sed -n '2{s/ .*//;p;}')" <<'PY' || die "the manifest (see $MANIFEST)"
import json, sys
m = json.load(open(sys.argv[1]))
platform, registry, factory, start = sys.argv[2:6]
empty = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
v1 = m["versions"][0]
checks = {
    "status deployed": m["status"] == "deployed",
    "network sepolia": m["network"] == "sepolia" and m["chainId"] == 11155111,
    "finalized evidence": m["evidence"]["finality"] == "finalized",
    "platform: the testnet deployer, the empty-code hash": m["chain"]["platformSafe"] == {"address": platform, "codeHash": empty},
    "registry and factory": v1["registry"]["address"].lower() == registry.lower() and v1["factory"]["address"].lower() == factory.lower(),
    "start at box 0's creation block": v1["startBlock"] == start,
}
for k, ok in checks.items():
    print(f"LIFE|manifest|{'ok' if ok else 'WRONG'}|{k}")
print(f"LIFE|manifest|evidence block {m['evidence']['block']['number']}, start {v1['startBlock']}, platform {m['chain']['platformSafe']['address']}")
sys.exit(0 if all(checks.values()) else 1)
PY

# Gas per sender, and SepETH at Sepolia's base fee read at the start.
python3 - "$OUT/txs.tsv" "$BASE_FEE" <<'PY'
import csv, sys
base = int(sys.argv[2])
per = {}
for row in csv.DictReader(open(sys.argv[1]), delimiter="\t"):
    per.setdefault(row["from"], 0)
    per[row["from"]] += int(row["gas_used"])
for who, gas in per.items():
    print(f"LIFE|gas|{who}|{gas:,} gas|{gas * base / 1e18:.6f} SepETH at {base / 1e9:.3f} gwei")
PY
say "DONE|nothing was sent to Sepolia; the fork stops now"
