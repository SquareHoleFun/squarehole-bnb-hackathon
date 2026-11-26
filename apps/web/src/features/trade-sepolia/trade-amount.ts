/**
 * F156 (SH-ALPHA-TRADE-BOX): the amount a tester types, read as raw units in bigint. No Number, no parseFloat: the text
 * is split at its one dot, the digits are read as integers and the fraction padded to the coin's decimals. A plan
 * refuses an amount from 2^127 up (packages/chain/src/trade-sepolia/trade.ts `invalid_amount`), so the box does too.
 */

/** The largest amount a plan takes: below int128's limit, as the swap's signed amount needs. */
export const MAX_AMOUNT = (1n << 127n) - 1n;

export type AmountRead =
  | { readonly kind: 'empty' }
  | { readonly kind: 'ok'; readonly raw: bigint }
  /** Not a plain decimal number (letters, two dots, a sign, an exponent, commas). */
  | { readonly kind: 'invalid' }
  /** More decimals than the coin has. */
  | { readonly kind: 'too_precise'; readonly decimals: number }
  | { readonly kind: 'zero' }
  | { readonly kind: 'too_large' };

const DECIMAL = /^(?<whole>[0-9]*)(?:\.(?<fraction>[0-9]*))?$/;

/** `text` as raw units of a coin with `decimals` decimals ("1.5" with 18 decimals is 1500000000000000000n). */
export function readAmount(text: string, decimals: number): AmountRead {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) throw new RangeError('decimals must be 0 to 36');
  const typed = text.trim();
  if (typed === '') return { kind: 'empty' };
  const match = DECIMAL.exec(typed);
  const whole = match?.groups?.whole ?? '';
  const fraction = match?.groups?.fraction ?? '';
  if (!match || (whole === '' && fraction === '')) return { kind: 'invalid' };
  // Trailing zeros carry no precision ("1.50" in a coin with one decimal is 1.5).
  const significant = fraction.replace(/0+$/, '');
  if (significant.length > decimals) return { kind: 'too_precise', decimals };
  const raw = BigInt(whole === '' ? '0' : whole) * 10n ** BigInt(decimals) + (significant === '' ? 0n : BigInt(significant.padEnd(decimals, '0')));
  if (raw === 0n) return { kind: 'zero' };
  if (raw > MAX_AMOUNT) return { kind: 'too_large' };
  return { kind: 'ok', raw };
}

/** Raw units as an exact decimal: every digit, no trailing zeros ("1500000000000000000n" with 18 decimals is "1.5"). */
export function exactAmount(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const units = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = decimals === 0 ? '' : (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * The tolerance a tester types, in percent, as basis points: "2" is 200, "0.1" is 10, "0.15" is 15. Two decimals at
 * most (one basis point); the plan takes 10 to 2,000 (0.1% to 20%), so anything outside is null.
 */
export function readTolerance(text: string): bigint | null {
  const read = readAmount(text, 2);
  if (read.kind !== 'ok') return null;
  return read.raw >= 10n && read.raw <= 2_000n ? read.raw : null;
}

/** Basis points as the percent the box shows: 200 is "2%", 15 is "0.15%". */
export const tolerancePercent = (bps: bigint): string => `${exactAmount(bps, 2)}%`;
