/**
 * The Alchemist on the site (SH-V21-FE14, step 8 requests 2 and 3): a coin pile whose coin is not the price coin can
 * have a fee side converted into the pile, but only through a row the release's own directory resolves and that
 * answers as this release's Alchemist for exactly these two coins, with its pinned route helper and the route that
 * helper holds (the chain package's `alchemistRowsV21`). The page asks the source's chain over its RPC: view calls only,
 * no funds, no wallet. The Demo has no directory, so it offers no Alchemist: no route is ever invented. G1
 * (SH-V21-G1-INT): rows and a box's module also carry the cap and the trigger the module answers (`inputCap()`,
 * `conversionTrigger()`), which the Fees step, the Overview and the pile panel show (the trigger by its address, F153).
 */
import { useMemo } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { BaseError, ExecutionRevertedError, type Address, type Hex } from 'viem';
import { alchemistModuleV21, alchemistRowsV21, releaseDirectoryV21, type AlchemistModuleV21, type AlchemistReadsV21, type AlchemistReleaseV21, type AlchemistRowV21, type ReleaseV2 } from '../../../../../../packages/chain/src/core/v2';
import { useDataSource } from '../../data-source';
import { BUILD_CORE } from '../../core/useCore';
import { sourceV2, type V2Source } from '../../core/v2/indexer-v2';
import { RETRY_MS } from './issuer-powers';
import type { AlchemistOffer } from './templates';
import { viewClient } from './view-client';
import { createReleaseOf } from '../../core/v2/releases';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

/** Only a revert means the function is absent or refused; every other failure concludes nothing (the read is asked again). */
const reverted = (error: unknown): boolean => error instanceof BaseError && error.walk((cause) => cause instanceof ExecutionRevertedError) !== null;

/**
 * The chain package's reads over the source's RPC, only once the RPC has said it serves `chainId`; no offchain lookups.
 * Every read is a getter of the release's directory, its modules or their route helpers, or a code read, never a
 * simulation that depends on its caller: on the public Sepolia RPC the calls are folded into Multicall3 calls and the
 * requests batched (view-client.ts), and each call still answers for itself.
 */
export function rpcAlchemistReads(rpc: string, chainId: number, fetchFn?: typeof fetch): AlchemistReadsV21 {
  const client = viewClient(rpc, chainId, fetchFn);
  let checked: Promise<void> | null = null;
  const sameChain = (): Promise<void> => {
    checked ??= client.getChainId().then((id) => { if (id !== chainId) throw new Error(`The RPC serves chain ${id}, not ${chainId}`); });
    checked.catch(() => { checked = null; });
    return checked;
  };
  return {
    call: async (to, data) => {
      await sameChain();
      try {
        const reply = await client.call({ to, data });
        return reply.data && reply.data !== '0x' ? reply.data : null;
      } catch (error) {
        if (reverted(error)) return null;
        throw error;
      }
    },
    code: async (address) => { await sameChain(); return ((await client.getCode({ address })) ?? '0x') as Hex; },
  };
}

/** The release parts a row must match, from the source's manifest, and its directory from the release receiver. */
export async function alchemistReleaseV21(reads: AlchemistReadsV21, source: V2Source): Promise<AlchemistReleaseV21> {
  // SH-300: Create uses the first release, whatever else the deployment lists.
  const release = createReleaseOf(source.manifest);
  if (!release) throw new Error('Choose a v2 release before creating');
  const base = { poolManager: source.manifest.chain.poolManager.address as Address, receiverImplementation: release.implementations.receiver.address, coordinatorImplementation: release.implementations.coordinator.address };
  const directory = await releaseDirectoryV21(reads, base.receiverImplementation);
  if (!directory) throw new Error('The release has no module directory');
  return { ...base, directory };
}

/**
 * XR-CREATE-RPC-COUNT F2: one discovery's read set. Every pair a discovery checks reads the same directory, rows and
 * modules, so each view call (by target and calldata) and each code read (by address) is asked once and its answer is
 * shared by every pair of that discovery: an absent getter's null and a failed read alike, so a failure is not asked
 * again within it. Nothing outlives the discovery: the next one asks the chain afresh, so a row that matured, was
 * withdrawn or changed its code since is seen. Every check stays the chain package's, run for each pair as before.
 */
export function discoveryReads(reads: AlchemistReadsV21): AlchemistReadsV21 {
  const calls = new Map<string, Promise<Hex | null>>();
  const codes = new Map<string, Promise<Hex>>();
  return {
    call: (to, data) => {
      const key = `${to.toLowerCase()}:${data.toLowerCase()}`;
      const asked = calls.get(key) ?? reads.call(to, data);
      calls.set(key, asked);
      return asked;
    },
    code: (address) => {
      const key = address.toLowerCase();
      const asked = codes.get(key) ?? reads.code(address);
      codes.set(key, asked);
      return asked;
    },
  };
}

/**
 * ALCH-TEMPLATE's discovery for `priceCoin`: the release's directory found once, then each pile coin checked as its own
 * pair (`alchemistRowsV21`, every check as for one pair alone), all over one read set (`discoveryReads`). Each pile's
 * rows newest first, in `piles`' order; null for a pile whose rows could not be read (it concludes nothing, the others
 * stand, and the offer asks again: `useAlchemistOffer`). Rejects when the release's directory cannot be read.
 */
export async function alchemistOfferRowsV21(reads: AlchemistReadsV21, source: V2Source, priceCoin: Address, piles: readonly Address[]): Promise<readonly (readonly AlchemistRowV21[] | null)[]> {
  const shared = discoveryReads(reads);
  const release = await alchemistReleaseV21(shared, source);
  return Promise.all(piles.map((pileCoin) => alchemistRowsV21(shared, release, { priceCoin, pileCoin }).catch((): null => null)));
}

/** The query key of one pair's rows, shared by `useAlchemistRows` and the offer's discovery (which fills it). */
const rowsKey = (source: V2Source | null, priceCoin: Address | null, pileCoin: Address | null) =>
  ['v2-alchemist', source?.network, source?.manifest.chainId, (source ? createReleaseOf(source.manifest)?.registry.address : undefined), priceCoin?.toLowerCase(), pileCoin?.toLowerCase()] as const;

/**
 * One pair's rows query: its key and its own read, over one read set per run (XR-CREATE-RPC-COUNT F2: a row and its
 * module read once even when two rows share a module). The one place a pair's answer is kept: `useAlchemistRows` runs
 * it, the offer watches it, the offer's discovery fills it.
 */
function pairRowsQuery(source: V2Source | null, reads: AlchemistReadsV21 | null, priceCoin: Address | null, pileCoin: Address | null) {
  return {
    queryKey: rowsKey(source, priceCoin, pileCoin),
    queryFn: async (): Promise<readonly AlchemistRowV21[]> => {
      if (!reads || !source || !priceCoin || !pileCoin) throw new Error('V2 chain unavailable');
      const shared = discoveryReads(reads);
      return alchemistRowsV21(shared, await alchemistReleaseV21(shared, source), { priceCoin, pileCoin });
    },
  };
}

/**
 * What the page knows about The Alchemist for a pair of coins. A ready row carries what the creator sees before
 * choosing it (G1): its route, its admitted per-step cap (`inputCap`, raw price coin) and its fixed trigger
 * (`conversionTrigger`), read from the module by the chain package; a module without both getters is not offered.
 * A step too small to convert stays in the box as P claims for its own pool depth (RC5-B), up to the row's dust size.
 */
export type AlchemistAnswer =
  | { readonly state: 'off' }
  | { readonly state: 'checking' }
  | { readonly state: 'failed' }
  | { readonly state: 'ready'; readonly rows: readonly AlchemistRowV21[] };
export const ALCHEMIST_OFF: AlchemistAnswer = Object.freeze({ state: 'off' });

/**
 * The resolved rows for a pile in `pileCoin` priced in `priceCoin`, newest first: off without a chain (the Demo), or for
 * the same coin twice (the built-in To the pile); asked again after RETRY_MS while a read fails, and once a minute
 * otherwise (a row matures one day after registration; a withdrawal ends it for new boxes).
 */
export function useAlchemistRows(priceCoin: Address | null, pileCoin: Address | null): AlchemistAnswer {
  const data = useDataSource();
  const source = useMemo(() => { try { return sourceV2(data.id, BUILD_CORE); } catch { return null; } }, [data.id]);
  const reads = useMemo(() => (source ? rpcAlchemistReads(source.rpc, source.manifest.chainId) : null), [source]);
  const wanted = priceCoin !== null && pileCoin !== null && priceCoin.toLowerCase() !== pileCoin.toLowerCase();
  const enabled = wanted && reads !== null && source !== null && !(DEMO_BUILD && data.isDemo);
  const query = useQuery({
    ...pairRowsQuery(source, reads, priceCoin, pileCoin),
    enabled,
    retry: false,
    staleTime: 60_000,
    refetchInterval: (q: { readonly state: { readonly status: string } }) => (q.state.status === 'error' ? RETRY_MS : 60_000),
  });
  if (!enabled) return ALCHEMIST_OFF;
  if (query.data) return { state: 'ready', rows: query.data };
  return query.isError ? { state: 'failed' } : { state: 'checking' };
}

/** What the offer's discovery keeps of a run: only the pile coins it could not read (the pair queries hold the answers). */
interface OfferDiscovery {
  readonly unread: readonly Address[];
}

/**
 * ALCH-TEMPLATE: the first listed coin (in `coins`' order, never the price coin) that an Alchemist row resolves for with
 * `priceCoin`, and that pair's newest row; null while none does, while reading, in the Demo, or without a price coin.
 * One discovery checks every pile coin over one read set (`alchemistOfferRowsV21`, XR-CREATE-RPC-COUNT F2) and fills
 * each pair's `useAlchemistRows` query, so the Fees step finds the chosen pair already read. XR-CREATE-RPC-BATCHING:
 * the offer is what those pair queries hold, watched without being run from here (F1), so a pair read again (the Fees
 * step's minute, a pair picked after five minutes) answers for the offer too and a row refused there is not offered
 * here; a discovery that could not read a pile coin is stale at once, so the next mount asks again (F2).
 */
export function useAlchemistOffer(priceCoin: Address | null, coins: readonly Address[]): AlchemistOffer | null {
  const data = useDataSource();
  const queryClient = useQueryClient();
  const source = useMemo(() => { try { return sourceV2(data.id, BUILD_CORE); } catch { return null; } }, [data.id]);
  const reads = useMemo(() => (source ? rpcAlchemistReads(source.rpc, source.manifest.chainId) : null), [source]);
  const enabled = priceCoin !== null && reads !== null && source !== null && !(DEMO_BUILD && data.isDemo);
  const piles = coins.filter((coin) => priceCoin !== null && coin.toLowerCase() !== priceCoin.toLowerCase());
  useQuery({
    queryKey: ['v2-alchemist-offer', source?.network, source?.manifest.chainId, (source ? createReleaseOf(source.manifest)?.registry.address : undefined), priceCoin?.toLowerCase(), piles.map((pile) => pile.toLowerCase()).join(',')],
    queryFn: async (): Promise<OfferDiscovery> => {
      if (!reads || !source || !priceCoin) throw new Error('V2 chain unavailable');
      const found = await alchemistOfferRowsV21(reads, source, priceCoin, piles);
      found.forEach((rows, i) => { const pile = piles[i]; if (rows && pile) queryClient.setQueryData(rowsKey(source, priceCoin, pile), rows); });
      return { unread: piles.filter((_, i) => !found[i]) };
    },
    // No other listed coin, nothing to check: nothing is read, as with no pair query before.
    enabled: enabled && piles.length > 0,
    retry: false,
    // A pile coin left unread is asked again the next time the offer mounts, the pairs that were read standing meanwhile.
    staleTime: (query) => ((query.state.data?.unread.length ?? 0) > 0 ? 0 : 60_000),
  });
  // Watched, never run from here: the discovery fills them, and only `useAlchemistRows` reads a pair on its own.
  const pairs = useQueries({ queries: (enabled ? piles : []).map((pile) => ({ ...pairRowsQuery(source, reads, priceCoin, pile), enabled: false })) });
  return enabled ? offerOf(piles, pairs.map((pair) => pair.data ?? null)) : null;
}

/**
 * The offer in the pairs' answers (in `piles`' order, null for a pair not read): the first pile coin with a row, and
 * its newest row.
 */
export function offerOf(piles: readonly Address[], found: readonly (readonly AlchemistRowV21[] | null)[]): AlchemistOffer | null {
  const at = found.findIndex((rows) => (rows?.length ?? 0) > 0);
  const row = at < 0 ? undefined : found[at]?.[0];
  const coin = piles[at];
  return row && coin ? { coin, row: row.id } : null;
}

/**
 * An existing box's module side as The Alchemist (its snapshot, so no directory row is needed: a withdrawal never
 * changes a box): the verified module and its route, or null when it is another action or cannot be read.
 */
/**
 * The release parts an existing box's Alchemist module is checked against: the BOX's release (its coordinator and
 * receiver implementations; SH-300, always named by the caller), the deployment's PoolManager.
 */
export function boxAlchemistReleaseOf(source: Pick<V2Source, 'manifest'>, release: ReleaseV2): Omit<AlchemistReleaseV21, 'directory'> {
  return { poolManager: source.manifest.chain.poolManager.address as Address, receiverImplementation: release.implementations.receiver.address, coordinatorImplementation: release.implementations.coordinator.address };
}

export function useBoxAlchemist(source: V2Source, module: { readonly module: Address; readonly codeHash: Hex } | null, coins: { readonly priceCoin: Address; readonly pileCoin: Address } | null, release: ReleaseV2): AlchemistModuleV21 | null {
  const reads = useMemo(() => rpcAlchemistReads(source.rpc, source.manifest.chainId), [source]);
  // SH-300: the box's own release (its coordinator implementation and receiver), named by the caller.
  const query = useQuery({
    queryKey: ['v2-box-alchemist', source.network, source.manifest.chainId, release?.registry.address.toLowerCase(), module?.module.toLowerCase(), module?.codeHash, coins?.priceCoin.toLowerCase(), coins?.pileCoin.toLowerCase()],
    queryFn: async () => {
      if (!module || !coins || !release) return null;
      try {
        const parts = boxAlchemistReleaseOf(source, release);
        return await alchemistModuleV21(reads, parts, module.module, module.codeHash, coins);
      } catch (error) {
        if (error instanceof Error && error.name === 'AlchemistRefusalV21') return null;
        throw error;
      }
    },
    enabled: module !== null && coins !== null && !/^0x0{40}$/i.test(module.module),
    retry: false,
    staleTime: Infinity,
  });
  return query.data ?? null;
}
