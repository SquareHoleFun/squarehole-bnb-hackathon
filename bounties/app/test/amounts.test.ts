import { describe, expect, it } from 'vitest';
import {
  formatAmount,
  formatBps,
  minOut,
  parseAmount,
  parsePercentToBps,
  redeemShare,
  shareBps,
  toDecimalString,
} from '../src/lib/amounts';

const E18 = 10n ** 18n;

describe('toDecimalString: exact to the last unit', () => {
  it('whole, fraction and one wei', () => {
    expect(toDecimalString(0n, 18)).toBe('0');
    expect(toDecimalString(E18, 18)).toBe('1');
    expect(toDecimalString(1n, 18)).toBe('0.000000000000000001');
    expect(toDecimalString(E18 + 1n, 18)).toBe('1.000000000000000001');
    expect(toDecimalString(1_500_000n, 6)).toBe('1.5');
    expect(toDecimalString(-5n * 10n ** 17n, 18)).toBe('-0.5');
    expect(toDecimalString(123n, 0)).toBe('123');
  });
  it('round-trips through parseAmount for every tested value', () => {
    for (const v of [1n, 9n, 10n, E18 - 1n, E18, 123456789012345678901234567890n]) {
      const p = parseAmount(toDecimalString(v, 18), 18);
      expect(p).toEqual({ ok: true, value: v });
    }
  });
});

describe('formatAmount: short, rounded down, readable for small sales', () => {
  it('a 0.05 BNB sale and its pieces read correctly', () => {
    expect(formatAmount(5n * 10n ** 16n, 18)).toBe('0.05');
    expect(formatAmount(498_400_000_000_000n, 18)).toBe('0.0004984');
    expect(formatAmount(12_345_678_900_000n, 18)).toBe('0.00001234');
    expect(formatAmount(1n, 18)).toBe('0.000000000000000001');
  });
  it('never rounds up', () => {
    expect(formatAmount(19_999n * 10n ** 14n, 18)).toBe('1.9999');
    expect(formatAmount(199_999n * 10n ** 13n, 18)).toBe('1.9999');
    expect(formatAmount(99_999n * 10n ** 13n, 18)).toBe('0.9999');
  });
  it('groups thousands and drops trailing zeros', () => {
    expect(formatAmount(1_240_000n * E18, 18)).toBe('1,240,000');
    expect(formatAmount(1_234_567n * E18 + 5n * 10n ** 17n, 18)).toBe('1,234,567.5');
    expect(formatAmount(0n, 18)).toBe('0');
    expect(formatAmount(-25n * 10n ** 17n, 18)).toBe('-2.5');
  });
});

describe('parseAmount: refuses rather than rounds', () => {
  it('accepts the usual forms', () => {
    expect(parseAmount('1', 18)).toEqual({ ok: true, value: E18 });
    expect(parseAmount(' 1.5 ', 18)).toEqual({ ok: true, value: 15n * 10n ** 17n });
    expect(parseAmount('.5', 18)).toEqual({ ok: true, value: 5n * 10n ** 17n });
    expect(parseAmount('1000.25', 18)).toEqual({ ok: true, value: 100025n * 10n ** 16n });
    expect(parseAmount('2.', 18)).toEqual({ ok: true, value: 2n * E18 });
    expect(parseAmount('0.000000000000000001', 18)).toEqual({ ok: true, value: 1n });
  });
  it('refuses a comma or any grouping, never repairs it (finding 6: "1,5" is not 15)', () => {
    expect(parseAmount('1,5', 18)).toEqual({ ok: false, reason: 'not-a-number' });
    expect(parseAmount('1,000.25', 18)).toEqual({ ok: false, reason: 'not-a-number' });
    expect(parseAmount('1 000', 18)).toEqual({ ok: false, reason: 'not-a-number' });
    expect(parseAmount('1_000', 18)).toEqual({ ok: false, reason: 'not-a-number' });
  });
  it('parses in the coin\'s own decimals (finding 6: a 6-decimal coin)', () => {
    expect(parseAmount('1', 6)).toEqual({ ok: true, value: 1_000_000n });
    expect(parseAmount('0.1234567', 6)).toEqual({ ok: false, reason: 'too-many-decimals' });
  });
  it('every refusal', () => {
    expect(parseAmount('', 18)).toEqual({ ok: false, reason: 'empty' });
    expect(parseAmount('   ', 18)).toEqual({ ok: false, reason: 'empty' });
    expect(parseAmount('abc', 18)).toEqual({ ok: false, reason: 'not-a-number' });
    expect(parseAmount('-1', 18)).toEqual({ ok: false, reason: 'not-a-number' });
    expect(parseAmount('1e18', 18)).toEqual({ ok: false, reason: 'not-a-number' });
    expect(parseAmount('1.2.3', 18)).toEqual({ ok: false, reason: 'not-a-number' });
    expect(parseAmount('.', 18)).toEqual({ ok: false, reason: 'not-a-number' });
    expect(parseAmount('0.0000000000000000001', 18)).toEqual({ ok: false, reason: 'too-many-decimals' });
    expect(parseAmount('1.5', 0)).toEqual({ ok: false, reason: 'too-many-decimals' });
    expect(parseAmount('0', 18)).toEqual({ ok: false, reason: 'zero' });
    expect(parseAmount('0.000', 18)).toEqual({ ok: false, reason: 'zero' });
    expect(parseAmount('0', 18, { allowZero: true })).toEqual({ ok: true, value: 0n });
  });
});

describe('guards and shares', () => {
  it('minOut rounds down and refuses a guard outside 0..100%', () => {
    expect(minOut(1000n, 50n)).toBe(995n);
    expect(minOut(999n, 50n)).toBe(994n); // 994.005 rounded down
    expect(minOut(1n, 1n)).toBe(0n);
    expect(minOut(123n, 0n)).toBe(123n);
    expect(minOut(123n, 10_000n)).toBe(0n);
    expect(() => minOut(1n, 10_001n)).toThrow(RangeError);
    expect(() => minOut(1n, -1n)).toThrow(RangeError);
  });
  it('percent text to basis points', () => {
    expect(parsePercentToBps('0.5')).toEqual({ ok: true, value: 50n });
    expect(parsePercentToBps('0')).toEqual({ ok: true, value: 0n });
    expect(parsePercentToBps('100')).toEqual({ ok: true, value: 10_000n });
    expect(parsePercentToBps('100.01').ok).toBe(false);
    expect(parsePercentToBps('0.001').ok).toBe(false);
    expect(formatBps(125n)).toBe('1.25%');
    expect(shareBps(1n, 3n)).toBe(3333n);
    expect(shareBps(5n, 0n)).toBe(0n);
  });
  it('redeemShare mirrors the pile rule: rounding down, the last holder empties it', () => {
    const pile = 623n * 10n ** 14n; // 0.0623
    const circ = 1_250_000n * E18;
    expect(redeemShare(pile, 10_000n * E18, circ)).toBe(498_400_000_000_000n);
    expect(redeemShare(10n, 1n, 3n)).toBe(3n);
    expect(redeemShare(10n, 3n, 3n)).toBe(10n);
    expect(redeemShare(10n, 0n, 3n)).toBe(0n);
    expect(redeemShare(10n, 1n, 0n)).toBe(0n);
  });
});
