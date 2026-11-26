/**
 * SH-BOX-LIFE-VIEW: the pool price's conversion, bigint only (life-chart.ts). GPU Poor's recorded √prices: PoolLaunched's
 * (the range's top tick, the curve's start) and the filling buy's (one tick under its bottom, the curve's end). The
 * launch curve's geometry and its tests went with its last caller (SH-BOX-CANDLES fix round 2).
 */
import { describe, expect, it } from 'vitest';
import { pricePPerTX18Of } from './life-chart';
import { pricePerMillionV2 } from './stats-v2';

describe('the pool price', () => {
  it('GPU Poor’s: 0.032659 tNVDA per 1M VRAM at the start (PoolLaunched’s √price), 0.48009 at 100% (the filling buy’s), as the founder saw it', () => {
    expect(pricePerMillionV2(pricePPerTX18Of(438_406_088_115_093_226_748_068_450_413_642n), 18)).toBe('0.032659');
    expect(pricePerMillionV2(pricePPerTX18Of(114_344_156_602_762_052_670_952_517_149_140n), 18)).toBe('0.48009');
  });

  it('falls as √price rises (P is currency0), and is 0 for a √price of 0', () => {
    expect(pricePPerTX18Of(2n * 10n ** 32n)).toBeLessThan(pricePPerTX18Of(10n ** 32n));
    expect(pricePPerTX18Of(0n)).toBe(0n);
  });
});
