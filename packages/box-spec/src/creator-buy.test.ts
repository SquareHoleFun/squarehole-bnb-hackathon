/**
 * The creator's first tokens (F61 O2, BC-117) on the CURVE_V1 layout: exact-input swap steps inside the one range,
 * checked against the layout's own totals (the whole range holds `raise` Q and `curveT` T) and its monotonicity.
 */
import { describe, expect, it } from 'vitest';
import { curveBuyOut, curveBuyStep, issuanceBps } from './creator-buy';
import { BOOTSTRAP_ETH, ISSUANCE, Q_LIST_V2 } from './generated/box-spec.v1';
import { boxCurve, tIsCurrency0 } from './layout';

const ETH = 10n ** 18n;
const ETH_Q = '0x0000000000000000000000000000000000000000';
const T = '0x00000000000000000000000000000000000000aa';
const curveFor = (raise: bigint) => boxCurve(raise, tIsCurrency0(T, ETH_Q));

describe('curveBuyOut (creator buy, F61 O2)', () => {
  it('is zero for no buy and grows with the input, never past the curve’s T', () => {
    const c = curveFor(ETH);
    expect(curveBuyOut(c, 0n)).toBe(0n);
    let previous = 0n;
    for (const qIn of [ETH / 1_000n, ETH / 100n, ETH / 20n, ETH / 2n, ETH - 1n]) {
      const out = curveBuyOut(c, qIn);
      expect(out > previous, `${qIn}`).toBe(true);
      expect(out < c.curveT).toBe(true);
      previous = out;
    }
  });

  it('crosses the whole curve for exactly the raise after the 1% fee (no bootstrap)', () => {
    for (const raise of Q_LIST_V2[0]?.raisePresets ?? []) {
      const c = curveFor(raise);
      // qIn × 0.99 = raise, rounded up so the fee leaves at least `raise`.
      const qIn = (raise * 1_000_000n + 989_999n) / 990_000n;
      const out = curveBuyStep(c, c.sqrtPriceStartX96, (raise * 1_000_000n) / 990_000n).tOut;
      expect(c.curveT - out).toBeLessThan(c.curveT / 1_000_000n);
      expect(() => curveBuyStep(c, c.sqrtPriceStartX96, qIn + raise / 100n)).toThrow(/leave the curve range/);
    }
  });

  it('a buy just below the raise stays inside the range after the bootstrap (the curve never closes at creation)', () => {
    for (const raise of Q_LIST_V2[0]?.raisePresets ?? []) {
      expect(() => curveBuyOut(curveFor(raise), raise - 1n)).not.toThrow();
    }
  });

  it('0.05 ETH on a 1 ETH target is about 13% of the issuance; the bootstrap comes first', () => {
    const c = curveFor(ETH);
    const out = curveBuyOut(c, ETH / 20n);
    const bps = issuanceBps(out);
    expect(bps).toBeGreaterThanOrEqual(1_200n);
    expect(bps).toBeLessThanOrEqual(1_400n);
    // Without the bootstrap ahead of it the same buy gets slightly more.
    expect(curveBuyOut(c, ETH / 20n, 0n) > out).toBe(true);
    expect(curveBuyOut(c, ETH / 20n, BOOTSTRAP_ETH)).toBe(out);
    expect(issuanceBps(ISSUANCE)).toBe(10_000n);
  });

  it('works the same way when T sorts below Q (Q is currency1)', () => {
    const q = '0xffffffffffffffffffffffffffffffffffffffff';
    const c = boxCurve(ETH, tIsCurrency0(T, q));
    expect(c.tIsCurrency0).toBe(true);
    const out = curveBuyOut(c, ETH / 20n);
    expect(issuanceBps(out)).toBeGreaterThanOrEqual(1_200n);
    expect(issuanceBps(out)).toBeLessThanOrEqual(1_400n);
    expect(() => curveBuyStep(c, c.sqrtPriceStartX96, -1n)).toThrow(/negative/);
  });
});
