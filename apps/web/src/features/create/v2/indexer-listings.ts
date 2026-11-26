import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { BaseError, ExecutionRevertedError, decodeFunctionResult, encodeFunctionData, erc20Abi, type Address } from 'viem';
import { listingDetailFromJson } from '../../../../../../packages/indexer/src/core/v2/listings-v2';
import { useDataSource } from '../../data-source';
import { BUILD_CORE } from '../../core/useCore';
import { address, object, sourceV2, type V2Source } from '../../core/v2/indexer-v2';
import type { Fetcher } from '../../core/core-client';
import { RETRY_MS, issuerPowerLines, type TokenReader } from './issuer-powers';
import { eatAnswerV21 } from './eat-check';
import { DEMO_LISTINGS, NATIVE_TOKEN, offeredListings, type EatAnswer, type SiteListing } from './listings';
import { ListingClass, ListingKind } from './spec-types';
import { CHECKED_BURN_SELECTOR } from './recipes';
import { viewClient } from './view-client';
import { NATIVE_SYMBOL } from '../../data-source/native-coin';
import { createReleaseOf } from '../../core/v2/releases';
import type { ReleaseV2 } from '../../../../../../packages/chain/src/core/v2';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

/** Only a revert (code 3, "execution reverted") means the function is absent; every other failure concludes nothing. */
const reverted = (error: unknown): boolean => error instanceof BaseError && error.walk((cause) => cause instanceof ExecutionRevertedError) !== null;

/**
 * How a reader sends its view calls. `aggregate` (the default): on the public Sepolia RPC they may be folded into
 * Multicall3 calls (view-client.ts), where the callee sees Multicall3 as its caller. false: each is its own eth_call, as
 * the factory's refusal() probe is sent (each probe is larger than one aggregate's budget anyway).
 */
export interface TokenReaderOptions { readonly aggregate?: boolean }

/**
 * The listing chain over the source's RPC (`TokenReader`): view calls (null for a revert or no data, a rejection for
 * any other failure) and code checks, both only once the RPC has said it serves `chainId`. Offchain lookups (CCIP-Read)
 * are off: a listed token cannot send the browser to a URL of its choosing. On the public Sepolia RPC the calls and
 * code checks are batched (view-client.ts); each still answers for itself.
 */
export function rpcTokenReader(rpc: string, chainId: number, fetchFn?: typeof fetch, { aggregate = true }: TokenReaderOptions = {}): TokenReader {
  const client = viewClient(rpc, chainId, fetchFn);
  let checked: Promise<void> | null = null;
  const sameChain = (): Promise<void> => {
    checked ??= client.getChainId().then((id) => {
      if (id !== chainId) throw new Error(`The RPC serves chain ${id}, not ${chainId}`);
    });
    checked.catch(() => { checked = null; });
    return checked;
  };
  return {
    call: async (to, data) => {
      await sameChain();
      try {
        const reply = await client.call({ to, data, ...(aggregate ? {} : { batch: false }) });
        return reply.data && reply.data !== '0x' ? reply.data : null;
      } catch (error) {
        if (reverted(error)) return null;
        throw error;
      }
    },
    hasCode: async (address) => {
      await sameChain();
      const code = await client.getCode({ address });
      return code !== undefined && code !== '0x';
    },
  };
}

const SYMBOL = encodeFunctionData({ abi: erc20Abi, functionName: 'symbol' });

/**
 * A listed coin's symbol, read once per chain and address for the page's life (SH-V21-FE14): the book refetches every
 * 6 s, and a book of hundreds of coins must not ask hundreds of symbols each time. Only a symbol that read well is
 * kept; a failed read shows the address and is asked again with the next refetch.
 */
const symbols = new Map<string, string>();
/** Test seam: forget every symbol read. */
export function resetListingSymbolsForTests(): void { symbols.clear(); }

/** The token's symbol when it reads as a short string; else its address. */
async function symbolOf(reader: TokenReader, chainId: number, token: Address): Promise<string> {
  const key = `${chainId}:${token.toLowerCase()}`;
  const known = symbols.get(key);
  if (known !== undefined) return known;
  try {
    const data = await reader.call(token, SYMBOL);
    const read = data ? decodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', data }) : '';
    if (read.length > 0 && read.length <= 32) { symbols.set(key, read); return read; }
    return token;
  } catch {
    return token;
  }
}

/**
 * Read only one release's permanent listing book. No implicit listing or on-chain price valuation. Each coin's issuer
 * powers come from its own contract at the listing's address (issuer-powers.ts), never from its ticker.
 */
export async function loadListingsV2(source: V2Source, fetcher: Fetcher = fetch, reader: TokenReader = rpcTokenReader(source.rpc, source.manifest.chainId), release: ReleaseV2 | undefined = createReleaseOf(source.manifest)): Promise<readonly SiteListing[]> {
  // SH-300: Create's release (the first) unless the caller names a box's own; listing ids repeat across releases, so a
  // book is always one registry's.
  if (!release) throw new Error('V2 release unavailable');
  const reply = await fetcher(`${source.origin}/v2/listings/${source.manifest.chainId}/${release.registry.address.toLowerCase()}`);
  if (!reply.ok) throw new Error('Price coins unavailable');
  const body = object(await reply.json());
  if (body.schema !== 'sh.core-listings.v2' || body.chainId !== source.manifest.chainId || address(body.registry).toLowerCase() !== release.registry.address.toLowerCase() || !Array.isArray(body.listings)) throw new Error('Wrong listing book');
  const rows = await Promise.all(body.listings.map(async (item): Promise<SiteListing> => {
    const wire = object(item); const d = listingDetailFromJson(wire.detail);
    if (wire.id !== d.id || address(wire.token).toLowerCase() !== d.token.toLowerCase() || wire.raise !== d.raise.toString()) throw new Error('Inconsistent listing');
    const native = d.token.toLowerCase() === NATIVE_TOKEN;
    const kind = ListingKind[d.kind as keyof typeof ListingKind];
    // Optional metadata cannot block a price coin: its address remains the identity. Its issuer powers (pause, freeze)
    // are read at its listed address, beside the symbol; the stock note follows the class.
    const [symbol, powers] = await Promise.all([native ? NATIVE_SYMBOL : symbolOf(reader, source.manifest.chainId, d.token), issuerPowerLines(reader, source.manifest.chainId, { token: d.token, kind })]);
    // v2.1: only an authenticated checked-burn admission carries the selector (listings-v2.ts); any other row locks.
    return { id: d.id, token: d.token, decimals: d.decimals, class: ListingClass[d.class as keyof typeof ListingClass], kind, raise: d.raise,
      bootstrap: d.q.bootstrapQ, listedAt: d.listedAt, symbol, name: symbol, powers, checkedBurn: d.checkedBurnSelector === CHECKED_BURN_SELECTOR };
  }));
  const offered = offeredListings(rows);
  if (offered.length !== rows.length) throw new Error('Invalid or duplicate price coins');
  return offered;
}
const NO_LISTINGS: readonly SiteListing[] = Object.freeze([]);

/**
 * The reader the factory's Eat answers are asked with: each refusal() probe as its own eth_call, never folded into a
 * Multicall3 call (a probe is larger than one aggregate's budget, so folding saves nothing, and the factory's planner is
 * then asked exactly as before). Its requests still share JSON-RPC batches on the public Sepolia RPC.
 */
export const eatReaderV2 = (source: V2Source): TokenReader => rpcTokenReader(source.rpc, source.manifest.chainId, undefined, { aggregate: false });

/** Each listing with the factory's answer to eating it, where it has answered (eat-check.ts). */
export const withEat = (listings: readonly SiteListing[], answers: readonly (EatAnswer | null | undefined)[]): readonly SiteListing[] =>
  listings.map((listing, i) => { const eat = answers[i]; return eat ? { ...listing, eat } : listing; });

export function useListingsV2(override?: readonly SiteListing[]) {
  const data = useDataSource();
  const resolved = useMemo(() => { try { return { source: sourceV2(data.id, BUILD_CORE), error: null }; } catch { return { source: null, error: 'Price coins unavailable' }; } }, [data.id]);
  const source = resolved.source;
  const query = useQuery({ queryKey: ['v2-listings', source?.network, source?.origin, source?.manifest.chainId, (source ? createReleaseOf(source.manifest)?.registry.address : undefined)], queryFn: () => { if (!source) throw new Error('V2 release unavailable'); return loadListingsV2(source); }, enabled: !override && !data.isDemo && source !== null, refetchInterval: 6000, retry: false });
  // V21-MONEY-01: the release's factory says, once per listing (and again if its raise or checked burn changes), whether
  // a box priced in it may eat it. Its refusal() view moves no funds and asks no wallet. An answer that concluded
  // nothing, or a failed read, is asked again after RETRY_MS.
  const factory = (source ? createReleaseOf(source.manifest)?.factory.address : undefined) ?? null;
  const reader = useMemo(() => (source ? eatReaderV2(source) : null), [source]);
  const loaded = query.data ?? NO_LISTINGS;
  const asked = !override && !data.isDemo && reader !== null && factory !== null ? loaded : NO_LISTINGS;
  const answers = useQueries({
    queries: asked.map((listing) => ({
      queryKey: ['v2-eat', source?.network, source?.origin, source?.manifest.chainId, factory, listing.id, listing.token, listing.raise.toString(), listing.checkedBurn === true],
      queryFn: () => { if (!reader || !factory) throw new Error('V2 release unavailable'); return eatAnswerV21(reader, factory, listing); },
      staleTime: (q: { readonly state: { readonly data?: EatAnswer | null } }) => (q.state.data ? Infinity : RETRY_MS),
      refetchInterval: (q: { readonly state: { readonly data?: EatAnswer | null } }) => (q.state.data ? false : RETRY_MS),
      retry: false,
    })),
    // One string per answer set, so the listings below change only when an answer does.
    combine: (results) => results.map((result) => result.data ?? '').join('|'),
  });
  const listings = useMemo(() => withEat(loaded, answers.split('|').map((answer) => (answer === 'allowed' || answer === 'refused' ? answer : null))), [loaded, answers]);
  if (override) return { listings: override, error: null };
  if (DEMO_BUILD && data.isDemo) return { listings: DEMO_LISTINGS, error: null };
  return { listings, error: resolved.error ?? (query.isError || !source ? 'Price coins unavailable' : query.isPending ? 'Reading price coins…' : null) };
}
