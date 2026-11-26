/**
 * F156 (SH-ALPHA-TRADE-BOX): which chain a trade runs on, read with the site's own RPC and never the wallet's (the
 * trade calls' integrator request 3: "the chainId from the build target and the site's read RPC ... to both prepare
 * and submit").
 *
 * - The Sepolia test site: chain 11155111, the keyless read RPC its v2 source names, and the trade calls' own pinned
 *   PoolSwapTest (SEPOLIA_TRADE_DEPLOYMENT; a local deployment is never honoured there).
 * - A local development build: chain 31337 only, the alpha setup of SH-ALPHA-REHEARSAL (packages/chain/scripts/
 *   alpha-rehearsal.mjs), whose own manifest names its PoolSwapTest (`localDeployment`). The build embeds that file
 *   when `SH_ALPHA_LOCAL_MANIFEST` names it (deployments-plugin.ts; a production build refuses the variable). The local
 *   twin with Sepolia's chain id gets no trading: it would need the Sepolia pins, which it does not have, and its
 *   signatures would be valid on Sepolia.
 * - SH-258, the BNB Chain testnet site (`SH_TESTNET=bnb`): chain 97, the keyless read RPC its v2 source names, and the
 *   network's own record (packages/chain/src/trade-sepolia/coin-deployment-97.json, embedded as `TESTNET_COIN_RECORD`):
 *   its PoolSwapTest, which must name the deployment's PoolManager, and the release's box registry from the manifest.
 *   Without the record, or while it is not `deployed`, the box says "Trading is not set up on this chain."
 */
import { ALPHA_LOCAL_MANIFEST, TESTNET_COIN_RECORD } from 'virtual:squarehole-deployments';
import { createHttpRequest, type Eip1193Request } from '@squarehole/chain/write';
import type { TradeDeployment } from '@squarehole/chain/trade-sepolia';
import { TESTNET, testnetExplorerHref } from '../data-source/testnet';
import { isAddress, type Address } from 'viem';
import { rolesOfV2, type ReleaseV2 } from '../../../../../packages/chain/src/core/v2';
import { releaseOfRegistry } from '../core/v2/releases';
import type { V2Snapshot, V2Source } from '../core/v2/indexer-v2';

/** The test network's chain (the old name kept, SH-258): 11155111, or 97 under SH_TESTNET=bnb. */
export const SEPOLIA_CHAIN: number = TESTNET.chainId;
/** SH-258: the test network's trade addresses come from its own record (BNB Chain testnet), not from a pin. */
export const RECORD_TESTNET = TESTNET.name !== 'sepolia';
export const ALPHA_LOCAL_CHAIN = 31_337;
export const ALPHA_LOCAL_SCHEMA = 'square-hole-alpha-local/1';

export interface TradeTarget {
  /** The build target's chain: Sepolia on the test site, 31337 for the local alpha. */
  readonly chainId: number;
  /** The site's read RPC as an EIP-1193 request function (the wallet's RPC is never used to prepare or check). */
  readonly rpc: Eip1193Request;
  /** The box's coordinator from the verified registry row the page shows, never typed in. */
  readonly coordinator: Address;
  /** 31337: the alpha setup's PoolSwapTest, manager and runtime hash; BNB Chain testnet: its record's, with the box registry. */
  readonly localDeployment?: TradeDeployment;
  /** A transaction's page on the explorer, or null where there is none (the local chain). */
  readonly explorer: (hash: string) => string | null;
}

export type TradeTargetRead = { readonly ok: true; readonly target: TradeTarget } | { readonly ok: false; readonly reason: string };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * The alpha manifest's `localDeployment` (core-v2-local-manifest.mjs `readAlphaLocalManifest`), checked: its schema, chain
 * 31337, three well-formed values, and the same PoolManager and registry as the deployment the page reads. Null for
 * anything else: no field is guessed.
 */
export function alphaDeploymentOf(input: unknown, source: Pick<V2Source, 'manifest'>): TradeDeployment | null {
  if (typeof input !== 'object' || input === null) return null;
  const manifest = input as { schema?: unknown; chainId?: unknown; registry?: { address?: unknown }; localDeployment?: Record<string, unknown> };
  const local = manifest.localDeployment;
  if (manifest.schema !== ALPHA_LOCAL_SCHEMA || manifest.chainId !== ALPHA_LOCAL_CHAIN || typeof local !== 'object' || local === null) return null;
  const { poolSwapTest, poolManager, poolSwapTestCodeHash } = local;
  if (typeof poolSwapTest !== 'string' || !isAddress(poolSwapTest) || typeof poolManager !== 'string' || !isAddress(poolManager)
    || typeof poolSwapTestCodeHash !== 'string' || !HASH.test(poolSwapTestCodeHash)) return null;
  if (!same(poolManager, source.manifest.chain.poolManager.address)) return null;
  const registry = manifest.registry?.address;
  if (typeof registry !== 'string' || !source.manifest.releases.some((release) => same(release.registry.address, registry))) return null;
  return Object.freeze({ poolSwapTest: poolSwapTest as Address, poolManager: poolManager as Address, poolSwapTestCodeHash: poolSwapTestCodeHash as `0x${string}` });
}

/**
 * SH-258: the test network's record (`coin-deployment-97.json`) as the trade calls' deployment: deployed, for this
 * chain, three well-formed values, the same PoolManager as the deployment the page reads, and the release's box
 * registry from the verified manifest (the page's box comes from one of its releases). Null for anything else.
 */
export function testnetDeploymentOf(input: unknown, source: Pick<V2Source, 'manifest'>, boxRelease: Pick<ReleaseV2, 'registry'>): TradeDeployment | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  const { chainId, status, poolSwapTest, poolManager, poolSwapTestCodeHash } = record;
  if (chainId !== SEPOLIA_CHAIN || status !== 'deployed') return null;
  if (typeof poolSwapTest !== 'string' || !isAddress(poolSwapTest) || typeof poolManager !== 'string' || !isAddress(poolManager)
    || typeof poolSwapTestCodeHash !== 'string' || !HASH.test(poolSwapTestCodeHash)) return null;
  if (!same(poolManager, source.manifest.chain.poolManager.address)) return null;
  // SH-300: the registry of the box's own release (a deployment may list two), and only one this manifest lists.
  const release = releaseOfRegistry(source.manifest, boxRelease.registry.address);
  if (!release) return null;
  return Object.freeze({ poolSwapTest: poolSwapTest as Address, poolManager: poolManager as Address, poolSwapTestCodeHash: poolSwapTestCodeHash as `0x${string}`,
    boxRegistry: release.registry.address });
}

/**
 * Where this box trades, or why it does not. `alpha` is the build's alpha manifest (tests pass their own);
 * `request` makes the RPC function (tests answer it themselves).
 */
export function tradeTargetOf(source: V2Source, view: Pick<V2Snapshot, 'record'> & { readonly release: Pick<ReleaseV2, 'registry'> }, alpha: unknown = ALPHA_LOCAL_MANIFEST,
  request: (url: string) => Eip1193Request = createHttpRequest, testnetRecord: unknown = TESTNET_COIN_RECORD): TradeTargetRead {
  const chainId = source.network === 'sepolia' ? SEPOLIA_CHAIN : ALPHA_LOCAL_CHAIN;
  if (source.manifest.chainId !== chainId) return { ok: false, reason: 'chain_not_allowed' };
  const coordinator = rolesOfV2(view.record).contracts.coordinator;
  if (!coordinator) return { ok: false, reason: 'invalid_box_wiring' };
  let rpc: Eip1193Request;
  try { rpc = request(source.rpc); } catch { return { ok: false, reason: 'rpc_failed' }; }
  if (chainId === SEPOLIA_CHAIN && !RECORD_TESTNET) {
    return { ok: true, target: { chainId, rpc, coordinator, explorer: (hash) => testnetExplorerHref({ chainId, txHash: hash }) } };
  }
  if (chainId === SEPOLIA_CHAIN) {
    const deployment = testnetDeploymentOf(testnetRecord, source, view.release);
    if (!deployment) return { ok: false, reason: 'deployment_required' };
    return { ok: true, target: { chainId, rpc, coordinator, localDeployment: deployment, explorer: (hash) => testnetExplorerHref({ chainId, txHash: hash }) } };
  }
  const localDeployment = alphaDeploymentOf(alpha, source);
  if (!localDeployment) return { ok: false, reason: 'deployment_required' };
  return { ok: true, target: { chainId, rpc, coordinator, localDeployment, explorer: () => null } };
}
