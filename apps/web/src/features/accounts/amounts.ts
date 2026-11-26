/**
 * Display helpers for personal amounts (SH-014). Raw amounts stay bigint/decimal strings until here; every display
 * value truncates (never overstates), and the exact value is always available from `exactAmount`. No Number is used
 * for an amount, block number or rate.
 */
import { formatTokenAmount, formatUnits, isRawAmount, type AssetIdentity, type DecimalAmount, type RawAmount } from '@squarehole/domain';
import { displaySymbol } from '../feed/format';

type AssetLike = Pick<AssetIdentity, 'decimals' | 'symbol'>;

/** Fraction digits for claim and balance figures: enough to show small demo entitlements without rounding up. */
export const AMOUNT_DIGITS = 6;

function groupDigits(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "9.705953" (truncated, grouped). */
export function formatNumber(raw: RawAmount | bigint, decimals: number, digits: number = AMOUNT_DIGITS): string {
  return formatTokenAmount(raw, decimals, { maxFractionDigits: digits });
}

/** "9.705953 AAPLx-DEMO" (truncated). */
export function formatAmount(raw: RawAmount | bigint, asset: AssetLike, digits: number = AMOUNT_DIGITS): string {
  return `${formatNumber(raw, asset.decimals, digits)} ${displaySymbol(asset.symbol)}`;
}

/** Every digit: "9.705953902720970302 AAPLx-DEMO". */
export function exactAmount(raw: RawAmount | bigint, asset: AssetLike): string {
  return `${formatUnits(raw, asset.decimals)} ${displaySymbol(asset.symbol)}`;
}

/** Block numbers and other decimal integer strings with thousands separators ("39,600"); anything else unchanged. */
export function formatInteger(value: string): string {
  return isRawAmount(value) ? groupDigits(value) : value;
}

/** "2,000" or "1,234.5": a decimal string grouped, digits unchanged. */
export function formatDecimal(value: DecimalAmount): string {
  const [whole = '', fraction] = value.split('.');
  return fraction === undefined ? groupDigits(whole) : `${groupDigits(whole)}.${fraction}`;
}

export const isZeroRaw = (raw: RawAmount): boolean => isRawAmount(raw) && BigInt(raw) === 0n;
