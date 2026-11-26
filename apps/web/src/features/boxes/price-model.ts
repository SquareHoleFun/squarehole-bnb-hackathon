/**
 * The price picture of a launch box (F49 M1: "token price only"; the founder: "They all cost the same - the thing to
 * understand is the change in price due to NFTs going in and out"). Pure bigint, vault-math.ts only:
 *
 * - FIT per Misfit is the vault's quote for one, ⌈(S − E)/n⌉ (`quoteWithdrawPrincipal`, equal weight F23). Taking one
 *   out locks that principal in the escrow E and lowers n; putting one back releases today's ⌊(S − E)/n⌋ from E and
 *   raises n. So in and out keep the FIT per Misfit (to within a raw unit, rounded in the vault's favour); only FIT
 *   burned (the fees, the buy-and-burn) lowers it, slowly, because S only ever falls (F24 a).
 * - What moves the ETH price of a Misfit is FIT's market price (the pool's); the vault prices in FIT only. The page
 *   never multiplies the two into an "ETH per Misfit" figure (M1), and never says that locking FIT moves its price
 *   (a market prediction; F23 safe wording).
 *
 * All four inputs (S, E, n, N) come from ONE block. When the chain's own `quoteWithdraw(1)` is read and disagrees with
 * this computation, the picture is marked unverified.
 */
import { assertVaultTotals, F23_FEES, flatFee, outsideCount, quoteReturnPrincipal, quoteWithdrawPrincipal, type VaultTotals } from '@squarehole/domain';
import { FIT_ISSUANCE_RAW } from '../fit-pair/fit-target';

export interface PriceInputs {
  /** S: token totalSupply, raw. */
  readonly supply: bigint;
  /** E: principal in the escrow, raw. */
  readonly escrow: bigint;
  /** n: items inside. */
  readonly inside: bigint;
  /** N: the edition size. */
  readonly collectionSize: bigint;
  /** The chain's `quoteWithdraw(1)` at the same block, or null when not read (Demo, an older vault). */
  readonly chainQuoteOne: bigint | null;
  /** The block the inputs were read at (null for Demo). */
  readonly block: bigint | null;
}

export type PriceCheck = 'matches_chain' | 'mismatch' | 'not_checked';

export interface PriceModel {
  /** FIT for one item: ⌈(S − E)/n⌉. Null when n = 1 (the last Misfit stays, F23). */
  readonly fitPerItem: bigint | null;
  /** What putting one back releases today, before the 5% fee: ⌊(S − E)/n⌋. Null when nothing is outside. */
  readonly releasePerItem: bigint | null;
  /** E: FIT locked in the vault for the items outside. */
  readonly locked: bigint;
  /** S − E: FIT outside the vault (what the quote divides). */
  readonly unlocked: bigint;
  /** m = N − n: items outside (placeholders during the curve, Misfits after graduation). */
  readonly outside: bigint;
  /** FIT burned since the one-time issuance (issuance − S); null if S is above the issuance (not a launch token). */
  readonly burned: bigint | null;
  /** The flat fees on one item at today's quote (F23 C3), all burned. */
  readonly fees: { readonly draw: bigint; readonly pick: bigint; readonly putBack: bigint } | null;
  readonly check: PriceCheck;
}

/** The vault totals of a reading, or null when they are not a state the vault can be in. */
export function totalsOf(inputs: PriceInputs): VaultTotals | null {
  const totals: VaultTotals = { supply: inputs.supply, escrow: inputs.escrow, inside: inputs.inside, collectionSize: inputs.collectionSize };
  try {
    assertVaultTotals(totals);
    return totals;
  } catch {
    return null;
  }
}

/** The price picture, or null when the inputs are not a reachable vault state (then the page says "Unavailable"). */
export function priceModel(inputs: PriceInputs, issuance: bigint = FIT_ISSUANCE_RAW): PriceModel | null {
  const totals = totalsOf(inputs);
  if (totals === null) return null;
  const fitPerItem = totals.inside > 1n ? quoteWithdrawPrincipal(totals, 1n) : null;
  const outside = outsideCount(totals);
  let releasePerItem: bigint | null = null;
  if (outside > 0n) {
    try {
      releasePerItem = quoteReturnPrincipal(totals, 1n);
    } catch {
      releasePerItem = null;
    }
  }
  const check: PriceCheck = inputs.chainQuoteOne === null || fitPerItem === null ? 'not_checked' : inputs.chainQuoteOne === fitPerItem ? 'matches_chain' : 'mismatch';
  return Object.freeze({
    fitPerItem,
    releasePerItem,
    locked: totals.escrow,
    unlocked: totals.supply - totals.escrow,
    outside,
    burned: totals.supply <= issuance ? issuance - totals.supply : null,
    fees:
      fitPerItem === null
        ? null
        : Object.freeze({ draw: flatFee(fitPerItem, F23_FEES.drawBps), pick: flatFee(fitPerItem, F23_FEES.pickBps), putBack: flatFee(releasePerItem ?? fitPerItem, F23_FEES.returnBps) }),
    check,
  });
}

/**
 * What taking one out costs, as the page shows it: the chain's own `quoteWithdraw(1)` when it disagrees with this
 * computation (that is what the vault would charge; the page marks it unverified), otherwise the computed quote.
 */
export function chargedQuote(model: PriceModel | null, inputs: PriceInputs | null): bigint | null {
  if (model === null) return null;
  if (model.check === 'mismatch') return inputs?.chainQuoteOne ?? null;
  return model.fitPerItem;
}

/** FIT per item before any burn: ⌈issuance / N⌉ (238,095.238… FIT at 4,200; 234,246.896… at 4,269). */
export function firstQuote(collectionSize: bigint, issuance: bigint = FIT_ISSUANCE_RAW): bigint {
  return quoteWithdrawPrincipal({ supply: issuance, escrow: 0n, inside: collectionSize, collectionSize }, 1n);
}
