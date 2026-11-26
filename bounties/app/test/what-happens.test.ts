import { describe, expect, it } from 'vitest';
import { bpsText, feeOn, flapFlow, fourFlow, PILE_ONLY, runTrades, splitByRules, type Parts } from '../src/picture/what-happens';

const ONE = 10n ** 18n;
const sum = (s: { creator: bigint; pile: bigint; burn: bigint }) => s.creator + s.pile + s.burn;
const parts = (creator: number, pile: number, burn: number): Parts => ({ creator: BigInt(creator), pile: BigInt(pile), burn: BigInt(burn) });

describe('SH-318 the rules split as RuleSplitter.distribute does', () => {
  it('adds up to the income to the last unit, the last rule taking the remainder', () => {
    for (const income of [0n, 1n, 7n, 9_999n, 10_001n, 123_456_789_123n, 3n * ONE + 1n]) {
      for (const p of [parts(3333, 3333, 3334), parts(1000, 6000, 3000), parts(1, 9998, 1), parts(5000, 0, 5000)]) {
        expect(sum(splitByRules(income, p))).toBe(income);
      }
    }
    // 10 units at 33.33 / 33.33 / 33.34: 3, 3, and the rest 4.
    expect(splitByRules(10n, parts(3333, 3333, 3334))).toEqual({ creator: 3n, pile: 3n, burn: 4n });
  });

  it('gives a part at 0 nothing and lets the last part above 0 take the remainder', () => {
    expect(splitByRules(101n, parts(5000, 5000, 0))).toEqual({ creator: 50n, pile: 51n, burn: 0n });
    expect(splitByRules(101n, parts(0, 5000, 5000))).toEqual({ creator: 0n, pile: 50n, burn: 51n });
  });

  it('gives one part at 100% everything', () => {
    expect(splitByRules(12_345n, PILE_ONLY)).toEqual({ creator: 0n, pile: 12_345n, burn: 0n });
    expect(splitByRules(12_345n, parts(10_000, 0, 0))).toEqual({ creator: 12_345n, pile: 0n, burn: 0n });
    expect(splitByRules(12_345n, parts(0, 0, 10_000))).toEqual({ creator: 0n, pile: 0n, burn: 12_345n });
  });

  it('refuses parts that do not add up to 10,000', () => {
    expect(() => splitByRules(1n, parts(5000, 4000, 0))).toThrow(RangeError);
  });
});

describe('SH-318 the trades', () => {
  it('rounds a fee up (Flap curve) or down (Four.meme)', () => {
    expect(feeOn(1n, 100n, 'up')).toBe(1n);
    expect(feeOn(1n, 100n, 'down')).toBe(0n);
    expect(feeOn(10_000n, 100n, 'up')).toBe(100n);
    expect(feeOn(ONE, 0n, 'up')).toBe(0n);
  });

  it('alternates buys and sells, buys first', () => {
    const run = runTrades(3, ONE, 300n, 500n, 'down');
    expect(run.traded).toBe(3n * ONE);
    expect(run.income).toBe(2n * (ONE * 3n) / 100n + (ONE * 5n) / 100n);
  });
});

describe('SH-318 the flows', () => {
  it('Flap: 100 trades of 1 coin at 1% give 1 coin of curve fees, shared by the rules exactly', () => {
    const flow = flapFlow(100, ONE, 100n, 2000n, parts(2000, 5000, 3000));
    expect(flow.curve.run.income).toBe(ONE);
    expect(flow.curve.split).toEqual({ creator: ONE / 5n, pile: ONE / 2n, burn: (ONE * 3n) / 10n });
    expect(flow.tax).toEqual({ burnedBps: 2000n, restBps: 8000n, parts: parts(2000, 5000, 3000) });
  });

  it('Flap: a fee of 0 pays nothing anywhere', () => {
    const flow = flapFlow(100, ONE, 0n, 0n, PILE_ONLY);
    expect(sum(flow.curve.split)).toBe(0n);
  });

  it('Four.meme: an odd split of an odd income still adds up', () => {
    const flow = fourFlow(100, 1_000_003n, 333n, 777n, parts(3300, 3300, 3400));
    expect(flow.run.income).toBe(50n * ((1_000_003n * 333n) / 10_000n) + 50n * ((1_000_003n * 777n) / 10_000n));
    expect(sum(flow.split)).toBe(flow.run.income);
  });

  it('says basis points as percent', () => {
    expect(bpsText(2000n)).toBe('20%');
    expect(bpsText(1250n)).toBe('12.5%');
    expect(bpsText(25n)).toBe('0.25%');
    expect(bpsText(0n)).toBe('0%');
  });
});
