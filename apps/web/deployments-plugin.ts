import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { PRODUCTION_STAMP } from './src/share/build-stamp';
import { TESTNET_PROFILES, testnetNameOf, type TestnetProfile } from '../../packages/chain/src/config/testnet-profile';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPLOYMENTS_DIR = resolve(HERE, '../../packages/contracts/deployments');
/** Core v1 manifests (`squarehole.core-deployment/v1`, S10a § 2.3): one per chain, Sepolia's committed. */
export const CORE_DEPLOYMENTS_DIR = join(DEPLOYMENTS_DIR, 'core-v1');
/** The committed v2 market records (`squarehole.fit-market/v1`), one per chain: today the full v2 deployment on Sepolia. */
export const FIT_MARKETS_DIR = resolve(HERE, 'fit-markets');
/**
 * SH-258: the build's test network (`SH_TESTNET`; build-target.ts `testnetOf` checks it against the target). Its chain
 * id names the files the test-network slot reads: `deployments/<id>.json`, `deployments/core-v1/<id>.json`, and on
 * BNB Chain testnet the trade box's and test-coin page's record `packages/chain/src/trade-sepolia/coin-deployment-97.json`
 * (Sepolia's record is pinned in the chain package itself). A file that does not exist is null: the pages then say
 * the network is not deployed, as a Sepolia build without its manifest does.
 */
export const testnetProfileOfEnv = (env: Env): TestnetProfile => TESTNET_PROFILES[testnetNameOf(env.SH_TESTNET)];
const TRADE_RECORDS_DIR = resolve(HERE, '../../packages/chain/src/trade-sepolia');
export function testnetCoinRecordPath(env: Env): string | null {
  const profile = testnetProfileOfEnv(env);
  return profile.name === 'sepolia' ? null : join(TRADE_RECORDS_DIR, `coin-deployment-${profile.chainId}.json`);
}
export const DEPLOYMENTS_MODULE = 'virtual:squarehole-deployments';
/** The anvil port of `pnpm dev:local` (scripts/dev-local.mjs; this repo's anvil range is 8550-8599). */
const DEFAULT_LOCAL_RPC_URL = 'http://127.0.0.1:8560';
/** The anvil port of `pnpm dev:core-local` (packages/chain/scripts/local-core-chain.mjs; core v1 on a Sepolia twin). */
const DEFAULT_CORE_LOCAL_RPC_URL = 'http://127.0.0.1:8562';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * `virtual:squarehole-deployments` (SH-C, ADR-0012 Part C): the deployment manifests the chain data sources read,
 * embedded at build time. Values are public identities (addresses, blocks, hashes), never secrets.
 * - Sepolia: `packages/contracts/deployments/11155111.json` when it exists (committed at Stage E); otherwise null, and
 *   the app says "not deployed yet".
 * - Local chain 31337: the manifest named by `SH_LOCAL_MANIFEST` (`pnpm dev:local` and the chain E2E set it), or, in
 *   the dev server only, `deployments/31337.json`. A plain `vite build` embeds no local manifest, so a hosted build
 *   never points at someone's anvil. `SH_LOCAL_RPC_URL` sets the local RPC (default port 8560).
 * - The v2 market records (T19 pair page, `squarehole.fit-market/v1`, at most one per chain), the same way: exactly the
 *   comma-separated files `SH_FIT_MARKET` names, or none (`SH_FIT_MARKET=none`); without the variable, every committed
 *   record in apps/web/fit-markets/ in the dev server only (today the full v2 deployment on Sepolia, with its neutral
 *   names). **A plain `vite build` embeds no record**: whether a public build shows the Sepolia rehearsal on /misfits is
 *   the founder's open question (docs/evidence/SH-V2-sepolia-full.md C9, question 1), so a build carries it only when
 *   someone names it. A named file that does not exist fails the build. A chain without a record makes the page say the
 *   market is not configured. `SH_SEPOLIA_INDEXER_ORIGIN` points the Sepolia record at a live indexer for this build
 *   (the committed record names none: no hosted indexer exists; a local `pnpm --filter @squarehole/indexer start`
 *   serves http://127.0.0.1:5393). The page checks it like every other field of the record (https, or http on a
 *   loopback address).
 * - Core v1 (S10a § 2.3): `CORE_MANIFESTS`, Sepolia's committed `deployments/core-v1/11155111.json` always (public
 *   identities; today the `awaiting-broadcast` placeholder, read as "Core v1 is not on Sepolia yet"), and a local
 *   core manifest only when `SH_CORE_LOCAL_MANIFEST` names it (written by `pnpm dev:core-local` into a gitignored
 *   folder; a local twin with Sepolia's chain id). `SH_CORE_LOCAL_RPC_URL` (default port 8562) is the local core RPC;
 *   `SH_CORE_LOCAL_INDEXER_ORIGIN` and `SH_CORE_SEPOLIA_INDEXER_ORIGIN` point a source at a live indexer gateway
 *   (none by default: the pages then read the chain directly). `SH_CORE_SEPOLIA_MANIFEST` names a Sepolia core
 *   manifest to embed instead of the committed one (the production smoke test's recorded v2 deployment). Every value
 *   is checked again by the app.
 * - Box pictures on the local v2 stack (SH-V2-LOCAL-ART, SH-V2-FE11): `CORE_ART_GATEWAYS.local`, the bare loopback origins
 *   `SH_CORE_LOCAL_ART_GATEWAYS` names (comma-separated; `pnpm dev:core-v2-local` passes its art gateway). The app asks
 *   them for a box's committed logo and cover by raw CID and shows the bytes only once their size and SHA-256 match
 *   the box's spec (src/features/boxes/box-pictures.ts).
 * - Box pictures on Sepolia (SH-TA-26): `CORE_ART_GATEWAYS.sepolia` is our own node, `SEPOLIA_ART_GATEWAY`
 *   (https://api.squarehole.fun/ipfs/<cid>, SH-TA-25: GET/HEAD, canonical raw CIDs, offline, digest-checked), in the
 *   Sepolia test target only (`SH_BUILD=production SH_TARGET=sepolia`). The site's CSP already allows that origin for
 *   images and connections (src/share/share-headers.ts `api`); its separate art origin list stays empty. Every other
 *   build names no Sepolia gateway: those boxes show the placeholder and nothing is fetched.
 * - The existing-NFTs add-on (SH-EXISTING-NFTS-E08C): `SET_LOCAL_MANIFEST`, its own local manifest
 *   (`squarehole.set-release/v1`, docs/design/existing-nfts-v2.md § 4.10), only when `SH_SET_LOCAL_MANIFEST` names it, in
 *   a development build. It never joins the core manifests' releases: the app parses it against the local core manifest
 *   and checks the factory's identity on chain before it shows anything of the add-on (src/features/set/set-build.ts).
 *   Local only until its release ticket (E-09): a production build refuses the variable like every local one.
 * - The Sepolia alpha's local trade setup (F156, SH-ALPHA-TRADE-BOX): `ALPHA_LOCAL_MANIFEST`, the 31337 alpha's own manifest
 *   (`square-hole-alpha-local/1`, packages/chain/scripts/lib/core-v2-local-manifest.mjs `readAlphaLocalManifest`), only when
 *   `SH_ALPHA_LOCAL_MANIFEST` names it, in a development build. It names the local PoolSwapTest the trade box passes to the
 *   trade calls as `localDeployment` on chain 31337 (src/features/trade-sepolia/trade-target.ts checks it against the local
 *   core manifest). Never a Sepolia override: the trade calls ignore a local deployment on 11155111. A production build
 *   refuses the variable like every local one.
 * - `SH_BUILD=production` (`buildModeOf`, below): no Demo and no local chain.
 */
export interface DeploymentsContext {
  /** `vite` / `vite dev` (not `vite build`, `vite preview` or vitest). */
  readonly devServer: boolean;
  readonly env: Env;
}

/**
 * The build mode (`SH_BUILD`, read at build time like the variables above):
 * - unset or `development`: today's site: the Demo data (the default source), the local chains and Sepolia.
 * - `production` (SH-V2-FE6, founder 2026-10-10: "a version with no demo at all"): no Demo and no local chain. The
 *   only data source is Sepolia, as far as the build carries a deployment there (there is no mainnet target, G08). The
 *   app drops every Demo branch at build time (`import.meta.env.SH_PRODUCTION`, `src/build-mode.ts`), and this module
 *   refuses every local variable, embeds no local RPC URL, takes only Sepolia records and manifests, and only https
 *   indexer origins.
 */
export type BuildMode = 'development' | 'production';

export function buildModeOf(env: Env): BuildMode {
  const value = env.SH_BUILD?.trim() ?? '';
  if (value === '' || value === 'development') return 'development';
  if (value === 'production') return 'production';
  throw new Error(`SH_BUILD must be unset, "development" or "production" (got "${value}")`);
}

/** The variables that point a build at a local chain: a production build refuses each one (never ignores it). */
export const LOCAL_VARIABLES = ['SH_LOCAL_MANIFEST', 'SH_LOCAL_RPC_URL', 'SH_CORE_LOCAL_MANIFEST', 'SH_CORE_LOCAL_RPC_URL', 'SH_CORE_LOCAL_INDEXER_ORIGIN', 'SH_CORE_LOCAL_ART_GATEWAYS', 'SH_SET_LOCAL_MANIFEST', 'SH_ALPHA_LOCAL_MANIFEST'] as const;

/**
 * The existing-NFTs add-on's local manifest a development build embeds: the file `SH_SET_LOCAL_MANIFEST` names, or none.
 * A named file that does not exist fails the build; a production build never gets here (`refuseLocal`).
 */
export function setManifestPath({ env }: Pick<DeploymentsContext, 'env'>): string | null {
  const named = env.SH_SET_LOCAL_MANIFEST?.trim();
  if (!named) return null;
  const path = resolve(named);
  if (!existsSync(path)) throw new Error(`SH_SET_LOCAL_MANIFEST names a file that does not exist: ${path}`);
  return path;
}

/**
 * The 31337 alpha's local manifest a development build embeds (F156, SH-ALPHA-TRADE-BOX): the file
 * `SH_ALPHA_LOCAL_MANIFEST` names, or none. A named file that does not exist fails the build; a production build never
 * gets here (`refuseLocal`).
 */
export function alphaManifestPath({ env }: Pick<DeploymentsContext, 'env'>): string | null {
  const named = env.SH_ALPHA_LOCAL_MANIFEST?.trim();
  if (!named) return null;
  const path = resolve(named);
  if (!existsSync(path)) throw new Error(`SH_ALPHA_LOCAL_MANIFEST names a file that does not exist: ${path}`);
  return path;
}

function refuseLocal(env: Env): void {
  for (const name of LOCAL_VARIABLES) {
    if (env[name]?.trim()) throw new Error(`SH_BUILD=production carries no local chain: unset ${name}`);
  }
}

/** A production indexer origin: https on a public host (never a loopback or local address). */
function productionOrigin(origin: string | null, what: string): string | null {
  if (origin === null) return null;
  const { protocol, hostname } = new URL(origin);
  const local = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]' || /^(127|10|0)\.|^192\.168\.|^169\.254\./.test(hostname);
  if (protocol !== 'https:' || local) throw new Error(`SH_BUILD=production: ${what} must be an https origin on a public host`);
  return origin;
}

/** The local RPC URL ships in the bundle: http(s) only, never credentials, a query string or a fragment. */
function localRpcUrl(env: Env): string {
  const value = env.SH_LOCAL_RPC_URL ?? DEFAULT_LOCAL_RPC_URL;
  const url = new URL(value);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    throw new Error('SH_LOCAL_RPC_URL must be a plain http(s) URL without credentials, query string or fragment (it is embedded in the bundle)');
  }
  return value;
}

/**
 * The market record files this build embeds (see above): named ones, or the committed ones in the dev server only. A
 * production build embeds only the named ones (as a plain `vite build`).
 */
export function fitMarketPaths({ devServer, env }: DeploymentsContext): string[] {
  const named = env.SH_FIT_MARKET?.trim() ?? '';
  if (named === 'none') return [];
  // SH-258: a production build for another test network than Sepolia (BNB Chain testnet, no FIT market) names none.
  if (named !== '' && buildModeOf(env) === 'production' && testnetProfileOfEnv(env).name !== 'sepolia') {
    throw new Error(`SH_BUILD=production for ${testnetProfileOfEnv(env).networkName} takes no market record: unset SH_FIT_MARKET or set it to none`);
  }
  if (named !== '') return named.split(',').map((path) => path.trim()).filter(Boolean).map((path) => resolve(path));
  if (!devServer || buildModeOf(env) === 'production' || !existsSync(FIT_MARKETS_DIR)) return [];
  return readdirSync(FIT_MARKETS_DIR).filter((name) => name.endsWith('.json')).sort().map((name) => join(FIT_MARKETS_DIR, name));
}

/** The record as embedded: the Sepolia one with this build's indexer origin when `SH_SEPOLIA_INDEXER_ORIGIN` is set. */
function embeddedMarket(value: unknown, env: Env): unknown {
  const origin = env.SH_SEPOLIA_INDEXER_ORIGIN?.trim();
  if (!origin || typeof value !== 'object' || value === null || (value as { chainId?: unknown }).chainId !== testnetProfileOfEnv(env).chainId) return value;
  return { ...value, indexer: { origin } };
}

const read = (path: string | null): unknown => (path !== null && existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : null);

/**
 * The core manifest files this build embeds: Sepolia's (the committed one, or the one `SH_CORE_SEPOLIA_MANIFEST` names
 * instead: a core v2 deployment for a test of a production build), and the local one `SH_CORE_LOCAL_MANIFEST` names.
 */
export function coreManifestPaths({ env }: DeploymentsContext): string[] {
  const namedSepolia = env.SH_CORE_SEPOLIA_MANIFEST?.trim();
  if (namedSepolia && !existsSync(resolve(namedSepolia))) throw new Error(`SH_CORE_SEPOLIA_MANIFEST names a file that does not exist: ${resolve(namedSepolia)}`);
  // SH-258: a public build never takes a rehearsal's files, and a production build of another test network than Sepolia
  // (BNB Chain testnet) takes only its canonical release file: no override (a fixture would ship as the deployment).
  if (namedSepolia && buildModeOf(env) === 'production') {
    if (/[\\/]hackathon[\\/]rehearsals[\\/]/.test(resolve(namedSepolia))) throw new Error('SH_BUILD=production never takes a rehearsal\'s manifest (hackathon/rehearsals/)');
    if (testnetProfileOfEnv(env).name !== 'sepolia') throw new Error(`SH_BUILD=production for ${testnetProfileOfEnv(env).networkName} reads only packages/contracts/deployments/core-v1/${testnetProfileOfEnv(env).chainId}.json: unset SH_CORE_SEPOLIA_MANIFEST`);
  }
  const sepolia = namedSepolia ? resolve(namedSepolia) : join(CORE_DEPLOYMENTS_DIR, `${testnetProfileOfEnv(env).chainId}.json`);
  const local = env.SH_CORE_LOCAL_MANIFEST?.trim();
  if (local && !existsSync(resolve(local))) throw new Error(`SH_CORE_LOCAL_MANIFEST names a file that does not exist: ${resolve(local)}`);
  return [...(existsSync(sepolia) ? [sepolia] : []), ...(local ? [resolve(local)] : [])];
}

/**
 * A production build takes the test network's records and manifests only (Sepolia's, or BNB Chain testnet's under
 * SH_TESTNET=bnb): a local one (chain 31337, network local) is a fixture.
 */
function sepoliaOnly(values: readonly unknown[], what: string, profile: TestnetProfile): void {
  for (const value of values) {
    const { chainId, network } = (typeof value === 'object' && value !== null ? value : {}) as { chainId?: unknown; network?: unknown };
    if (chainId !== profile.chainId || (network !== undefined && network !== profile.manifestNetwork)) {
      throw new Error(`SH_BUILD=production takes ${profile.networkName} ${what} only (chain ${profile.chainId})`);
    }
  }
}

/** An indexer origin for the bundle: a bare http(s) origin (the app checks it again, as fit-target.ts does). */
function indexerOriginOf(value: string | undefined, what: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const url = new URL(trimmed);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(`${what} must be a bare http(s) origin (no credentials, path, query or fragment)`);
  }
  return url.origin;
}

/**
 * The Sepolia test site's picture gateway (SH-TA-26): the API origin, which serves `/ipfs/<raw CIDv1>` from our own node
 * (SH-TA-25). A bare origin: box-pictures.ts appends `/ipfs/<cid>` and checks the bytes against the spec's SHA-256.
 */
export const SEPOLIA_ART_GATEWAY = 'https://api.squarehole.fun';

/** The Sepolia gateways a build embeds: ours in the Sepolia test target (production, `SH_TARGET=sepolia`), else none. */
export function sepoliaArtGateways(env: Env): string[] {
  // Sepolia's gateway is pinned and the setting is not read there (as before SH-258: no new refusal for Sepolia).
  if (testnetProfileOfEnv(env).name === 'sepolia') return buildModeOf(env) === 'production' && env.SH_TARGET === 'sepolia' ? [SEPOLIA_ART_GATEWAY] : [];
  const named = indexerOriginOf(env.SH_CORE_SEPOLIA_ART_GATEWAY, 'SH_CORE_SEPOLIA_ART_GATEWAY');
  // SH-258: another test network (BNB Chain testnet) takes its gateway from `SH_CORE_SEPOLIA_ART_GATEWAY`, one bare
  // origin (https on a public host in production); without it, none, and its boxes show the placeholder.
  if (named === null) return [];
  return [buildModeOf(env) === 'production' ? (productionOrigin(named, 'SH_CORE_SEPOLIA_ART_GATEWAY') as string) : named];
}

/** A loopback host: 127.0.0.0/8, localhost or [::1]. The local art gateways may name nothing else. */
const LOOPBACK = (hostname: string) => hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);

/**
 * `SH_CORE_LOCAL_ART_GATEWAYS`: comma-separated bare http(s) origins on a loopback host (the local stack's art gateway),
 * no credentials, path, query or fragment; each once, in the order given. Anything else fails the build.
 */
export function localArtGateways(value: string | undefined): string[] {
  const named = value?.split(',').map((part) => part.trim()).filter(Boolean) ?? [];
  const origins: string[] = [];
  for (const entry of named) {
    let url: URL;
    try { url = new URL(entry); } catch { throw new Error(`SH_CORE_LOCAL_ART_GATEWAYS: "${entry}" is not a URL`); }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '') || !LOOPBACK(url.hostname)) {
      throw new Error('SH_CORE_LOCAL_ART_GATEWAYS must name bare http(s) origins on a loopback host (no credentials, path, query or fragment)');
    }
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  return origins;
}

/**
 * SH-ARWEAVE-PICTURES-WEB (founder 2026-10-24): where a v2 box's logo and cover go on Arweave (Create shrinks them to
 * Turbo's free tier, refuses one that cannot fit before the box is created, and publishes both once it exists; every page
 * reads them there, checked by hash; the hosts are src/features/pictures/arweave-hosts.ts, in the site's connect-src).
 * On, per core source: Sepolia in the Sepolia test target (production, `SH_TARGET=sepolia`); and, outside production,
 * wherever `SH_ARWEAVE_PICTURES=1` asks for it (the local stack included: the opt-in live browser test). Every other
 * build: off, so no test suite and no dev server ever publishes to Arweave or asks it unless told to. A Vitest
 * environment (`VITEST`, the unit tests) is always off, whatever else it holds (fix round 2: an opt-in the shell
 * exported for the dev server must not reach the unit tests; vite.config.ts clears it there too).
 */
export function arweavePictures(env: Env): { local: boolean; sepolia: boolean } {
  const value = env.SH_ARWEAVE_PICTURES?.trim() ?? '';
  if (value !== '' && value !== '1') throw new Error('SH_ARWEAVE_PICTURES must be unset or "1"');
  if (env.VITEST) return { local: false, sepolia: false };
  const production = buildModeOf(env) === 'production';
  const asked = value === '1' && !production;
  // SH-258: in the test target, only where the test network keeps pictures on Arweave (`switches.arweavePictures`).
  // The test source's opt-in follows the switch as well (SH-285: on for BNB Chain testnet too, the founder's R142-LOGO).
  const onTestnet = testnetProfileOfEnv(env).switches.arweavePictures;
  return { local: asked, sepolia: onTestnet && (asked || (production && env.SH_TARGET === 'sepolia')) };
}

/** The virtual module's source, and the existing files it was read from (to watch in the dev server). */
export function deploymentsModule(context: DeploymentsContext): { readonly code: string; readonly watch: readonly string[] } {
  const { devServer, env } = context;
  const production = buildModeOf(env) === 'production';
  if (production) refuseLocal(env);
  const localPath = production ? null : env.SH_LOCAL_MANIFEST ? resolve(env.SH_LOCAL_MANIFEST) : devServer ? join(DEPLOYMENTS_DIR, '31337.json') : null;
  const profile = testnetProfileOfEnv(env);
  const sepoliaPath = join(DEPLOYMENTS_DIR, `${profile.chainId}.json`);
  const coinRecordPath = testnetCoinRecordPath(env);
  const marketPaths = fitMarketPaths(context);
  for (const path of marketPaths) if (!existsSync(path)) throw new Error(`SH_FIT_MARKET names a file that does not exist: ${path}`);
  const corePaths = coreManifestPaths(context);
  const setPath = production ? null : setManifestPath(context);
  const alphaPath = production ? null : alphaManifestPath(context);
  const coreLocalRpc = env.SH_CORE_LOCAL_RPC_URL ? localRpcUrl({ SH_LOCAL_RPC_URL: env.SH_CORE_LOCAL_RPC_URL }) : DEFAULT_CORE_LOCAL_RPC_URL;
  const coreIndexers = {
    local: indexerOriginOf(env.SH_CORE_LOCAL_INDEXER_ORIGIN, 'SH_CORE_LOCAL_INDEXER_ORIGIN'),
    sepolia: indexerOriginOf(env.SH_CORE_SEPOLIA_INDEXER_ORIGIN, 'SH_CORE_SEPOLIA_INDEXER_ORIGIN'),
  };
  const artGateways = { local: production ? [] : localArtGateways(env.SH_CORE_LOCAL_ART_GATEWAYS), sepolia: sepoliaArtGateways(env) };
  const markets = marketPaths.map((path) => embeddedMarket(read(path), env));
  const cores = corePaths.map((path) => read(path));
  if (production) {
    sepoliaOnly(markets, 'market records', profile);
    sepoliaOnly(cores, 'core manifests', profile);
    productionOrigin(indexerOriginOf(env.SH_SEPOLIA_INDEXER_ORIGIN, 'SH_SEPOLIA_INDEXER_ORIGIN'), 'SH_SEPOLIA_INDEXER_ORIGIN');
    productionOrigin(coreIndexers.sepolia, 'SH_CORE_SEPOLIA_INDEXER_ORIGIN');
  }
  // A production build names no local RPC: the local sources do not exist there.
  const code = [
    `export const LOCAL_MANIFEST = ${JSON.stringify(read(localPath))};`,
    `export const SEPOLIA_MANIFEST = ${JSON.stringify(read(sepoliaPath))};`,
    `export const LOCAL_RPC_URL = ${JSON.stringify(production ? '' : localRpcUrl(env))};`,
    `export const FIT_MARKETS = ${JSON.stringify(markets)};`,
    `export const CORE_MANIFESTS = ${JSON.stringify(cores)};`,
    `export const CORE_LOCAL_RPC_URL = ${JSON.stringify(production ? '' : coreLocalRpc)};`,
    `export const CORE_INDEXER_ORIGINS = ${JSON.stringify(production ? { ...coreIndexers, local: null } : coreIndexers)};`,
    `export const CORE_ART_GATEWAYS = ${JSON.stringify(artGateways)};`,
    `export const CORE_ARWEAVE = ${JSON.stringify(arweavePictures(env))};`,
    `export const SET_LOCAL_MANIFEST = ${JSON.stringify(read(setPath))};`,
    `export const ALPHA_LOCAL_MANIFEST = ${JSON.stringify(read(alphaPath))};`,
    `export const TESTNET_COIN_RECORD = ${JSON.stringify(read(coinRecordPath))};`,
    '',
  ].join('\n');
  // Only existing files can be watched (a watched missing file becomes a failed import in the dev server).
  const watch = [localPath, sepoliaPath, ...marketPaths, ...corePaths, setPath, alphaPath, coinRecordPath].filter((path): path is string => path !== null && existsSync(path));
  return { code, watch };
}

export function squareHoleDeployments(env: Env = process.env): Plugin {
  const resolved = `\0${DEPLOYMENTS_MODULE}`;
  let devServer = false;
  return {
    name: 'squarehole-deployments',
    configResolved(config) {
      devServer = config.command === 'serve' && config.mode !== 'test';
    },
    resolveId(source) {
      return source === DEPLOYMENTS_MODULE ? resolved : null;
    },
    load(id) {
      if (id !== resolved) return null;
      const { code, watch } = deploymentsModule({ devServer, env });
      for (const path of watch) this.addWatchFile(path);
      return code;
    },
  };
}

/**
 * The production site's page head (SH-V2-FE6): index.html's title and description say Demo, so a production build
 * gets the generic ones of the link previews (src/share/share-meta.ts): "Square Hole", "Different shapes. Same hole."
 * It also carries the production stamp (src/share/build-stamp.ts), by which the link-preview function knows the site.
 */
export const PRODUCTION_TITLE = 'Square Hole';
export const PRODUCTION_DESCRIPTION = 'Different shapes. Same hole.';

export function productionIndexHtml(html: string): string {
  const titled = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${PRODUCTION_TITLE}</title>`);
  const described = titled.replace(/<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i, () => `<meta name="description" content="${PRODUCTION_DESCRIPTION}" />\n    ${PRODUCTION_STAMP}`);
  if (!described.includes(`<title>${PRODUCTION_TITLE}</title>`) || !described.includes(`content="${PRODUCTION_DESCRIPTION}"`)) {
    throw new Error('index.html needs a <title> and a description meta tag for the production head');
  }
  return described;
}

/** The production head, applied only when `SH_BUILD=production`. */
export function squareHoleProductionHead(env: Env = process.env): Plugin {
  return {
    name: 'squarehole-production-head',
    transformIndexHtml: (html) => (buildModeOf(env) === 'production' ? productionIndexHtml(html) : html),
  };
}
