# The Four.meme rail's creation signer (SH-259): lane g's bounties/openfour/sign/ with only its runtime dependencies
# (npm ci from its own lockfile, no dev tools, no install scripts: no network after the build), and the stack's HTTP
# wrapper hackathon/stack/sign/. Built only when stack.env turns the service on (SH_BNB_SIGN=1; compose profile `sign`).
FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea AS deps
WORKDIR /src/openfour
COPY bounties/core/package.json /src/core/package.json
COPY bounties/core/src /src/core/src
COPY bounties/openfour/package.json bounties/openfour/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY bounties/openfour/sign ./sign
COPY bounties/openfour/lib ./lib

FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
COPY --from=deps /src /app
COPY hackathon/stack/sign /app/hackathon-sign
USER node
ENV NODE_ENV=production
# Healthy when ready or off until the records are placed; unhealthy when the service refused to start (health.js).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "/app/hackathon-sign/health.js"]
CMD ["node", "/app/hackathon-sign/server.js"]
