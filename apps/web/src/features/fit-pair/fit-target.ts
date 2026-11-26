/**
 * Which FIT market the pair page shows (v2 T19). One target per data source:
 * - demo: `DEMO_FIT_TARGET`, invented addresses on the local demo chain 31337, fed by the Demo stream (demo-live.ts);
 *   labelled "Demo" everywhere and never linked out (EXT-08);
 * - local / Sepolia: the build's market record for that chain (`squarehole.fit-market/v1`; deployments-plugin.ts embeds
 *   the files `SH_FIT_MARKET` names, or in the dev server the committed records in apps/web/fit-markets/, today the
 *   full v2 deployment on Sepolia; a plain `vite build` embeds none); otherwise an honest "not configured" / "not
 *   deployed" state.
 *
 * The record is untrusted build input until `parseFitMarket` accepts it: exact addresses, a pool id that is the id of
 * this token's own pool key (native ETH, the token, 1%, spacing 60, the hook), decimal block numbers, a known curve
 * shape, neutral names if it has any (market-names.ts) and then a neutral label too, and an indexer origin that is a
 * bare http(s) origin (no credentials, path, query or fragment; http only for the local chain or a loopback address).
 * No mainnet target exists in this build (G08).
 */
import { keccak256Hex } from '@squarehole/artwork';
import { checkRpcUrl, SEPOLIA_PUBLIC_RPC_URLS } from '@squarehole/chain';
import { isAddress, type Address } from '@squarehole/domain';
import { getSqrtPriceAtTick, MISFITS_CURVE, MISFITS_LAUNCH_SHAPE, REHEARSAL_CURVE, type CurveShape } from '@squarehole/indexer/client';
import type { DataSourceId } from '../data-source';
import { LAUNCH_HINTS, LAUNCH_NAMES, parseMarketNames, type FitMarketNames } from './market-names';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export const FIT_MARKET_SCHEMA = 'squarehole.fit-market/v1';
/** FitPoolHook.WINDOW_BLOCKS: the launch window after the announced open. */
export const WINDOW_BLOCKS = 32n;
/** FitLaunchShape.LATCH_BLOCKS: graduation is possible this many blocks after the completion. */
export const LATCH_BLOCKS = 32n;
/** "Confirmed" = at least this many blocks deep counting the block itself (the indexer's default). */
export const DEFAULT_CONFIRMATIONS = 2;
/**
 * The Misfits edition of the Demo market: 4,269, the last 69 an Icons series (F49 E8, 2026-10-01; F35 planned 4,200).
 * A chain market's N always comes from its record and its vault, never from here.
 */
export const MISFITS_EDITION = 4_269n;
/** FIT is issued once: 1,000,000,000 with 18 decimals (F24 a). */
export const FIT_ISSUANCE_RAW = 10n ** 27n;

export type Hex32 = `0x${string}`;

/** FitLaunchShape.EPS_TICKS: graduation runs while the price is at most this many ticks back inside the curve (≈ 0.1%). */
export const GRADUATION_BAND_TICKS = 10;

/** √P at the band's edge (FitLaunchShape.SQRT_PRICE_BAND_X96 on the Misfits curve): `graduate()` needs √P ≤ this. */
export function graduationBandSqrtX96(curve: Pick<CurveShape, 'tickLower'>): bigint {
  return getSqrtPriceAtTick(curve.tickLower + GRADUATION_BAND_TICKS);
}

const word = (hex: string): string => hex.toLowerCase().replace(/^0x/, '').padStart(64, '0');

/**
 * The Uniswap v4 pool id of FIT's pool: keccak256(abi.encode(PoolKey)) with native ETH as currency0, FIT as currency1,
 * the static 1% fee, tick spacing 60 and the hook (FitPoolHook `_key`, FitLaunchShape.LP_FEE / TICK_SPACING). Both
 * are positive, so every word is a plain left-padded value. Lowercase hex.
 */
export function fitPoolId(token: string, hook: string): Hex32 {
  if (!isAddress(token) || !isAddress(hook)) throw new FitMarketError('The pool key needs two 20-byte addresses');
  const encoded = [
    word('0x0'),
    word(token),
    word(MISFITS_LAUNCH_SHAPE.lpFeePips.toString(16)),
    word(MISFITS_LAUNCH_SHAPE.tickSpacing.toString(16)),
    word(hook),
  ].join('');
  const bytes = new Uint8Array(encoded.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(encoded.slice(i * 2, i * 2 + 2), 16);
  return keccak256Hex(bytes);
}

export interface FitMarketTarget {
  readonly kind: 'demo' | 'chain';
  readonly chainId: number;
  /** "Local chain 31337", "Sepolia testnet". */
  readonly networkLabel: string;
  /** Where the record came from, shown on the page. */
  readonly label: string;
  /** The launch's names, or the neutral set a rehearsal was deployed with (market-names.ts). */
  readonly names: FitMarketNames;
  /** The token (FIT, or a rehearsal's): the contract address people copy. */
  readonly token: Address;
  readonly poolId: Hex32;
  readonly poolManager: Address;
  readonly hook: Address;
  readonly launchRouter: Address | null;
  readonly vault: Address | null;
  readonly placeholders: Address | null;
  readonly collection: Address | null;
  /** The rest of the deployment, listed with the addresses when the record names them. */
  readonly genesis: Address | null;
  readonly collector: Address | null;
  readonly executor: Address | null;
  readonly randomnessSource: Address | null;
  readonly deployBlock: bigint;
  readonly openBlock: bigint;
  /** openBlock + 32: the first block every route can buy in. */
  readonly closeBlock: bigint;
  readonly collectionSize: bigint;
  readonly curve: CurveShape;
  readonly curveName: 'misfits' | 'rehearsal';
  /** The live indexer's gateway origin, or null (then the page reads the chain directly). */
  readonly indexerOrigin: string | null;
  /** The RPC the direct reads use, or null (the demo). */
  readonly rpcUrl: string | null;
}

export class FitMarketError extends Error {
  override readonly name = 'FitMarketError';
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^(0|[1-9][0-9]{0,30})$/;

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new FitMarketError(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function address(value: unknown, what: string): Address {
  if (typeof value !== 'string' || !isAddress(value)) throw new FitMarketError(`${what} must be a 0x-prefixed 20-byte address`);
  return value as Address;
}

function optionalAddress(value: unknown, what: string): Address | null {
  return value === null || value === undefined ? null : address(value, what);
}

function uint(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !UINT.test(value)) throw new FitMarketError(`${what} must be a decimal integer string`);
  return BigInt(value);
}

// The production site takes https indexers only (deployments-plugin.ts refuses any other origin for it as well).
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(DEMO_BUILD ? ['127.0.0.1', 'localhost', '[::1]'] : []);

/**
 * A bare http(s) origin, as the gateway's endpoints hang off it. https off the local chain, except a loopback address
 * (an indexer the person runs on this machine, `pnpm --filter @squarehole/indexer start`).
 */
export function indexerOrigin(value: unknown, chainId: number): string {
  if (typeof value !== 'string') throw new FitMarketError('indexer.origin must be a string');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FitMarketError('indexer.origin must be an absolute URL');
  }
  const local = DEMO_BUILD && (chainId === 31_337 || LOOPBACK_HOSTS.has(url.hostname));
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new FitMarketError(DEMO_BUILD ? 'indexer.origin must be https (http only on the local chain or a loopback address)' : 'indexer.origin must be https');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new FitMarketError('indexer.origin must be a bare origin without credentials, path, query or fragment');
  }
  return url.origin;
}

const NETWORK_LABELS: ReadonlyMap<number, string> = new Map([
  [31_337, 'Local chain 31337'],
  [11_155_111, 'Sepolia testnet'],
]);

/** The fallback labels: a neutral market's must not name the launch either ("FIT market record" would). */
export const LAUNCH_MARKET_FALLBACK_LABEL = 'FIT market record';
export const NEUTRAL_MARKET_FALLBACK_LABEL = 'Market record';

/**
 * The record's label as the page prints it under the contracts: plain text of at most 120 characters (no markup, no
 * controls), and for a market with neutral names also neutral (no launch hint, market-names.ts), like the names. A
 * label that fails is replaced by the fallback, never shown.
 */
function marketLabel(value: unknown, names: FitMarketNames): string {
  const neutral = names.kind === 'neutral';
  // eslint-disable-next-line no-control-regex
  const plain = typeof value === 'string' && value.length > 0 && value.length <= 120 && !/[\u0000-\u001f\u007f<>]/u.test(value);
  if (!plain) return neutral ? NEUTRAL_MARKET_FALLBACK_LABEL : LAUNCH_MARKET_FALLBACK_LABEL;
  return neutral && LAUNCH_HINTS.test(value) ? NEUTRAL_MARKET_FALLBACK_LABEL : value;
}

/** Parses a `squarehole.fit-market/v1` record. Throws `FitMarketError` naming the first problem. */
export function parseFitMarket(input: unknown, rpcUrl: string | null): FitMarketTarget {
  const value = record(input, 'The FIT market record');
  if (value.schema !== FIT_MARKET_SCHEMA) throw new FitMarketError(`schema must be ${FIT_MARKET_SCHEMA}`);
  const chainId = value.chainId;
  if (typeof chainId !== 'number' || !NETWORK_LABELS.has(chainId)) throw new FitMarketError('chainId must be 31337 or 11155111 (no mainnet target in this build)');
  const contracts = record(value.contracts, 'contracts');
  if (typeof value.poolId !== 'string' || !HEX32.test(value.poolId)) throw new FitMarketError('poolId must be a 32-byte hex value');
  const token = address(contracts.token, 'contracts.token');
  const hook = address(contracts.hook, 'contracts.hook');
  const poolId = value.poolId.toLowerCase() as Hex32;
  // The DEX Screener link, the indexer's URLs and the direct read all key on the pool id, the header on FIT: they must
  // name the same pool.
  if (poolId !== fitPoolId(token, hook)) throw new FitMarketError('poolId is not the id of the pool key of this FIT and hook (native ETH, 1%, spacing 60)');
  const openBlock = uint(value.openBlock, 'openBlock');
  const deployBlock = uint(value.deployBlock, 'deployBlock');
  if (deployBlock > openBlock) throw new FitMarketError('deployBlock must not be after openBlock');
  const curveName = value.curve;
  if (curveName !== 'misfits' && curveName !== 'rehearsal') throw new FitMarketError('curve must be "misfits" or "rehearsal"');
  const collectionSize = uint(value.collectionSize, 'collectionSize');
  if (collectionSize < 1n) throw new FitMarketError('collectionSize must be positive');
  const names = parseMarketNames(value.names, (message) => new FitMarketError(message));
  const indexer = value.indexer === null || value.indexer === undefined ? null : record(value.indexer, 'indexer');
  return Object.freeze({
    kind: 'chain',
    chainId,
    networkLabel: NETWORK_LABELS.get(chainId) ?? `Chain ${chainId}`,
    label: marketLabel(value.label, names),
    names,
    token,
    poolId,
    poolManager: address(contracts.poolManager, 'contracts.poolManager'),
    hook,
    launchRouter: optionalAddress(contracts.launchRouter, 'contracts.launchRouter'),
    vault: optionalAddress(contracts.vault, 'contracts.vault'),
    placeholders: optionalAddress(contracts.placeholders, 'contracts.placeholders'),
    collection: optionalAddress(contracts.collection, 'contracts.collection'),
    genesis: optionalAddress(contracts.genesis, 'contracts.genesis'),
    collector: optionalAddress(contracts.collector, 'contracts.collector'),
    executor: optionalAddress(contracts.executor, 'contracts.executor'),
    randomnessSource: optionalAddress(contracts.randomnessSource, 'contracts.randomnessSource'),
    deployBlock,
    openBlock,
    closeBlock: openBlock + WINDOW_BLOCKS,
    collectionSize,
    curve: curveName === 'misfits' ? MISFITS_CURVE : REHEARSAL_CURVE,
    curveName,
    indexerOrigin: indexer === null ? null : indexerOrigin(indexer.origin, chainId),
    rpcUrl,
  });
}

/**
 * The Demo target: invented addresses on the local demo chain (D07). Nothing here is deployed; the page labels it
 * "Demo" and builds no link from it.
 */
const DEMO_TOKEN = '0x000000000000000000000000000000000000f17e' as Address;
const DEMO_HOOK = '0x0000000000000000000000000000000000002ae0' as Address;

export const DEMO_FIT_TARGET: FitMarketTarget = /* @__PURE__ */ Object.freeze({
  kind: 'demo',
  chainId: 31_337,
  networkLabel: 'Local chain 31337',
  label: 'Trades on the Misfits curve, computed with the exact pool math',
  names: LAUNCH_NAMES,
  token: DEMO_TOKEN,
  // The id of the invented pool key, so the Demo follows the same rule as a real record.
  poolId: /* @__PURE__ */ fitPoolId(DEMO_TOKEN, DEMO_HOOK),
  poolManager: '0x0000000000000000000000000000000000004444' as Address,
  hook: DEMO_HOOK,
  launchRouter: '0x00000000000000000000000000000000000007a0' as Address,
  vault: '0x0000000000000000000000000000000000000b0c' as Address,
  placeholders: '0x0000000000000000000000000000000000000b0d' as Address,
  collection: '0x0000000000000000000000000000000000001068' as Address,
  genesis: null,
  collector: null,
  executor: null,
  randomnessSource: null,
  deployBlock: 21_000_000n,
  openBlock: 21_000_300n,
  closeBlock: 21_000_300n + WINDOW_BLOCKS,
  collectionSize: MISFITS_EDITION,
  curve: MISFITS_CURVE,
  curveName: 'misfits',
  indexerOrigin: null,
  rpcUrl: null,
});

export type FitTargetResolution =
  | { readonly status: 'ready'; readonly target: FitMarketTarget }
  | { readonly status: 'not_configured' | 'invalid'; readonly reason: string };

export const FIT_NOT_CONFIGURED_LOCAL = DEMO_BUILD
  ? 'No FIT market in this build for the local chain. A local build names one with SH_FIT_MARKET (a squarehole.fit-market/v1 record); the v2 genesis is not deployed by this app.'
  : '';
export const FIT_NOT_DEPLOYED_SEPOLIA = DEMO_BUILD
  ? 'This build carries no market record for Sepolia: a build names one with SH_FIT_MARKET (the dev server embeds apps/web/fit-markets/). The 2026-09-30 route rehearsal has none and is not shown here.'
  : 'No market record for Sepolia in this build.';

export interface FitBuild {
  /** Every market record the build embeds (vite.config.ts), at most one per chain. */
  readonly fitMarkets: readonly unknown[];
  readonly localRpcUrl: string;
}

/**
 * The RPC a Sepolia record's direct reads use: the first of the chain package's keyless public list, checked by the
 * chain package's own rule (https, no credentials, query or fragment).
 */
function sepoliaRpcUrl(): string {
  const [first] = SEPOLIA_PUBLIC_RPC_URLS;
  if (first === undefined) throw new FitMarketError('The chain package lists no Sepolia RPC');
  return checkRpcUrl(11_155_111, first);
}

const declaredChain = (value: unknown): unknown => (typeof value === 'object' && value !== null ? (value as { chainId?: unknown }).chainId : undefined);

/** The build's record for `chainId`, null when there is none; throws `FitMarketError` when there are two. */
export function marketRecordFor(records: readonly unknown[], chainId: number): unknown {
  const matching = records.filter((value) => declaredChain(value) === chainId);
  if (matching.length > 1) throw new FitMarketError(`the build carries ${matching.length} market records for chain ${chainId}; keep one`);
  return matching[0] ?? null;
}

/** The target for a data source, or why there is none. Never throws. */
export function resolveFitTarget(source: DataSourceId, build: FitBuild): FitTargetResolution {
  if (DEMO_BUILD && source === 'demo') return { status: 'ready', target: DEMO_FIT_TARGET };
  const local = DEMO_BUILD && source === 'local';
  const chainId = local ? 31_337 : 11_155_111;
  const none = local ? FIT_NOT_CONFIGURED_LOCAL : FIT_NOT_DEPLOYED_SEPOLIA;
  try {
    const record = marketRecordFor(build.fitMarkets, chainId);
    if (record === null) return { status: 'not_configured', reason: none };
    return { status: 'ready', target: parseFitMarket(record, local ? build.localRpcUrl : sepoliaRpcUrl()) };
  } catch (error) {
    return { status: 'invalid', reason: `The market record in this build is invalid: ${error instanceof Error ? error.message : 'unknown problem'}.` };
  }
}
