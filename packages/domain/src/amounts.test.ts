import { describe, expect, it } from 'vitest';
import {
  AmountError,
  DISPLAY_ROUNDING,
  compareDecimal,
  computeMarketCapUsd,
  decimalToString,
  derivedInitialSupplyRaw,
  formatTokenAmount,
  formatUnits,
  formatUsdCompact,
  isDecimalAmount,
  isRawAmount,
  parseDecimal,
  parseRawAmount,
  toRawAmount,
  verifyMarketCap,
} from './index';

const UINT256_MAX = 2n ** 256n - 1n;

function expectAmountError(fn: () => unknown, code: AmountError['code']): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AmountError);
    expect((error as AmountError).code).toBe(code);
    return;
  }
  throw new Error('expected an AmountError');
}

const MALFORMED_RAW = ['', ' ', '+1', '-1', ' 1', '1 ', '1e3', '1E3', '0x10', '01', '00', '1.0', '1_000', '1,000', 'NaN', 'Infinity', '١٢'];
const MALFORMED_DECIMAL = ['', '.5', '1.', '+1.0', '-0.5', ' 1', '1 ', '01.5', '00', '1e3', '0x1', 'NaN', 'Infinity', '1,5', '1..2', '1.2.3'];

describe('raw amounts (bigint in logic, decimal strings in data)', () => {
  it('parses canonical unsigned integers, including values far beyond 2^53', () => {
    expect(parseRawAmount('0')).toBe(0n);
    expect(parseRawAmount('9007199254740993')).toBe(9007199254740993n);
    expect(parseRawAmount(UINT256_MAX.toString())).toBe(UINT256_MAX);
    expect(isRawAmount('100000000000000000000000')).toBe(true);
  });

  it.each(MALFORMED_RAW)('rejects malformed raw amount %j', (value) => {
    expect(isRawAmount(value)).toBe(false);
    expectAmountError(() => parseRawAmount(value), 'malformed_raw_amount');
  });

  it('serialises bigint back to a decimal string and refuses negatives', () => {
    expect(toRawAmount(UINT256_MAX)).toBe(UINT256_MAX.toString());
    expectAmountError(() => toRawAmount(-1n), 'negative_amount');
  });

  it('derives the demo-only initial supply as total + burned (ADR-0003 Supply)', () => {
    expect(derivedInitialSupplyRaw('110000000000000000000000', '120000000000000000000')).toBe('110120000000000000000000');
  });
});

describe('formatUnits (exact)', () => {
  it.each([
    [0n, 18, '0'],
    [1n, 18, '0.000000000000000001'],
    [1_500_000_000_000_000_000n, 18, '1.5'],
    [100_000_000_000_000_000_000_000n, 18, '100000'],
    [1_000_000n, 6, '1'],
    [1_000_000n, 18, '0.000000000001'],
    [1_234_567n, 6, '1.234567'],
    [120n, 0, '120'],
    [UINT256_MAX, 18, '115792089237316195423570985008687907853269984665640564039457.584007913129639935'],
  ])('formatUnits(%s, %i) = %s', (raw, decimals, expected) => {
    expect(formatUnits(raw, decimals)).toBe(expected);
  });

  it('accepts raw strings and rejects invalid decimals', () => {
    expect(formatUnits('2500000', 6)).toBe('2.5');
    expectAmountError(() => formatUnits(1n, -1), 'invalid_decimals');
    expectAmountError(() => formatUnits(1n, 37), 'invalid_decimals');
    expectAmountError(() => formatUnits(1n, 1.5), 'invalid_decimals');
    expectAmountError(() => formatUnits(-1n, 18), 'negative_amount');
  });
});

describe('decimal strings (USD and prices)', () => {
  it('parses to a scaled bigint without Number', () => {
    expect(parseDecimal('600000.00')).toEqual({ units: 60000000n, scale: 2 });
    expect(parseDecimal('0')).toEqual({ units: 0n, scale: 0 });
    expect(parseDecimal('0.000000000000000000000000000001')).toEqual({ units: 1n, scale: 30 });
    expect(isDecimalAmount('4200')).toBe(true);
  });

  it.each(MALFORMED_DECIMAL)('rejects malformed decimal %j', (value) => {
    expect(isDecimalAmount(value)).toBe(false);
    expectAmountError(() => parseDecimal(value), 'malformed_decimal');
  });

  it('compares exactly, ignoring trailing zeros', () => {
    expect(compareDecimal('600000.00', '600000')).toBe(0);
    expect(compareDecimal('72000.00', '72000.000')).toBe(0);
    expect(compareDecimal('0.1', '0.09999999999999999999999')).toBe(1);
    expect(compareDecimal('9007199254740993', '9007199254740992.999')).toBe(1);
    expect(compareDecimal('1.2', '1.20000000000000000001')).toBe(-1);
  });

  it('prints a canonical exact string', () => {
    expect(decimalToString(parseDecimal('600000.00'))).toBe('600000');
    expect(decimalToString(parseDecimal('0.50'))).toBe('0.5');
    expect(decimalToString({ units: 0n, scale: 20 })).toBe('0');
  });
});

describe('market cap verification (price x raw supply / 10^decimals)', () => {
  it('computes exact caps for 18-decimal supply', () => {
    expect(computeMarketCapUsd('2.40', '250000000000000000000000', 18)).toBe('600000');
    expect(computeMarketCapUsd('0.12', '600000000000000000000000', 18)).toBe('72000');
    expect(computeMarketCapUsd('0.000001', '1', 18)).toBe('0.000000000000000000000001');
  });

  it('flags mismatch, match and not-computable pairs', () => {
    const base = { priceUsd: '2.40', circulatingSupplyRaw: '250000000000000000000000', marketCapUsd: '600000.00', token: { decimals: 18 } };
    expect(verifyMarketCap(base)).toBe('match');
    expect(verifyMarketCap({ ...base, marketCapUsd: '600000.01' })).toBe('mismatch');
    expect(verifyMarketCap({ ...base, marketCapUsd: null })).toBe('mismatch');
    expect(verifyMarketCap({ ...base, priceUsd: null })).toBe('not_computable');
    expect(verifyMarketCap({ ...base, circulatingSupplyRaw: null })).toBe('not_computable');
  });
});

describe('display formatting (documented rounding: truncation, never overstates)', () => {
  it('declares truncation toward zero', () => {
    expect(DISPLAY_ROUNDING).toBe('truncate');
  });

  it.each([
    ['0', '$0'],
    ['0.00', '$0'],
    ['0.005', '<$0.01'],
    ['0.01', '$0.01'],
    ['0.50', '$0.5'],
    ['850', '$850'],
    ['850.759', '$850.75'],
    ['999.999', '$999.99'],
    ['1000', '$1K'],
    ['4200', '$4.2K'],
    ['72000.00', '$72K'],
    ['600000.00', '$600K'],
    ['999999.99', '$999.9K'],
    ['1200000', '$1.2M'],
    ['1250000', '$1.2M'],
    ['1999999.99', '$1.9M'],
    ['2500000000', '$2.5B'],
    ['1000000000000', '$1T'],
    ['123456789012345678901234567890', '$123456789012345678.9T'],
  ])('formatUsdCompact(%s) = %s', (value, expected) => {
    expect(formatUsdCompact(value)).toBe(expected);
  });

  it('rejects malformed USD values', () => {
    expectAmountError(() => formatUsdCompact('1e6'), 'malformed_decimal');
  });

  it.each([
    [0n, 18, {}, '0'],
    [1n, 18, {}, '<0.0001'],
    [1n, 18, { maxFractionDigits: 0 }, '<1'],
    [1_234_567_891_234_567_890n, 18, {}, '1.2345'],
    [250_000n * 10n ** 18n, 18, {}, '250,000'],
    [1_234_567n * 10n ** 18n + 5n * 10n ** 17n, 18, {}, '1,234,567.5'],
    [1_500_000n, 6, {}, '1.5'],
    [999_999n, 6, { maxFractionDigits: 2 }, '0.99'],
    [250_000n * 10n ** 18n, 18, { compact: true }, '250K'],
    [1_999_999n * 10n ** 18n, 18, { compact: true }, '1.9M'],
    [999n * 10n ** 18n, 18, { compact: true }, '999'],
  ] as const)('formatTokenAmount(%s, %i, %o) = %s', (raw, decimals, options, expected) => {
    expect(formatTokenAmount(raw, decimals, options)).toBe(expected);
  });

  it('accepts raw strings and validates options', () => {
    expect(formatTokenAmount('1000000', 6)).toBe('1');
    expectAmountError(() => formatTokenAmount('-1', 6), 'malformed_raw_amount');
    expectAmountError(() => formatTokenAmount('1', 6, { maxFractionDigits: 37 }), 'invalid_decimals');
  });
});
