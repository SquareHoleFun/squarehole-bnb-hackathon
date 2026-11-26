import { estimatePayoutRaw, isDecimalAmount } from '@squarehole/domain';
import { describe, expect, it } from 'vitest';
import {
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  Q192,
  Q96,
  displayQPerT,
  exactRateForQuote,
  mulFloor,
  rational,
  rawQPerRawT,
  toDecimalString,
  toSignificantDecimal,
} from './pool-math';

/** Deterministic PRNG (mulberry32) for property checks. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randomBigint = (next: () => number, digits: number): bigint => {
  let text = String(1 + Math.floor(next() * 9));
  for (let i = 1; i < digits; i += 1) text += String(Math.floor(next() * 10));
  return BigInt(text);
};

describe('pool mid price from sqrtPriceX96 (exact bigint)', () => {
  it('price 1 when sqrtPriceX96 = 2^96, both orientations', () => {
    expect(rawQPerRawT(Q96, true)).toEqual({ num: 1n, den: 1n });
    expect(rawQPerRawT(Q96, false)).toEqual({ num: 1n, den: 1n });
  });

  it('T as currency0: Q per T = sqrt² / 2^192; T as currency1: the inverse', () => {
    const sqrt = 2n * Q96; // price1per0 = 4
    expect(rawQPerRawT(sqrt, true)).toEqual({ num: 4n, den: 1n });
    expect(rawQPerRawT(sqrt, false)).toEqual({ num: 1n, den: 4n });
  });

  it('matches the local launch record: 1 WETH start FDV for 1e27 raw T is ~1e-9 WETH per T', () => {
    // The Misfits' initial sqrtPriceX96 from the local manifest (T 0x9409… sorts below WETH 0xe7f1…: T is currency0).
    const sqrt = 2498287050797415220819352n;
    const perT = displayQPerT(rawQPerRawT(sqrt, true), 18, 18);
    // Q per T ≈ 1e-9 (1 WETH / 1e9 whole T), a little below because the start tick rounds towards cheaper T.
    const decimal = toSignificantDecimal(perT, 6);
    expect(decimal).toBe('0.000000000994318');
    expect(isDecimalAmount(decimal)).toBe(true);
  });

  it('scales by token decimals (6-decimal Q)', () => {
    const raw = rational(1n, 10n ** 12n); // 1 raw Q (6 dp) per 1e12 raw T (18 dp)
    expect(toDecimalString(displayQPerT(raw, 18, 6), 6)).toBe('1');
  });

  it('rejects an uninitialised or out-of-range sqrtPriceX96', () => {
    expect(() => rawQPerRawT(0n, true)).toThrow(RangeError);
    expect(() => rawQPerRawT(MIN_SQRT_PRICE - 1n, true)).toThrow(RangeError);
    expect(() => rawQPerRawT(MAX_SQRT_PRICE + 1n, false)).toThrow(RangeError);
    expect(() => rawQPerRawT(MIN_SQRT_PRICE, true)).not.toThrow();
  });

  it('market cap floor(amount × price) is exact and never overstates', () => {
    const next = prng(7);
    for (let i = 0; i < 500; i += 1) {
      const sqrt = MIN_SQRT_PRICE + (randomBigint(next, 40) % (MAX_SQRT_PRICE - MIN_SQRT_PRICE));
      const amount = randomBigint(next, 1 + Math.floor(next() * 27));
      const tIsCurrency0 = next() < 0.5;
      const price = rawQPerRawT(sqrt, tIsCurrency0);
      const value = mulFloor(amount, price);
      const square = sqrt * sqrt;
      const exactNum = tIsCurrency0 ? amount * square : amount * Q192;
      const exactDen = tIsCurrency0 ? Q192 : square;
      expect(value * exactDen <= exactNum).toBe(true);
      expect((value + 1n) * exactDen > exactNum).toBe(true);
    }
  });
});

describe('decimal formatting (truncation, never overstates)', () => {
  it('truncates to the requested digits and trims zeros', () => {
    expect(toDecimalString(rational(2n, 3n), 4)).toBe('0.6666');
    expect(toDecimalString(rational(5n, 2n), 4)).toBe('2.5');
    expect(toDecimalString(rational(10n, 1n), 0)).toBe('10');
  });

  it('keeps significant digits after leading zeros', () => {
    expect(toSignificantDecimal(rational(1n, 3n * 10n ** 9n), 5)).toBe('0.00000000033333');
    expect(toSignificantDecimal(rational(123456789n, 1000n), 5)).toBe('123456');
    expect(toSignificantDecimal(rational(0n, 1n), 5)).toBe('0');
  });
});

describe('exactRateForQuote: tPerQ reproduces the quoted payout under the domain identity', () => {
  it('floor(qIn × tPerQ) === tOut for random quotes and decimals (property)', () => {
    const next = prng(42);
    for (let i = 0; i < 2000; i += 1) {
      const qDecimals = [6, 18][Math.floor(next() * 2)] as number;
      const tDecimals = 18;
      const qIn = randomBigint(next, 1 + Math.floor(next() * 24));
      const tOut = randomBigint(next, 1 + Math.floor(next() * 30));
      const rate = exactRateForQuote(qIn, tOut, qDecimals, tDecimals);
      expect(isDecimalAmount(rate)).toBe(true);
      expect(estimatePayoutRaw(qIn, rate, qDecimals, tDecimals)).toBe(tOut);
    }
  });

  it('a local conversion from the SH-B2 run', () => {
    // 0.000404… WETH → 343,690.11… MISFITS (orders of magnitude from docs/evidence/SH-B2-contracts.md).
    const qIn = 404_000_000_000_000n;
    const tOut = 343_690_110_000_000_000_000_000n;
    expect(estimatePayoutRaw(qIn, exactRateForQuote(qIn, tOut, 18, 18), 18, 18)).toBe(tOut);
  });

  it('refuses a non-positive input', () => {
    expect(() => exactRateForQuote(0n, 1n, 18, 18)).toThrow(RangeError);
  });
});
