#!/bin/sh
# The launch page's build inside the web image (app.Dockerfile, stage `launch`): lane h's app at bounties/app, from
# its own lockfile, into /launch-out (served at /launches/ of the site; hash routes). A release without the app builds
# an empty folder, and /launches/ answers 404. Network only at build time (npm ci); the page fetches nothing from npm at run time.
set -eu
src=/launch-src/bounties/app
mkdir -p /launch-out
if [ ! -f "$src/package-lock.json" ]; then echo "launch: no bounties/app in this release"; exit 0; fi
cd "$src"
npm ci --no-audit --no-fund
PILE_BASE=/launches/ npm run build
test -s dist/index.html
test -s dist/addresses.json
cp -R dist/. /launch-out/
echo "launch: built $(find /launch-out -type f | wc -l) files"
