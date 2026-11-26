/**
 * Decimal-safe amounts. Raw on-chain quantities are unsigned decimal strings in data and `bigint` in logic;
 * USD values and prices are non-negative decimal strings handled as scaled bigints. JavaScript `Number` and
 * floats are never used for money (AGENTS.md "Security boundaries", 03-FEED "Economic quantities").
 *
 * Display rounding mode: TRUNCATION toward zero. All displayed amounts are non-negative, so a displayed value is
 * always <= the exact value (it never overstates a balance, supply, cap or turnover). A positive value that
 * truncates to zero is shown as "<" + the smallest step instead of a fake zero.
 */
import { AmountError } from './errors';
import type { DecimalAmount, PairRecord, RawAmount } from './types';

export const RAW_AMOUNT_PATTERN = /^(0|[1-9][0-9]*)$/;
export const DECIMAL_AMOUNT_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
/** Matches `feed.schema.json` (`decimals` maximum 36). */
export const MAX_TOKEN_DECIMALS = 36;
export const DISPLAY_ROUNDING = 'truncate';

/** Exact non-negative decimal: `units / 10^scale`. */
export interface ScaledDecimal {
  readonly units: bigint;
  readonly scale: number;
}

const pow10 = (exponent: number): bigint => 10n ** BigInt(exponent);

function assertDecimals(decimals: number, label = 'decimals'): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) {
    throw new AmountError('invalid_decimals', `${label} must be an integer between 0 and ${MAX_TOKEN_DECIMALS}`);
  }
}

export function isRawAmount(value: unknown): value is RawAmount {
  return typeof value === 'string' && RAW_AMOUNT_PATTERN.test(value);
}

/** Strict `^(0|[1-9][0-9]*)$` parse: no sign, spaces, exponent, hex, separators or leading zeros. */
export function parseRawAmount(value: string): bigint {
  if (!isRawAmount(value)) {
    throw new AmountError('malformed_raw_amount', 'Raw amount must be an unsigned decimal integer string');
  }
  return BigInt(value);
}

export function toRawAmount(value: bigint): RawAmount {
  if (value < 0n) throw new AmountError('negative_amount', 'Raw amounts are unsigned');
  return value.toString();
}

function toRawBigint(raw: RawAmount | bigint): bigint {
  if (typeof raw === 'bigint') {
    if (raw < 0n) throw new AmountError('negative_amount', 'Raw amounts are unsigned');
    return raw;
  }
  return parseRawAmount(raw);
}

/**
 * Demo-only initial supply = current post-burn supply + burned (ADR-0003 "Supply"). Must be labelled as derived.
 */
export function derivedInitialSupplyRaw(totalSupplyRaw: RawAmount, burnedRaw: RawAmount): RawAmount {
  return toRawAmount(parseRawAmount(totalSupplyRaw) + parseRawAmount(burnedRaw));
}

export function isDecimalAmount(value: unknown): value is DecimalAmount {
  return typeof value === 'string' && DECIMAL_AMOUNT_PATTERN.test(value);
}

export function parseDecimal(value: string): ScaledDecimal {
  if (!isDecimalAmount(value)) {
    throw new AmountError('malformed_decimal', 'Decimal amount must match ^(0|[1-9][0-9]*)(\\.[0-9]+)?$');
  }
  const dot = value.indexOf('.');
  if (dot === -1) return { units: BigInt(value), scale: 0 };
  const fraction = value.slice(dot + 1);
  return { units: BigInt(value.slice(0, dot) + fraction), scale: fraction.length };
}

function toScaled(value: DecimalAmount | ScaledDecimal): ScaledDecimal {
  return typeof value === 'string' ? parseDecimal(value) : value;
}

/** Exact comparison; trailing zeros are irrelevant ("600000.00" equals "600000"). */
export function compareDecimal(a: DecimalAmount | ScaledDecimal, b: DecimalAmount | ScaledDecimal): -1 | 0 | 1 {
  const left = toScaled(a);
  const right = toScaled(b);
  const scale = Math.max(left.scale, right.scale);
  const l = left.units * pow10(scale - left.scale);
  const r = right.units * pow10(scale - right.scale);
  return l === r ? 0 : l > r ? 1 : -1;
}

/** Exact canonical string (trailing fractional zeros removed, "0" for zero). */
export function decimalToString(value: ScaledDecimal): DecimalAmount {
  if (value.units < 0n) throw new AmountError('negative_amount', 'Decimal amounts are non-negative');
  if (value.scale === 0) return value.units.toString();
  const digits = value.units.toString().padStart(value.scale + 1, '0');
  const whole = digits.slice(0, digits.length - value.scale);
  const fraction = digits.slice(digits.length - value.scale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Exact `raw / 10^decimals` as a decimal string, e.g. formatUnits(1500000n, 6) === "1.5". */
export function formatUnits(raw: RawAmount | bigint, decimals: number): DecimalAmount {
  assertDecimals(decimals);
  return decimalToString({ units: toRawBigint(raw), scale: decimals });
}

/** Exact `priceUsd x supplyRaw / 10^decimals` (no rounding at any step). */
export function computeMarketCapUsd(priceUsd: DecimalAmount, supplyRaw: RawAmount | bigint, decimals: number): DecimalAmount {
  assertDecimals(decimals);
  const price = parseDecimal(priceUsd);
  return decimalToString({ units: price.units * toRawBigint(supplyRaw), scale: price.scale + decimals });
}

export type MarketCapCheck = 'match' | 'mismatch' | 'not_computable';

/**
 * Verifies `marketCapUsd === priceUsd x circulating economic T supply` exactly. The NFT mirror is never added
 * again (FEED-07). `not_computable` when price or circulation is unknown; a missing cap alongside a computable
 * one is a mismatch.
 */
export function verifyMarketCap(
  pair: Pick<PairRecord, 'priceUsd' | 'circulatingSupplyRaw' | 'marketCapUsd'> & { token: Pick<PairRecord['token'], 'decimals'> },
): MarketCapCheck {
  if (pair.priceUsd === null || pair.circulatingSupplyRaw === null) return 'not_computable';
  if (pair.marketCapUsd === null) return 'mismatch';
  const expected = computeMarketCapUsd(pair.priceUsd, pair.circulatingSupplyRaw, pair.token.decimals);
  return compareDecimal(expected, pair.marketCapUsd) === 0 ? 'match' : 'mismatch';
}

/** floor(value x 10^digits) split into whole units and a trimmed fraction string. */
function truncate(value: ScaledDecimal, digits: number): { whole: bigint; fraction: string } {
  const scaled =
    digits >= value.scale ? value.units * pow10(digits - value.scale) : value.units / pow10(value.scale - digits);
  const whole = scaled / pow10(digits);
  const fraction = digits === 0 ? '' : (scaled % pow10(digits)).toString().padStart(digits, '0').replace(/0+$/, '');
  return { whole, fraction };
}

const COMPACT_UNITS = [
  [12, 'T'],
  [9, 'B'],
  [6, 'M'],
  [3, 'K'],
] as const;

/** One truncated decimal with a K/M/B/T suffix for values >= 1000, else null. */
function compact(value: ScaledDecimal): string | null {
  const whole = value.units / pow10(value.scale);
  for (const [exponent, suffix] of COMPACT_UNITS) {
    if (whole >= pow10(exponent)) {
      const tenths = (value.units * 10n) / pow10(value.scale + exponent);
      const tenth = tenths % 10n;
      return `${tenths / 10n}${tenth === 0n ? '' : `.${tenth}`}${suffix}`;
    }
  }
  return null;
}

function groupThousands(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Deterministic compact USD: "$0", "<$0.01", "$0.5", "$850", "$4.2K", "$600K", "$1.2M", "$2.5B", "$1T".
 * Below 1000: up to two truncated decimals. From 1000: one truncated decimal and a suffix. Never overstates.
 */
export function formatUsdCompact(value: DecimalAmount): string {
  const parsed = parseDecimal(value);
  if (parsed.units === 0n) return '$0';
  const short = compact(parsed);
  if (short !== null) return `$${short}`;
  const { whole, fraction } = truncate(parsed, 2);
  if (whole === 0n && fraction === '') return '<$0.01';
  return `$${whole}${fraction ? `.${fraction}` : ''}`;
}

export interface TokenAmountFormat {
  /** Truncated fractional digits for non-compact output (default 4, max 36). */
  maxFractionDigits?: number;
  /** K/M/B/T with one truncated decimal for values >= 1000. */
  compact?: boolean;
}

/** Token amount for display: "250,000", "1.2345", "<0.0001", or compact "1.9M". Truncates; never overstates. */
export function formatTokenAmount(raw: RawAmount | bigint, decimals: number, options: TokenAmountFormat = {}): string {
  assertDecimals(decimals);
  const maxFractionDigits = options.maxFractionDigits ?? 4;
  assertDecimals(maxFractionDigits, 'maxFractionDigits');
  const value: ScaledDecimal = { units: toRawBigint(raw), scale: decimals };
  if (value.units === 0n) return '0';
  if (options.compact) {
    const short = compact(value);
    if (short !== null) return short;
  }
  const { whole, fraction } = truncate(value, maxFractionDigits);
  if (whole === 0n && fraction === '') {
    return maxFractionDigits === 0 ? '<1' : `<0.${'0'.repeat(maxFractionDigits - 1)}1`;
  }
  return `${groupThousands(whole)}${fraction ? `.${fraction}` : ''}`;
}
