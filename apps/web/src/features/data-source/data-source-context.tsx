import { CORE_LOCAL_RPC_URL, CORE_MANIFESTS, FIT_MARKETS, LOCAL_MANIFEST, LOCAL_RPC_URL, SEPOLIA_MANIFEST } from 'virtual:squarehole-deployments';
import { coreAvailability, localCoreWalletChainId } from '../core/core-build';
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { DEFAULT_RUNTIME_LOADER, createChainSession, type ChainRuntimeState, type ChainSession, type RuntimeLoader } from './chain-session';
import type { ChainRuntime } from './chain-runtime';
import {
  DATA_LABELS,
  DATA_SOURCE_BADGES,
  LOCAL_CHAIN_ID,
  SAMPLE_CHAIN_LABEL,
  TWIN_BADGE,
  TWIN_LABEL,
  localIsCoreTwin,
  SEPOLIA_CHAIN_ID,
  dataSourceOptions,
  deploymentSummary,
  effectiveDataSource,
  useStoredDataSource,
  type DataSourceBadge,
  type DeploymentSummary,
  type DataSourceBuild,
  type DataSourceId,
  type DataSourceOption,
} from './data-source';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export interface DataSourceValue {
  /** The source the app shows (the stored choice when this build can serve it, else the demo). */
  readonly id: DataSourceId;
  readonly option: DataSourceOption;
  readonly options: readonly DataSourceOption[];
  /** The stored choice (may differ from `id` when the build cannot serve it). */
  readonly stored: DataSourceId | null;
  readonly chainId: number;
  /**
   * The chain the wallet is checked against: the source's chain, except on the local twin carrying a core v2
   * deployment, whose box actions run on its manifest's chain (Sepolia's id on anvil, SH-V21-EXAMPLES-E2E-FIX2 O-2).
   */
  readonly walletChainId: number;
  readonly isDemo: boolean;
  readonly badge: DataSourceBadge;
  /** The data's name on a page: "Local chain 31337" (the sample data's chain too; F130), "Local chain (Sepolia twin)" for the core twin, "Sepolia testnet". */
  readonly dataLabel: string;
  /** The local source is the core v1 twin (Sepolia's chain id on anvil): read only, never offered to a wallet. */
  readonly coreTwin: boolean;
  /** The chain session of a chain source; null for the demo fixtures. */
  readonly chain: ChainSession | null;
  /** Display summary of the chain source's deployment manifest (About & risks); null for the demo fixtures. */
  readonly deployment: DeploymentSummary | null;
  readonly localRpcUrl: string;
}

export const BUILD_DEPLOYMENTS: DataSourceBuild = Object.freeze({
  localManifest: LOCAL_MANIFEST,
  sepoliaManifest: SEPOLIA_MANIFEST,
  localRpcUrl: LOCAL_RPC_URL,
  // The v2 market record for Sepolia (parsed by the pair page; here it only makes the source selectable).
  sepoliaMarket: FIT_MARKETS.find((record) => typeof record === 'object' && record !== null && (record as { chainId?: unknown }).chainId === SEPOLIA_CHAIN_ID) ?? null,
  // Core v1 (S10a): Sepolia's committed manifest (awaiting the broadcast today) and a named local core chain.
  coreSepolia: coreAvailability(CORE_MANIFESTS).sepolia,
  coreLocal: coreAvailability(CORE_MANIFESTS).local,
  coreLocalRpcUrl: CORE_LOCAL_RPC_URL,
  coreLocalWalletChainId: localCoreWalletChainId(CORE_MANIFESTS),
  production: import.meta.env?.SH_PRODUCTION === true,
});

export function dataSourceValue(id: DataSourceId, stored: DataSourceId | null, build: DataSourceBuild, loader: RuntimeLoader = DEFAULT_RUNTIME_LOADER): DataSourceValue {
  const options = dataSourceOptions(build);
  const option = options.find((candidate) => candidate.id === id) ?? options[0];
  if (option === undefined) throw new Error('No data source options');
  const chain =
    DEMO_BUILD && id === 'local'
      ? createChainSession({ chainId: LOCAL_CHAIN_ID, manifest: build.localManifest, rpcUrls: [build.localRpcUrl] }, loader)
      : id === 'sepolia'
        ? createChainSession({ chainId: SEPOLIA_CHAIN_ID, manifest: build.sepoliaManifest }, loader)
        : null;
  // The local source as the core twin gets its own labels (by source, never by chain id; S10a review).
  const twin = id === 'local' && localIsCoreTwin(build);
  return Object.freeze({
    id,
    option,
    options,
    stored,
    chainId: option.chainId,
    walletChainId: twin && typeof build.coreLocalWalletChainId === 'number' ? build.coreLocalWalletChainId : option.chainId,
    isDemo: DEMO_BUILD && id === 'demo',
    badge: twin ? TWIN_BADGE : DATA_SOURCE_BADGES[id],
    dataLabel: twin ? TWIN_LABEL : DEMO_BUILD && id === 'demo' ? SAMPLE_CHAIN_LABEL : DATA_LABELS[id],
    coreTwin: twin,
    chain,
    deployment: DEMO_BUILD && id === 'local' ? deploymentSummary(build.localManifest) : id === 'sepolia' ? deploymentSummary(build.sepoliaManifest) : null,
    localRpcUrl: build.localRpcUrl,
  });
}

/** Without a provider (unit tests of single features) the app is the demo; on the production site, Sepolia. */
const DEFAULT_VALUE = DEMO_BUILD
  ? dataSourceValue('demo', null, { localManifest: null, sepoliaManifest: null, localRpcUrl: LOCAL_RPC_URL })
  : dataSourceValue('sepolia', null, { localManifest: null, sepoliaManifest: null, localRpcUrl: '', production: true });

const DataSourceContext = createContext<DataSourceValue>(DEFAULT_VALUE);

export interface DataSourceProviderProps {
  children: ReactNode;
  /** Test seam: what the build can serve (production: `virtual:squarehole-deployments`). */
  build?: DataSourceBuild;
  /** Test seam: how a chain runtime is created. */
  loader?: RuntimeLoader;
}

/**
 * The data source of the whole app, from the stored choice. A new choice creates a new session (the app below is
 * keyed by the source id, so caches, wallet state and flows of the previous source never leak into the next one).
 */
export function DataSourceProvider({ children, build = BUILD_DEPLOYMENTS, loader = DEFAULT_RUNTIME_LOADER }: DataSourceProviderProps) {
  const stored = useStoredDataSource();
  const options = useMemo(() => dataSourceOptions(build), [build]);
  const id = effectiveDataSource(stored, options);
  const value = useMemo(() => dataSourceValue(id, stored, build, loader), [id, stored, build, loader]);
  return <DataSourceContext.Provider value={value}>{children}</DataSourceContext.Provider>;
}

export function useDataSource(): DataSourceValue {
  return useContext(DataSourceContext);
}

const IDLE: ChainRuntimeState = Object.freeze({ status: 'idle' });
const noSubscription = (): (() => void) => () => undefined;

/** The chain runtime state of the current source (idle for the demo). */
export function useChainRuntimeState(): ChainRuntimeState {
  const { chain } = useDataSource();
  return useSyncExternalStore(chain?.subscribe ?? noSubscription, chain?.getState ?? (() => IDLE), chain?.getState ?? (() => IDLE));
}

/** The loaded chain runtime, or null (demo, or not loaded yet). */
export function useChainRuntime(): ChainRuntime | null {
  const state = useChainRuntimeState();
  return state.status === 'ready' ? state.runtime : null;
}

/**
 * Where chain requests go (write chain, the manifest's writer projection, the app's RPC reader), or null for the demo
 * fixtures or while the runtime loads. Pages build `ChainTxSpec`s from it (features/tx/chain-requests.ts).
 */
export function useChainWriteTarget(): ChainRuntime['write'] | null {
  return useChainRuntime()?.write ?? null;
}
