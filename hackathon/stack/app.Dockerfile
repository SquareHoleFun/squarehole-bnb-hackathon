# syntax=docker/dockerfile:1
# The web app's BNB Chain testnet build (SH_TESTNET=bnb, the test-network target) served by Caddy (SH-259 Part 4).
# Stage one builds the static site from the release's sources and the committed lockfile, the way the test site's app
# release builds it (infra/server/app/build.mjs: production mode, the test-network target, no FIT market), with the
# stack's own origin as the indexer's and the item pictures' origin (SH-258's SH_CORE_SEPOLIA_ART_GATEWAY). Stage two is plain Caddy with the site and its config.
# The base images are the test site's, pinned by digest (indexer.Dockerfile, caddy.Dockerfile).
FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea AS build
ENV CI=true
RUN npm install --global --ignore-scripts pnpm@10.29.1 && npm cache clean --force
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter '@squarehole/web...'
# The origin that serves this build's API and item pictures: https://<SH_BNB_HOST>.
ARG SH_BNB_ORIGIN
RUN test -n "$SH_BNB_ORIGIN" \
  && SH_BUILD=production SH_TARGET=sepolia SH_TESTNET=bnb SH_FIT_MARKET=none \
     SH_CORE_SEPOLIA_INDEXER_ORIGIN="$SH_BNB_ORIGIN" SH_SEPOLIA_INDEXER_ORIGIN="$SH_BNB_ORIGIN" \
     SH_CORE_SEPOLIA_ART_GATEWAY="$SH_BNB_ORIGIN" \
     pnpm --filter @squarehole/web exec vite build --outDir /site \
  && test -s /site/index.html

# The launch page (lane h's bounties/app, which imports its entries' ABIs from bounties/flap and bounties/openfour), from
# its own lockfile, served at /launches/; empty when the release has no app. `bountie[s]` matches the folder when it
# exists; the build script is always there, so the COPY never fails.
FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea AS launch
ENV CI=true
COPY hackathon/stack/launch-build.sh /launch-src/
COPY hackathon/stack/launch-build.sh bountie[s] /launch-src/bounties/
# SH-280: the site's Privy app id, by the platform's own committed file (bounties/app/vite.config.ts reads it; no copy).
COPY apps/web/src/features/alpha-sepolia/privy-config.ts /launch-src/apps/web/src/features/alpha-sepolia/privy-config.ts
RUN sh /launch-src/launch-build.sh

FROM caddy:2.11.6@sha256:907efba736324e43f891ccb9d760fe5abe545e313419b3d18d63d4ec670dad8d
COPY hackathon/stack/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /site /srv/app
COPY --from=launch /launch-out /srv/app/launches
