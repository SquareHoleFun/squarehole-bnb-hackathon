/**
 * Typed per-chain configuration (ADR-0012): which RPCs to read, which deployment manifest names the Square Hole
 * contracts, where the canonical Uniswap v4 contracts are, and the read policies (snapshot block tag, staleness,
 * log range bounds). Built from `packages/contracts/deployments/<chainId>.json`; a chain without a manifest is
 * `not_deployed` (honest state, no providers).
 */
import type { Address } from 'viem';
import { ChainConfigError } from '../errors';
import {
  BNB_TESTNET_CHAIN_ID,
  DEFAULT_LOCAL_RPC_URL,
  LOCAL_CHAIN_ID,
  SEPOLIA_TESTNET_CHAIN_ID,
  TESTNET,
  TESTNET_CHAIN_ID,
  isSupportedChainId,
  type SupportedChainId,
} from './chains';
import { parseDeploymentManifest, type DeploymentManifest } from './manifest';

export type BlockTagPolicy = 'latest' | 'safe' | 'finalized';

export type ChainDeployment =
  | { readonly status: 'deployed'; readonly manifest: DeploymentManifest }
  | { readonly status: 'not_deployed'; readonly reason: string };

export interface UniswapV4Addresses {
  readonly poolManager: Address;
  /** Canonical StateView; null where none exists (local anvil unless the caller deployed one). */
  readonly stateView: Address | null;
  /** Canonical V4Quoter; null where none exists (local anvil unless the caller deployed one). */
  readonly v4Quoter: Address | null;
}

export interface LogRangePolicy {
  /** First getLogs span in blocks; halves on provider limits, grows back after successes. */
  readonly initialRange: number;
  readonly maxRange: number;
  readonly minRange: number;
}

export interface ChainConfig {
  readonly chainId: SupportedChainId;
  readonly label: string;
  readonly kind: 'local' | 'testnet';
  readonly rpcUrls: readonly string[];
  readonly deployment: ChainDeployment;
  /**
   * Present when deployed. On a test network with canonical Uniswap v4 contracts (Sepolia) always those; elsewhere
   * (BNB Chain testnet, the local chain) the manifest's PoolManager.
   */
  readonly uniswap: UniswapV4Addresses | null;
  readonly multicall3: Address | null;
  readonly explorers: readonly { readonly id: string; readonly name: string; readonly origin: string }[];
  /** Block the feed snapshot (state reads AND derived metrics) is taken at: one consistent block per snapshot. */
  readonly snapshotTag: BlockTagPolicy;
  /** Account reads (positions, claims, quotes) use the newest block: claims must reflect the latest settlement. */
  readonly accountTag: 'latest';
  /** A snapshot whose block is older than this (wall clock) is `stale`; null = never (anvil mines on demand). */
  readonly staleAfterMs: number | null;
  readonly logs: LogRangePolicy;
  readonly requestTimeoutMs: number;
  /** Manifest launch key of the pinned platform item (F09: FIT). Identity comes from the manifest address. */
  readonly platformLaunchKey: string;
}

export interface ChainConfigInput {
  readonly chainId: number;
  /** Parsed JSON of deployments/<chainId>.json, or null/undefined when the file does not exist. */
  readonly manifest?: unknown;
  /** Replaces the default RPC list (the test network: its keyless public list; local: anvil default URL). */
  readonly rpcUrls?: readonly string[];
  /** Local chain only: addresses of a StateView / V4Quoter the caller deployed (e.g. the integration suite). */
  readonly localLens?: { readonly stateView?: Address | null; readonly v4Quoter?: Address | null };
  readonly snapshotTag?: BlockTagPolicy;
  readonly staleAfterMs?: number | null;
  readonly logs?: Partial<LogRangePolicy>;
  readonly requestTimeoutMs?: number;
}

const NOT_DEPLOYED_REASON: Readonly<Record<SupportedChainId, string>> = {
  [LOCAL_CHAIN_ID]:
    'No local deployment manifest: run packages/contracts/scripts/local-e2e.sh (it writes deployments/31337.json) and point the app at that anvil.',
  [SEPOLIA_TESTNET_CHAIN_ID]:
    'Square Hole’s pair registry is not deployed on Sepolia: packages/contracts/deployments/11155111.json does not exist. The v2 rehearsal has no pair registry; its market, when a build carries it, is on its own page.',
  [BNB_TESTNET_CHAIN_ID]: 'Square Hole’s pair registry is not deployed on BNB Chain Testnet: packages/contracts/deployments/97.json does not exist.',
};

/**
 * Keyless http(s) URLs only: no credentials, no query string (a key in a URL would ship in the bundle); https only on
 * the test network. Exported for other readers of these RPCs (the app's FIT pair page); throws `ChainConfigError`.
 */
export function checkRpcUrl(chainId: SupportedChainId, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ChainConfigError('invalid_rpc_url', 'RPC URL is not an absolute URL');
  }
  const httpsOnly = chainId !== LOCAL_CHAIN_ID;
  if (url.protocol !== 'https:' && (httpsOnly || url.protocol !== 'http:')) {
    throw new ChainConfigError('invalid_rpc_url', httpsOnly ? `${TESTNET.networkName} RPC URLs must use https` : 'RPC URLs must use http or https');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new ChainConfigError('invalid_rpc_url', 'RPC URLs must not carry credentials, query strings or fragments');
  }
  return value;
}

export function createChainConfig(input: ChainConfigInput): ChainConfig {
  const { chainId } = input;
  if (!isSupportedChainId(chainId)) {
    throw new ChainConfigError('unsupported_chain', `Chain ${String(chainId)} is not supported (only 31337 and ${TESTNET_CHAIN_ID}; no mainnet)`);
  }
  // The test-network slot (named `sepolia` in the code); its values come from the build's profile (SH-258).
  const sepolia = chainId === TESTNET_CHAIN_ID;
  const rpcUrls = (input.rpcUrls ?? (sepolia ? TESTNET.publicRpcUrls : [DEFAULT_LOCAL_RPC_URL])).map((url) => checkRpcUrl(chainId, url));
  if (rpcUrls.length === 0) throw new ChainConfigError('no_rpc_url', 'At least one RPC URL is required');

  let deployment: ChainDeployment;
  if (input.manifest === undefined || input.manifest === null) {
    deployment = { status: 'not_deployed', reason: NOT_DEPLOYED_REASON[chainId] };
  } else {
    const manifest = parseDeploymentManifest(input.manifest);
    if (manifest.chainId !== chainId) {
      throw new ChainConfigError('manifest_chain_mismatch', `The manifest is for chain ${manifest.chainId}, not ${chainId}`);
    }
    // The profile's PoolManager: the canonical one where the network has one (Sepolia); else the manifest's own.
    const canonical = sepolia ? TESTNET.uniswap : null;
    if (canonical && manifest.contracts.poolManager.address.toLowerCase() !== canonical.poolManager.toLowerCase()) {
      throw new ChainConfigError('non_canonical_pool_manager', `A ${TESTNET.networkName} manifest must use the canonical Uniswap v4 PoolManager`);
    }
    deployment = { status: 'deployed', manifest };
  }

  const uniswap: UniswapV4Addresses | null =
    deployment.status !== 'deployed'
      ? null
      : sepolia && TESTNET.uniswap
        ? TESTNET.uniswap
        : {
            poolManager: deployment.manifest.contracts.poolManager.address,
            stateView: input.localLens?.stateView ?? null,
            v4Quoter: input.localLens?.v4Quoter ?? null,
          };

  const logs: LogRangePolicy = {
    initialRange: input.logs?.initialRange ?? (sepolia ? TESTNET.logs.initialRange : 10_000),
    maxRange: input.logs?.maxRange ?? (sepolia ? TESTNET.logs.maxRange : 100_000),
    minRange: input.logs?.minRange ?? 1,
  };
  if (!(logs.minRange >= 1 && logs.minRange <= logs.initialRange && logs.initialRange <= logs.maxRange)) {
    throw new ChainConfigError('invalid_manifest', 'log range policy must satisfy 1 <= min <= initial <= max');
  }

  return Object.freeze({
    chainId,
    label: sepolia ? TESTNET.dataLabel : 'Local anvil chain (31337)',
    kind: sepolia ? 'testnet' : 'local',
    rpcUrls: Object.freeze([...rpcUrls]),
    deployment,
    uniswap,
    multicall3: sepolia ? TESTNET.multicall3 : null,
    explorers: sepolia ? TESTNET.explorers : Object.freeze([]),
    snapshotTag: input.snapshotTag ?? (sepolia ? TESTNET.snapshotTag : 'latest'),
    accountTag: 'latest',
    staleAfterMs: input.staleAfterMs === undefined ? (sepolia ? TESTNET.staleAfterMs : null) : input.staleAfterMs,
    logs: Object.freeze(logs),
    requestTimeoutMs: input.requestTimeoutMs ?? (sepolia ? TESTNET.requestTimeoutMs : 5_000),
    platformLaunchKey: 'FIT',
  });
}

/** The manifest of a deployed config; throws for `not_deployed` (callers check `deployment.status` first). */
export function deployedManifest(config: ChainConfig): DeploymentManifest {
  if (config.deployment.status !== 'deployed') throw new ChainConfigError('invalid_manifest', config.deployment.reason);
  return config.deployment.manifest;
}
