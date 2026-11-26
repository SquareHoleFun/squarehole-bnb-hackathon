# syntax=docker/dockerfile:1
# The card service (packages/cards, `src/service/main.ts`): draws a box's 1200 x 630 link-preview card for Caddy's
# /card/* on api.squarehole.fun (F81 CF1). Built on the server from a release tarball of this repository at one commit
# (infra/server/ship.sh), like the indexer's image: Node 24 runs the TypeScript sources directly (type stripping, the
# package's scripts/register-ts.mjs), only production dependencies of the card package and the workspace packages it
# imports are installed from the committed lockfile (resvg's native build is the prebuilt linux-x64-gnu binary the
# lockfile names; its wasm build stays as the fallback). Runs as the image's unprivileged `node` user.
FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea

ENV CI=true NODE_ENV=production SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm_config_ignore_scripts=true
RUN npm install --global --ignore-scripts pnpm@10.29.1 && npm cache clean --force

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/cards/package.json packages/cards/
COPY packages/indexer/package.json packages/indexer/
COPY packages/chain/package.json packages/chain/
COPY packages/box-spec/package.json packages/box-spec/
COPY packages/domain/package.json packages/domain/
COPY packages/artwork/package.json packages/artwork/
# Both sharp binaries come from locked optional npm packages. No compiler or install script is used.
RUN pnpm install --frozen-lockfile --prod --filter '@squarehole/cards...' && pnpm store prune
# Fail the x64 glibc build if optional binary packages were omitted. Runtime never downloads a decoder.
RUN node -e "const {createRequire}=require('node:module'); const r=createRequire('/app/packages/cards/package.json'); const s=r('sharp'); const b=createRequire(r.resolve('sharp')); b('@img/sharp-linux-x64/sharp.node'); b.resolve('@img/sharp-libvips-linux-x64/binary'); if(s.versions.sharp!=='0.35.5') process.exit(1)"

COPY packages/domain/src packages/domain/src
COPY packages/box-spec/src packages/box-spec/src
COPY packages/chain/src packages/chain/src
COPY packages/artwork/src packages/artwork/src
COPY packages/indexer/src packages/indexer/src
COPY packages/cards/src packages/cards/src
# The offline memory regression uses the same opt-in timeout helper as local tests.
COPY vitest.timeouts.mjs ./
COPY packages/cards/assets packages/cards/assets
COPY packages/cards/scripts/register-ts.mjs packages/cards/scripts/
COPY packages/cards/scripts/check-webp.ts packages/cards/scripts/
COPY packages/cards/notices /app/notices
# Keep the installed packages' notices byte for byte. The bundle ships no full component licence texts.
RUN node -e "const {createRequire}=require('node:module'); const {dirname,join}=require('node:path'); const {mkdirSync,copyFileSync}=require('node:fs'); const r=createRequire('/app/packages/cards/package.json'); const b=createRequire(r.resolve('sharp')); for(const [name,root,files] of [['sharp',dirname(dirname(r.resolve('sharp'))),['LICENSE','README.md']],['sharp-linux-x64',dirname(b.resolve('@img/sharp-linux-x64/package')),['LICENSE','README.md']],['sharp-libvips-linux-x64',dirname(b.resolve('@img/sharp-libvips-linux-x64/package')),['README.md','versions.json']]]) { const out=join('/app/notices',name); mkdirSync(out,{recursive:true}); for(const file of files) copyFileSync(join(root,file),join(out,file)); }"
# The generic card: the landing page's, as the site serves it (config.ts DEFAULT_GENERIC finds it here).
COPY apps/web/public/share/square-hole-1200x630.jpg apps/web/public/share/

# The disk cache's folder, owned by `node`: a new named volume mounted here starts with this owner.
RUN mkdir -p /cache && chown node:node /cache

USER node
WORKDIR /app/packages/cards
ENV SH_CARDS_HOST=0.0.0.0 SH_CARDS_PORT=5395 SH_CARDS_CACHE_DIR=/cache
EXPOSE 5395
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5395/card/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--experimental-transform-types", "--no-warnings=ExperimentalWarning", "--import", "./scripts/register-ts.mjs", "src/service/main.ts"]
