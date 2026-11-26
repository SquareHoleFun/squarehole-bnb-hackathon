/**
 * v2 lock/release vault arithmetic (v2 T05; square-hole-core-v2/docs/03-ESCROW-AND-INVARIANTS.md). bigint only.
 *
 * Reference: the preserved integer oracle `square-hole-core-v2/reference/v0_1/model.py` (class `Vault`). Every
 * function here matches it raw unit for raw unit; `vault-oracle.differential.test.ts` checks that on random traces.
 *
 * Founder answers that shape this module (docs/decisions/DECISION-LOG.md F23, 2026-09-28):
 * - Equal weight: every Misfit converts at the same current rate r = (S − E) / n. No tiers, no per-NFT deposits.
 * - The last Misfit cannot leave the vault (v2-G04, the oracle's `block_last` policy), so n ≥ 1 in every state.
 * - FIT may be sent to the vault outside a conversion. It is NOT part of E, so it never changes a quote; it stays in
 *   the vault as permanent surplus and nothing can move it out (v2-G06). See `unsolicitedFit`.
 * - Per-Misfit FIT stream: a Misfit's share is burned while it is inside and credited to its owner while outside.
 *
 * Flat fees (F23 C3; ADR-0014 § G05; placeholder tickets stage 1): draw 1% (every ticket), named pick 25%, return 5%
 * (a Misfit return, and a ticket handed back while the gate is closed), each `ceil(p × bps ÷ 10,000)` of the principal
 * p and burned after the principal moves, at the new occupancy. `NO_FEES` keeps the v2 docs/03 normative examples
 * fee-free. The principal quotes below never include a fee; `quoteTake`, `quoteHandBack`, `quotePick` and
 * `quoteReturnNet` add or withhold it.
 *
 * Symbols (docs/03): S FIT totalSupply · E FIT principal locked by withdrawals · A = S − E · n Misfits inside ·
 * N fixed collection size · m = N − n outside · r = A / n · L = m·r (owed to outside Misfits) · K = E − L (stuck
 * surplus, never spent) · U = N·r = S − K (all-return envelope; not supply, not a value).
 */
import { VaultRuleError } from './errors';

/** An exact non-negative rational in lowest terms; `den` is always positive. Never rounded into a payout. */
export interface ExactRatio {
  readonly num: bigint;
  readonly den: bigint;
}

/** The four numbers every quote depends on, read from one pre-operation state. */
export interface VaultTotals {
  /** S: FIT totalSupply in raw units. Burns are the only thing that lowers it. */
  readonly supply: bigint;
  /** E: FIT principal locked in the conversion escrow by withdrawals. Excludes unsolicited FIT (F23). */
  readonly escrow: bigint;
  /** n: Misfits inside the vault. */
  readonly inside: bigint;
  /** N: the fixed collection size. */
  readonly collectionSize: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** `num / den` in lowest terms. Rejects a negative numerator or a non-positive denominator. */
export function exactRatio(num: bigint, den: bigint): ExactRatio {
  if (den <= 0n || num < 0n) throw new VaultRuleError('invalid_totals', 'ratio needs num ≥ 0 and den > 0');
  const g = gcd(num, den);
  return g > 1n ? { num: num / g, den: den / g } : { num, den };
}

/** ⌈a / b⌉ for a ≥ 0, b > 0 (the oracle's `ceil_div`). */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (a < 0n || b <= 0n) throw new VaultRuleError('invalid_totals', 'ceilDiv needs a ≥ 0 and b > 0');
  return (a + b - 1n) / b;
}

/**
 * Rejects totals no reachable F23 state can have: negative values, E > S, n outside 1..N, or fewer than one raw FIT
 * per inside Misfit (A < n). With n ≥ 1 guaranteed, (S − E) / n is always defined.
 */
export function assertVaultTotals(t: VaultTotals): void {
  const { supply: s, escrow: e, inside: n, collectionSize: total } = t;
  if (s < 0n || e < 0n || e > s) throw new VaultRuleError('invalid_totals', 'need 0 ≤ E ≤ S');
  if (total < 1n || n < 1n || n > total) throw new VaultRuleError('invalid_totals', 'need 1 ≤ n ≤ N (F23: the last Misfit stays)');
  if (s - e < n) throw new VaultRuleError('invalid_totals', 'need at least one raw FIT per inside Misfit (A ≥ n)');
}

/** m = N − n: Misfits outside the vault. */
export function outsideCount(t: VaultTotals): bigint {
  assertVaultTotals(t);
  return t.collectionSize - t.inside;
}

/** A = S − E: all FIT outside the principal escrow (wallets, pool, treasury, stream reserve, unsolicited FIT). */
export function activeSupply(t: VaultTotals): bigint {
  assertVaultTotals(t);
  return t.supply - t.escrow;
}

/** r = (S − E) / n, exact. The same pre-operation rate prices both directions (VLT-01). */
export function conversionRate(t: VaultTotals): ExactRatio {
  return exactRatio(activeSupply(t), t.inside);
}

function checkCount(count: bigint, available: bigint): void {
  if (count <= 0n || count > available) {
    throw new VaultRuleError('invalid_quantity', `count must be between 1 and ${available}`);
  }
}

/**
 * FIT principal to withdraw `count` Misfits: ⌈A·k / n⌉ (rounds up, in the vault's favour). Withdrawing every Misfit
 * left is refused (F23: the last Misfit cannot leave).
 */
export function quoteWithdrawPrincipal(t: VaultTotals, count: bigint): bigint {
  const a = activeSupply(t);
  checkCount(count, t.inside);
  if (count === t.inside) throw new VaultRuleError('last_misfit', 'the last Misfit cannot leave the vault (F23)');
  return ceilDiv(a * count, t.inside);
}

/**
 * FIT principal released for returning `count` Misfits: ⌊A·k / n⌋ (rounds down, in the vault's favour). Refused when
 * it would pay less than one raw unit per Misfit.
 */
export function quoteReturnPrincipal(t: VaultTotals, count: bigint): bigint {
  const a = activeSupply(t);
  checkCount(count, t.collectionSize - t.inside);
  const amount = (a * count) / t.inside;
  if (amount < count) throw new VaultRuleError('return_below_unit', 'return quote below one raw unit per Misfit');
  return amount;
}

/** L = m·r: what the escrow owes the outside Misfits at the current rate (exact). */
export function escrowObligation(t: VaultTotals): ExactRatio {
  return exactRatio(outsideCount(t) * activeSupply(t), t.inside);
}

/** Exact solvency, cross-multiplied: E·n ≥ m·A. */
export function isEscrowSolvent(t: VaultTotals): boolean {
  return t.escrow * t.inside >= outsideCount(t) * activeSupply(t);
}

/** K = E − L: principal surplus that is permanently stuck (exact). Not a budget; nothing may spend it. */
export function escrowSurplus(t: VaultTotals): ExactRatio {
  const diff = t.escrow * t.inside - outsideCount(t) * activeSupply(t);
  if (diff < 0n) throw new VaultRuleError('escrow_insolvent', 'escrow below the outside obligation');
  return exactRatio(diff, t.inside);
}

/** U = N·r = S − K: the hypothetical FIT released if every Misfit came back at today's rate. Not supply, not a value. */
export function allReturnEnvelope(t: VaultTotals): ExactRatio {
  return exactRatio(t.collectionSize * activeSupply(t), t.inside);
}

/**
 * Dust guard for any burn of non-escrow FIT (the oracle's proposed guard, not yet a v2-G05 decision): a burn may not
 * leave fewer than one raw FIT per inside Misfit, so r never reaches zero.
 */
export function assertBurnKeepsUnit(t: VaultTotals, amount: bigint): void {
  if (amount < 0n) throw new VaultRuleError('invalid_amount', 'burn amount must be ≥ 0');
  if (activeSupply(t) - amount < t.inside) {
    throw new VaultRuleError('dust_guard', 'burn would leave less than one raw FIT per inside Misfit');
  }
}

/**
 * F23: FIT sitting in the vault beyond the tracked principal E. It came from plain transfers, not conversions. It is
 * never part of a quote, never paid out and never swept, so it is permanent surplus on top of K.
 */
export function unsolicitedFit(vaultBalance: bigint, escrow: bigint): bigint {
  if (escrow < 0n || vaultBalance < escrow) {
    throw new VaultRuleError('escrow_insolvent', 'vault FIT balance is below the tracked principal');
  }
  return vaultBalance - escrow;
}

/** How one funded FIT stream budget splits across the N Misfit slots (F23 A3). */
export interface SlotStreamSplit {
  /** ⌊budget·n / N⌋: the inside Misfits' share, burned. */
  readonly burned: bigint;
  /** ⌊budget·count / N⌋ per outside owner (the oracle floors per owner, not per Misfit). */
  readonly credits: ReadonlyMap<string, bigint>;
  /** Sum of `credits`. */
  readonly credited: bigint;
  /** budget − burned − credited: rounding dust that stays with the source. */
  readonly dust: bigint;
}

/**
 * Split `budget` FIT across the N slots: inside slots burn, outside slots credit their current owner. `outsideCounts`
 * must add up to N − n. Owners with a zero count get nothing and no entry.
 */
export function splitSlotStream(
  budget: bigint,
  inside: bigint,
  collectionSize: bigint,
  outsideCounts: ReadonlyMap<string, bigint>,
): SlotStreamSplit {
  if (budget < 0n) throw new VaultRuleError('invalid_amount', 'stream budget must be ≥ 0');
  if (collectionSize < 1n || inside < 1n || inside > collectionSize) {
    throw new VaultRuleError('invalid_totals', 'need 1 ≤ n ≤ N');
  }
  let counted = 0n;
  const credits = new Map<string, bigint>();
  for (const [owner, count] of outsideCounts) {
    if (count < 0n) throw new VaultRuleError('invalid_totals', 'owner counts must be ≥ 0');
    counted += count;
    if (count > 0n) credits.set(owner, (budget * count) / collectionSize);
  }
  if (counted !== collectionSize - inside) throw new VaultRuleError('invalid_totals', 'owner counts must add up to N − n');
  const burned = (budget * inside) / collectionSize;
  const credited = [...credits.values()].reduce((sum, value) => sum + value, 0n);
  return { burned, credits, credited, dust: budget - burned - credited };
}

// ---------------------------------------------------------------------------------------------------------------
// Flat fees and ticket quotes (F23 C3; ADR-0014 § G05; F36 a, placeholder tickets stage 1).

/** Basis points in 100%. */
export const FEE_BPS_DENOMINATOR = 10_000n;

/** The flat conversion fees, in basis points of the principal. Every fee is burned (FIT, never kept). */
export interface VaultFeeSchedule {
  /** Every ticket: a placeholder during the curve, a draw after graduation, a terminal take by number. F23: 1%. */
  readonly drawBps: bigint;
  /** A named pick of a revealed shelf Misfit. F23: 25%. */
  readonly pickBps: bigint;
  /** A Misfit return, and a ticket handed back while the gate is closed. F23: 5%. */
  readonly returnBps: bigint;
}

/** `none`: the v2 docs/03 normative examples (fee-free). `flat-f23`: the founder's rates (F23 C3, F24 e). */
export type VaultFeePolicy = 'none' | 'flat-f23';

export const NO_FEES: VaultFeeSchedule = Object.freeze({ drawBps: 0n, pickBps: 0n, returnBps: 0n });
export const F23_FEES: VaultFeeSchedule = Object.freeze({ drawBps: 100n, pickBps: 2_500n, returnBps: 500n });

export function feeSchedule(policy: VaultFeePolicy): VaultFeeSchedule {
  return policy === 'none' ? NO_FEES : F23_FEES;
}

/** ceil(p × bps ÷ 10,000): fees round up, in the vault's favour, by less than one raw unit (ADR-0014 § G05). */
export function flatFee(principal: bigint, bps: bigint): bigint {
  if (principal < 0n) throw new VaultRuleError('invalid_amount', 'principal must be ≥ 0');
  if (bps < 0n || bps > FEE_BPS_DENOMINATOR) throw new VaultRuleError('invalid_amount', 'fee rate must be 0 … 10,000 bps');
  return ceilDiv(principal * bps, FEE_BPS_DENOMINATOR);
}

/** What a caller pays: the principal locked into E plus the fee burned. */
export interface ChargedQuote {
  readonly principal: bigint;
  readonly fee: bigint;
  readonly total: bigint;
}

/** What a caller receives: the principal released from E less the fee burned. */
export interface ReleaseQuote {
  readonly principal: bigint;
  readonly fee: bigint;
  readonly net: bigint;
}

/**
 * k tickets (placeholders or draws): ⌈A·k/n⌉ plus the draw fee. The Misfit is chosen later, so a ticket needs an
 * unreserved hidden Misfit for each k (`hidden` = h); the shelf never serves a ticket. Refusals in the vault's order:
 * invalid_quantity, last_misfit, no_hidden.
 */
export function quoteTake(t: VaultTotals, count: bigint, hidden: bigint, fees: VaultFeeSchedule): ChargedQuote {
  const principal = quoteWithdrawPrincipal(t, count);
  if (count > hidden) throw new VaultRuleError('no_hidden', 'not enough unreserved hidden Misfits for the tickets');
  const fee = flatFee(principal, fees.drawBps);
  return { principal, fee, total: principal + fee };
}

/**
 * k tickets handed back (`tickets` = t pending): ⌊A·k/n⌋, less the return fee while the gate is closed (a hand-back
 * during the curve) and fee-free once it is open (a cancel after graduation) or once the coordinator has waived that
 * fee (`feeFree`: the gate is open or the fee is waived; F38 4). The draw fee is never refunded.
 */
export function quoteHandBack(
  t: VaultTotals,
  count: bigint,
  tickets: bigint,
  feeFree: boolean,
  fees: VaultFeeSchedule,
): ReleaseQuote {
  if (count <= 0n || count > tickets) throw new VaultRuleError('invalid_quantity', `count must be between 1 and ${tickets}`);
  const principal = quoteReturnPrincipal(t, count);
  const fee = feeFree ? 0n : flatFee(principal, fees.returnBps);
  return { principal, fee, net: principal - fee };
}

/** A named pick of k revealed shelf Misfits: ⌈A·k/n⌉ plus 25%. */
export function quotePick(t: VaultTotals, count: bigint, fees: VaultFeeSchedule): ChargedQuote {
  const principal = quoteWithdrawPrincipal(t, count);
  const fee = flatFee(principal, fees.pickBps);
  return { principal, fee, total: principal + fee };
}

/** A return of k revealed Misfits: ⌊A·k/n⌋ less 5%. */
export function quoteReturnNet(t: VaultTotals, count: bigint, fees: VaultFeeSchedule): ReleaseQuote {
  const principal = quoteReturnPrincipal(t, count);
  const fee = flatFee(principal, fees.returnBps);
  return { principal, fee, net: principal - fee };
}

/**
 * The fee burn after a conversion, checked at the state after the operation (the principal has moved, n has
 * changed): the burn may not leave fewer than one raw FIT per inside Misfit. `after` is the post-operation state
 * before the burn. The same rule FIT enforces on every burn (supply floor E + n).
 */
export function assertFeeBurnKeepsUnit(after: VaultTotals, fee: bigint): void {
  if (fee === 0n) return;
  if (after.supply - after.escrow - fee < after.inside) {
    throw new VaultRuleError('dust_guard', 'the fee burn would leave less than one raw FIT per inside Misfit');
  }
}

/** The vault's counts (placeholder tickets): n = h + s, m = outside Misfits + t. */
export interface VaultCountTotals {
  readonly collectionSize: bigint;
  /** n. */
  readonly inside: bigint;
  /** h: Misfits never out of the vault and not reserved by a ticket. */
  readonly hidden: bigint;
  /** t: tickets pending (reserved, not yet delivered). */
  readonly tickets: bigint;
}

/**
 * Checks the stage-1 count identities and returns the shelf s = n − h and the Misfits outside m − t: 0 ≤ h ≤ n,
 * t ≥ 0 and n + t ≤ N.
 */
export function assertVaultCounts(c: VaultCountTotals): { readonly shelf: bigint; readonly misfitsOutside: bigint } {
  const { collectionSize: total, inside: n, hidden: h, tickets: t } = c;
  if (h < 0n || h > n) throw new VaultRuleError('invalid_totals', 'need 0 ≤ h ≤ n');
  if (t < 0n || n + t > total) throw new VaultRuleError('invalid_totals', 'need t ≥ 0 and n + t ≤ N');
  return { shelf: n - h, misfitsOutside: total - n - t };
}
