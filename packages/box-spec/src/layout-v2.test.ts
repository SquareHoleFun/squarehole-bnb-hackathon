import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import cases from '../vectors/cases.v2.json';
import legacyVectors from '../../contracts/test/vectors/box-spec/layout-v1.json';
import { boxCurve as legacyCurve, boxGraduated as legacyGraduated, centreTick as legacyCentre } from './layout';
import { boxCurve, boxGraduated, centreTick, fullRange } from './layout-v2';
import { CURVE_SHARE_TARGET, ISSUANCE, MIN_USABLE_TICK, MAX_USABLE_TICK } from './generated/box-spec.v1';
import { getAmount0Delta, getAmount1Delta, getSqrtPriceAtTick, getTickAtSqrtPrice, isqrt } from './v4-math';

const LIMIT = 43_368_086n;
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v));
const exactCentre = (r: bigint) => Math.floor((getTickAtSqrtPrice(isqrt((CURVE_SHARE_TARGET << 192n) / r)) + 30) / 60) * 60;

describe('CQ9-4 / F114 R28E small raises', () => {
  it.each(cases.layouts)('BC-003/067: $name agrees with the exact Python vectors', (v) => {
    const r = BigInt(v.curve.raise);
    const c = boxCurve(r, false);
    const { centreTickExact, raiseHeld, ...curve } = v.curve;
    expect(raiseHeld).toBe(r.toString());
    expect(centreTickExact).toBe(getTickAtSqrtPrice(isqrt((CURVE_SHARE_TARGET << 192n) / r)));
    expect(json(c)).toEqual(curve);
    expect(json(boxGraduated(c, 1, r, c.poolShare))).toEqual({ gradLayout: 1, ...v.bPrime });
    expect(json(boxGraduated(c, 2, r, c.poolShare))).toEqual({ gradLayout: 2, ...v.askFullBidSentinel });
  });

  it('BC-215: every listed vector raise builds, including 15,100,000 WBTC sats', () => {
    for (const listing of cases.listings) {
      const r = BigInt(listing.raise);
      const c = boxCurve(r, false);
      expect(() => fullRange(c, r, c.poolShare)).not.toThrow();
    }
  });

  it('BC-002/003: every legacy vector is identical in both orders', () => {
    for (const v of legacyVectors.vectors) {
      const r = BigInt(v.raise);
      const c = boxCurve(r, v.tIsCurrency0);
      expect(c).toEqual(legacyCurve(r, v.tIsCurrency0));
      for (const grad of [1, 2]) expect(boxGraduated(c, grad, r, c.poolShare)).toEqual(legacyGraduated(c, grad, r, c.poolShare));
    }
  });

  it('BC-003: the overflow boundary is continuous and the old branch is exact', () => {
    for (let r = LIMIT - 100n; r <= LIMIT + 100n; r++) {
      expect(centreTick(r, false)).toBe(exactCentre(r));
      if (r > LIMIT) expect(boxCurve(r, false)).toEqual(legacyCurve(r, false));
    }
    expect(() => legacyCurve(15_100_000n, false)).toThrow('FullMath.mulDiv overflow');
    expect(() => boxCurve(0n, false)).toThrow('RaiseIsZero');
  });

  it('BC-003: exact-centre difference is bounded at every small-raise spacing transition', () => {
    // Test the integer raises immediately around every centre-rounding boundary.
    const numerator = CURVE_SHARE_TARGET << 192n;
    for (let tick = 443_610; tick <= 619_530; tick += 60) {
      const s = getSqrtPriceAtTick(tick);
      const transition = numerator / (s * s);
      for (const r of [transition - 1n, transition, transition + 1n]) {
        if (r <= 0n || r > LIMIT) continue;
        const diff = exactCentre(r) - centreTick(r, false);
        expect(diff).toBeGreaterThanOrEqual(0);
        expect(diff).toBeLessThanOrEqual(60);
      }
    }
  });

  it('BC-003: sampled existing centres retain their exact calculation at every scale', () => {
    let seed = 0x435139n;
    for (let i = 0; i < 2_003; i++) {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      const r = LIMIT + 1n + seed * (10n ** BigInt(i % 14));
      for (const order of [false, true]) expect(centreTick(r, order)).toBe(legacyCentre(r, order));
    }
  });
});

describe('CQ11-0 / BC-003/067 full-range graduation', () => {
  it('BC-003: the Solidity replay digest pins all shared inputs and outputs', () => {
    let digest = Buffer.alloc(32);
    for (const v of cases.fullRangeLayouts) {
      const g = v.fullRange;
      const values = [v.raise, v.tIsCurrency0 ? 1 : 0, v.qHeld, v.tAvailable,
        g.tickLower, g.tickUpper, g.liquidity, g.qAmount, g.tAmount, g.qDust, g.tDust];
      const words = values.map((v) => Buffer.from(BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0'), 'hex'));
      digest = createHash('sha256').update(Buffer.concat([digest, ...words])).digest();
    }
    const fixture = readFileSync(new URL('../../contracts/test/box-v2/cq9/FullRangeVectors.sol', import.meta.url), 'utf8');
    expect(fixture).toContain(`DIGEST = hex"${digest.toString('hex')}"`);
    const raises = [...fixture.matchAll(/uint256\((\d+)\)/g)].map((match) => match[1]);
    expect(raises).toEqual(cases.fullRangeLayouts.filter((v) => v.name.endsWith('/pool-share')).map((v) => v.raise));
  });

  it.each(cases.fullRangeLayouts)('$name matches Python and Solidity', (v) => {
    const c = boxCurve(BigInt(v.raise), v.tIsCurrency0);
    const g = fullRange(c, BigInt(v.qHeld), BigInt(v.tAvailable));
    expect(json(g)).toEqual(v.fullRange);
    assertFunded(c, BigInt(v.qHeld), BigInt(v.tAvailable));
  });

  it('BC-067: every admitted raise funds one position, sampled at every bit scale', () => {
    const max = (1n << 128n) - 1n;
    let seed = 0x43513131n;
    let admitted = 0;
    let rejected = 0;
    for (let i = 0; i < 2048; i++) {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & max;
      const r = 1_000_000n + seed % ((1n << BigInt(20 + i % 109)) - 1_000_000n);
      for (const order of [false, true]) {
        let c: ReturnType<typeof boxCurve>;
        try { c = boxCurve(r, order); } catch (error) {
          expect(String(error)).toContain('NoExactLiquidity');
          rejected++;
          continue;
        }
        admitted++;
        assertFunded(c, r, c.poolShare);
        assertFunded(c, max, ISSUANCE);
      }
    }
    expect(admitted).toBeGreaterThan(1000);
    expect(rejected).toBeGreaterThan(0);
  });
});

function assertFunded(c: ReturnType<typeof boxCurve>, q: bigint, t: bigint): void {
  const g = fullRange(c, q, t);
  expect(g.tickLower).toBe(MIN_USABLE_TICK);
  expect(g.tickUpper).toBe(MAX_USABLE_TICK);
  const a = getSqrtPriceAtTick(g.tickLower);
  const b = getSqrtPriceAtTick(g.tickUpper);
  const p = c.sqrtPriceEndX96;
  const amount0 = getAmount0Delta(p, b, g.liquidity, true);
  const amount1 = getAmount1Delta(a, p, g.liquidity, true);
  expect(g.qAmount).toBe(c.tIsCurrency0 ? amount1 : amount0);
  expect(g.tAmount).toBe(c.tIsCurrency0 ? amount0 : amount1);
  expect(g.qAmount).toBeLessThanOrEqual(q);
  expect(g.tAmount).toBeLessThanOrEqual(t);
  expect(g.qAmount + g.qDust).toBe(q);
  expect(g.tAmount + g.tDust).toBe(t);
  expect(g.liquidity).toBeLessThan(1n << 128n);
  if (q >= c.raise && t >= c.poolShare) expect(g.liquidity).toBeGreaterThan(0n);
}
