/**
 * Item payouts (M3-53, F127): what one wallet knows about each of its items, and the claim-state rule. Pure data,
 * bigint only; no wallet, no RPC. The rule is M2's (holder-claims.ts), by block number only:
 *
 * Once this wallet's claim of an item is mined at block R, the item shows "Claimed" and no Claim button until a read
 * at block R or later decides it. That read is then the item's whole truth: credit 0 keeps "Claimed"; credit above 0
 * brings back the amount and Claim. Unlike a batch, an item keeps receiving shares, so a later credit is not proof
 * the claim failed: it is simply what the item can claim now. An older or failed read never changes what is shown.
 */
import type { Address, Hex } from 'viem';
import type { readItemClaimV2 } from '../../../../../../packages/indexer/src/core/v2/m3-reads-v2';
import type { ItemsHistory } from './m3-data';

export type ItemClaimV2 = Awaited<ReturnType<typeof readItemClaimV2>>;
/** What the claim-state rule needs of one item's credit: a full ledger read (readItemClaimV2) or a wallet claims index row. */
export type ItemCredit = Pick<ItemClaimV2, 'owner' | 'status' | 'claimableP' | 'outsideP' | 'stashP' | 'graduated' | 'failed' | 'payout'>;
export interface ItemRead { readonly block: bigint; readonly credit: ItemCredit }

/**
 * An item's credit in the box token (v2.1 step 2) for the same rule, from the same read's `t` quote (claimT pays it), in
 * the P-named fields as the claims index's `itemWalletQuoteV21` does; null when the box pays no item in T.
 */
export function itemCreditTOf(read: ItemClaimV2): ItemCredit | null {
  const t = read.t;
  if (!t) return null;
  return { owner: read.owner, status: read.status, claimableP: t.claimableT, outsideP: t.outsideT, stashP: t.stashT, graduated: read.graduated, failed: read.failed, payout: t.payout };
}
export interface ItemClaim { readonly tx: Hex; readonly block: bigint; readonly paidP: bigint }
export interface ItemKnown { readonly read?: ItemRead; readonly claim?: ItemClaim }
/** One wallet's items on one ledger, keyed by the item id as a decimal string. */
export type ItemSession = Readonly<Record<string, ItemKnown>>;

/** Keep the newest read: a read replaces the stored one only when its block is the same or later. */
export function withItemRead(session: ItemSession, id: bigint, read: ItemRead): ItemSession {
  const known = session[id.toString()];
  if (known?.read && read.block < known.read.block) return session;
  return { ...session, [id.toString()]: { ...known, read } };
}

/** Record a mined claim; a later claim of the same item replaces the earlier one. */
export function withItemClaim(session: ItemSession, id: bigint, claim: ItemClaim): ItemSession {
  return { ...session, [id.toString()]: { ...session[id.toString()], claim } };
}

export type ItemState =
  | { readonly kind: 'claimed'; readonly amount: bigint; readonly checked: boolean }
  | { readonly kind: 'ready' | 'paused' | 'unchecked'; readonly amount: bigint; readonly stash: bigint }
  /** The ledger has not caught up with its funding or vault records; a claim waits for a sync. */
  | { readonly kind: 'syncing' }
  /** Before graduation item shares wait; there is nothing to claim yet. */
  | { readonly kind: 'waiting' }
  /** This wallet's item with nothing to claim, or an item this wallet no longer holds. */
  | { readonly kind: 'none' | 'other' | 'unknown' };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function itemState(known: ItemKnown | undefined, account: Address): ItemState {
  const read = known?.read; const claim = known?.claim;
  if (claim && (!read || read.block < claim.block)) return { kind: 'claimed', amount: claim.paidP, checked: false };
  if (!read) return { kind: 'unknown' };
  const { credit } = read;
  if (!same(credit.owner, account)) return { kind: 'other' };
  if (credit.status === 'sync_pending') return { kind: 'syncing' };
  if (credit.claimableP === null || credit.claimableP === 0n) {
    if (claim) return { kind: 'claimed', amount: claim.paidP, checked: true };
    return { kind: !credit.graduated && !credit.failed ? 'waiting' : 'none' };
  }
  const stash = credit.stashP ?? 0n;
  const kind = credit.payout === 'available' ? 'ready' : credit.payout === 'unavailable' ? 'paused' : 'unchecked';
  return { kind, amount: credit.claimableP, stash };
}

/** The amount a Claim button would claim now, or null when this item has no Claim button. */
export const claimableItem = (state: ItemState): bigint | null => (state.kind === 'ready' ? state.amount : null);

/** At most this many items' owners are read per page and snapshot (one call each), without the indexer's owner list. */
export const MAX_OWNER_SCAN = 64;
/** At most this many of this wallet's items get a full credit read per page and snapshot (about ten calls each). */
export const MAX_ITEMS_READ = 12;

const asc = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
const unique = (ids: readonly bigint[]): bigint[] => [...new Set(ids.map(String))].map(BigInt);
/** A claim mined this session that no read at or after its receipt's block has decided yet. */
const awaitingRead = (known: ItemKnown | undefined): boolean => known?.claim !== undefined && (!known.read || known.read.block < known.claim.block);
/** A claim a read at or after its receipt's block has decided. The item can earn again, so it is still read, last. */
const decided = (known: ItemKnown | undefined): boolean => known?.claim !== undefined && known.read !== undefined && known.read.block >= known.claim.block;

/**
 * The read plan (M363-OC01, like the holder batches' OC-01 plan). `reserved`: the item typed in Details, then every
 * receipt waiting for its deciding read, on every page. `rest`: the items that may be this wallet's. With the indexer's
 * owner list these are exactly the items it lists for this wallet (ascending); without it, every item recorded outside
 * the vault, newest movement first. Items whose claim was decided rotate to the end: completing a page brings the next
 * items forward, and they are still read again for new earnings. History only narrows the list; owners and amounts
 * always come from the reads at the displayed hash.
 */
function readPlan(history: ItemsHistory | null | undefined, session: ItemSession, extra: bigint | null, account: Address | null) {
  const explicit = extra !== null && extra > 0n ? [extra] : [];
  const pending = Object.entries(session).filter(([, known]) => awaitingRead(known)).map(([id]) => BigInt(id)).sort(asc);
  const reserved = unique([...explicit, ...pending]);
  const owners = account !== null ? history?.owners : undefined;
  const indexed = owners !== undefined;
  const pool = account !== null && owners !== undefined
    ? Object.entries(owners).filter(([, owner]) => owner !== null && same(owner, account)).map(([id]) => BigInt(id)).sort(asc)
    : (history?.known ?? []).filter((item) => !item.inside).map((item) => item.id);
  const taken = new Set(reserved.map(String));
  const free = unique(pool).filter((id) => !taken.has(id.toString()));
  const rest = [...free.filter((id) => !decided(session[id.toString()])), ...free.filter((id) => decided(session[id.toString()]))];
  // With the owner list every candidate should be this wallet's, so a page is as large as the full reads allow.
  const size = indexed ? MAX_ITEMS_READ : MAX_OWNER_SCAN;
  return { explicit, pending: pending.filter((id) => !explicit.includes(id)), reserved, rest, size };
}

/** How many pages `itemCandidates` cycles through: the rest in the slots left, or the pending receipts when they alone exceed a page. */
export function itemPages(history: ItemsHistory | null | undefined, session: ItemSession, extra: bigint | null, account: Address | null = null): number {
  const plan = readPlan(history, session, extra, account);
  if (plan.reserved.length > MAX_ITEMS_READ) return Math.ceil(plan.pending.length / (MAX_ITEMS_READ - plan.explicit.length));
  const free = plan.size - plan.reserved.length;
  return Math.max(1, Math.ceil(plan.rest.length / free));
}

/**
 * Which items' owners to read on `page` (pages wrap around), in priority order: the typed item and every pending
 * receipt always, then one page of the rest. When the pending receipts alone exceed the full-read bound they are paged
 * fairly instead, the typed item staying on every page. The order matters: `itemsToRead` keeps the first of them.
 */
export function itemCandidates(history: ItemsHistory | null | undefined, session: ItemSession, extra: bigint | null, page = 0, account: Address | null = null): bigint[] {
  const plan = readPlan(history, session, extra, account);
  const pages = itemPages(history, session, extra, account);
  const at = ((page % pages) + pages) % pages;
  if (plan.reserved.length > MAX_ITEMS_READ) {
    const slots = MAX_ITEMS_READ - plan.explicit.length;
    return [...plan.explicit, ...plan.pending.slice(at * slots, (at + 1) * slots)];
  }
  const free = plan.size - plan.reserved.length;
  return [...plan.reserved, ...plan.rest.slice(at * free, (at + 1) * free)];
}

/**
 * Of the scanned items, the ones to read in full: this wallet's, and the ones it claimed this session, taken in the
 * candidates' priority order up to the bound (so a typed item or a pending receipt is never crowded out); ascending ids.
 */
export function itemsToRead(candidates: readonly bigint[], owners: ReadonlyMap<string, Address | null>, session: ItemSession, account: Address): bigint[] {
  const mine = unique(candidates).filter((id) => { const owner = owners.get(id.toString()); return (owner != null && same(owner, account)) || session[id.toString()]?.claim !== undefined; });
  return mine.slice(0, MAX_ITEMS_READ).sort(asc);
}
