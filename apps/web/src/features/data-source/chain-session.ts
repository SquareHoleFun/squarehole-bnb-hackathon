/**
 * A chain data source as the app's existing boundaries see it (SH-C, ADR-0012 Part C). Synchronous and light (no viem):
 * the feed, account and registry providers here are thin wrappers that load the chain runtime (`chain-runtime.ts`)
 * with the first read and then delegate to the chain package's providers. A failed load or read rejects like any other
 * provider failure, so every page shows its "unavailable" state; nothing is ever shown as empty or zero instead.
 */
import type {
  AccountProvider,
  AssetRegistryProvider,
  ExternalLinkProvider,
  FeedProvider,
  PairId,
} from '@squarehole/domain';
import { createChainExternalLinkProvider } from '@squarehole/links';
import type { AccountSources } from '../accounts/account-sources';
import type { FeedSource, FeedSourceFor } from '../feed/feed-sources';
import type { ChainRuntime, ChainRuntimeInput } from './chain-runtime';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export type ChainRuntimeState =
  | { readonly status: 'idle' | 'loading' }
  | { readonly status: 'ready'; readonly runtime: ChainRuntime }
  | { readonly status: 'error'; readonly message: string };

export interface ChainSession {
  readonly chainId: number;
  /** Loads (once) and returns the runtime; a failed load can be retried by calling again. */
  load(): Promise<ChainRuntime>;
  /** The runtime once loaded (synchronous; for request specs built during render). */
  readonly getState: () => ChainRuntimeState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly feedSources: FeedSourceFor;
  readonly accountSources: AccountSources;
  readonly registry: AssetRegistryProvider;
  readonly links: ExternalLinkProvider;
}

export type RuntimeLoader = (input: ChainRuntimeInput) => Promise<ChainRuntime>;

/** The production loader: the runtime chunk (viem, ABIs, providers) arrives with the first chain read. */
export const loadChainRuntime: RuntimeLoader = async (input) => (await import('./chain-runtime')).createChainRuntime(input);

/**
 * The production site's loader (SH-V2-FE6): the first handoff's pair registry runtime serves only the pair pages,
 * which that site does not have, so it is not shipped; a read through it fails like any unavailable source.
 */
export const NO_CHAIN_RUNTIME: RuntimeLoader = () => Promise.reject(new Error('The pair registry is not part of this site.'));

/** The loader this build uses by default. */
export const DEFAULT_RUNTIME_LOADER: RuntimeLoader = DEMO_BUILD ? loadChainRuntime : NO_CHAIN_RUNTIME;

export function createChainSession(input: ChainRuntimeInput, loader: RuntimeLoader = DEFAULT_RUNTIME_LOADER): ChainSession {
  let state: ChainRuntimeState = { status: 'idle' };
  let pending: Promise<ChainRuntime> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: ChainRuntimeState): void => {
    state = next;
    [...listeners].forEach((listener) => listener());
  };

  function load(): Promise<ChainRuntime> {
    if (state.status === 'ready') return Promise.resolve(state.runtime);
    if (pending) return pending;
    set({ status: 'loading' });
    pending = loader(input).then(
      (runtime) => {
        pending = null;
        set({ status: 'ready', runtime });
        return runtime;
      },
      (error: unknown) => {
        pending = null;
        set({ status: 'error', message: error instanceof Error ? error.message : 'The chain data source could not be loaded' });
        throw error;
      },
    );
    return pending;
  }

  const feed: FeedProvider = {
    readFeed: async (query, signal) => (await load()).providers.feed.readFeed(query, signal),
    readPair: async (pairId, signal) => (await load()).providers.feed.readPair(pairId, signal),
    latestSnapshot: async (signal) => (await load()).providers.feed.latestSnapshot(signal),
    readPairDetail: async (pairId: PairId, signal) => (await load()).providers.feed.readPairDetail(pairId, signal),
  };
  const feedSource: FeedSource = Object.freeze({ provider: feed, mode: 'live' });

  const accounts: AccountProvider = {
    readClaim: async (pairId, account, signal) => (await load()).providers.accounts.readClaim(pairId, account, signal),
    listPositions: async (account, signal) => (await load()).providers.accounts.listPositions(account, signal),
    listClaims: async (account, signal) => (await load()).providers.accounts.listClaims(account, signal),
  };
  const accountSource = Object.freeze({ provider: accounts, mode: 'live' as const });

  const registry: AssetRegistryProvider = {
    listSupportedQuotes: async (chainId, signal) => (await load()).providers.registry.listSupportedQuotes(chainId, signal),
    readAsset: async (chainId, address, signal) => (await load()).providers.registry.readAsset(chainId, address, signal),
  };

  return Object.freeze({
    chainId: input.chainId,
    load,
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // One source for every `?scenario=`: scenarios exist only for the demo fixtures.
    feedSources: () => feedSource,
    accountSources: Object.freeze({ sourceFor: () => accountSource, settlements: null }),
    registry,
    // No route-evidence record is shipped (EXT-05): execution and discovery stay unverified.
    links: createChainExternalLinkProvider({}),
  });
}
