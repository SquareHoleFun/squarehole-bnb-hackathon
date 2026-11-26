# syntax=docker/dockerfile:1
# The core v1 indexer and gateway (packages/indexer `start:core`), built on the server from a release tarball of this
# repository at one commit (infra/server/ship.sh). Node 24 runs the TypeScript sources directly (type stripping, the
# package's scripts/register-ts.mjs): no build step. Only production dependencies of the indexer and the workspace
# packages it imports are installed, from the committed lockfile. Runs as the image's unprivileged `node` user.
FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea

ENV CI=true NODE_ENV=production
RUN npm install --global --ignore-scripts pnpm@10.29.1 && npm cache clean --force

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/indexer/package.json packages/indexer/
COPY packages/chain/package.json packages/chain/
COPY packages/box-spec/package.json packages/box-spec/
COPY packages/domain/package.json packages/domain/
RUN pnpm install --frozen-lockfile --prod --filter '@squarehole/indexer...' && pnpm store prune

COPY packages/domain/src packages/domain/src
COPY packages/box-spec/src packages/box-spec/src
COPY packages/chain/src packages/chain/src
COPY packages/indexer/src packages/indexer/src
COPY packages/indexer/scripts/register-ts.mjs packages/indexer/scripts/
# Box 0's public logo and collection cover, for the listing check (packages/indexer/src/core/release-art.ts): the FIT
# icon is an SVG, which our picture route never serves. Read by sha256, never served.
COPY packages/design/art/fit/fit-icon.svg packages/design/art/fit/
COPY docs/design/misfits-v2/banner/final/misfits-collection-sorter-1024.png docs/design/misfits-v2/banner/final/

USER node
WORKDIR /app/packages/indexer
ENV SH_CORE_GATEWAY_HOST=0.0.0.0 SH_CORE_GATEWAY_PORT=5394
EXPOSE 5394
# Docker's view of /healthz (200: idling on an awaiting manifest, or following the chain). Informational: the restart
# policy acts on exits, not on this.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5394/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--experimental-transform-types", "--no-warnings=ExperimentalWarning", "--import", "./scripts/register-ts.mjs", "src/core/core-main.ts"]
