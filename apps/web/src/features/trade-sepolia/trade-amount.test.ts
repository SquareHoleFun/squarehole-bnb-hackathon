import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exactAmount, MAX_AMOUNT, readAmount, readTolerance, tolerancePercent } from './trade-amount';

const ETHER = 10n ** 18n;

describe('readAmount: what a tester types, in raw units, bigint only', () => {
  it('reads plain decimals exactly', () => {
    expect(readAmount('1', 18)).toEqual({ kind: 'ok', raw: ETHER });
    expect(readAmount('1.5', 18)).toEqual({ kind: 'ok', raw: 15n * ETHER / 10n });
    expect(readAmount('.5', 18)).toEqual({ kind: 'ok', raw: ETHER / 2n });
    expect(readAmount('1.', 18)).toEqual({ kind: 'ok', raw: ETHER });
    expect(readAmount(' 2 ', 6)).toEqual({ kind: 'ok', raw: 2_000_000n });
    expect(readAmount('0.000001', 6)).toEqual({ kind: 'ok', raw: 1n });
    expect(readAmount('0.000000000000000001', 18)).toEqual({ kind: 'ok', raw: 1n });
    // A float would lose these digits: 2^53 + 1 whole coins and 18 decimals.
    expect(readAmount('9007199254740993.000000000000000001', 18)).toEqual({ kind: 'ok', raw: 9007199254740993n * ETHER + 1n });
  });

  it('takes trailing zeros as no precision', () => {
    expect(readAmount('1.50', 1)).toEqual({ kind: 'ok', raw: 15n });
    expect(readAmount('5.000', 0)).toEqual({ kind: 'ok', raw: 5n });
  });

  it('refuses what is not a plain positive decimal', () => {
    expect(readAmount('', 18)).toEqual({ kind: 'empty' });
    expect(readAmount('   ', 18)).toEqual({ kind: 'empty' });
    for (const text of ['abc', '1e3', '-1', '+1', '1,5', '1.2.3', '.', '0x10', 'Infinity', 'NaN', '1 000']) expect(readAmount(text, 18), text).toEqual({ kind: 'invalid' });
    expect(readAmount('0', 18)).toEqual({ kind: 'zero' });
    expect(readAmount('0.000', 18)).toEqual({ kind: 'zero' });
    expect(readAmount('0.0000001', 6)).toEqual({ kind: 'too_precise', decimals: 6 });
    expect(readAmount('5.1', 0)).toEqual({ kind: 'too_precise', decimals: 0 });
  });

  it('stops below the plan’s int128 bound (2^127)', () => {
    expect(readAmount(MAX_AMOUNT.toString(), 0)).toEqual({ kind: 'ok', raw: (1n << 127n) - 1n });
    expect(readAmount((1n << 127n).toString(), 0)).toEqual({ kind: 'too_large' });
  });

  it('round-trips exactAmount for many amounts and decimals', () => {
    let seed = 0x5348n;
    const next = () => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n); return seed; };
    for (let i = 0; i < 400; i += 1) {
      const decimals = Number(next() % 37n);
      const raw = (next() * next()) % MAX_AMOUNT + 1n;
      expect(readAmount(exactAmount(raw, decimals), decimals)).toEqual({ kind: 'ok', raw });
    }
  });
});

describe('exactAmount: every digit, no trailing zeros', () => {
  it('formats raw units', () => {
    expect(exactAmount(15n * ETHER / 10n, 18)).toBe('1.5');
    expect(exactAmount(1n, 18)).toBe('0.000000000000000001');
    expect(exactAmount(10_000_000n, 6)).toBe('10');
    expect(exactAmount(0n, 6)).toBe('0');
    expect(exactAmount(42n, 0)).toBe('42');
  });
});

describe('readTolerance: percent in, basis points out, 0.1% to 20%', () => {
  it('reads the range the plan takes', () => {
    expect(readTolerance('2')).toBe(200n);
    expect(readTolerance('0.1')).toBe(10n);
    expect(readTolerance('0.15')).toBe(15n);
    expect(readTolerance('20')).toBe(2000n);
    expect(readTolerance('20.00')).toBe(2000n);
  });
  it('refuses anything else', () => {
    for (const text of ['', '0', '0.09', '20.01', '21', '0.001', 'abc', '-2', '2%']) expect(readTolerance(text), text).toBeNull();
  });
  it('shows basis points as the percent typed', () => {
    expect(tolerancePercent(200n)).toBe('2%');
    expect(tolerancePercent(15n)).toBe('0.15%');
    expect(tolerancePercent(10n)).toBe('0.1%');
    expect(tolerancePercent(2000n)).toBe('20%');
  });
});

describe('no floating point on amounts in the trade box (CLAUDE.md)', () => {
  it('the amount, chain and box modules call no parseFloat, parseInt, Number() or toFixed', () => {
    for (const name of ['trade-amount.ts', 'trade-run.ts', 'trade-target.ts', 'TradeBox.tsx', 'one-press.ts', 'use-sends.ts', 'TestCoinPage.tsx']) {
      const code = readFileSync(join(dirname(fileURLToPath(import.meta.url)), name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, name).not.toMatch(/\bparseFloat\b|\bparseInt\b|\bNumber\(|\.toFixed\(/);
    }
  });
});
