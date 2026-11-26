import { describe, expect, it } from 'vitest';
import {
  compareDecimal,
  formatTokenAmount,
  formatUnits,
  formatUsdCompact,
  parseDecimal,
  parseRawAmount,
  toRawAmount,
  type ScaledDecimal,
} from './index';
import { createPrng } from './test-support/prng';

const SEED = 20260925;
const RUNS = 2000;
const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** Exact rational comparison helper: a/10^sa vs b/10^sb. */
function cmp(a: ScaledDecimal, b: ScaledDecimal): number {
  const scale = Math.max(a.scale, b.scale);
  const left = a.units * pow10(scale - a.scale);
  const right = b.units * pow10(scale - b.scale);
  return left === right ? 0 : left > right ? 1 : -1;
}

/** Parses the compact display back to an exact lower bound ("$1.2M" -> 1200000). */
function parseDisplay(display: string): ScaledDecimal {
  const body = display.replace(/^\$/, '').replaceAll(',', '');
  const suffix = body.at(-1) ?? '';
  const exponent = { K: 3, M: 6, B: 9, T: 12 }[suffix];
  const number = parseDecimal(exponent === undefined ? body : body.slice(0, -1));
  return exponent === undefined ? number : { units: number.units * pow10(exponent), scale: number.scale };
}

describe('amount properties (seeded, reproducible)', () => {
  it(`raw amounts round-trip exactly (seed ${SEED}, ${RUNS} runs, up to 90 digits)`, () => {
    const prng = createPrng(SEED);
    for (let run = 0; run < RUNS; run += 1) {
      const value = prng.bigDigits(90);
      expect(parseRawAmount(toRawAmount(value))).toBe(value);
    }
  });

  it('formatUnits is lossless for 0, 6, 18 and 36 decimals', () => {
    const prng = createPrng(SEED + 1);
    for (let run = 0; run < RUNS; run += 1) {
      const raw = prng.bigDigits(80);
      const decimals = prng.pick([0, 6, 18, 36]);
      const parsed = parseDecimal(formatUnits(raw, decimals));
      expect(parsed.units * pow10(decimals - parsed.scale)).toBe(raw);
    }
  });

  it('compareDecimal agrees with exact scaled comparison and ignores trailing zeros', () => {
    const prng = createPrng(SEED + 2);
    for (let run = 0; run < RUNS; run += 1) {
      const a = { units: prng.bigDigits(40), scale: prng.int(30) };
      const b = { units: prng.bigDigits(40), scale: prng.int(30) };
      const aText = formatUnits(a.units, a.scale);
      const bText = formatUnits(b.units, b.scale);
      expect(compareDecimal(aText, bText)).toBe(cmp(a, b));
      expect(compareDecimal(bText, aText)).toBe(cmp(b, a));
      const padded = aText.includes('.') ? `${aText}000` : `${aText}.000`;
      expect(compareDecimal(aText, padded)).toBe(0);
    }
  });

  it('compact USD display never overstates and stays within one display step', () => {
    const prng = createPrng(SEED + 3);
    for (let run = 0; run < RUNS; run += 1) {
      const value = { units: prng.bigDigits(24), scale: prng.int(8) };
      const display = formatUsdCompact(formatUnits(value.units, value.scale));
      if (display === '<$0.01') {
        expect(cmp(value, { units: 1n, scale: 2 })).toBe(-1);
        expect(value.units > 0n).toBe(true);
        continue;
      }
      const shown = parseDisplay(display);
      expect(cmp(shown, value)).toBeLessThanOrEqual(0);
      // One display step: 0.01 below 1000, otherwise 0.1 of the suffix unit.
      const suffix = display.at(-1) ?? '';
      const stepExponent = { K: 2, M: 5, B: 8, T: 11 }[suffix];
      const step = stepExponent === undefined ? { units: 1n, scale: 2 } : { units: pow10(stepExponent), scale: 0 };
      const upper = { units: shown.units * pow10(Math.max(shown.scale, step.scale) - shown.scale), scale: Math.max(shown.scale, step.scale) };
      const stepAligned = step.units * pow10(upper.scale - step.scale);
      expect(cmp(value, { units: upper.units + stepAligned, scale: upper.scale })).toBe(-1);
    }
  });

  it('token amount display never overstates (6 and 18 decimals, plain and compact)', () => {
    const prng = createPrng(SEED + 4);
    for (let run = 0; run < RUNS; run += 1) {
      const raw = prng.bigDigits(40);
      const decimals = prng.pick([6, 18]);
      const compact = prng.int(2) === 1;
      const display = formatTokenAmount(raw, decimals, { compact });
      const exact = { units: raw, scale: decimals };
      if (display.startsWith('<')) {
        expect(raw > 0n).toBe(true);
        expect(cmp(exact, parseDisplay(display.slice(1)))).toBe(-1);
        continue;
      }
      expect(cmp(parseDisplay(display), exact)).toBeLessThanOrEqual(0);
    }
  });
});
