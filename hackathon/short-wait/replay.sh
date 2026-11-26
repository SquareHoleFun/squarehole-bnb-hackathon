#!/usr/bin/env bash
# Usage (from the repository's top, on the machine): [PORT=8574] SOURCE_COMMIT=<40 hex> bash hackathon/short-wait/replay.sh <runner> <log dir>
# SH-300: plays hackathon/short-wait/commands.txt with the orchestrator's step runner (<runner>, run-steps2.sh, used
# as it is) on a fresh local fork of the BNB test network, steps 1 to 11, in real time: anvil mines a block every
# second at the wall clock's time, nothing is warped. As lane e's hackathon/rail-shop/rehearse.sh, the real wallets
# are impersonated and no key is read: in a copy of the file in <log dir>, a forge line's `--account <w>
# --password-file <f>` becomes `--unlocked` (its --sender stays), a cast send's becomes `--unlocked --from <address>`,
# and card-shop.mjs's `--password-dir ~/.secrets` becomes `--local-proof --unlocked` (its --dry lines get
# `--local-proof`: the fork is a loopback endpoint). Nothing else in the file changes; the diff is printed. The wallets
# keep their real test BNB. The deployment files the file writes are this folder's own copy (never committed from here).
set -u
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 1
RUNNER=${1:?the runner (run-steps2.sh)}; LOGDIR=${2:?a log folder}
: "${SOURCE_COMMIT:?export SOURCE_COMMIT}"
PORT=${PORT:-8574}
export RPC=http://127.0.0.1:$PORT SOURCE_COMMIT
if cast chain-id -r "$RPC" >/dev/null 2>&1; then echo "port $PORT already answers: not ours, refused"; exit 1; fi
mkdir -p "$LOGDIR"
anvil --host 127.0.0.1 --port "$PORT" --fork-url https://bsc-testnet-rpc.publicnode.com --hardfork osaka --block-time 1 \
  --retries 20 --timeout 60000 --auto-impersonate --silent > "$LOGDIR/anvil.log" 2>&1 &
APID=$!
for _ in $(seq 1 60); do cast block-number -r "$RPC" >/dev/null 2>&1 && break; sleep 1; done
kill -0 "$APID" 2>/dev/null || { echo "the anvil this script started is not running"; exit 1; }
[ "$(cast chain-id -r "$RPC")" = 97 ] || { echo "not a fork of chain 97"; kill "$APID"; exit 1; }
FILE="$LOGDIR/commands.unlocked.txt"
sed -E \
  -e '/forge script/ s# --account hack-[a-z]+ --password-file ~/\.secrets/hack-[a-z]+\.pass# --unlocked#' \
  -e '/cast send/ s# --account hack-deployer --password-file ~/\.secrets/hack-deployer\.pass# --unlocked --from 0x2EF9A78074bbf674bEA16f21154a30c821A3C576#' \
  -e '/cast send/ s# --account hack-alice --password-file ~/\.secrets/hack-alice\.pass# --unlocked --from 0x2908E3351ec8F20a8a6746773e42EA1D2FFb3c7F#' \
  -e '/card-shop\.mjs/ s# --password-dir ~/\.secrets# --local-proof --unlocked#' \
  -e '/card-shop\.mjs/ s# --dry\)# --dry --local-proof)#' \
  hackathon/short-wait/commands.txt > "$FILE"
echo "fork of chain 97 at block $(cast block-number -r "$RPC") (anvil $APID, port $PORT); the runner $(sha256sum < "$RUNNER" | cut -c1-16); the file's changes for the fork:"
diff hackathon/short-wait/commands.txt "$FILE" | grep -c '^>' | sed 's/^/  lines changed: /'
if grep -E -- '--account|--password-file|--password-dir' "$FILE" | grep -v '^#' | grep -q .; then echo "a signing flag is left in the fork's copy: stopped"; kill "$APID"; exit 1; fi
t0=$(date +%s)
RPC=$RPC LOGDIR=$LOGDIR bash "$RUNNER" "$FILE" 1 11; e=$?
echo "runner exit $e after $(( ($(date +%s) - t0) / 60 )) min $(( ($(date +%s) - t0) % 60 )) s"
kill "$APID"; wait "$APID" 2>/dev/null
exit "$e"
