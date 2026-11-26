/**
 * F156 (SH-ALPHA-TEST-COINS, work package G phase 2): where the test-coin page reads and sends, read with the site's
 * own RPC and never the wallet's (the coin calls' integrator request 2: "the build-target chain and the site's read RPC
 * supplied separately from the wallet").
 *
 * - The Sepolia test site: chain 11155111, the keyless read RPC its v2 source names, and the coin calls' own pinned
 *   record (`SEPOLIA_COIN_DEPLOYMENT`). Until the founder deploys and seeds the coins it holds predicted addresses and
 *   says so (`status: 'predicted'`); the page then shows one line and reads nothing.
 * - A local development build: chain 31337 only, the alpha setup's own manifest (`coinDeployment`, embedded with
 *   `SH_ALPHA_LOCAL_MANIFEST` as for the trade box, trade-target.ts). The local twin with Sepolia's chain id gets nothing.
 *
 * The pairs come from the record, never from this file: the founder may seed two pools or four.
 */
import { ALPHA_LOCAL_MANIFEST, TESTNET_COIN_RECORD } from 'virtual:squarehole-deployments';
import { SEPOLIA_COIN_DEPLOYMENT } from '@squarehole/chain/trade-sepolia';
import { createHttpRequest, type Eip1193Request } from '@squarehole/chain/write';
import { testnetExplorerHref } from '../data-source/testnet';
import { isAddress, zeroAddress, type Address } from 'viem';
import type { V2Source } from '../core/v2/indexer-v2';
import { ALPHA_LOCAL_CHAIN, ALPHA_LOCAL_SCHEMA, RECORD_TESTNET, SEPOLIA_CHAIN } from './trade-target';

/** A coin the page shows: its address, its symbol and its decimals, as the record names them. */
export interface CoinView {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
}

export interface CoinTarget {
  readonly chainId: number;
  /** The site's read RPC as an EIP-1193 request function (the wallet's RPC is never used to prepare or check). */
  readonly rpc: Eip1193Request;
  /** 31337 only: the alpha manifest's `coinDeployment`, which the coin calls check and take as `localDeployment`. */
  readonly localDeployment?: unknown;
  /** tETH, the faucet's coin and one side of every pair. */
  readonly teth: CoinView;
  /** The coins paired with tETH, in the record's order. */
  readonly pairs: readonly CoinView[];
  readonly explorer: (hash: string) => string | null;
}

export type CoinTargetRead = { readonly ok: true; readonly target: CoinTarget } | { readonly ok: false; readonly reason: string };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const addressOf = (value: unknown): Address | null => (typeof value === 'string' && isAddress(value) && !same(value, zeroAddress) ? value as Address : null);

/**
 * The coins a record names, for showing: tETH and each pair's coin with its symbol and decimals. Null when a field is
 * missing or malformed (the coin calls parse the record strictly again on every read and plan).
 */
export function coinsOf(record: unknown): { readonly teth: CoinView; readonly pairs: readonly CoinView[] } | null {
  if (typeof record !== 'object' || record === null) return null;
  const { teth, pairs } = record as { teth?: { address?: unknown }; pairs?: unknown };
  const tethAddress = addressOf(teth?.address);
  if (!tethAddress || !Array.isArray(pairs)) return null;
  const shown: CoinView[] = [];
  for (const pair of pairs as unknown[]) {
    const { coin, symbol, decimals } = (typeof pair === 'object' && pair !== null ? pair : {}) as { coin?: unknown; symbol?: unknown; decimals?: unknown };
    const address = addressOf(coin);
    if (!address || typeof symbol !== 'string' || symbol.length === 0 || typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
    shown.push(Object.freeze({ address, symbol, decimals }));
  }
  return Object.freeze({ teth: Object.freeze({ address: tethAddress, symbol: 'tETH', decimals: 18 }), pairs: Object.freeze(shown) });
}

/**
 * The coin at `address` in a record (tETH or a pair's coin), for naming what a plan approved; null when the record does
 * not name it. A plan's own record (`plan.deployment`) names its coins, so any page can say what it revokes.
 */
export function coinOfRecord(record: unknown, address: string): CoinView | null {
  const coins = coinsOf(record);
  if (!coins) return null;
  return [coins.teth, ...coins.pairs].find((coin) => same(coin.address, address)) ?? null;
}

/** What a coin plan spends, by its own record: a pair swap's input coin (its revocation names it); null for the drip. */
const spentCoinOf = (plan: { readonly deployment: unknown; readonly revoke: { readonly to: string } | null }): CoinView | null =>
  (plan.revoke ? coinOfRecord(plan.deployment, plan.revoke.to) : null);

/** "Revoke 0.25 tETH" for what a coin plan left approved, or "Revoke approval" without a figure or a known coin. */
export function coinRevokeLabel(plan: { readonly deployment: unknown; readonly revoke: { readonly to: string } | null }, left: bigint | null, format: (raw: bigint, decimals: number) => string): string {
  const coin = spentCoinOf(plan);
  return left === null || !coin ? 'Revoke approval' : `Revoke ${format(left, coin.decimals)} ${coin.symbol}`;
}

/** How any page shows an amount of what a coin plan spends (a mined swap's fill), in the coin its record names. */
export function coinAmountOf(plan: { readonly deployment: unknown; readonly revoke: { readonly to: string } | null }, format: (raw: bigint, decimals: number) => string) {
  const coin = spentCoinOf(plan);
  return coin ? { unit: coin.symbol, show: (raw: bigint) => format(raw, coin.decimals) } : null;
}

/**
 * The alpha manifest's `coinDeployment` (core-v2-local-manifest.mjs `readAlphaLocalManifest`), when it is the alpha's:
 * its schema and chain, a deployed record on 31337 and the same PoolManager as the deployment the page reads.
 */
export function alphaCoinRecordOf(input: unknown, source: Pick<V2Source, 'manifest'>): unknown {
  if (typeof input !== 'object' || input === null) return null;
  const manifest = input as { schema?: unknown; chainId?: unknown; coinDeployment?: Record<string, unknown> };
  const record = manifest.coinDeployment;
  if (manifest.schema !== ALPHA_LOCAL_SCHEMA || manifest.chainId !== ALPHA_LOCAL_CHAIN || typeof record !== 'object' || record === null) return null;
  if (record.chainId !== ALPHA_LOCAL_CHAIN || record.status !== 'deployed') return null;
  const manager = addressOf(record.poolManager);
  if (!manager || !same(manager, source.manifest.chain.poolManager.address)) return null;
  return record;
}

/**
 * SH-258: BNB Chain testnet's coin record when it can be used: deployed, for this chain, and the same PoolManager as the
 * deployment the page reads (the coin calls parse it strictly again). Null for anything else.
 */
export function testnetCoinRecordOf(input: unknown, source: Pick<V2Source, 'manifest'>): unknown {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  if (record.chainId !== SEPOLIA_CHAIN || record.status !== 'deployed') return null;
  const manager = addressOf(record.poolManager);
  return manager && same(manager, source.manifest.chain.poolManager.address) ? record : null;
}

/**
 * Where the test coins are, or why the page has none. `alpha` is the build's alpha manifest (tests pass their own);
 * `request` makes the RPC function (tests answer it themselves).
 */
export function coinTargetOf(source: V2Source | null, alpha: unknown = ALPHA_LOCAL_MANIFEST,
  request: (url: string) => Eip1193Request = createHttpRequest, testnetRecord: unknown = TESTNET_COIN_RECORD): CoinTargetRead {
  // SH-258: without a deployed record the coins are not live, whether or not the chain can be read here.
  if (RECORD_TESTNET && (typeof testnetRecord !== 'object' || testnetRecord === null || (testnetRecord as { status?: unknown }).status !== 'deployed')) {
    return { ok: false, reason: 'deployment_predicted' };
  }
  if (!source) return { ok: false, reason: 'source_unavailable' };
  const chainId = source.network === 'sepolia' ? SEPOLIA_CHAIN : ALPHA_LOCAL_CHAIN;
  if (source.manifest.chainId !== chainId) return { ok: false, reason: 'chain_not_allowed' };
  // SH-258: BNB Chain testnet's coins are its own record's; until it is deployed the page says the coins are not live
  // yet, as Sepolia's said while its record held predicted addresses.
  if (chainId === SEPOLIA_CHAIN && RECORD_TESTNET) {
    const record = testnetCoinRecordOf(testnetRecord, source);
    if (!record) return { ok: false, reason: 'deployment_predicted' };
    const coins = coinsOf(record);
    if (!coins) return { ok: false, reason: 'invalid_deployment' };
    let rpc: Eip1193Request;
    try { rpc = request(source.rpc); } catch { return { ok: false, reason: 'rpc_failed' }; }
    return { ok: true, target: { chainId, rpc, localDeployment: record, ...coins, explorer: (hash) => testnetExplorerHref({ chainId, txHash: hash }) } };
  }
  if (chainId === SEPOLIA_CHAIN && SEPOLIA_COIN_DEPLOYMENT.status !== 'deployed') return { ok: false, reason: 'deployment_predicted' };
  const record = chainId === SEPOLIA_CHAIN ? SEPOLIA_COIN_DEPLOYMENT : alphaCoinRecordOf(alpha, source);
  if (!record) return { ok: false, reason: 'deployment_required' };
  const coins = coinsOf(record);
  if (!coins) return { ok: false, reason: 'invalid_deployment' };
  let rpc: Eip1193Request;
  try { rpc = request(source.rpc); } catch { return { ok: false, reason: 'rpc_failed' }; }
  if (chainId === SEPOLIA_CHAIN) {
    return { ok: true, target: { chainId, rpc, ...coins, explorer: (hash) => testnetExplorerHref({ chainId, txHash: hash }) } };
  }
  return { ok: true, target: { chainId, rpc, localDeployment: record, ...coins, explorer: () => null } };
}
