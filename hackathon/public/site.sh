#!/usr/bin/env bash
# Level 1 of the guide: the BNB Chain test site built on your computer and served at http://127.0.0.1:<port>/, reading
# the live test network through the live site's index (its gateway answers any origin). Nothing is sent anywhere by
# this script; the page itself asks your browser wallet before any transaction.
#
# usage: bash hackathon/public/site.sh            build, then serve until Ctrl-C (port 5391)
#        SH_SITE_PORT=<port> SH_SITE_INDEXER=<https origin> bash hackathon/public/site.sh
# The build is the test site's: production mode, the test-network target, chain 97 (the same settings as the live
# site's image, hackathon/stack/app.Dockerfile). A production build takes only an https origin on a public host as
# its index; the default is the live site's.
set -euo pipefail
cd "$(dirname "$0")/../.."
PORT=${SH_SITE_PORT:-5391}
INDEXER=${SH_SITE_INDEXER:-https://138-197-196-174.sslip.io}
[ -d node_modules ] || pnpm install --frozen-lockfile
SH_BUILD=production SH_TARGET=sepolia SH_TESTNET=bnb SH_FIT_MARKET=none \
  SH_CORE_SEPOLIA_INDEXER_ORIGIN="$INDEXER" SH_SEPOLIA_INDEXER_ORIGIN="$INDEXER" SH_CORE_SEPOLIA_ART_GATEWAY="$INDEXER" \
  pnpm --filter @squarehole/web exec vite build
test -s apps/web/dist/index.html
echo "site: built; serving http://127.0.0.1:$PORT/ (Ctrl-C stops it)"
exec pnpm --filter @squarehole/web exec vite preview --host 127.0.0.1 --port "$PORT" --strictPort
