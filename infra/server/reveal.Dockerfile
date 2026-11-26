# syntax=docker/dockerfile:1
# Built only by the founder from the reviewed release and locked dependencies.
FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
ENV CI=true NODE_ENV=production
RUN npm install --global --ignore-scripts pnpm@10.29.1 && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/indexer/package.json packages/indexer/
COPY packages/artwork/package.json packages/artwork/
COPY packages/chain/package.json packages/chain/
COPY packages/box-spec/package.json packages/box-spec/
COPY packages/domain/package.json packages/domain/
COPY packages/keeper/package.json packages/keeper/
RUN pnpm install --frozen-lockfile --prod --filter '@squarehole/indexer...' --filter '@squarehole/artwork...' --filter '@squarehole/chain...' --filter '@squarehole/box-spec...' --filter '@squarehole/domain...' --filter '@squarehole/keeper...' && pnpm store prune
COPY packages/indexer/src packages/indexer/src
COPY packages/artwork/src packages/artwork/src
COPY packages/chain/src packages/chain/src
COPY packages/box-spec/src packages/box-spec/src
COPY packages/domain/src packages/domain/src
COPY packages/keeper/src/config.ts packages/keeper/src/gas.ts packages/keeper/src/income.ts packages/keeper/src/jobs.ts packages/keeper/src/m2-gas.ts packages/keeper/src/m3-gas.ts packages/keeper/src/
COPY packages/keeper/scripts/register-ts.mjs packages/keeper/scripts/register-ts.mjs
COPY scripts/ipfs scripts/ipfs
COPY scripts/box/lib scripts/box/lib
COPY scripts/box/reveal-service/common.mjs scripts/box/reveal-service/poster.mjs scripts/box/reveal-service/journal.mjs scripts/box/reveal-service/
COPY scripts/nft scripts/nft
COPY infra/server/services infra/server/services
RUN mkdir -p /state && chown node:node /state
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "infra/server/services/run.mjs", "reveal", "--healthcheck"]
CMD ["node", "--experimental-transform-types", "--no-warnings=ExperimentalWarning", "--import", "./packages/keeper/scripts/register-ts.mjs", "infra/server/services/run.mjs", "reveal"]
