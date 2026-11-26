#!/usr/bin/env bash
# SH-275's container trial of the alpha on the build machine, from a checkout (no release, no ship, no published port):
#   bash hackathon/stack/test/alpha-trial.sh <trial folder> <fitted Caddyfile> [claims]
# Builds the alpha-api and keeper images of this checkout (tag sh275trial), then compose.yaml + alpha.compose.yaml +
# test/alpha-trial.yaml under the project sh275-trial: a local chain 97 in a container (this machine's Anvil binary, a
# block a second, port 8621 on the trial's own network only), alpha-folders, alpha-api (auto approval, a fixture Privy
# key), alpha-sender (live, chain 97, a fixture key with a 1 tBNB float), a Caddy with the given Caddyfile; then the
# driver (sign-ins, claims, payments). Reports the containers' health and the cookie key's mode, owner and size (never
# its content). Everything it started is removed at the end: the project with its volumes.
set -euo pipefail
die() { printf 'alpha-trial: %s\n' "$*" >&2; exit 1; }
[ "$#" -ge 2 ] || die "usage: alpha-trial.sh <trial folder> <fitted Caddyfile> [claims]"
repo=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$1"; trial=$(cd "$1" && pwd); caddyfile=$(readlink -f "$2"); claims=${3:-3}
[ ! -e "$trial/etc" ] || die "$trial holds an earlier trial; give a fresh folder"
mkdir -p "$trial/etc/alpha-sender" "$trial/app/join" "$trial/fixture" "$trial/srv/withheld"
chmod 0700 "$trial/etc" "$trial/etc/alpha-sender"
cp "$caddyfile" "$trial/Caddyfile"
printf '<!doctype html><title>trial join page</title>\n' > "$trial/app/join/index.html"
: > "$trial/etc/db.env"; : > "$trial/etc/indexer.env"; : > "$trial/etc/keeper.env"
# Fixture keys only: the stand-in's Privy key pair, and the sender's key (private key 900, as the services' tests use).
node --input-type=module -e '
  import { generateKeyPairSync } from "node:crypto"; import { writeFileSync } from "node:fs";
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  writeFileSync(process.argv[1] + "/fixture/privy-private.pem", privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o644 });
  writeFileSync(process.argv[1] + "/privy-line", publicKey.export({ type: "spki", format: "pem" }).trim().replaceAll("\n", "\\n"));
' "$trial"
desk_key=0x0000000000000000000000000000000000000000000000000000000000000384
desk=$(cd "$repo/packages/keeper" && node -e "console.log(require('viem/accounts').privateKeyToAccount('$desk_key').address)")
( umask 077; printf '%s\n' "$desk_key" > "$trial/etc/alpha-sender/desk.key" ); chmod 0400 "$trial/etc/alpha-sender/desk.key"
{ echo SH_ALPHA_ENABLED=1; echo SH_ALPHA_PRIVY_APP_ID=fixture-app; printf 'SH_ALPHA_PRIVY_VERIFICATION_KEY=%s\n' "$(cat "$trial/privy-line")"; } > "$trial/etc/alpha-api.env"
printf 'SH_SERVICE_ENABLED=1\nSH_SERVICE_MODE=live\nSH_SERVICE_ALLOW_MAINNET=0\nSH_KEEPER_RPC_URL=http://chain97:8621\nSH_ALPHA_DESK_ADDRESS=%s\nSH_ALPHA_TETH=0x860822580d4eb2529de0c74c3e2b1d6d7c183302\n' "$desk" > "$trial/etc/alpha-sender.env"
chmod 0600 "$trial/etc/"*.env
# The values ship.sh derives for the keeper and the indexer (compose.yaml requires them; neither runs in this trial).
printf 'SH_BNB_HOST=trial.example.org\nSH_BNB_ETC=%s\nSH_BNB_SRV=%s\nSH_TRIAL_DIR=%s\nSH_TRIAL_CLAIMS=%s\nSH_TRIAL_DESK=%s\nSH_TRIAL_ANVIL=%s\nSH_RELEASE=sh275trial\nSH_BNB_CORE_ATLAS=0\nSH_BNB_KEEPER_ATLAS=0\nSH_BNB_KEEPER_CHAIN_ID=97\nSH_BNB_KEEPER_REGISTRY=0x0000000000000000000000000000000000000001\nSH_BNB_KEEPER_FROM_BLOCK=1\nSH_BNB_KEEPER_PRIORITY_FEE_WEI=1\nSH_BNB_KEEPER_MAX_FEE_WEI=1\n' \
  "$trial/etc" "$trial/srv" "$trial" "$claims" "$desk" "$(readlink -f "$(command -v anvil)")" > "$trial/trial.env"
compose=(docker compose --project-name sh275-trial --env-file "$trial/trial.env" --file "$repo/hackathon/stack/compose.yaml"
  --file "$repo/hackathon/stack/alpha.compose.yaml" --file "$repo/hackathon/stack/test/alpha-trial.yaml" --profile alpha --profile trial)

cleanup() { "${compose[@]}" down --volumes --remove-orphans > "$trial/down.log" 2>&1 || true; }
trap cleanup EXIT

"${compose[@]}" config --quiet
"${compose[@]}" build --quiet alpha-api keeper
echo "alpha-trial: images built"
"${compose[@]}" up --detach trial-chain alpha-api alpha-sender trial-caddy
echo "alpha-trial: services up"
set +e
"${compose[@]}" run --rm --no-deps trial-driver > "$trial/driver.json" 2> "$trial/driver.err"
driver=$?
set -e
cat "$trial/driver.json"
sleep 35 # one more health interval
for svc in alpha-folders alpha-api alpha-sender; do
  id=$("${compose[@]}" ps --all --quiet "$svc")
  echo "alpha-trial: $svc $(docker inspect --format '{{.State.Status}} exit={{.State.ExitCode}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} user={{.Config.User}}' "$id")"
done
echo "alpha-trial: cookie key (mode uid size): $(docker run --rm --network none --entrypoint stat -v sh275-trial_alpha_config:/c:ro squarehole-bnb-alpha-api:sh275trial -c '%a %u %s' /c/cookie.key)"
echo "alpha-trial: volume owners: $(docker run --rm --network none --entrypoint sh -v sh275-trial_alpha_queue:/q:ro -v sh275-trial_alpha_receipts:/r:ro -v sh275-trial_alpha_state:/s:ro -v sh275-trial_alpha_sender_state:/t:ro squarehole-bnb-alpha-api:sh275trial -c 'stat -c "%n %a %u:%g" /q /r /s /t | tr "\n" " "')"
"${compose[@]}" logs --no-color alpha-folders alpha-api alpha-sender 2>&1 | tail -n 30
exit "$driver"
