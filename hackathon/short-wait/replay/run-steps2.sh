#!/usr/bin/env bash
# Runs numbered steps of a commands file on the hackathon machine, one line after another, from the repository root of
# a quiet checkout. The file's format (hackathon/rail-coin/commands.txt, hackathon/flap-rules/commands.txt): a comment
# line "# <n> <what>" opens a step; the lines under it are its commands. A line is classified by what it is:
#   CHECK  it carries "# expect <text>": a read that must show the expectation (tried up to six times, five seconds
#          apart: a public endpoint may answer from a block behind);
#   SEND   it holds "cast send" or "--broadcast": it must exit 0; a cast send must end with status 1, a forge script
#          must print its own success line. A SEND is refused unless a DRY line of the same step succeeded before it;
#   DRY    anything else: a dry call, a simulation or a plain read; it must exit 0.
# The first line that fails stops the run: nothing later is sent. Every line's whole output goes to
# <log dir>/step-<n>-<k>-<kind>.log; a short line per command goes to the screen.
# usage: RPC=<endpoint> LOGDIR=<folder> run-steps2.sh <commands file> <first step> <last step>
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.foundry/bin:$HOME/.local/share/mise/shims:$PATH"
: "${RPC:?set RPC}" "${LOGDIR:?set LOGDIR}"
file=$1; first=$2; last=$3
[ -f "$file" ] || { echo "no commands file $file"; exit 2; }
grep -q '<META_\|<RULES_\|<[A-Z_]*>' <(awk -v a="$first" -v b="$last" '/^# [0-9]+ /{n=$2} n>=a && n<=b' "$file") && { echo "a placeholder <...> is still in steps $first to $last: stopped, nothing ran"; exit 2; }
mkdir -p "$LOGDIR"
num() { python3 -I -c "import sys; a=sys.argv[1].split()[0] if sys.argv[1].split() else ''; print(int(a))" "$1" 2>/dev/null; }
expect_ok() { # <output> <expectation>
  local flat want=$2 got
  flat=$(tr '\n' ' ' <<<"$1" | sed -E 's/  +/ /g; s/^ //; s/ $//')
  case "$want" in
    listed) grep -q -i '^true' <<<"$flat" ;;
    '>='*) got=$(num "$flat") || return 1; python3 -I -c "import sys; sys.exit(0 if int(sys.argv[1]) >= int(sys.argv[2]) else 1)" "$got" "${want#>=}" ;;
    *[!0-9]*) grep -q -i -F -- "$want" <<<"$flat" ;;
    *) got=$(num "$flat") || return 1; [ "$got" = "$want" ] ;;
  esac
}
step=0; k=0; dry_ok=0; what=''
while IFS= read -r line <&3; do
  case "$line" in
    '# '[0-9]*) rest=${line#\# }; step=${rest%% *}; what=${rest#* }; k=0; dry_ok=0
      if [ "$step" -ge "$first" ] && [ "$step" -le "$last" ]; then echo "== step $step: $what"; fi; continue ;;
    ''|'#'*) continue ;;
  esac
  { [ "$step" -ge "$first" ] && [ "$step" -le "$last" ]; } || continue
  k=$((k + 1))
  if [[ "$line" == *'# expect '* ]]; then
    want=${line##*# expect }; cmd=${line%% # expect*}; cmd=${cmd%"${cmd##*[![:space:]]}"}; ok=0
    for try in 1 2 3 4 5 6; do
      out=$(eval "$cmd" 2>&1) || true
      if expect_ok "$out" "$want"; then ok=1; break; fi
      sleep 5
    done
    printf '%s\n' "$out" > "$LOGDIR/step-$step-$k-check.log"
    echo "   check: $(tr '\n' ' ' <<<"$out" | head -c 110) (expected: $want)"
    [ "$ok" = 1 ] || { echo "STOP at step $step: the check does not show what is expected"; exit 1; }
  elif [[ "$line" == *'cast send'* || "$line" == *'--broadcast'* ]]; then
    [ "$dry_ok" = 1 ] || { echo "STOP at step $step: a send without a dry line before it in this step"; exit 1; }
    out=$(eval "$line" 2>&1); e=$?
    printf '%s\n' "$out" > "$LOGDIR/step-$step-$k-send.log"
    if [ "$e" != 0 ]; then echo "   SEND FAILED (exit $e): $(tail -n 6 <<<"$out" | tr '\n' ' ' | head -c 500)"; echo "STOP at step $step"; exit 1; fi
    if [[ "$line" == *'cast send'* ]]; then
      echo "   sent: $(grep -E '^transactionHash' <<<"$out" | awk '{print $2}') block $(grep -E '^blockNumber' <<<"$out" | awk '{print $2}') gas $(grep -E '^gasUsed' <<<"$out" | awk '{print $2}') $(grep -E '^status' <<<"$out" | head -n 1)"
      grep -q -E '^status +1' <<<"$out" || { echo "STOP at step $step: the send did not end with status 1"; exit 1; }
    else
      grep -a -E 'Hash: 0x|Contract Address: 0x|Paid: ' <<<"$out" | sed -E 's/^[^A-Za-z0-9]*//' | awk '{printf "   %s\n", $0}' | cut -c1-150
      if grep -q 'ONCHAIN EXECUTION COMPLETE & SUCCESSFUL' <<<"$out"; then :
      elif ! grep -a -q 'Hash: 0x' <<<"$out"; then echo "   nothing to send (the script broadcast no transaction): $(grep -a -v '^\s*$' <<<"$out" | grep -a -iE 'measured|nothing|no share|already' | tail -n 1 | head -c 140)"
      else echo "STOP at step $step: transactions were sent but the script did not report a complete on-chain run"; exit 1; fi
    fi
    dry_ok=0
  else
    out=$(eval "$line" 2>&1); e=$?
    printf '%s\n' "$out" > "$LOGDIR/step-$step-$k-dry.log"
    if [ "$e" != 0 ]; then echo "   DRY FAILED (exit $e): $(tail -n 8 <<<"$out" | tr '\n' ' ' | head -c 600)"; echo "STOP at step $step, nothing sent for it"; exit 1; fi
    echo "   dry ok: $(grep -a -v '^\s*$' <<<"$out" | tail -n 1 | head -c 110)"
    dry_ok=1
  fi
done 3< "$file"
echo "== steps $first to $last done at $(date -u +%FT%TZ)"
