# syntax=docker/dockerfile:1
# Root build context; the integrator must first add this package's lockfile importer.
FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
ENV CI=true NODE_ENV=production
RUN npm install --global --ignore-scripts pnpm@10.29.1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/cow-poster/package.json packages/cow-poster/
COPY packages/chain/package.json packages/chain/
COPY packages/box-spec/package.json packages/box-spec/
COPY packages/domain/package.json packages/domain/
RUN pnpm install --frozen-lockfile --prod --filter '@squarehole/cow-poster...'
COPY packages/domain/src packages/domain/src
COPY packages/box-spec/src packages/box-spec/src
COPY packages/chain/src packages/chain/src
COPY packages/chain/scripts/register-ts.mjs packages/chain/scripts/register-ts.mjs
COPY packages/cow-poster/src packages/cow-poster/src
RUN mkdir -p /state && chown node:node /state
USER node
WORKDIR /app/packages/cow-poster
ENV SH_COW_STATE_DIR=/state SH_COW_HEALTH_FILE=/state/health.json
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "const h=JSON.parse(require('node:fs').readFileSync(process.env.SH_COW_HEALTH_FILE,'utf8')); process.exit(['running','idle','disabled'].includes(h.phase)&&Number.isFinite(h.updatedAt)&&Date.now()-h.updatedAt<=2*Number(process.env.SH_COW_CYCLE_MS??600000)+60000?0:1)"]
CMD ["node", "--experimental-transform-types", "--no-warnings=ExperimentalWarning", "--import", "../chain/scripts/register-ts.mjs", "src/main.ts"]
