/**
 * Raw amounts bound to one asset (SH-V2-T03; v2 docs/07 "Every amount includes asset identity and decimals; never
 * infer from symbol"). `bigint` in logic; `{ assetId, raw }` with a decimal string in data. Arithmetic never mixes
 * assets, chains or decimals, never goes below zero and never leaves uint256. Exact ratios (r = A/n, K) stay
 * rational and are never rounded into a payable amount.
 *
 * USD values are not amounts: they live in metrics.ts as priced estimates with a source.
 */
import { formatTokenAmount, isRawAmount, MAX_TOKEN_DECIMALS, parseRawAmount } from '../amounts';
import { AmountError } from '../errors';
import type { Address, RawAmount } from '../types';
import { parseAssetId, type AssetId, type ChainId } from './ids';

export const MAX_UINT256 = 2n ** 256n - 1n;

export type AssetStandard = 'native' | 'erc20' | 'mock';

/** Exact asset identity. `symbol` is presentation only and never decides identity. */
export interface AssetRef {
  readonly id: AssetId;
  readonly standard: AssetStandard;
  /** Null for a mock asset: it exists on no chain. */
  readonly chainId: ChainId | null;
  /** Null for native ETH and for mock assets. */
  readonly address: Address | null;
  readonly decimals: number;
  readonly symbol: string;
}

export interface AssetRefInput {
  readonly id: AssetId | string;
  readonly decimals: number;
  readonly symbol: string;
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) {
    throw new AmountError('invalid_decimals', `decimals must be an integer between 0 and ${MAX_TOKEN_DECIMALS}`);
  }
}

/** Builds a frozen asset ref; chain and address come from the id, never from the caller. */
export function assetRef(input: AssetRefInput): AssetRef {
  const parsed = parseAssetId(input.id);
  assertDecimals(input.decimals);
  return Object.freeze({
    id: parsed.id,
    standard: parsed.kind,
    chainId: parsed.chainId,
    address: parsed.address,
    decimals: input.decimals,
    symbol: input.symbol,
  });
}

/**
 * Same asset: same id and same decimals. The same id with other decimals is corrupt data and throws
 * `AmountError('asset_mismatch')` rather than answering false.
 */
export function sameAsset(a: AssetRef, b: AssetRef): boolean {
  if (a.id !== b.id) return false;
  if (a.decimals !== b.decimals) throw new AmountError('asset_mismatch', `${a.id} is listed with ${a.decimals} and ${b.decimals} decimals`);
  return true;
}

function assertSameAsset(a: AssetRef, b: AssetRef): void {
  if (!sameAsset(a, b)) throw new AmountError('asset_mismatch', `Cannot combine ${a.id} with ${b.id}`);
}

// --- Amounts ------------------------------------------------------------------------------------------------------

export interface Amount {
  readonly asset: AssetRef;
  readonly raw: bigint;
}

function checkRange(raw: bigint): bigint {
  if (raw < 0n) throw new AmountError('negative_amount', 'Raw amounts are unsigned');
  if (raw > MAX_UINT256) throw new AmountError('amount_out_of_range', 'Raw amounts fit in uint256');
  return raw;
}

/** An amount of one asset. Strings must be canonical decimal integers (`^(0|[1-9][0-9]*)$`). */
export function amountOf(asset: AssetRef, raw: bigint | RawAmount): Amount {
  const value = typeof raw === 'bigint' ? raw : parseRawAmount(raw);
  return Object.freeze({ asset, raw: checkRange(value) });
}

export function addAmounts(a: Amount, b: Amount): Amount {
  assertSameAsset(a.asset, b.asset);
  return amountOf(a.asset, a.raw + b.raw);
}

/** a − b; throws `underflow` instead of going negative. */
export function subAmounts(a: Amount, b: Amount): Amount {
  assertSameAsset(a.asset, b.asset);
  if (b.raw > a.raw) throw new AmountError('underflow', 'The result would be negative');
  return amountOf(a.asset, a.raw - b.raw);
}

export function compareAmounts(a: Amount, b: Amount): -1 | 0 | 1 {
  assertSameAsset(a.asset, b.asset);
  return a.raw === b.raw ? 0 : a.raw > b.raw ? 1 : -1;
}

export type Rounding = 'floor' | 'ceil';

/** Exact `value × num / den` for non-negative integers, rounded as asked (the full-precision mulDiv of v2 docs/03). */
export function mulDiv(value: bigint, num: bigint, den: bigint, rounding: Rounding): bigint {
  if (value < 0n || num < 0n || den < 0n) throw new AmountError('negative_amount', 'mulDiv takes non-negative integers');
  if (den === 0n) throw new AmountError('division_by_zero', 'Division by zero');
  const product = value * num;
  const quotient = product / den;
  return rounding === 'ceil' && quotient * den !== product ? quotient + 1n : quotient;
}

// --- Decimal string codec -----------------------------------------------------------------------------------------

/** Data-at-rest form of an amount. */
export interface AmountData {
  readonly assetId: AssetId;
  readonly raw: RawAmount;
}

export function encodeAmount(amount: Amount): AmountData {
  return { assetId: amount.asset.id, raw: amount.raw.toString() };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Decodes `{ assetId, raw }` for the expected asset only. A number, float or non-canonical string is rejected. */
export function decodeAmount(data: unknown, asset: AssetRef): Amount {
  if (!isObject(data)) throw new AmountError('malformed_raw_amount', 'Expected { assetId, raw }');
  if (data.assetId !== asset.id) throw new AmountError('asset_mismatch', `Expected an amount of ${asset.id}`);
  if (!isRawAmount(data.raw)) throw new AmountError('malformed_raw_amount', 'raw must be an unsigned decimal integer string');
  return amountOf(asset, data.raw);
}

export interface AmountFormat {
  readonly maxFractionDigits?: number;
  readonly compact?: boolean;
}

/** Display only: truncated (never overstates), with the asset symbol. */
export function formatAmount(amount: Amount, options: AmountFormat = {}): string {
  return `${formatTokenAmount(amount.raw, amount.asset.decimals, options)} ${amount.asset.symbol}`;
}

// --- Exact ratios -------------------------------------------------------------------------------------------------

/** A non-negative rational `num / den` in lowest terms, `den > 0`. */
export interface Ratio {
  readonly num: bigint;
  readonly den: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function ratio(num: bigint, den: bigint): Ratio {
  if (num < 0n || den < 0n) throw new AmountError('negative_amount', 'Ratios are non-negative');
  if (den === 0n) throw new AmountError('division_by_zero', 'Ratio denominator is zero');
  if (num === 0n) return Object.freeze({ num: 0n, den: 1n });
  const divisor = gcd(num, den);
  return Object.freeze({ num: num / divisor, den: den / divisor });
}

export const ratioFloor = (value: Ratio): bigint => value.num / value.den;
export const ratioCeil = (value: Ratio): bigint => mulDiv(value.num, 1n, value.den, 'ceil');
export const ratioIsInteger = (value: Ratio): boolean => value.den === 1n;

export function compareRatio(a: Ratio, b: Ratio): -1 | 0 | 1 {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left === right ? 0 : left > right ? 1 : -1;
}

export interface RatioData {
  readonly num: RawAmount;
  readonly den: RawAmount;
}

export function encodeRatio(value: Ratio): RatioData {
  return { num: value.num.toString(), den: value.den.toString() };
}

export function decodeRatio(data: unknown): Ratio {
  if (!isObject(data) || !isRawAmount(data.num) || !isRawAmount(data.den)) {
    throw new AmountError('malformed_raw_amount', 'Expected { num, den } as unsigned decimal integer strings');
  }
  return ratio(BigInt(data.num), BigInt(data.den));
}

/** A ratio of raw units shown in whole units of `asset`: truncated, and marked "≈" when not exact. */
export function formatRatio(value: Ratio, asset: AssetRef, options: AmountFormat = {}): string {
  const shown = formatAmount(amountOf(asset, ratioFloor(value)), options);
  return ratioIsInteger(value) ? shown : `≈${shown}`;
}
