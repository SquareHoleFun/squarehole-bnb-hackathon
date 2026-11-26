# Sourced by the local scripts: starts anvil on a fork of the public BSC Testnet endpoint on port $PORT, stops it on
# exit, and sets the local-fork switch the signer preload and the preflight require (loopback endpoint only). Each run
# gets its own record folder (a fork is a new chain), out/local-<port>-<time>.
UPSTREAM=${FORK_UPSTREAM:-https://bsc-testnet-rpc.publicnode.com}
RPC=http://127.0.0.1:$PORT
mkdir -p out
if cast chain-id --rpc-url "$RPC" > /dev/null 2>&1; then echo "stopped: port $PORT already answers (another node is running there)"; exit 1; fi
anvil --fork-url "$UPSTREAM" --port "$PORT" --chain-id 97 --silent > "out/anvil-$PORT.log" 2>&1 &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" > /dev/null 2>&1 && break; sleep 1; done
# Our anvil must be the one answering: a port taken by something else is a stop, not a fallback.
if ! kill -0 "$ANVIL" 2>/dev/null || [ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null)" != 97 ]; then
  echo "stopped: anvil did not start on port $PORT:"; tail -n 3 "out/anvil-$PORT.log"; exit 1
fi
export RPC_URL=$RPC OPENFOUR_LOCAL_FORK=1 LOCAL_FORK_URL=$RPC
export OPENFOUR_OUT_DIR="out/local-$PORT-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OPENFOUR_OUT_DIR"
fund() { cast rpc anvil_setBalance "$1" 0x56bc75e2d63100000 --rpc-url "$RPC" > /dev/null; } # 100 BNB, local fork only
gas_since() { node scripts/gas-between.js "$RPC" "$1" "$2"; } # transactions and gas in blocks (from, to]
echo "== local fork on $RPC at block $(cast block-number --rpc-url "$RPC"); records in $OPENFOUR_OUT_DIR"
