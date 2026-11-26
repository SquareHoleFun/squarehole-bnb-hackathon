/**
 * Display helpers for the FIT pair page. Amounts stay bigint or decimal strings and are TRUNCATED, never rounded up
 * (they never overstate). Charges go the other way: a fee or tax is rounded UP, so it is never understated
 * (`formatTaxPips`). Only bounded drawing numbers (basis points, pips, block counts for text) are JS numbers.
 */
import { formatTokenAmount } from '@squarehole/domain';

/** "1.2345" (ETH, truncated to `digits` decimals, without the unit). */
export function ethDecimal(raw: bigint, digits = 4): string {
  return formatTokenAmount(raw, 18, { maxFractionDigits: digits });
}

/** "4.206980085": a raise (a curve's target) with every digit it has. F74 U5: one raise for every box, stated exactly. */
export const raiseDecimal = (raw: bigint): string => ethDecimal(raw, 18);

/** "1.2345 ETH" (truncated to `digits` decimals). */
export function formatEth(raw: bigint, digits = 4): string {
  return `${ethDecimal(raw, digits)} ETH`;
}

/** "148,550,043.97 RHT2", or compact "148.5M RHT2": an 18-decimal amount in the market's token symbol. */
export function formatToken(raw: bigint, symbol: string, options: { compact?: boolean; digits?: number } = {}): string {
  return `${formatTokenAmount(raw, 18, { maxFractionDigits: options.digits ?? 2, compact: options.compact ?? false })} ${symbol}`;
}

/** "148,550,043.97 FIT", or compact "148.5M FIT". */
export function formatFit(raw: bigint, options: { compact?: boolean; digits?: number } = {}): string {
  return formatToken(raw, 'FIT', options);
}

const SHORT_UNITS: readonly (readonly [exponent: bigint, suffix: string])[] = [
  [9n, 'B'],
  [6n, 'M'],
  [3n, 'K'],
];

/**
 * A token figure short enough for a phone-width tile, in the market's token symbol, two truncated decimals with a
 * suffix from a thousand up: 1,079,101.56 RHT2 → "1.07M RHT2", 501,312,000 FIT → "501.31M FIT"; below a thousand as
 * `formatToken`. Never overstates.
 */
export function formatTokenShort(raw: bigint, symbol: string): string {
  const scale = 10n ** 18n;
  for (const [exponent, suffix] of SHORT_UNITS) {
    const unit = scale * 10n ** exponent;
    if (raw >= unit) {
      const hundredths = (raw * 100n) / unit;
      const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
      return `${formatCount(hundredths / 100n)}${fraction ? `.${fraction}` : ''}${suffix} ${symbol}`;
    }
  }
  return formatToken(raw, symbol);
}

/** `formatTokenShort` in FIT: 1,079,101.56 FIT → "1.07M FIT". */
export function formatFitShort(raw: bigint): string {
  return formatTokenShort(raw, 'FIT');
}

/** Basis points as a percentage with one truncated decimal: 5,012 → "50.1%". */
export function formatBps(bps: number): string {
  const clamped = Math.max(0, Math.min(10_000, Math.trunc(bps)));
  return `${Math.trunc(clamped / 100)}.${Math.trunc((clamped % 100) / 10)}%`;
}

/**
 * A charge in pips (the launch tax) as a percentage with two decimals, rounded UP: 931,974 → "93.20%", 80,565 →
 * "8.06%". A fee disclosure never understates what is taken; `LaunchTaxRouter.taxFor` rounds the tax up as well.
 */
export function formatTaxPips(pips: number): string {
  const clamped = Math.max(0, Math.min(1_000_000, Math.trunc(pips)));
  const hundredths = Math.ceil(clamped / 100);
  return `${Math.trunc(hundredths / 100)}.${(hundredths % 100).toString().padStart(2, '0')}%`;
}

export function formatBlock(block: bigint): string {
  return block.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatCount(value: bigint): string {
  return formatBlock(value);
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * A decimal string cut to `digits` significant digits (truncated): "0.00000000137466052" → "0.0000000013746". Whole
 * numbers keep every integer digit.
 */
export function significant(decimal: string, digits = 5): string {
  const match = DECIMAL.exec(decimal);
  if (!match) return decimal;
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (whole !== '0') {
    const room = Math.max(0, digits - whole.replace(/^0+/, '').length);
    const kept = fraction.slice(0, room).replace(/0+$/, '');
    return kept ? `${whole}.${kept}` : whole;
  }
  const lead = fraction.search(/[1-9]/);
  if (lead < 0) return '0';
  const kept = fraction.slice(0, lead + digits).replace(/0+$/, '');
  return `0.${kept}`;
}

/** decimal × 10^shift, exactly (a string shift): "0.0000000013746" × 10^6 → "0.0013746". */
export function shiftDecimal(decimal: string, shift: number): string {
  const match = DECIMAL.exec(decimal);
  if (!match || shift < 0) return decimal;
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(shift, '0');
  const newWhole = `${whole}${fraction.slice(0, shift)}`.replace(/^0+(?=\d)/, '');
  const rest = fraction.slice(shift).replace(/0+$/, '');
  return rest ? `${newWhole}.${rest}` : newWhole;
}

/** "0x2D9f…BE01". */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * How long before the newest block a trade's block was, truncated (never rounded up): "now" (the same block),
 * "36 s ago", "4 min ago", "3 h ago", "2 d ago". Counted from the newest block's timestamp, not the reader's clock, so
 * a Demo chain with invented times and a quiet real chain both read right; the exact UTC time goes in a title.
 */
export function formatAgo(seconds: bigint): string {
  if (seconds <= 0n) return 'now';
  if (seconds < 60n) return `${seconds} s ago`;
  if (seconds < 3_600n) return `${seconds / 60n} min ago`;
  if (seconds < 86_400n) return `${seconds / 3_600n} h ago`;
  return `${seconds / 86_400n} d ago`;
}

/** A block timestamp as an ISO string for `<time dateTime>` (null when it is out of the Date range). */
export function isoTime(unix: bigint): string | null {
  const date = new Date(Number(unix) * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A block's time in UTC, "30 Sep, 03:42:12 UTC" (block timestamps are whole seconds). */
export function formatUtc(unix: bigint, withSeconds = true): string {
  const date = new Date(Number(unix) * 1000);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  const month = date.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  const pad = (value: number) => value.toString().padStart(2, '0');
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}${withSeconds ? `:${pad(date.getUTCSeconds())}` : ''}`;
  return `${date.getUTCDate()} ${month}, ${time} UTC`;
}

/** "12 blocks" / "1 block". */
export function blocks(count: bigint): string {
  return `${formatBlock(count)} ${count === 1n ? 'block' : 'blocks'}`;
}
