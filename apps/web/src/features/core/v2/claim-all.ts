/**
 * "Claim all" covers every claim a wallet has (F128, founder 2026-10-10: "Claim all should be all all claims"): its
 * holder batches (M2), its item payouts (M3), the creator's fee claim, the creator's remainder of a box nobody
 * bought, on a failed box the hand-in of its coins for its share of the pot (an approval, then the claim), and for the
 * recorded seeder of a failed coin pile the return of its seed (M363-OC03), in the pile's own coin. Pure data, bigint
 * only; no wallet, no RPC.
 *
 * Each step is one transaction with its own signature: the contracts have no batch entry. The list is fixed before
 * the first signature and runs box after box, stopping at the first step that does not confirm (holder-claims.ts
 * `claimInOrder`); everything after it stays claimable.
 *
 * The creator's claims and the hand-in follow the block-number rule of holder-claims.ts and item-claims.ts: once this
 * wallet's claim is mined at block R it shows Claimed until a read at block R or later decides it. That read is then
 * the whole truth: nothing left keeps Claimed; something left is what the wallet can claim now (fees and coins keep
 * arriving, so it is not proof the claim failed). An older read never changes what is shown.
 */
import type { Address, Hex } from 'viem';

/** A read of one single claim at a snapshot block: `amount` is what can be claimed (for the hand-in, the coins in). */
export interface SingleRead {
  readonly block: bigint;
  readonly amount: bigint;
  /** The hand-in only: the P its coins take out of the pot at this block, and what the coordinator may already take. */
  readonly pOut?: bigint;
  readonly approved?: bigint;
  /**
   * The inbox P a failed box's claim first moves into the pot. RC6-RR-INBOX: on the hand-in (the final share) or the
   * creator's remainder the amount already includes it, conditional on that intake.
   */
  readonly collectFirstP?: bigint;
}
/** A mined single claim: `paid` is the P it paid (for the hand-in, the coins handed in, with `p` the P they took out). */
export interface SingleClaim { readonly tx: Hex; readonly block: bigint; readonly paid: bigint; readonly p?: bigint }
export interface SingleKnown { readonly read?: SingleRead; readonly claim?: SingleClaim }

/** Keep the newest read: a read replaces the stored one only when its block is the same or later. */
export function withSingleRead(known: SingleKnown | undefined, read: SingleRead): SingleKnown {
  if (known?.read && read.block < known.read.block) return known;
  return { ...known, read };
}

/** Record a mined claim; a later claim replaces the earlier one (its block starts the rule over). */
export const withSingleClaim = (known: SingleKnown | undefined, claim: SingleClaim): SingleKnown => ({ ...known, claim });

export type SingleState =
  | { readonly kind: 'claimed'; readonly amount: bigint; readonly p?: bigint }
  | { readonly kind: 'ready'; readonly read: SingleRead }
  | { readonly kind: 'none' | 'unknown' };

const claimedOf = (claim: SingleClaim): SingleState => ({ kind: 'claimed', amount: claim.paid, ...(claim.p !== undefined ? { p: claim.p } : {}) });

export function singleState(known: SingleKnown | undefined): SingleState {
  const read = known?.read; const claim = known?.claim;
  if (claim && (!read || read.block < claim.block)) return claimedOf(claim);
  if (!read) return { kind: 'unknown' };
  if (read.amount > 0n) return { kind: 'ready', read };
  return claim ? claimedOf(claim) : { kind: 'none' };
}

/**
 * One transaction of a Claim all run. Amounts are P, except `coins`, the box's own coin T, the seed return's `amount`,
 * in the pile's own coin `asset` (never added to P), sent by the pile to its recorded seeder `to`, and v2.1's payouts in
 * the box token: a holder batch `inT` and an item's T credit (`item-t`, claimT), both in T (never added to P).
 */
export type ClaimStep =
  | { readonly kind: 'holder'; readonly batch: bigint; readonly amount: bigint; readonly inT?: true }
  | { readonly kind: 'item'; readonly id: bigint; readonly amount: bigint }
  | { readonly kind: 'item-t'; readonly id: bigint; readonly amount: bigint }
  | { readonly kind: 'creator'; readonly amount: bigint }
  /** `collectFirstP` (RC6-RR-INBOX): the inbox P this remainder includes, which its claim first moves into the pot. */
  | { readonly kind: 'remainder'; readonly amount: bigint; readonly collectFirstP?: bigint }
  | { readonly kind: 'approve'; readonly coins: bigint }
  /**
   * A final share with `collectFirstP` (RC6-RR-INBOX) includes that inbox P in `amount`. `amount` null only on a mined
   * hand-in whose receipt named no P (claim-reads.ts `claimed`): a step to sign always carries its P (SH-RC7 item 29).
   */
  | { readonly kind: 'hand-in'; readonly coins: bigint; readonly amount: bigint | null; readonly collectFirstP?: bigint }
  | { readonly kind: 'seed-return'; readonly amount: bigint; readonly asset: Address; readonly to: Address };

/** A failed coin pile's seed owed back to its recorded seeder (M363-OC03), as the snapshot reads it. */
export interface SeedOwed { readonly amount: bigint; readonly asset: Address; readonly to: Address }

export interface BoxClaimsInput {
  /** Ready holder batches and items with their exact claimable amount (claimableNow / claimableItem), in P or `inT`. */
  readonly holder: readonly { readonly batch: bigint; readonly amount: bigint; readonly inT?: boolean }[];
  readonly items: readonly { readonly id: bigint; readonly amount: bigint }[];
  /** v2.1 step 2: items' credit in the box token, claimed apart from their P credit. */
  readonly itemsT?: readonly { readonly id: bigint; readonly amount: bigint }[];
  readonly creator: SingleState;
  readonly remainder: SingleState;
  readonly handIn: SingleState;
  /** The seed return, only for the recorded seeder of a failed pile with a backed seed due; absent elsewhere. */
  readonly seed?: { readonly state: SingleState; readonly owed: SeedOwed | null };
}

const byId = <T>(id: (item: T) => bigint) => (a: T, b: T) => { const x = id(a); const y = id(b); return x < y ? -1 : x > y ? 1 : 0; };

/**
 * One box's steps, in the order they run: holder batches and items (ascending; an item's T credit after its P credit),
 * the creator's fees, the creator's remainder, then the hand-in: its approval when the coordinator may not yet take the
 * coins, and the hand-in itself; last the seed return, in the pile's own coin. Amounts of zero never make a step.
 */
export function boxSteps(input: BoxClaimsInput): ClaimStep[] {
  const items = [
    ...input.items.filter((i) => i.amount > 0n).map((i) => ({ kind: 'item' as const, id: i.id, amount: i.amount })),
    ...(input.itemsT ?? []).filter((i) => i.amount > 0n).map((i) => ({ kind: 'item-t' as const, id: i.id, amount: i.amount })),
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.kind === b.kind ? 0 : a.kind === 'item' ? -1 : 1));
  const steps: ClaimStep[] = [
    ...[...input.holder].filter((h) => h.amount > 0n).sort(byId((h) => h.batch)).map((h) => ({ kind: 'holder' as const, batch: h.batch, amount: h.amount, ...(h.inT ? { inT: true as const } : {}) })),
    ...items,
  ];
  if (input.creator.kind === 'ready') steps.push({ kind: 'creator', amount: input.creator.read.amount });
  if (input.remainder.kind === 'ready') {
    const { amount, collectFirstP } = input.remainder.read;
    steps.push({ kind: 'remainder', amount, ...(collectFirstP !== undefined ? { collectFirstP } : {}) });
  }
  if (input.handIn.kind === 'ready') {
    const { amount: coins, pOut, approved = 0n, collectFirstP } = input.handIn.read;
    // SH-RC7 item 29: every read of a hand-in carries its quote (the final share's includes the inbox's readable P), so
    // one without it is no step: never a 0, never an unpriced share. A priced one names the inbox P it includes.
    if (pOut !== undefined) {
      if (approved < coins) steps.push({ kind: 'approve', coins });
      steps.push({ kind: 'hand-in', coins, amount: pOut, ...(collectFirstP !== undefined ? { collectFirstP } : {}) });
    }
  }
  const seed = input.seed;
  if (seed?.owed && seed.state.kind === 'ready') steps.push({ kind: 'seed-return', amount: seed.state.read.amount, asset: seed.owed.asset, to: seed.owed.to });
  return steps;
}

/**
 * The P a step pays this wallet (an approval pays nothing; the seed return pays the pile's own coin, a T payout T), or
 * null when unknown: only a mined hand-in whose receipt named no P, which no sum may count.
 */
export const stepP = (step: ClaimStep): bigint | null => (step.kind === 'approve' || step.kind === 'seed-return' || step.kind === 'item-t' || (step.kind === 'holder' && step.inT) ? 0n : step.amount);
/** The box token T a step pays this wallet: a holder batch or item credit paid in T (v2.1 step 2); never the hand-in's coins, which go in. */
export const stepT = (step: ClaimStep): bigint => (step.kind === 'item-t' || (step.kind === 'holder' && step.inT) ? step.amount : 0n);

/** Claims a person counts: every step but the approval, which only lets the hand-in take the coins. */
export const claimCount = (steps: readonly ClaimStep[]): number => steps.filter((step) => step.kind !== 'approve').length;

const stepKey = (step: ClaimStep): string =>
  step.kind === 'holder' ? `holder:${step.batch}:${step.amount}${step.inT ? ':t' : ''}` : step.kind === 'item' || step.kind === 'item-t' ? `${step.kind}:${step.id}:${step.amount}`
    : step.kind === 'approve' ? `approve:${step.coins}` : step.kind === 'hand-in' ? `hand-in:${step.coins}:${step.amount ?? 'unknown'}`
      : step.kind === 'seed-return' ? `seed-return:${step.asset.toLowerCase()}:${step.to.toLowerCase()}:${step.amount}` : `${step.kind}:${step.amount}`;

export interface PlannedBox<B> { readonly key: string; readonly box: B; readonly steps: readonly ClaimStep[] }
export interface ListEntry<B> { readonly key: string; readonly box: B; readonly step: ClaimStep }

/** Every box's steps, one box after another, in the order given. */
export const claimList = <B>(boxes: readonly PlannedBox<B>[]): ListEntry<B>[] => boxes.flatMap(({ key, box, steps }) => steps.map((step) => ({ key, box, step })));

/** What a confirmation named, exactly: any change of a box, step or amount since then means a fresh look. */
export const listSignature = <B>(list: readonly ListEntry<B>[]): string => list.map((entry) => `${entry.key}|${stepKey(entry.step)}`).join(';');
