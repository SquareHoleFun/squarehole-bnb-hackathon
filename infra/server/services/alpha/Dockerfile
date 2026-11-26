# syntax=docker/dockerfile:1
FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
ENV CI=true NODE_ENV=production
RUN npm install --global --ignore-scripts pnpm@10.29.1 && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/keeper/package.json packages/keeper/
COPY packages/burn-bot/package.json packages/burn-bot/
COPY packages/chain/package.json packages/chain/
COPY packages/box-spec/package.json packages/box-spec/
COPY packages/domain/package.json packages/domain/
RUN pnpm install --frozen-lockfile --prod --filter '@squarehole/keeper...' && pnpm store prune
COPY infra/server/services/alpha-api.mjs infra/server/services/alpha-api.mjs
COPY infra/server/services/alpha infra/server/services/alpha
# Root reads the 0600 HMAC file; server.mjs drops to 2101:2101 (+read group 2103) before state/network access.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "infra/server/services/alpha-api.mjs", "--healthcheck"]
CMD ["node", "infra/server/services/alpha-api.mjs"]
