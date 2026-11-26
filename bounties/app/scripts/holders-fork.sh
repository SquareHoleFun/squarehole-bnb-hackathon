#!/usr/bin/env bash
# SH-290: the holders panel on lane f's stand for holder payouts (../flap/script/stake-stand.sh: a fork of BSC Testnet
# as it is, the rules pair and the RailStakeFactory deployed, a test-dollar rules sale whose rules pay the creator's
# stake 40%, bought, completed, claimed, staked by the creator, income shared out, synced, half a period passed). The
# stand stays up (KEEP=1); this script writes the page's deployment file for it and runs e2e/holders.spec.ts, then stops
# the stand by its own process number. anvil on port 8622 (PORT), the page on 5471. Local only, no key.
# usage: scripts/holders-fork.sh [playwright args...]
set -u
cd "$(dirname "$0")/.." || exit 1
PORT=${PORT:-8622}
RPC=http://127.0.0.1:$PORT
STAND=../flap/deployments/anvil-97-stand.json
LOG=../../.cache/holders-stand.log
mkdir -p ../../.cache
rm -f "$STAND"
(cd ../flap && PORT=$PORT KEEP=1 exec bash script/stake-stand.sh) > "$LOG" 2>&1 &
SPID=$!
stop() { kill "$SPID" 2>/dev/null; pkill -P "$SPID" 2>/dev/null; wait "$SPID" 2>/dev/null; }
trap stop EXIT
for _ in $(seq 1 300); do grep -q "anvil stays up" "$LOG" 2>/dev/null && break; kill -0 "$SPID" 2>/dev/null || break; sleep 2; done
grep -q "anvil stays up" "$LOG" || { echo "the stand did not come up:"; tail -n 20 "$LOG"; exit 1; }
grep -E "^STEP|distributed|claimed|written" "$LOG"
node -e '
const fs = require("fs");
const [src, stand, out] = process.argv.slice(1);
const a = JSON.parse(fs.readFileSync(src, "utf8"));
const s = JSON.parse(fs.readFileSync(stand, "utf8"));
a.rpcUrl = s.rpc; a.rpcUrls = [s.rpc]; a.railStake = s.railStake;
fs.mkdirSync(require("path").dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(a, null, 2) + "\n");
fs.writeFileSync(require("path").join(require("path").dirname(out), "holders.json"), JSON.stringify(s, null, 2) + "\n");
' public/addresses.json "$STAND" public/local/addresses.json || exit 1
PILE_RPC=$RPC npx playwright test --workers=1 e2e/holders.spec.ts "$@"
