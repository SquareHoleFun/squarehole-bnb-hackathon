/**
 * The reads behind every v2 claim (M2-53, M3-53, F128). Claim all and the Claims page read the wallet claims index
 * first (claims-index.ts): one answer for every box at one block, with recent payments. Only when it is unavailable do
 * they fall back to the bounded direct scan the holder and item panels also use (shared query keys, so a box page
 * reads each thing once). Every successful read is stamped with its block and written into this session's knowledge
 * through the claim-state rules (holder-claims.ts, item-claims.ts, claim-all.ts); a failed read writes nothing. No
 * wallet: reads use a request function that throws, so nothing here can reach a wallet.
 */
import { keepPreviousData, queryOptions, skipToken, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Address } from 'viem';
import { rolesOfV2 } from '../../../../../../packages/chain/src/core/v2';
import type { WalletClaimsPageV2 } from '../../../../../../packages/chain/src/core/v2/claims-reader';
import { holderActionIO } from './actions-v2';
import { boxSteps, singleState, withSingleClaim, withSingleRead, type ClaimStep, type SingleClaim, type SingleKnown, type SingleRead, type SingleState } from './claim-all';
import { claimAllIO, creatorFeesOf, creatorReaderV2, creatorRemainderInboxPOf, creatorRemainderOf, readCreatorFeesV2, readHandInV2, seedOwedOf } from './claim-all-actions';
import { NOTHING_LEFT_BATCH, claimsIndexIO, indexedBoxOf, nothingLeftItem, receiptsOf, restartable, viewAt, type IndexedBoxV2, type IndexedKind } from './claims-index';
import { batchState, batchesToRead, claimableNow, holderCandidates, withClaim, withRead, type BatchKnown, type HolderSession } from './holder-claims';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { claimableItem, itemCandidates, itemCreditTOf, itemState, itemsToRead, withItemClaim, withItemRead, type ItemKnown, type ItemSession } from './item-claims';
import { m3ActionIO } from './m3-actions';
import { batchInT, holderHistoryOf } from './payouts-t';

const readOnly = async (): Promise<never> => { throw new Error('Read-only'); };
const low = (value: string | null | undefined) => value?.toLowerCase() ?? null;
const session = { queryFn: skipToken, gcTime: Infinity, staleTime: Infinity } as const;

// This session's knowledge, keyed by chain, contract and wallet. It outlives panel remounts; after a page reload the
// wallet claims index brings back the recent payments.
export const holderSessionKey = (chainId: number, ledger: string | null, account: string | null) => ['v2-holder-session', chainId, low(ledger), low(account)] as const;
export const itemSessionKey = (chainId: number, ledger: string | null, account: string | null) => ['v2-item-session', chainId, low(ledger), low(account)] as const;
/** v2.1 step 2: the same wallet's items' credit in the box token, claimed apart (claimT), by the same rule. */
export const itemTSessionKey = (chainId: number, ledger: string | null, account: string | null) => ['v2-item-t-session', chainId, low(ledger), low(account)] as const;
export type SingleKind = 'creator' | 'remainder' | 'hand-in' | 'seed';
export const singleSessionKey = (kind: SingleKind, chainId: number, contract: string | null, account: string | null) => [`v2-${kind}-session`, chainId, low(contract), low(account)] as const;
export const walletClaimsKey = (source: V2Source, account: Address | null) => ['v2-wallet-claims', source.manifest.chainId, source.origin, low(account)] as const;

/** One wallet's holder batches on one box, read at the displayed snapshot. */
export function holderReadOptions(queries: QueryClient, source: V2Source, view: V2Snapshot, account: Address | null, batches: readonly bigint[]) {
  const chainId = source.manifest.chainId; const ledger = view.claimRow?.contracts.holderLedger ?? null;
  return queryOptions({
    queryKey: ['v2-holder-share', chainId, ledger, account, view.block.toString(), view.blockHash, batches.join(',')],
    retry: false as const,
    queryFn: async () => {
      if (!account) throw new Error('Choose a wallet');
      const io = holderActionIO(source, view, readOnly);
      const results = await Promise.all(batches.map(async (batch) => {
        try { return { batch, credit: await io.claim(batch, account) }; } catch { return { batch, credit: null }; }
      }));
      queries.setQueryData<HolderSession>(holderSessionKey(chainId, ledger, account), (known) => results.reduce((next, { batch, credit }) =>
        credit ? withRead(next, batch, { block: view.block, credit }) : next, known ?? {}));
      return { failed: results.filter((r) => r.credit === null).length };
    },
  });
}

export interface ItemReadData { readonly mine: readonly bigint[]; readonly failed: number }

/** One wallet's items on one box: owners of the candidates, then the full credit of its own, at the displayed snapshot. */
export function itemReadOptions(queries: QueryClient, source: V2Source, view: V2Snapshot, account: Address | null, candidates: readonly bigint[]) {
  const chainId = source.manifest.chainId; const ledger = view.claimRow?.contracts.itemLedger ?? null;
  const key = itemSessionKey(chainId, ledger, account);
  return queryOptions({
    queryKey: ['v2-item-share', chainId, ledger, account, view.block.toString(), view.blockHash, candidates.join(',')],
    retry: false as const,
    // A new snapshot or a claim keeps this wallet's rows on screen until the next answer lands (never another wallet's).
    placeholderData: (previous: ItemReadData | undefined, query: { readonly queryKey: readonly unknown[] } | undefined) => (query?.queryKey[3] === account ? keepPreviousData(previous) : undefined),
    queryFn: async (): Promise<ItemReadData> => {
      if (!account) throw new Error('Choose a wallet');
      const io = m3ActionIO(source, view, readOnly);
      const owners = await io.owners(candidates);
      const mine = itemsToRead(candidates, owners, queries.getQueryData<ItemSession>(key) ?? {}, account);
      const results = await Promise.all(mine.map(async (id) => { try { return { id, credit: await io.item(id) }; } catch { return { id, credit: null }; } }));
      queries.setQueryData<ItemSession>(key, (before) => results.reduce((next, { id, credit }) => credit ? withItemRead(next, id, { block: view.block, credit }) : next, before ?? {}));
      // The same read carries the item's T credit when a side pays items in the box token.
      queries.setQueryData<ItemSession>(itemTSessionKey(chainId, ledger, account), (before) => results.reduce((next, { id, credit }) => {
        const t = credit ? itemCreditTOf(credit) : null;
        return t ? withItemRead(next, id, { block: view.block, credit: t }) : next;
      }, before ?? {}));
      return { mine, failed: results.filter((r) => r.credit === null).length + [...owners.values()].filter((o) => o === null).length };
    },
  });
}

/** The hand-in of a failed box: this wallet's coins, their share of the pot and the approval, at the displayed snapshot. */
export function handInReadOptions(queries: QueryClient, source: V2Source, view: V2Snapshot, account: Address | null) {
  const chainId = source.manifest.chainId; const coordinator = rolesOfV2(view.record).contracts.coordinator ?? null;
  return queryOptions({
    queryKey: ['v2-hand-in', chainId, coordinator, account, view.block.toString(), view.blockHash],
    retry: false as const,
    queryFn: async () => {
      if (!account) throw new Error('Choose a wallet');
      const read = await readHandInV2(view, account, claimAllIO(source, view, readOnly));
      queries.setQueryData<SingleKnown>(singleSessionKey('hand-in', chainId, coordinator, account), (known) => withSingleRead(known, read));
      return { failed: 0 };
    },
  });
}

/**
 * The creator's next payment (FINAL-OC01, `readCreatorFeesV2`): the payee's own simulated claim at the displayed
 * snapshot, written into this session's knowledge like every read. Claim all's direct scan, the box page's creator panel
 * and its button share it (one read per snapshot); a failed read writes nothing and stays "unavailable", never 0.
 */
export function creatorReadOptions(queries: QueryClient, source: V2Source, view: V2Snapshot, account: Address | null) {
  const chainId = source.manifest.chainId; const receiver = rolesOfV2(view.record).contracts.receiver ?? null;
  return queryOptions({
    queryKey: ['v2-creator-quote', chainId, low(receiver), low(account), view.block.toString(), view.blockHash],
    retry: false as const,
    queryFn: async () => {
      if (!account) throw new Error('Choose a wallet');
      const read = await readCreatorFeesV2(view, account, await creatorReaderV2(source));
      queries.setQueryData<SingleKnown>(singleSessionKey('creator', chainId, receiver, account), (known) => withSingleRead(known, read));
      return { failed: 0, amount: read.amount };
    },
  });
}

/**
 * The payee's next payment for the box page (its creator panel and its button), whoever views it: the same read as
 * Claim all's, as the payee, with no wallet. Only after graduation and before failure; the previous answer stays on
 * screen while a new snapshot is read.
 */
export function useCreatorQuoteV2(source: V2Source, view: V2Snapshot): { readonly state: SingleState; readonly failed: boolean } {
  const queries = useQueryClient();
  // A zero payee is no payee: nobody can claim, so nothing is read.
  const payee = view.money && !/^0x0{40}$/i.test(view.money.creatorPayee) ? view.money.creatorPayee : null;
  const on = view.graduated && view.failed === null && payee !== null;
  // One read per snapshot (its key holds the block and its hash): a later observer of the same snapshot (the creator's
  // sheet opened after the page's own button read it) takes that answer, never a second read.
  const read = useQuery({ ...creatorReadOptions(queries, source, view, payee), enabled: on, staleTime: Infinity });
  // The read lands in this session's knowledge, beside any claim mined here (the box page's button or Claim all): the
  // block rule of claim-all.ts then decides, so a claim mined at R shows Claimed until a read at R or later.
  const known = useQuery({ ...session, queryKey: singleSessionKey('creator', source.manifest.chainId, rolesOfV2(view.record).contracts.receiver ?? null, payee) }).data as SingleKnown | undefined;
  // SH-255 round 3 (D12): the session keeps one read per height, keyed without the hash; this snapshot's own answer
  // (its query holds the block hash) is the read shown for it, so a fork read at the same height never stands in.
  const shown: SingleKnown | undefined = read.data ? { ...known, read: { block: view.block, amount: read.data.amount } } : known;
  return { state: on ? singleState(shown) : { kind: 'none' }, failed: on && read.isError };
}

/** A recorded claim replaces an earlier one only: the index's receipts never undo a later claim of this session. */
const later = (known: { readonly claim?: { readonly block: bigint } } | undefined, block: bigint) => !known?.claim || known.claim.block <= block;

/**
 * Writes the index's payments into this session's knowledge, each with the index's own deciding read at block A where
 * the index lists nothing left for it. So "Claimed" survives a reload (panels included), and an old receipt never waits
 * for a read of its own. A claim with something left again (an item earning more) keeps only its receipt: the panel's
 * next read decides it at the displayed block.
 */
function recordReceipts(queries: QueryClient, chainId: number, account: Address, page: WalletClaimsPageV2) {
  const block = BigInt(page.asOf.block);
  // An item's P and T credit are separate claims (v2.1 step 2): its key names the coin.
  const open = new Set(page.items.filter((row) => row.status !== 'claimed').map((row) =>
    `${row.roleAddress}:${row.kind === 'holder' ? row.batchId : row.kind === 'item' ? row.itemId : ''}:${row.kind === 'item' && row.asset === row.box.token ? 't' : ''}`));
  const single: Partial<Record<IndexedKind, Exclude<SingleKind, 'seed'>>> = { creator: 'creator', remainder: 'remainder', 'hand-in': 'hand-in' };
  for (const r of receiptsOf(page)) {
    const left = open.has(`${r.role}:${r.id ?? ''}:${r.kind === 'item' && r.inT ? 't' : ''}`);
    if (r.kind === 'holder' && r.id !== null) {
      const id = r.id;
      queries.setQueryData<HolderSession>(holderSessionKey(chainId, r.role, account), (s = {}) => {
        const claimed = later(s[id.toString()], r.block) ? withClaim(s, id, { tx: r.tx, block: r.block, paidP: r.paidP }) : s;
        return left ? claimed : withRead(claimed, id, { block, credit: NOTHING_LEFT_BATCH });
      });
    } else if (r.kind === 'item' && r.id !== null) {
      const id = r.id;
      queries.setQueryData<ItemSession>((r.inT ? itemTSessionKey : itemSessionKey)(chainId, r.role, account), (s = {}) => {
        const claimed = later(s[id.toString()], r.block) ? withItemClaim(s, id, { tx: r.tx, block: r.block, paidP: r.paidP }) : s;
        return left ? claimed : withItemRead(claimed, id, { block, credit: nothingLeftItem(account) });
      });
    } else {
      const kind = single[r.kind];
      if (!kind) continue;
      const claim: SingleClaim = r.kind === 'hand-in' ? { tx: r.tx, block: r.block, paid: r.coinsT ?? 0n, p: r.paidP } : { tx: r.tx, block: r.block, paid: r.paidP };
      queries.setQueryData<SingleKnown>(singleSessionKey(kind, chainId, r.role, account), (known) => {
        const claimed = later(known, r.block) ? withSingleClaim(known, claim) : known ?? {};
        return left ? claimed : withSingleRead(claimed, { block, amount: 0n });
      });
    }
  }
}

/** The wallet claims index for `account` on `source`: every page, or an error (then the scan takes over, marked). */
export function walletClaimsOptions(queries: QueryClient, source: V2Source, account: Address | null) {
  return queryOptions({
    queryKey: walletClaimsKey(source, account),
    retry: (count: number, error: unknown) => count < 1 && restartable(error),
    retryDelay: 0,
    staleTime: 15_000,
    refetchInterval: 30_000,
    queryFn: async ({ signal }): Promise<WalletClaimsPageV2> => {
      if (!account) throw new Error('Choose a wallet');
      const page = await claimsIndexIO.read(source, account, signal);
      recordReceipts(queries, source.manifest.chainId, account, page);
      return page;
    },
  });
}

/** One box as Claim all sees it: its snapshot, source and the names its list uses. */
export interface ClaimBoxV2 {
  readonly key: string;
  readonly view: V2Snapshot;
  readonly source: V2Source;
  readonly name: string;
  /** The price coin P's symbol, and the box's own coin T's. */
  readonly symbol: string;
  readonly ticker: string;
  /** Stale or unverified: nothing is read or sent until a current verified read. */
  readonly disabled: boolean;
}

/** Where a box's list came from: the wallet claims index, or the bounded direct chain scan (its fallback). */
export type ClaimVia = 'index' | 'scan';
/** A box with its list's origin. From the index, `view` carries the index's block and hash: each send re-checks there. */
export interface ClaimingBoxV2 extends ClaimBoxV2 { readonly via: ClaimVia }

export interface BoxClaimsV2 {
  readonly box: ClaimingBoxV2;
  readonly steps: readonly ClaimStep[];
  /** This wallet's mined claims on this box: this session's and the index's recent payments, until something is left again. */
  readonly claimed: readonly ClaimStep[];
  /** Any part of this box has an answer (a "Nothing to claim" is then true, not a guess). */
  readonly known: boolean;
  readonly reading: boolean;
  readonly failed: boolean;
  /** Null while the index is still answering, or when this box needs no read. */
  readonly via: ClaimVia | null;
}

/** Whether a box can hold any claim for anyone: holder payouts, item payouts, the creator's fees, or a failed box. */
export const hasClaimsV2 = (view: V2Snapshot): boolean =>
  Boolean(view.claimRow?.contracts.holderLedger || view.claimRow?.contracts.itemLedger) || view.failed !== null || view.graduated;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Whether this box can hold a claim for `account` that needs a read (the snapshot alone cannot say the amount). */
function needsRead(view: V2Snapshot, account: Address): boolean {
  const failed = view.failed !== null; const closing = view.closing;
  return Boolean(view.claimRow?.contracts.holderLedger || view.claimRow?.contracts.itemLedger)
    || creatorFeesOf(view, account) === null
    || (failed && closing !== null && closing.tLeft > 0n)
    || (failed && closing !== null && closing.tLeft === 0n && closing.creatorEntitlement > 0n && same(view.record.creator, account));
}

/** One kind of session knowledge for every box, typed (an unset session reads as empty). */
function useSessions<T>(keys: readonly (readonly unknown[])[]): (T | undefined)[] {
  return useQueries({ queries: keys.map((queryKey) => ({ ...session, queryKey })) }).map((q) => q.data as T | undefined);
}
type Read = { readonly data?: unknown; readonly isError: boolean; readonly isFetching: boolean };
const answered = (q: Read | undefined, enabled: boolean) => !enabled || q?.data !== undefined || q?.isError === true;
const readFailed = (q: Read | undefined) => q?.isError === true || ((q?.data as { failed?: number } | undefined)?.failed ?? 0) > 0;
const ids = (known: Readonly<Record<string, { readonly claim?: unknown }>>) => Object.keys(known).filter((id) => known[id]?.claim !== undefined).map(BigInt);
const unique = (list: readonly bigint[]) => [...new Set(list.map(String))].map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** This session's single claims of one box: creator fees, remainder, hand-in and seed return. */
interface Singles { readonly creator?: SingleKnown; readonly remainder?: SingleKnown; readonly handIn?: SingleKnown; readonly seed?: SingleKnown }

/** The claims the box lists, from one source of reads: the ready steps and the confirmed ones. */
interface Derived { readonly steps: ClaimStep[]; readonly claimed: ClaimStep[] }

/** One kind of item credit of one box: its session's knowledge by id, and the ids to show. */
interface ItemsOf { readonly of: (id: bigint) => ItemKnown | undefined; readonly ids: readonly bigint[] }
const NO_ITEMS: ItemsOf = { of: () => undefined, ids: [] };

function derive(view: V2Snapshot, account: Address, holderOf: (id: bigint) => BatchKnown | undefined, holderIds: readonly bigint[],
  itemsP: ItemsOf, itemsT: ItemsOf, creator: SingleState, remainder: SingleState, handIn: SingleState, seedKnown: SingleKnown | undefined): Derived {
  const owed = seedOwedOf(view, account);
  const seed = singleState({ claim: seedKnown?.claim, read: { block: view.block, amount: owed?.amount ?? 0n } });
  const holder = holderIds.map((batch) => ({ batch, inT: batchInT(view.spec, batch), state: batchState(holderOf(batch)) }));
  const items = itemsP.ids.map((id) => ({ id, state: itemState(itemsP.of(id), account) }));
  const itemsInT = itemsT.ids.map((id) => ({ id, state: itemState(itemsT.of(id), account) }));
  const ready = (list: readonly { readonly id: bigint; readonly state: ReturnType<typeof itemState> }[]) => list.flatMap(({ id, state }) => { const amount = claimableItem(state); return amount === null ? [] : [{ id, amount }]; });
  const steps = boxSteps({
    holder: holder.flatMap(({ batch, inT, state }) => { const amount = claimableNow(state); return amount === null ? [] : [{ batch, amount, inT }]; }),
    items: ready(items), itemsT: ready(itemsInT),
    creator, remainder, handIn, seed: { state: seed, owed },
  });
  const pile = view.m3?.pile;
  const claimed: ClaimStep[] = [
    ...holder.flatMap(({ batch, inT, state }) => (state.kind === 'claimed' ? [{ kind: 'holder' as const, batch, amount: state.amount, ...(inT ? { inT: true as const } : {}) }] : [])),
    ...items.flatMap(({ id, state }) => (state.kind === 'claimed' ? [{ kind: 'item' as const, id, amount: state.amount }] : [])),
    ...itemsInT.flatMap(({ id, state }) => (state.kind === 'claimed' ? [{ kind: 'item-t' as const, id, amount: state.amount }] : [])),
    ...(creator.kind === 'claimed' ? [{ kind: 'creator' as const, amount: creator.amount }] : []),
    ...(remainder.kind === 'claimed' ? [{ kind: 'remainder' as const, amount: remainder.amount }] : []),
    // A mined hand-in whose receipt named no P (its quote included inbox P, RC6-RR-INBOX) has none until the index's receipt brings it.
    ...(handIn.kind === 'claimed' ? [{ kind: 'hand-in' as const, coins: handIn.amount, amount: handIn.p ?? null }] : []),
    ...(seed.kind === 'claimed' && pile ? [{ kind: 'seed-return' as const, amount: seed.amount, asset: view.m3?.pileMoney?.asset ?? pile.asset, to: pile.seeder }] : []),
  ];
  return { steps, claimed };
}

/** The index's answer for one box: each listed claim is a read at block A, anything it does not list has nothing left. */
function fromIndex(view: V2Snapshot, account: Address, ix: IndexedBoxV2, holder: HolderSession, item: ItemSession, itemT: ItemSession, singles: Singles): Derived {
  const at = ix.at.block;
  const holderIds = unique([...[...ix.holder.keys()].map(BigInt), ...ids(holder)]);
  const indexed = (rows: IndexedBoxV2['items'], session: ItemSession): ItemsOf => ({
    of: (id) => ({ claim: session[id.toString()]?.claim, read: { block: at, credit: rows.get(id.toString()) ?? nothingLeftItem(account) } }),
    ids: unique([...[...rows.keys()].map(BigInt), ...ids(session)]),
  });
  const single = (known: SingleKnown | undefined, read: SingleRead) => singleState({ claim: known?.claim, read });
  return derive(view, account,
    (batch): BatchKnown => ({ claim: holder[batch.toString()]?.claim, read: { block: at, credit: ix.holder.get(batch.toString()) ?? NOTHING_LEFT_BATCH } }), holderIds,
    indexed(ix.items, item), indexed(ix.itemsT, itemT),
    single(singles.creator, { block: at, amount: ix.creator }),
    single(singles.remainder, { block: at, amount: ix.remainder, ...(ix.remainderInboxP !== null ? { collectFirstP: ix.remainderInboxP } : {}) }),
    single(singles.handIn, ix.handIn ? { block: at, amount: ix.handIn.coins, approved: ix.handIn.approved,
      pOut: ix.handIn.pOut, ...(ix.handIn.collectFirstP !== null ? { collectFirstP: ix.handIn.collectFirstP } : {}) } : { block: at, amount: 0n }),
    singles.seed);
}

/**
 * Every claim `account` can make on each box (F128), with where its list came from. From the wallet claims index when
 * it answers: every holder batch, item, creator claim, remainder and hand-in it lists, at its block. Otherwise the
 * bounded direct scan of FE4: the first page of holder batches and items (OC-01, M363-OC01), the creator's next payment
 * (read, FINAL-OC01), the remainder from the snapshot, and the hand-in (read). Either way the seed return comes from the
 * snapshot, and the steps follow the claim-state rules. The reads run only with a wallet and a current verified box.
 */
export function useClaimsV2(boxes: readonly ClaimBoxV2[], account: Address | null): BoxClaimsV2[] {
  const queries = useQueryClient();
  const parts = boxes.map((box) => {
    const { view, source } = box; const chainId = source.manifest.chainId; const contracts = rolesOfV2(view.record).contracts;
    const on = account !== null && !box.disabled;
    return { box, chainId, holderLedger: view.claimRow?.contracts.holderLedger ?? null, itemLedger: view.claimRow?.contracts.itemLedger ?? null,
      coordinator: contracts.coordinator ?? null, receiver: contracts.receiver ?? null, pile: view.spec.boxType === 5 ? contracts.vault ?? null : null,
      on, wants: on && account !== null && needsRead(view, account) };
  });
  // One index traversal per source among the boxes that need a read (My Box has one source; a box page one box).
  const sources = [...new Map(parts.filter((p) => p.wants).map((p) => [`${p.chainId}|${p.box.source.origin}`, p.box.source])).values()];
  const indexReads = useQueries({ queries: sources.map((source) => ({ ...walletClaimsOptions(queries, source, account), enabled: account !== null })) });
  const indexOf = (source: V2Source) => indexReads[sources.findIndex((s) => s.manifest.chainId === source.manifest.chainId && s.origin === source.origin)];
  // The last outcome decides, also while the index is asked again: a refetch after an error keeps the scan on screen.
  const modes = parts.map((p) => {
    if (!p.wants) return 'none' as const;
    const index = indexOf(p.box.source);
    if (index?.data !== undefined && index.dataUpdatedAt >= index.errorUpdatedAt) return 'index' as const;
    return (index?.errorUpdatedAt ?? 0) > 0 ? 'scan' as const : 'waiting' as const;
  });
  const holders = useSessions<HolderSession>(parts.map((p) => holderSessionKey(p.chainId, p.holderLedger, account)));
  const items = useSessions<ItemSession>(parts.map((p) => itemSessionKey(p.chainId, p.itemLedger, account)));
  const itemsT = useSessions<ItemSession>(parts.map((p) => itemTSessionKey(p.chainId, p.itemLedger, account)));
  const creators = useSessions<SingleKnown>(parts.map((p) => singleSessionKey('creator', p.chainId, p.receiver, account)));
  const remainders = useSessions<SingleKnown>(parts.map((p) => singleSessionKey('remainder', p.chainId, p.coordinator, account)));
  const handIns = useSessions<SingleKnown>(parts.map((p) => singleSessionKey('hand-in', p.chainId, p.coordinator, account)));
  const seeds = useSessions<SingleKnown>(parts.map((p) => singleSessionKey('seed', p.chainId, p.pile, account)));
  // The fallback scan runs only while the index is unavailable.
  const plans = parts.map((p, i) => {
    const scan = modes[i] === 'scan' && p.on && account !== null;
    const batches = scan && p.holderLedger ? batchesToRead(holderHistoryOf(p.box.view), account, holders[i] ?? {}, null, 0, (batch) => batchInT(p.box.view.spec, batch)) : [];
    const candidates = scan && p.itemLedger ? itemCandidates(p.box.view.m3?.items, items[i] ?? {}, null, 0, account) : [];
    const failed = p.box.view.failed !== null && (p.box.view.closing?.tLeft ?? 0n) > 0n;
    const creator = account !== null && creatorFeesOf(p.box.view, account) === null;
    return { batches, candidates, enabled: [scan && batches.length > 0, scan && candidates.length > 0, scan && failed, scan && creator] as const };
  });
  const holderReads = useQueries({ queries: parts.map((p, i) => ({ ...holderReadOptions(queries, p.box.source, p.box.view, account, plans[i]?.batches ?? []), enabled: plans[i]?.enabled[0] ?? false })) });
  const itemReads = useQueries({ queries: parts.map((p, i) => ({ ...itemReadOptions(queries, p.box.source, p.box.view, account, plans[i]?.candidates ?? []), enabled: plans[i]?.enabled[1] ?? false })) });
  const handInReads = useQueries({ queries: parts.map((p, i) => ({ ...handInReadOptions(queries, p.box.source, p.box.view, account), enabled: plans[i]?.enabled[2] ?? false })) });
  const creatorReads = useQueries({ queries: parts.map((p, i) => ({ ...creatorReadOptions(queries, p.box.source, p.box.view, account), enabled: plans[i]?.enabled[3] ?? false })) });
  return parts.map(({ box, wants }, i) => {
    const mode = modes[i] ?? 'none';
    const scanBox: ClaimingBoxV2 = { ...box, via: 'scan' };
    if (!account) return { box: scanBox, steps: [], claimed: [], known: false, reading: false, failed: false, via: null };
    const { view } = box; const holder = holders[i] ?? {}; const item = items[i] ?? {}; const itemT = itemsT[i] ?? {};
    const singles: Singles = { creator: creators[i], remainder: remainders[i], handIn: handIns[i], seed: seeds[i] };
    const index = wants ? indexOf(box.source) : undefined;
    if (mode === 'index' && index?.data !== undefined) {
      const ix = indexedBoxOf(index.data, view);
      const { steps, claimed } = fromIndex(view, account, ix, holder, item, itemT, singles);
      // A creator payment the receiver would refuse is unavailable (Retry asks the index again), never "nothing".
      return { box: { ...box, view: viewAt(view, ix.at), via: 'index' }, steps: box.disabled ? [] : steps, claimed, known: true, reading: index.isFetching, failed: ix.creatorRefused, via: 'index' };
    }
    if (mode === 'scan') {
      const enabled = plans[i]?.enabled ?? [false, false, false, false];
      const reads = [holderReads[i], itemReads[i], handInReads[i], creatorReads[i]] as const;
      const holderIds = unique([...holderCandidates(holderHistoryOf(view), account, holder, null, (batch) => batchInT(view.spec, batch)), ...ids(holder)]);
      const mine = itemReads[i]?.data?.mine ?? [];
      const own = (session: ItemSession): ItemsOf => ({ of: (id) => session[id.toString()], ids: unique([...mine, ...ids(session)]) });
      // The remainder comes from the snapshot itself; the creator's fees from their read (`creatorReadOptions`), unless the
      // snapshot already says there are none. Only this session's claims are stored beside them.
      const at = (known: SingleKnown | undefined, amount: bigint, collectFirstP: bigint | null = null) =>
        singleState({ claim: known?.claim, read: { block: view.block, amount, ...(collectFirstP !== null ? { collectFirstP } : {}) } });
      const decided = creatorFeesOf(view, account);
      // RC6-RR-INBOX: the snapshot's remainder includes the inbox P it read at the same hash; the claim moves that P first.
      const { steps, claimed } = derive(view, account, (batch) => holder[batch.toString()], holderIds, own(item), own(itemT),
        decided === null ? singleState(singles.creator) : at(singles.creator, decided),
        at(singles.remainder, creatorRemainderOf(view, account), creatorRemainderInboxPOf(view, account)), singleState(singles.handIn), singles.seed);
      return {
        box: scanBox, steps: box.disabled ? [] : steps, claimed,
        known: reads.every((q, j) => answered(q, enabled[j] ?? false)),
        reading: index?.isFetching === true || reads.some((q) => q?.isFetching === true),
        failed: reads.some(readFailed), via: 'scan',
      };
    }
    // No read needed (only the snapshot's seed return can be here), or the index is still answering.
    const none: SingleState = { kind: 'none' };
    const { steps, claimed } = derive(view, account, () => undefined, [], NO_ITEMS, NO_ITEMS, none, none, none, singles.seed);
    return { box: scanBox, steps: box.disabled ? [] : steps, claimed, known: mode === 'none', reading: index?.isFetching === true, failed: false, via: null };
  });
}
