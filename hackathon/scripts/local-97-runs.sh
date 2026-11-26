#!/usr/bin/env bash
# SH-259's two runs on a LOCAL chain 97 (SH-260's plain rehearsal, replayed block by block from its dump: the release,
# a box priced in the native coin and one priced in tNVDA, both graduated and traded), on loopback only:
#   indexer  the indexer at the chain's real pace: anvil (port 8572) mined every 450 ms by pace-rig.mjs, every RPC
#            request delayed 150 ms (a public endpoint's round trip) and counted (rig on 8581); the indexer follows for
#            SH_RUN_SECONDS (default 180), then stops for 60 s (a backlog) and catches up again. Lag sampled every second.
#   keeper   the keeper's dry run against the same chain through the rig (requests counted), signer address the
#            event's keeper wallet; it sends nothing (SH_KEEPER_DRY_RUN=1) and names the jobs it would send.
# Every process it starts is stopped by its own PID at the end. Output: .cache/local-97/<run>/ (logs and summary).
#   bash hackathon/scripts/local-97-runs.sh indexer|keeper
set -euo pipefail
run=${1:?indexer or keeper}
root=$(git rev-parse --show-toplevel)
cd "$root"
out="$root/.cache/local-97/$run"
mkdir -p "$out"
data=hackathon/rehearsals/plain-97
manifest="$root/$data/core-v1/97.json"
chain=http://127.0.0.1:8572
rig=http://127.0.0.1:8581
pids=()
stop() { for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap stop EXIT
rpc() { curl -fsS --max-time 5 -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":${3:-[]}}" "$1" | jq -r .result; }

gunzip -c "$data/anvil-state.json.gz" > "$out/anvil-state.json"
# A fresh chain 97 from the dump's genesis time, then the dump's blocks replayed onto it (replay-97.mjs), so every
# historical state is held (a dump loaded with --load-state answers only at its last block).
genesis=$(jq -r '.blocks[] | select(.header.number == "0x0") | .header.timestamp' "$out/anvil-state.json")
anvil --chain-id 97 --hardfork osaka --base-fee 0 --gas-limit 100000000 --timestamp "$((genesis))" \
  --port 8572 --host 127.0.0.1 --no-mining --silent > "$out/anvil.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 50); do [ "$(rpc "$chain" eth_chainId 2>/dev/null)" = 0x61 ] && break; sleep 0.2; done
[ "$(rpc "$chain" eth_chainId)" = 0x61 ] || { echo "anvil did not start"; exit 1; }
# The real chain 97 has Multicall3 at its canonical address (probe of 25 November) and the indexer batches its views
# through it; the local chain gets the same code (read from the public chain, a read-only call) so the counts match. Planted at genesis: the indexer looks for it at the first block it reads views at.
multicall=0xcA11bde05977b3631167028862bE2a173976CA11
code=$(rpc https://bsc-testnet-rpc.publicnode.com eth_getCode "[\"$multicall\",\"latest\"]")
[ "${#code}" -gt 1000 ] || { echo "no Multicall3 code read"; exit 1; }
rpc "$chain" anvil_setCode "[\"$multicall\",\"$code\"]" > /dev/null
node hackathon/scripts/replay-97.mjs "$out/anvil-state.json" "$chain" | tee "$out/replay.json"
echo "replayed: block $(( $(rpc "$chain" eth_blockNumber) ))" | tee "$out/summary.txt"
node hackathon/scripts/pace-rig.mjs --target "$chain" --listen 8581 --latency-ms 150 --mine-ms 450 \
  --report "$out/rig.json" > "$out/rig.log" 2>&1 &
rigpid=$!
pids+=("$rigpid")
sleep 1

if [ "$run" = indexer ]; then
  seconds=${SH_RUN_SECONDS:-180}
  start_indexer() {
    SH_TESTNET=bnb SH_CORE_MANIFEST="$manifest" SH_CORE_HTTP_URLS="$rig" SH_CORE_WS_URLS='' SH_CORE_POLL_MS=1000 \
    SH_CORE_BLOCK_MS=450 SH_CORE_GATEWAY_HOST=127.0.0.1 SH_CORE_GATEWAY_PORT=8582 SH_HISTORY=memory \
    SH_CORE_CREATE_OPTIONS_DIR="$root/$data/create-options/data" \
      bash -c 'cd packages/indexer && exec node --experimental-transform-types --no-warnings=ExperimentalWarning --import ./scripts/register-ts.mjs src/core/core-main.ts' >> "$out/indexer.log" 2>&1 &
    ipid=$!
    pids+=("$ipid")
  }
  sample() { # sample <seconds> <label>: chain head, indexer head, lag, once a second
    for _ in $(seq 1 "$1"); do
      head=$(( $(rpc "$chain" eth_blockNumber) ))
      seen=$(curl -fsS --max-time 2 http://127.0.0.1:8582/v2/feed 2>/dev/null | jq -r '.asOf.block // empty' || true)
      cards=$(curl -fsS --max-time 2 http://127.0.0.1:8582/v2/feed 2>/dev/null | jq -r '.cards | length' || true)
      printf '%s %s %s %s %s\n' "$2" "$(date +%s)" "$head" "${seen:-none}" "${cards:-none}" >> "$out/lag.txt"
      sleep 1
    done
  }
  start_indexer
  sample "$seconds" follow
  kill -USR1 "$rigpid"  # count requests of the steady part only from here: reset
  sample 60 steady
  cp "$out/rig.json" "$out/rig-steady.json"
  kill "$ipid"; wait "$ipid" 2>/dev/null || true
  last=$(tail -n 1 "$out/lag.txt" | awk '{print $4}')
  sleep 60
  backlog=$(( $(rpc "$chain" eth_blockNumber) - last ))
  start_indexer
  took=none
  for second in $(seq 1 120); do
    sleep 1
    head=$(( $(rpc "$chain" eth_blockNumber) ))
    seen=$(curl -fsS --max-time 2 http://127.0.0.1:8582/v2/feed 2>/dev/null | jq -r '.asOf.block // empty' || true)
    printf 'catchup %s %s %s\n' "$(date +%s)" "$head" "${seen:-none}" >> "$out/lag.txt"
    if [ -n "$seen" ] && [ $((head - seen)) -le 8 ]; then took=$second; break; fi
  done
  kill "$ipid"; wait "$ipid" 2>/dev/null || true
  awk '$1=="steady" && $4!="none" { lag=$3-$4; n++; s+=lag; if (lag>m) m=lag } END { printf "steady 60 s: mean lag %.1f blocks, max %d (samples %d)\n", s/n, m, n }' "$out/lag.txt" | tee -a "$out/summary.txt"
  echo "catch-up: $backlog blocks behind after a 60 s stop; within 8 blocks of the head $took s after the restart (process start included)" | tee -a "$out/summary.txt"
  echo "steady requests: $(cat "$out/rig-steady.json")" | tee -a "$out/summary.txt"
  grep -c '"event":"core_listening"' "$out/indexer.log" | sed 's/^/indexer starts: /' | tee -a "$out/summary.txt"
  grep -ci 'error' "$out/indexer.log" | sed 's/^/indexer lines with "error": /' | tee -a "$out/summary.txt"
else
  # The keeper's wallet on this local chain: 0.011 tBNB. Its simulations carry its fees, and anvil refuses an eth_call
  # whose gas (the block's 100 million, none given) at 0.1 gwei is more than the balance; on 0.005 tBNB every
  # simulation failed here (SIMULATION_ERROR). A geth node lowers such a call's gas to what the balance pays instead.
  rpc "$chain" anvil_setBalance '["0x920B1439BC0BF2f30f9E01B9Bb94d90A9ba35189","0x27147114878000"]' > /dev/null
  registry=$(jq -r '.releases[0].registry.address' "$manifest")
  from=$(jq -r '.releases[0].startBlock' "$manifest")
  # A journal of its own for each run: the last run's skip log and retry backoff would hide this run's decisions.
  state="$out/state-$(date +%s)"
  mkdir -p "$state"
  # The stack's keeper settings without the service's own lines, the key file and the endpoints (no spaces in values).
  mapfile -t settings < <(grep -E '^SH_KEEPER_[A-Z_]+=[^<]*$' hackathon/stack/keeper.env.example | grep -v 'SH_KEEPER_KEY_FILE\|SH_KEEPER_RPC')
  env "${settings[@]}" \
    SH_TESTNET=bnb SH_KEEPER_DRY_RUN=1 SH_KEEPER_RPC_URL="$rig" SH_KEEPER_ADDRESS=0x920B1439BC0BF2f30f9E01B9Bb94d90A9ba35189 \
    SH_KEEPER_BOX_REGISTRY="$registry" SH_KEEPER_FROM_BLOCK="$from" SH_KEEPER_STATE_FILE="$state/keeper.json" \
    bash -c 'cd packages/keeper && exec node --experimental-transform-types --no-warnings=ExperimentalWarning --import ./scripts/register-ts.mjs src/main.ts' > "$out/keeper.log" 2>&1 &
  kpid=$!
  pids+=("$kpid")
  sleep "${SH_RUN_SECONDS:-120}"
  kill "$kpid"; wait "$kpid" 2>/dev/null || true
  echo "keeper log lines: $(wc -l < "$out/keeper.log")" | tee -a "$out/summary.txt"
  grep -o '"msg":"[^"]*","boxId":"[0-9]*","job":"[a-zA-Z]*","code":"[A-Z_]*"\|"msg":"dry run: would send"[^}]*' "$out/keeper.log" | sort | uniq -c | tee -a "$out/summary.txt"
  # Gas of the keeper's jobs on these two boxes now, estimated from the keeper's address (a revert says the job has no work).
  keeper=0x920B1439BC0BF2f30f9E01B9Bb94d90A9ba35189
  for id in 0 1; do
    hook=$(cast call --rpc-url "$chain" "$registry" 'roleOf(uint256,uint256)(address)' "$id" 2)
    receiver=$(cast call --rpc-url "$chain" "$registry" 'roleOf(uint256,uint256)(address)' "$id" 5)
    for job in "$receiver collect(address)" "$hook deepen(address)" "$hook buyBack(address)" "$hook sellFees(address)"; do
      gas=$(cast estimate --rpc-url "$chain" --from "$keeper" "${job% *}" "${job#* }" "$keeper" 2>/dev/null || echo reverts)
      echo "estimate box $id ${job#* }: $gas" | tee -a "$out/summary.txt"
    done
  done
fi
kill "$rigpid"; wait "$rigpid" 2>/dev/null || true
echo "rig: $(cat "$out/rig.json")" | tee -a "$out/summary.txt"
