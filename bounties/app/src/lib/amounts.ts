// Amounts are bigint in every calculation and strings on screen. No Number or parseFloat touches an amount.

/** The exact decimal string of `value` in units of 10^decimals, without trailing zeros ("1.5", "0.000001", "12"). */
export function toDecimalString(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let out = whole.toString();
  if (decimals > 0 && frac > 0n) {
    out += '.' + frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  }
  return neg ? '-' + out : out;
}

function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * A short display string, always rounded DOWN (never shows more than there is):
 * - at or above 1: up to `maxFraction` decimals (default 4), thousands grouped;
 * - below 1: up to `significant` significant digits (default 4) after the leading zeros, so 0.05 BNB and
 *   0.0000123 BNB both read correctly;
 * - zero: "0".
 */
export function formatAmount(
  value: bigint,
  decimals: number,
  opts: { maxFraction?: number; significant?: number } = {},
): string {
  const maxFraction = opts.maxFraction ?? 4;
  const significant = opts.significant ?? 4;
  const neg = value < 0n;
  const abs = neg ? -value : value;
  if (abs === 0n) return '0';
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fracDigits = decimals > 0 ? (abs % base).toString().padStart(decimals, '0') : '';
  let frac: string;
  if (whole > 0n) {
    frac = fracDigits.slice(0, maxFraction);
  } else {
    const firstNonZero = fracDigits.search(/[1-9]/);
    frac = fracDigits.slice(0, firstNonZero + significant);
  }
  frac = frac.replace(/0+$/, '');
  const s = group(whole.toString()) + (frac ? '.' + frac : '');
  return neg ? '-' + s : s;
}

export type ParseResult = { ok: true; value: bigint } | { ok: false; reason: ParseRefusal };
export type ParseRefusal = 'empty' | 'not-a-number' | 'too-many-decimals' | 'zero';

/**
 * Parses what a person typed into an amount with `decimals` places, exactly. Refuses rather than rounds: more
 * decimals than the unit has is a refusal, not a silent cut. Accepts "1", "1.5", ".5" and surrounding spaces. A comma,
 * a space or any other grouping is refused, never repaired ("1,5" is not 15); negative numbers and exponents are not
 * numbers here.
 */
export function parseAmount(text: string, decimals: number, opts: { allowZero?: boolean } = {}): ParseResult {
  const t = text.trim();
  if (t === '') return { ok: false, reason: 'empty' };
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return { ok: false, reason: 'not-a-number' };
  const [w = '', f = ''] = t.split('.');
  if (f.length > decimals) return { ok: false, reason: 'too-many-decimals' };
  const value = BigInt((w === '' ? '0' : w) + f.padEnd(decimals, '0'));
  if (value === 0n && !opts.allowZero) return { ok: false, reason: 'zero' };
  return { ok: true, value };
}

/** Basis points: 10000 = 100%. */
export const BPS = 10_000n;

/** The least a call may pay out: `quote` minus `slippageBps`, rounded down. */
export function minOut(quote: bigint, slippageBps: bigint): bigint {
  if (slippageBps < 0n || slippageBps > BPS) throw new RangeError('slippage out of range');
  return (quote * (BPS - slippageBps)) / BPS;
}

/** Parses a percentage like "0.5" into basis points (0.01% steps). */
export function parsePercentToBps(text: string): ParseResult {
  const r = parseAmount(text, 2, { allowZero: true });
  if (!r.ok) return r;
  if (r.value > BPS) return { ok: false, reason: 'not-a-number' };
  return r;
}

/** `part / whole` in basis points, rounded down; 0 when whole is 0. */
export function shareBps(part: bigint, whole: bigint): bigint {
  if (whole === 0n) return 0n;
  return (part * BPS) / whole;
}

/** Basis points as a percent string: 125n -> "1.25%". */
export function formatBps(bps: bigint): string {
  return toDecimalString(bps, 2) + '%';
}

/** The pile's redemption rule, mirrored for previews: pile * amount / circulating, rounded down; the whole pile
 * for the whole circulating supply. The page always shows the contract's own `quoteRedeem`; this is for tests and
 * for the picture. */
export function redeemShare(pile: bigint, amount: bigint, circulating: bigint): bigint {
  if (amount === 0n || circulating === 0n) return 0n;
  if (amount >= circulating) return pile;
  return (pile * amount) / circulating;
}
