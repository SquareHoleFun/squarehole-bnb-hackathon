/**
 * Data source choice (SH-C, ADR-0012 Part C; 01-PRODUCT `/settings` "data provider"). Three sources, one at a time:
 * - `demo`: the bundled demo fixtures on the local demo chain 31337 (the default); nothing is read from a chain and
 *   the wallet is the demo wallet, which signs nothing.
 * - `local`: a Square Hole deployment on a local anvil chain (31337), read over RPC; writes go through a browser wallet.
 * - `sepolia`: the Sepolia testnet, offered once the build carries a Sepolia deployment: the pair registry's manifest
 *   (`packages/contracts/deployments/11155111.json`, ADR-0012) or the v2 market record (apps/web/fit-markets/, the
 *   full v2 system deployed on 2026-09-30, shown on /misfits). With only the market record, the registry's pages say
 *   it is not deployed there (their chain runtime cannot load), never an empty chain. Without either, the option is
 *   disabled with an honest "not deployed yet".
 *
 * The choice is stored in this browser only (one versioned key, guarded like the other preferences: storage can be
 * missing or throw). A stored choice the build cannot serve falls back to the demo and says so; it is never guessed.
 *
 * The production build (`SH_BUILD=production`, SH-V2-FE6) offers Sepolia only: no Demo and no local chain (G08: no
 * mainnet target exists). Its Demo and local options, labels and texts are folded away (`DEMO_BUILD`).
 */
import { DEMO_CHAIN_ID } from '@squarehole/domain';
import { TESTNET } from './testnet';
import { useSyncExternalStore } from 'react';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export type DataSourceId = 'demo' | 'local' | 'sepolia';
export const DATA_SOURCE_IDS: readonly DataSourceId[] = Object.freeze(DEMO_BUILD ? ['demo', 'local', 'sepolia'] : ['sepolia']);
export const DEFAULT_DATA_SOURCE: DataSourceId = DEMO_BUILD ? 'demo' : 'sepolia';
export const DATA_SOURCE_KEY = 'squarehole.data-source.v1';

export const LOCAL_CHAIN_ID = DEMO_CHAIN_ID;
/**
 * The test network's chain (SH-258: the source named `sepolia` is the build's test network, Sepolia by default or BNB
 * Chain testnet under `SH_TESTNET=bnb`; its names below come from the same profile).
 */
export const SEPOLIA_CHAIN_ID: number = TESTNET.chainId;
/** The test network's name in a sentence ("on Sepolia", "on BNB Chain Testnet"). */
const NET = TESTNET.networkName;

/** What this build can serve (from `virtual:squarehole-deployments`; tests pass their own). */
export interface DataSourceBuild {
  readonly localManifest: unknown;
  readonly sepoliaManifest: unknown;
  readonly localRpcUrl: string;
  /** The build's v2 market record for Sepolia (`squarehole.fit-market/v1`), when it carries one. */
  readonly sepoliaMarket?: unknown;
  /**
   * Core v1 (S10a): Sepolia's core manifest status (`awaiting-broadcast` until the founder broadcasts; the option then
   * says "Core v1 is not on Sepolia yet") and whether a local core chain is embedded (`SH_CORE_LOCAL_MANIFEST`).
   */
  readonly coreSepolia?: 'deployed' | 'awaiting-broadcast' | 'none' | 'invalid';
  readonly coreLocal?: boolean;
  /** The local core chain's RPC (`SH_CORE_LOCAL_RPC_URL`), shown in the option's hint when the local source is the twin. */
  readonly coreLocalRpcUrl?: string;
  /** A local core v2 deployment's chain (core-build.ts `localV2WalletChainId`): the wallet's chain on the twin. */
  readonly coreLocalWalletChainId?: number | null;
  /** `SH_BUILD=production`: Sepolia is the only option (no Demo, no local chain). */
  readonly production?: boolean;
}

/**
 * Whether the local source is the core v1 twin (S10a § 7.1: an anvil with Sepolia's chain id): a local core manifest and
 * no first-handoff local deployment. It is read only and never offered to a wallet (a signature there would be valid on
 * Sepolia), so it gets its own title, hint and labels, never "anvil 31337".
 */
export function localIsCoreTwin(build: DataSourceBuild): boolean {
  return DEMO_BUILD && build.coreLocal === true && (build.localManifest === null || build.localManifest === undefined);
}

/** No badge (a source the production build does not have). */
const NO_BADGE: DataSourceBadge = Object.freeze({ lead: '', rest: '', short: '' });

/** The core twin's badge and data label. */
export const TWIN_BADGE: DataSourceBadge = DEMO_BUILD ? Object.freeze({ lead: 'Local chain', rest: ' · Sepolia twin', short: ' · twin' }) : NO_BADGE;
export const TWIN_LABEL = DEMO_BUILD ? 'Local chain (Sepolia twin)' : '';

export interface DataSourceBadge {
  /** Bold first part ("Local chain", "Testnet"; empty for the sample data, which has no badge, F130). */
  readonly lead: string;
  /** Rest of the wide badge (" 31337", " · Sepolia"). */
  readonly rest: string;
  /** Rest of the narrow badge. */
  readonly short: string;
}

export interface DataSourceOption {
  readonly id: DataSourceId;
  readonly title: string;
  readonly hint: string;
  readonly chainId: number;
  readonly available: boolean;
  /** Why the option cannot be chosen in this build (null when available). */
  readonly unavailableReason: string | null;
}

export const DATA_SOURCE_BADGES: Readonly<Record<DataSourceId, DataSourceBadge>> = Object.freeze({
  // F130 (founder, 2026-10-11): no Demo badge. The sample data shows no source badge at all.
  demo: NO_BADGE,
  local: DEMO_BUILD ? Object.freeze({ lead: 'Local chain', rest: ' 31337', short: ' 31337' }) : NO_BADGE,
  sepolia: Object.freeze({ lead: 'Testnet', rest: ` · ${TESTNET.badgeName}`, short: ` · ${TESTNET.badgeName}` }),
});

/** Short label of the data ("Sample data", only in Settings; "Local chain 31337", "Sepolia testnet"). */
export const DATA_LABELS: Readonly<Record<DataSourceId, string>> = Object.freeze({
  demo: DEMO_BUILD ? 'Sample data' : '',
  local: DEMO_BUILD ? 'Local chain 31337' : '',
  sepolia: TESTNET.dataLabel,
});

/**
 * The sample data's chain where a page names its data's chain (a network label, "Nothing on … is shown as FIT"): its
 * boxes live on the local chain 31337. "Sample data" (DATA_LABELS) is said in Settings only (F130); a box it does not
 * hold is "not found", never "not on" a chain (BoxPage).
 */
export const SAMPLE_CHAIN_LABEL = DEMO_BUILD ? 'Local chain 31337' : '';

export const LOCAL_NOT_CONFIGURED = DEMO_BUILD
  ? 'No local deployment in this build. Run `pnpm dev:local`: it starts anvil on port 8560, deploys Square Hole with the contracts’ scripts, seeds trades and claims, and starts the app pointed at it.'
  : '';
export const SEPOLIA_NOT_DEPLOYED = `Not deployed yet: Square Hole has no ${NET} deployment (packages/contracts/deployments/${TESTNET.chainId}.json does not exist). Deploying needs the founder-funded testnet deployer (Stage E).`;
/** Sepolia's core v1 manifest is the committed placeholder: the option says so instead of "not deployed" (S10a § 2.3). */
export const CORE_SEPOLIA_AWAITING = DEMO_BUILD
  ? `Core v1 is not on ${NET} yet: the founder’s broadcast is pending, and no address is guessed.`
  : '';
/** The production site's reasons (no Demo to point at, no repository paths): a few words each. */
export const PRODUCTION_NOT_DEPLOYED = `No ${NET} deployment in this build.`;
export const PRODUCTION_CORE_AWAITING = `Core v1 is not on ${NET} yet: no address is guessed.`;
/** The option's hint when Sepolia carries core v1 (box 0 and later boxes from the registry). */
export const SEPOLIA_CORE_HINT = (import.meta.env?.SH_BNB !== true && TESTNET.switches.box0)
  ? `Reads core v1 on ${NET} (box 0 and every box from its registry) through keyless public RPCs. Read only: nothing asks your wallet. Test tokens have no value; not audited.`
  : `Reads the ${NET} deployment through keyless public RPCs and sends launches and claims through your browser wallet. Test tokens have no value; not audited.`;
export const SEPOLIA_HINT =
  `Reads the ${NET} deployment through keyless public RPCs and sends launches and claims through your browser wallet. Test tokens have no value; not audited.`;
/** The option's hint when the build carries only the v2 market record (no pair registry on Sepolia). */
export const SEPOLIA_MARKET_ONLY_HINT =
  'Reads the v2 rehearsal market on Sepolia (neutral names, a test set, no art) through keyless public RPCs; the market has its own page. The pair registry is not deployed on Sepolia, so the feed, launches and claims say so. Test tokens have no value; not audited.';

/** The Sepolia option: offered once the build carries a deployment there; otherwise disabled with the reason. */
function sepoliaOption(build: DataSourceBuild): DataSourceOption {
  const registry = build.sepoliaManifest !== null && build.sepoliaManifest !== undefined;
  const market = build.sepoliaMarket !== null && build.sepoliaMarket !== undefined;
  const core = build.coreSepolia === 'deployed';
  const sepolia = registry || market || core;
  // Inline (not a helper call), so the bundler folds it in a production bundle.
  const production = !DEMO_BUILD || build.production === true;
  const awaiting = build.coreSepolia === 'awaiting-broadcast';
  const reason = production ? (awaiting ? PRODUCTION_CORE_AWAITING : PRODUCTION_NOT_DEPLOYED) : awaiting ? CORE_SEPOLIA_AWAITING : SEPOLIA_NOT_DEPLOYED;
  return Object.freeze({
    id: 'sepolia',
    title: TESTNET.dataLabel,
    hint: registry ? SEPOLIA_HINT : core ? SEPOLIA_CORE_HINT : SEPOLIA_MARKET_ONLY_HINT,
    chainId: SEPOLIA_CHAIN_ID,
    available: sepolia,
    unavailableReason: sepolia ? null : reason,
  });
}

export function dataSourceOptions(build: DataSourceBuild): readonly DataSourceOption[] {
  // The production site: Sepolia only (no Demo, no local chain; no mainnet target exists, G08).
  if (!DEMO_BUILD || build.production === true) return Object.freeze([sepoliaOption(build)]);
  const local = (build.localManifest !== null && build.localManifest !== undefined) || build.coreLocal === true;
  return Object.freeze([
    Object.freeze({
      id: 'demo',
      title: 'Sample data',
      hint: 'Sample boxes and accounts at a fixed time. Nothing is read from a chain, and its wallet signs nothing.',
      chainId: LOCAL_CHAIN_ID,
      available: true,
      unavailableReason: null,
    }),
    Object.freeze(
      localIsCoreTwin(build)
        ? {
            id: 'local' as const,
            title: TWIN_LABEL,
            hint: `Reads core v1 on a local twin of Sepolia (${build.coreLocalRpcUrl ?? build.localRpcUrl}). Read only: it never asks your wallet. Test tokens only; not audited.`,
            chainId: LOCAL_CHAIN_ID,
            available: true,
            unavailableReason: null,
          }
        : {
            id: 'local' as const,
            title: 'Local chain (anvil 31337)',
            hint: `Reads a Square Hole deployment on your local anvil chain (${build.localRpcUrl}) and sends launches and claims through your browser wallet. Test tokens only; not audited.`,
            chainId: LOCAL_CHAIN_ID,
            available: local,
            unavailableReason: local ? null : LOCAL_NOT_CONFIGURED,
          },
    ),
    sepoliaOption(build),
  ]);
}

/**
 * What the About & risks page says about a chain source's deployment, read defensively from the build's manifest (the
 * chain package's parser validates the whole manifest when the runtime loads; this summary is display text only and
 * never an identity the app reads or writes with). Unexpected shapes give nulls, never a guess.
 */
export interface DeploymentSummary {
  readonly registry: string | null;
  readonly gitCommit: string | null;
  readonly gitDirty: boolean | null;
}

export function deploymentSummary(manifest: unknown): DeploymentSummary | null {
  if (typeof manifest !== 'object' || manifest === null) return null;
  const value = manifest as { gitCommit?: unknown; gitDirty?: unknown; contracts?: { registry?: { address?: unknown } } };
  const registry = value.contracts?.registry?.address;
  return Object.freeze({
    registry: typeof registry === 'string' && /^0x[0-9a-fA-F]{40}$/.test(registry) ? registry : null,
    gitCommit: typeof value.gitCommit === 'string' && /^[0-9a-f]{40}$/.test(value.gitCommit) ? value.gitCommit : null,
    gitDirty: typeof value.gitDirty === 'boolean' ? value.gitDirty : null,
  });
}

export const isDataSourceId = (value: unknown): value is DataSourceId => typeof value === 'string' && (DATA_SOURCE_IDS as readonly string[]).includes(value);

/**
 * The stored choice when this build can serve it, otherwise the default: the demo, or on the production site its one
 * source (Sepolia, shown with its "not deployed" state when the build carries no deployment there).
 */
export function effectiveDataSource(stored: DataSourceId | null, options: readonly DataSourceOption[]): DataSourceId {
  const fallback = options.some((option) => option.id === DEFAULT_DATA_SOURCE) ? DEFAULT_DATA_SOURCE : (options[0]?.id ?? DEFAULT_DATA_SOURCE);
  if (stored === null) return fallback;
  return options.find((option) => option.id === stored)?.available ? stored : fallback;
}

// --- storage (guarded) ---------------------------------------------------------------------------------------------

export type DataSourceSaveResult = 'saved' | 'not_saved';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** A stored value that parses as `{ "source": <id> }`; anything else reads as "no choice". */
export function parseStoredDataSource(raw: string | null): DataSourceId | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const source = typeof parsed === 'object' && parsed !== null ? (parsed as { source?: unknown }).source : undefined;
    return isDataSourceId(source) ? source : null;
  } catch {
    return null;
  }
}

// A choice that could not be written applies for this tab until a later save succeeds.
let unsaved: { readonly value: DataSourceId | null } | null = null;
const listeners = new Set<() => void>();

function readRaw(): string | null {
  try {
    return storage()?.getItem(DATA_SOURCE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function readStoredDataSource(): DataSourceId | null {
  if (unsaved !== null) return unsaved.value;
  return parseStoredDataSource(readRaw());
}

const notify = (): void => [...listeners].forEach((listener) => listener());

/**
 * The last choice made in this tab and whether it was stored. The app below the data source remounts on a switch, so
 * the Settings page reads this to announce the result and to put focus back on the chosen option.
 */
export interface DataSourceChange {
  readonly id: DataSourceId | null;
  readonly result: DataSourceSaveResult;
}
let lastChange: DataSourceChange | null = null;

export const readLastDataSourceChange = (): DataSourceChange | null => lastChange;

export function useLastDataSourceChange(): DataSourceChange | null {
  return useSyncExternalStore(subscribeDataSource, readLastDataSourceChange, () => null);
}

export function saveDataSource(id: DataSourceId): DataSourceSaveResult {
  const result = writeDataSource(id);
  lastChange = Object.freeze({ id, result });
  notify();
  return result;
}

function writeDataSource(id: DataSourceId): DataSourceSaveResult {
  let result: DataSourceSaveResult = 'not_saved';
  try {
    const target = storage();
    if (target !== null) {
      target.setItem(DATA_SOURCE_KEY, JSON.stringify({ source: id }));
      result = 'saved';
    }
  } catch {
    result = 'not_saved';
  }
  unsaved = result === 'saved' ? null : { value: id };
  return result;
}

/** Test seam and "Reset to defaults": forget the choice. */
export function clearDataSource(): DataSourceSaveResult {
  let result: DataSourceSaveResult = 'not_saved';
  try {
    const target = storage();
    if (target !== null) {
      target.removeItem(DATA_SOURCE_KEY);
      result = 'saved';
    }
  } catch {
    result = 'not_saved';
  }
  unsaved = result === 'saved' ? null : { value: null };
  lastChange = Object.freeze({ id: null, result });
  notify();
  return result;
}

function onStorage(event: StorageEvent): void {
  if (event.key === null || event.key === DATA_SOURCE_KEY) notify();
}

export function subscribeDataSource(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

export function useStoredDataSource(): DataSourceId | null {
  return useSyncExternalStore(subscribeDataSource, readStoredDataSource, () => null);
}

/** Test seam: drop an unsaved in-memory choice and the last change. */
export function resetDataSourceForTests(): void {
  unsaved = null;
  lastChange = null;
  notify();
}
