/**
 * docs/03 identities and derived vault quantities, computed from the raw state fields alone (v2 T06). Test-only.
 *
 * Deliberately independent of `vault-math.ts`: the reference runner derives r, L, K, U and the quotes with the
 * domain functions, and the law checker (`laws.ts`) recomputes them here, so an error in one path shows up as a
 * disagreement instead of being copied into both.
 */
import type { ExactRational, QuoteOutcome, TraceIdentities } from './format';

export interface CoreTotals {
  /** S, E, D, N, n and the sum of ordinary balances (accounts only). */
  readonly supply: bigint;
  readonly escrow: bigint;
  readonly unsolicited: bigint;
  readonly collectionSize: bigint;
  readonly inside: bigint;
  readonly accountsTotal: bigint;
  readonly claimsReserve: bigint;
  readonly burned: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** num/den in lowest terms as decimal strings; num ≥ 0, den > 0. */
export function rational(num: bigint, den: bigint): ExactRational {
  if (den <= 0n || num < 0n) throw new Error(`not a non-negative rational: ${num}/${den}`);
  const g = gcd(num, den);
  return { num: (num / g).toString(), den: (den / g).toString() };
}

export function identityTerms(t: CoreTotals): TraceIdentities {
  const n = t.inside;
  const m = t.collectionSize - n;
  const a = t.supply - t.escrow;
  const en = t.escrow * n;
  const ma = m * a;
  return {
    En: en.toString(),
    mA: ma.toString(),
    Kn: (en - ma).toString(),
    Sn: (t.supply * n).toString(),
    NA: (t.collectionSize * a).toString(),
    held: (t.accountsTotal + t.escrow + t.unsolicited + t.claimsReserve).toString(),
    issued: (t.supply + t.burned).toString(),
    vaultFitN: ((t.escrow + t.unsolicited) * n).toString(),
  };
}

/** r, L, K, U exactly (docs/03 definitions). Needs n ≥ 1, which block-last guarantees. */
export function derivedRationals(t: CoreTotals): {
  readonly rate: ExactRational;
  readonly obligation: ExactRational;
  readonly surplus: ExactRational;
  readonly envelope: ExactRational;
} {
  const n = t.inside;
  const m = t.collectionSize - n;
  const a = t.supply - t.escrow;
  return {
    rate: rational(a, n),
    obligation: rational(m * a, n),
    surplus: rational(t.escrow * n - m * a, n),
    envelope: rational(t.collectionSize * a, n),
  };
}

/** One-Misfit quotes from the pre-operation state, with the reference refusal codes. */
export function oneMisfitQuotes(t: CoreTotals): { readonly withdraw: QuoteOutcome; readonly ret: QuoteOutcome } {
  const n = t.inside;
  const m = t.collectionSize - n;
  const a = t.supply - t.escrow;
  const withdraw: QuoteOutcome = n <= 1n ? { error: 'last_misfit' } : { ok: ((a + n - 1n) / n).toString() };
  let ret: QuoteOutcome;
  if (m < 1n) ret = { error: 'invalid_quantity' };
  else if (a / n < 1n) ret = { error: 'return_below_unit' };
  else ret = { ok: (a / n).toString() };
  return { withdraw, ret };
}

/** F23 C3 in basis points, per fee policy (independent of `vault-math.ts`'s schedule on purpose). */
export function feeBps(policy: 'none' | 'flat-f23'): { readonly draw: bigint; readonly pick: bigint; readonly ret: bigint } {
  return policy === 'none' ? { draw: 0n, pick: 0n, ret: 0n } : { draw: 100n, pick: 2_500n, ret: 500n };
}

/** ceil(p·bps / 10,000) (ADR-0014 § G05). */
export const feeOf = (principal: bigint, bps: bigint): bigint => (principal * bps + 9_999n) / 10_000n;

/** One ticket from the pre-operation state: ⌈A/n⌉ + draw fee, or last_misfit (n = 1) / no_hidden (h = 0). */
export function oneTicketQuote(t: CoreTotals, hidden: bigint, drawBps: bigint): QuoteOutcome {
  const n = t.inside;
  if (n <= 1n) return { error: 'last_misfit' };
  if (hidden < 1n) return { error: 'no_hidden' };
  const a = t.supply - t.escrow;
  const principal = (a + n - 1n) / n;
  return { ok: (principal + feeOf(principal, drawBps)).toString() };
}

/**
 * Round-trip loss for k Misfits with no quote-changing event between withdraw and return (VLT-06), from the withdraw's
 * pre-state (A, n): the withdraw locks c = ⌈A·k/n⌉; with ε = c·n − A·k ∈ [0, n−1] the return releases c − ⌈ε/(n−k)⌉.
 * So the loss is exactly ⌈ε/(n−k)⌉ ≥ 0 (never a profit) and at most ⌈(n−1)/(n−k)⌉ (1 raw unit for k = 1).
 */
export function roundTripLoss(active: bigint, inside: bigint, k: bigint): { readonly loss: bigint; readonly bound: bigint } {
  const c = (active * k + inside - 1n) / inside;
  const epsilon = c * inside - active * k;
  const rest = inside - k;
  return { loss: (epsilon + rest - 1n) / rest, bound: (inside - 1n + rest - 1n) / rest };
}
