/**
 * Holder fee share claims (M2-53, F127): what one wallet knows about each batch, and the one claim-state rule.
 * Pure data, bigint only; no wallet, no RPC.
 *
 * The rule (founder, 2026-10-10: keep it simple). Once this wallet's claim of a batch is mined at block R, the batch
 * shows "Claimed" and no Claim button until a read at block R or later decides it:
 * - that read shows the credit gone: the claim stands ("Claimed");
 * - that read still shows the credit: the claim was reorged out, so the unpaid amount and the Claim button come back
 *   with one note ("Not confirmed, claim again").
 * Reads are compared by block number only. The newest read wins; an older read arriving late, or a failed read,
 * never changes what is shown (a failed read only adds a retry chip on the panel).
 */
import type { Address, Hex } from 'viem';
import type { M2ViewV2 } from '../../../../../../packages/indexer/src/core/v2/m2-views-v2';
import type { HolderClaimV2 } from './actions-v2';

/**
 * What the claim-state rule needs of one batch's credit: a full ledger read (readHolderClaimV2) or a wallet claims index
 * row. `grows`: a batch paid in T (v2.1 step 2) settles each purchased tranche as it comes, so credit after a claim is
 * what it can claim now (like an item), not a claim that did not hold.
 */
export type BatchCredit = Pick<HolderClaimV2, 'status' | 'claimableP' | 'payout'> & { readonly grows?: true };
/** A successful read of one batch for this wallet, with the snapshot block it was read at. */
export interface BatchRead { readonly block: bigint; readonly credit: BatchCredit }
/** This session's mined claim of one batch: its transaction, its receipt's block and the amount it paid. */
export interface BatchClaim { readonly tx: Hex; readonly block: bigint; readonly paidP: bigint }
export interface BatchKnown { readonly read?: BatchRead; readonly claim?: BatchClaim }
/** One wallet's batches on one ledger, keyed by the batch id as a decimal string. */
export type HolderSession = Readonly<Record<string, BatchKnown>>;

/** Keep the newest read: a read replaces the stored one only when its block is the same or later. */
export function withRead(session: HolderSession, batch: bigint, read: BatchRead): HolderSession {
  const known = session[batch.toString()];
  if (known?.read && read.block < known.read.block) return session;
  return { ...session, [batch.toString()]: { ...known, read } };
}

/** Record a mined claim; a later claim of the same batch (claiming again after a reorg) replaces the earlier one. */
export function withClaim(session: HolderSession, batch: bigint, claim: BatchClaim): HolderSession {
  return { ...session, [batch.toString()]: { ...session[batch.toString()], claim } };
}

export type BatchState =
  /** Mined this session. `checked` once a read at or after the receipt's block shows the credit gone. */
  | { readonly kind: 'claimed'; readonly amount: bigint; readonly checked: boolean }
  /** Mined, but a read at or after the receipt's block still shows the credit: claim again. */
  | { readonly kind: 'unconfirmed'; readonly amount: bigint | null; readonly ready: boolean }
  | { readonly kind: 'ready' | 'paused' | 'unchecked'; readonly amount: bigint }
  | { readonly kind: 'open' | 'funding' | 'calculating' | 'none' | 'unknown' };

const creditGone = (credit: BatchCredit) => (credit.status === 'settled' && credit.claimableP === 0n) || (credit.grows === true && (credit.claimableP === null || credit.claimableP === 0n));
const readyCredit = (credit: BatchCredit): bigint | null =>
  credit.status === 'settled' && credit.payout === 'available' && credit.claimableP !== null && credit.claimableP > 0n ? credit.claimableP : null;

export function batchState(known: BatchKnown | undefined): BatchState {
  const read = known?.read; const claim = known?.claim;
  if (claim) {
    if (!read || read.block < claim.block) return { kind: 'claimed', amount: claim.paidP, checked: false };
    if (creditGone(read.credit)) return { kind: 'claimed', amount: claim.paidP, checked: true };
    if (!read.credit.grows) return { kind: 'unconfirmed', amount: read.credit.status === 'settled' ? read.credit.claimableP : null, ready: readyCredit(read.credit) !== null };
  }
  if (!read) return { kind: 'unknown' };
  const { status, payout, claimableP } = read.credit;
  if (status === 'open') return { kind: 'open' };
  if (status === 'awaiting_funding') return { kind: 'funding' };
  if (status === 'settling') return { kind: 'calculating' };
  if (claimableP === null || claimableP === 0n) return { kind: 'none' };
  return { kind: payout === 'available' ? 'ready' : payout === 'unavailable' ? 'paused' : 'unchecked', amount: claimableP };
}

/** The amount a Claim button would claim now, or null when this batch has no Claim button. */
export function claimableNow(state: BatchState): bigint | null {
  if (state.kind === 'ready') return state.amount;
  if (state.kind === 'unconfirmed' && state.ready) return state.amount;
  return null;
}

/** At most this many batches are read per snapshot (seven calls each); the rest is paged (OC-01). */
export const MAX_BATCHES_READ = 12;

/** A claim mined this session that no read at or after its receipt's block has decided yet. */
export const awaitingRead = (known: BatchKnown | undefined): boolean => known?.claim !== undefined && (!known.read || known.read.block < known.claim.block);
/** A claim decided for good: a read at or after its receipt's block shows the credit gone. Nothing more to read. */
const decided = (known: BatchKnown | undefined): boolean => known?.claim !== undefined && known.read !== undefined && known.read.block >= known.claim.block && creditGone(known.read.credit);
const asc = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
const unique = (ids: readonly bigint[]): bigint[] => [...new Set(ids.map(String))].map(BigInt);

/** Which batches pay in the box token (v2.1 step 2, `payouts-t.ts batchInT`): their credit can grow after a claim. */
export type GrowsAfterClaim = (batch: bigint) => boolean;
const NEVER: GrowsAfterClaim = () => false;

/**
 * The read plan (SH-V2-M2-63 OC-01). `reserved`: the batch typed in Details, then every receipt waiting for its
 * deciding read; these are read first on every page. `rest`, newest first: the recorded batches that may still hold
 * this wallet's credit and the claims a read sent back to "claim again", paged into the slots left. A decided claim
 * leaves the plan (its row keeps saying Claimed from the session), except a batch paid in the box token (`grows`): each
 * later tranche adds credit to it, so it stays in the plan after the others, as a claimed item does. The history only
 * narrows the list; amounts always come from the ledger read.
 */
function readPlan(history: M2ViewV2 | null | undefined, account: Address, session: HolderSession, extra: bigint | null, grows: GrowsAfterClaim) {
  const me = account.toLowerCase();
  const explicit = extra !== null && extra > 0n ? [extra] : [];
  const pending = Object.entries(session).filter(([, known]) => awaitingRead(known)).map(([id]) => BigInt(id)).sort(asc);
  const reserved = unique([...explicit, ...pending]);
  const recorded = Object.entries(history?.batches ?? {}).filter(([, b]) => {
    const fullyPaid = b.complete && b.holderP !== null && b.paidP >= b.holderP;
    return !fullyPaid && !Object.keys(b.payments).some((holder) => holder.toLowerCase() === me);
  }).map(([id]) => BigInt(id));
  const claimed = Object.keys(session).map(BigInt).filter((id) => session[id.toString()]?.claim !== undefined);
  const taken = new Set(reserved.map(String));
  const open = unique([...recorded, ...claimed]).filter((id) => !taken.has(id.toString()));
  const desc = (a: bigint, b: bigint) => asc(b, a);
  const rest = [
    ...open.filter((id) => !decided(session[id.toString()])).sort(desc),
    ...open.filter((id) => decided(session[id.toString()]) && grows(id)).sort(desc),
  ];
  return { explicit, pending: pending.filter((id) => !explicit.includes(id)), reserved, rest, decided: claimed.filter((id) => decided(session[id.toString()])) };
}

/** How many pages `batchesToRead` cycles through: the rest in the slots left, or the pending receipts when they alone exceed the bound. */
export function batchPages(history: M2ViewV2 | null | undefined, account: Address, session: HolderSession, extra: bigint | null, grows: GrowsAfterClaim = NEVER): number {
  const plan = readPlan(history, account, session, extra, grows);
  if (plan.reserved.length > MAX_BATCHES_READ) return Math.ceil(plan.pending.length / (MAX_BATCHES_READ - plan.explicit.length));
  const free = MAX_BATCHES_READ - plan.reserved.length;
  return free > 0 ? Math.max(1, Math.ceil(plan.rest.length / free)) : 1;
}

/**
 * Which batches to read for this wallet on `page` (pages wrap around), ascending, at most MAX_BATCHES_READ: the typed
 * batch and every pending receipt always (OC-01), then one page of the rest, newest first. When the pending receipts
 * alone exceed the bound they are paged fairly instead, the typed batch staying on every page.
 */
export function batchesToRead(history: M2ViewV2 | null | undefined, account: Address, session: HolderSession, extra: bigint | null, page = 0, grows: GrowsAfterClaim = NEVER): bigint[] {
  const plan = readPlan(history, account, session, extra, grows);
  const pages = batchPages(history, account, session, extra, grows);
  const at = ((page % pages) + pages) % pages;
  if (plan.reserved.length > MAX_BATCHES_READ) {
    const slots = MAX_BATCHES_READ - plan.explicit.length;
    return [...plan.explicit, ...plan.pending.slice(at * slots, (at + 1) * slots)].sort(asc);
  }
  const free = MAX_BATCHES_READ - plan.reserved.length;
  return [...plan.reserved, ...plan.rest.slice(at * free, (at + 1) * free)].sort(asc);
}

/** Every batch this wallet may have a row for, on any page, ascending: the read plan and the decided claims. */
export function holderCandidates(history: M2ViewV2 | null | undefined, account: Address, session: HolderSession, extra: bigint | null, grows: GrowsAfterClaim = NEVER): bigint[] {
  const plan = readPlan(history, account, session, extra, grows);
  return unique([...plan.reserved, ...plan.rest, ...plan.decided]).sort(asc);
}

/** Run claims one after another, one signature each, stopping at the first that does not confirm. */
export async function claimInOrder<T>(list: readonly T[], claimOne: (item: T, index: number) => Promise<void>): Promise<{ readonly done: number; readonly stoppedAt: T | null; readonly error: unknown }> {
  for (const [index, item] of list.entries()) {
    try {
      await claimOne(item, index);
    } catch (error) {
      return { done: index, stoppedAt: item, error };
    }
  }
  return { done: list.length, stoppedAt: null, error: null };
}
