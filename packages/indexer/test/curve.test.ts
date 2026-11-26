import { describe, expect, it } from 'vitest';
import { curveDrawPoints, curvePoint, ethPerToken, MISFITS_CURVE, REHEARSAL_CURVE, priceDecimal, units18 } from '../src/curve';
import { BAND_TARGET_WEI, MISFITS_LAUNCH_SHAPE, REHEARSAL_SHAPE } from '../src/shape';
import { computeSwapStepExactIn, getAmount0Delta, getAmount1Delta, getSqrtPriceAtTick } from '../src/v4-math';

const S = REHEARSAL_SHAPE;
const FEE = BigInt(S.lpFeePips);

describe('curve state from one sqrt price (the Sepolia rehearsal as deployed)', () => {
  it('starts empty at the top edge and is full at the completion price', () => {
    const start = curvePoint(S.sqrtPriceUpperX96);
    expect(start).toMatchObject({ retainedWei: 0n, soldRaw: 0n, fillBps: 0, curveBps: 0 });
    expect(start.leftRaw).toBe(getAmount1Delta(S.sqrtPriceLowerX96, S.sqrtPriceUpperX96, S.liquidity, false));
    const end = curvePoint(S.sqrtPriceLowerX96);
    expect(end.retainedWei).toBe(S.curveRaiseWei);
    expect(end.leftRaw).toBe(0n);
    expect(end.curveBps).toBe(10_000);
    expect(end.fillBps).toBe(10_000); // the full raise (4.2168 ETH) is above the band's 4.20698 target
    // Tokens out of the curve, rounded down, never more than the position took in (rounded up).
    expect(end.soldRaw).toBeLessThanOrEqual(S.curveTokensDeposited);
    expect(S.curveTokensDeposited - end.soldRaw).toBeLessThanOrEqual(1n);
  });

  it('matches the live pool after the bootstrap buy', () => {
    const point = curvePoint(2_134_673_235_199_704_036_912_890_647_912_850n);
    expect(point.retainedWei).toBe(1_484_999_999_999_999n); // 0.0015 ETH less the 1% fee, rounded down
    expect(point.soldRaw).toBe(1_079_104_076_324_374_082_820_149n); // Bootstrapped.tokensOut
    expect(point.fillBps).toBe(3);
    expect(units18(point.retainedWei)).toBe('0.001484999999999999');
    expect(priceDecimal(2_134_673_235_199_704_036_912_890_647_912_850n)).toBe('0.0000000013775150668');
  });

  it('clamps outside the range', () => {
    expect(curvePoint(S.sqrtPriceUpperX96 + 10n ** 20n).retainedWei).toBe(0n);
    expect(curvePoint(S.sqrtPriceLowerX96 - 10n ** 20n).retainedWei).toBe(S.curveRaiseWei);
  });

  it('reaches the band target just before the completion price', () => {
    // Retained ETH is strictly monotone in sqrt price; bisect the sqrt price where it first reaches the target.
    let lo = S.sqrtPriceLowerX96;
    let hi = S.sqrtPriceUpperX96;
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (curvePoint(mid).retainedWei >= BAND_TARGET_WEI) lo = mid;
      else hi = mid;
    }
    expect(curvePoint(lo).fillBps).toBe(10_000);
    expect(curvePoint(hi).fillBps).toBe(9_999);
    expect(lo).toBeGreaterThan(S.sqrtPriceLowerX96); // 100% of the band comes before the curve's end: "target reached", not graduated
    expect(curvePoint(lo).curveBps).toBe(9_976);
  });

  it('prices: k ≈ 14.70 between the start (≈1.3748e-9) and the completion (≈2.0209e-8) ETH per token', () => {
    const p0 = ethPerToken(S.sqrtPriceUpperX96);
    const p1 = ethPerToken(S.sqrtPriceLowerX96);
    const k1000 = (p1.num * p0.den * 1_000n) / (p1.den * p0.num);
    expect(k1000).toBe(14_700n);
    expect(priceDecimal(S.sqrtPriceUpperX96, 5)).toBe('0.0000000013747'); // truncated, never rounded up (1.37479…e-9)
    expect(priceDecimal(S.sqrtPriceLowerX96, 5)).toBe('0.000000020209');
  });

  it('draws 33 points on the launch window grid (840 ticks), monotone, with exact end points', () => {
    const points = curveDrawPoints(32);
    expect(points).toHaveLength(33);
    expect(points[0]).toMatchObject({ tick: S.tickUpper, retainedWei: 0n });
    expect(points[32]).toMatchObject({ tick: S.tickLower, retainedWei: S.curveRaiseWei });
    expect(points[1]?.tick).toBe(S.tickUpper - 840);
    for (let i = 1; i < points.length; i += 1) expect((points[i]?.retainedWei ?? 0n) > (points[i - 1]?.retainedWei ?? 0n)).toBe(true);
    expect(() => curveDrawPoints(11)).toThrow(RangeError); // 26,880 ticks do not split into 11 steps
  });

  it('retained ETH is the principal net of sells, fees excluded, along any buy/sell path', () => {
    // Replays a path of exact-input swaps with the v4 step math. The pool keeps amountIn (fee apart) on buys and pays
    // amountOut on sells; the curve's retained ETH must equal that net principal up to rounding (one wei per swap).
    let sqrt = S.sqrtPriceUpperX96;
    let principal = 0n;
    let swaps = 0n;
    const path: [boolean, bigint][] = [
      [true, 10n ** 17n], [true, 3n * 10n ** 17n], [false, 5n * 10n ** 24n], [true, 10n ** 18n], [false, 2n * 10n ** 25n], [true, 7n * 10n ** 15n],
    ];
    for (const [buy, amount] of path) {
      const limit = buy ? S.sqrtPriceLowerX96 : S.sqrtPriceUpperX96;
      const step = computeSwapStepExactIn(sqrt, limit, S.liquidity, amount, FEE);
      principal += buy ? step.amountIn : -step.amountOut;
      sqrt = step.sqrtPriceNextX96;
      swaps += 1n;
      const retained = curvePoint(sqrt).retainedWei;
      expect(principal - retained).toBeGreaterThanOrEqual(0n);
      expect(principal - retained).toBeLessThanOrEqual(swaps);
    }
    expect(curvePoint(sqrt).retainedWei).toBe(getAmount0Delta(sqrt, S.sqrtPriceUpperX96, S.liquidity, false));
  });

  it('uses the rehearsal constants', () => {
    expect(REHEARSAL_CURVE.targetWei).toBe(4_206_980_085_000_000_000n);
    expect(getSqrtPriceAtTick(REHEARSAL_CURVE.tickUpper)).toBe(REHEARSAL_CURVE.sqrtPriceUpperX96);
  });
});

describe('the Misfits launch curve (FitLaunchShape since F40 L6)', () => {
  const M = MISFITS_LAUNCH_SHAPE;

  it('fills the band exactly at the completion price: the full raise is the target', () => {
    const end = curvePoint(M.sqrtPriceLowerX96, MISFITS_CURVE);
    expect(end.retainedWei).toBe(BAND_TARGET_WEI);
    expect(end.retainedWei).toBe(4_206_980_085_000_000_000n);
    expect([end.fillBps, end.curveBps]).toEqual([10_000, 10_000]);
    expect(end.leftRaw).toBe(0n);
    expect(M.curveTokensDeposited - end.soldRaw).toBeLessThanOrEqual(1n);
    // One tick above the completion price, the band is not full yet.
    const before = curvePoint(getSqrtPriceAtTick(M.tickLower + 1), MISFITS_CURVE);
    expect(before.retainedWei).toBeLessThan(BAND_TARGET_WEI);
    expect(before.fillBps).toBe(9_999);
  });

  it('keeps fillBps and curveBps equal along the curve', () => {
    for (const point of curveDrawPoints(32, MISFITS_CURVE)) {
      const p = curvePoint(getSqrtPriceAtTick(point.tick), MISFITS_CURVE);
      expect(p.fillBps).toBe(p.curveBps);
    }
  });

  it('keeps the rehearsal on its own deployed shape', () => {
    expect(MISFITS_CURVE.tickLower).toBe(REHEARSAL_CURVE.tickLower);
    expect(MISFITS_CURVE.tickUpper).toBe(REHEARSAL_CURVE.tickUpper);
    expect(MISFITS_CURVE.liquidity).toBeLessThan(REHEARSAL_CURVE.liquidity);
    expect(REHEARSAL_CURVE.raiseWei - MISFITS_CURVE.raiseWei).toBe(9_814_751_692_248_391n);
  });
});
