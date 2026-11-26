/**
 * SH-BOX-CANDLES: the candle answers, the steps and Max, the numbers. Fixtures: the Alchemist box's candles as
 * api.squarehole.fun answered them on 2026-10-28 (e2e/fixtures/box-candles/), and GPU Poor's recorded activity
 * (e2e/fixtures/box-life/) through the test route (test-support/candles-v2.ts).
 */
import { describe, expect, it } from 'vitest';
import { candlesFromTrades } from '../../../../../../packages/indexer/src/core/candles';
import type { TradeRoute } from '../../../../../../packages/indexer/src/core/derive-core';
import alchemist1d from '../../../../e2e/fixtures/box-candles/alchemist-1d.json' with { type: 'json' };
import alchemist1h from '../../../../e2e/fixtures/box-candles/alchemist-1h.json' with { type: 'json' };
import alchemist1m from '../../../../e2e/fixtures/box-candles/alchemist-1m.json' with { type: 'json' };
import {
  axisPriceV2, boxStartV2, bucketsOverV2, CANDLE_CHOICES_V2, CANDLE_LIMITS_V2, CANDLE_STEPS_V2, candleLimitV2, candlePriceV2, candleReadoutV2, candlesUrlV2,
  CHART_DIGITS_V2, DEFAULT_CANDLE_CHOICE_V2, drawBaseV2, drawnPriceV2, drawScaleV2, drawValueV2, maxStepV2, parseCandlesV2, significantV2, TIME_SLOTS_MAX, timeSlotsV2,
  WIDE_CHART_PX, zeroCountV2, type PriceCandleV2,
} from './candles-v2';
import { pricePerMillionV2 } from './stats-v2';
import { pricePPerTX18Of } from './life-chart';
import type { HourlyCandleV2, StatisticsV2 } from './stats-v2';
import { candleAnswerV2, candlesOfItemsV2 } from './test-support/candles-v2';
import { recordedLifeV2 } from './test-support/life-v2';

type Wire = Record<string, unknown>;
const recorded1m = alchemist1m as Wire;

describe('the steps', () => {
  it('are one constant, finest first, then Max, the default', () => {
    expect(CANDLE_STEPS_V2.map((step) => [step.id, step.seconds])).toEqual([['12s', 12n], ['1m', 60n], ['10m', 600n], ['1h', 3_600n], ['10h', 36_000n], ['1d', 86_400n]]);
    expect(CANDLE_CHOICES_V2).toEqual(['12s', '1m', '10m', '1h', '10h', '1d', 'max']);
    expect(DEFAULT_CANDLE_CHOICE_V2).toBe('max');
  });

  it('ask for one of two limits by the chart’s width, so the server’s cache keys stay few', () => {
    expect(CANDLE_LIMITS_V2).toEqual({ narrow: 120, wide: 300 });
    expect([candleLimitV2(0), candleLimitV2(324), candleLimitV2(WIDE_CHART_PX - 1), candleLimitV2(WIDE_CHART_PX), candleLimitV2(894)]).toEqual([120, 120, 120, 300, 300]);
    expect(candlesUrlV2('https://api.squarehole.fun', 11155111, '0x27FFa84723187584a29f723514bc0185c4a9bed4', '10m', 120))
      .toBe('https://api.squarehole.fun/v2/boxes/11155111/0x27ffa84723187584a29f723514bc0185c4a9bed4/candles?interval=10m&limit=120');
  });
});

describe('a candle answer', () => {
  it('parses the live answer: √price to the price, the high from the lowest √price (P is currency0), volume and trades', () => {
    const answer = parseCandlesV2(recorded1m, '1m', 300);
    expect(answer.step).toBe('1m');
    expect(answer.asOfBlock).toBe(12009973n);
    expect(answer.candles.map((c) => c.start)).toEqual([1793150700n, 1793153880n, 1793153940n, 1793154120n]);
    const wire = (recorded1m.candles as Wire[])[0] as Wire;
    expect(answer.candles[0]).toEqual({
      start: 1793150700n,
      open: pricePPerTX18Of(BigInt(wire.openSqrtPriceX96 as string)),
      high: pricePPerTX18Of(BigInt(wire.lowSqrtPriceX96 as string)),
      low: pricePPerTX18Of(BigInt(wire.highSqrtPriceX96 as string)),
      close: pricePPerTX18Of(BigInt(wire.closeSqrtPriceX96 as string)),
      volumeP: 35655029729003340410n,
      trades: 1,
    });
    // The bootstrap buy, then the fill, then the hook's two swaps (the price moves, no volume, no trade).
    expect(answer.candles.map((c) => [candlePriceV2(c.close, 18), c.volumeP, c.trades])).toEqual([['32.655', 35655029729003340410n, 1], ['479.09', 100974445980372006760603n, 1], ['481.44', 0n, 0], ['483.8', 0n, 0]]);
    expect(parseCandlesV2(alchemist1h, '1h', 300).candles).toHaveLength(2);
    expect(parseCandlesV2(alchemist1d, '1d', 300).candles).toHaveLength(1);
  });

  it('a candle of several swaps: the high and the low whichever way the price ran', () => {
    const [a, b, c] = [3619679393819893996447412573959n, 3601987230580817423672215802557n, 13864316341171495485193645228472n];
    const body = { asOf: null, interval: '12s', candles: [{ start: '1793153880', openSqrtPriceX96: String(a), highSqrtPriceX96: String(c), lowSqrtPriceX96: String(b), closeSqrtPriceX96: String(a), volumeQ: '7', trades: 3 }] };
    const [candle] = parseCandlesV2(body, '12s', 120).candles;
    expect(candle?.high).toBe(pricePPerTX18Of(b));
    expect(candle?.low).toBe(pricePPerTX18Of(c));
    expect([candle?.open, candle?.close]).toEqual([pricePPerTX18Of(a), pricePPerTX18Of(a)]);
  });

  it('keeps the newest `limit` candles of a server that does not page yet', () => {
    expect(parseCandlesV2(recorded1m, '1m', 2).candles.map((c) => c.start)).toEqual([1793153940n, 1793154120n]);
  });

  it('is refused whole when anything is off', () => {
    const candles = recorded1m.candles as Wire[];
    const first = candles[0] as Wire;
    const bad: unknown[] = [
      null,
      { ...recorded1m, interval: '1h' },
      { ...recorded1m, candles: 'none' },
      { ...recorded1m, candles: [...candles].reverse() },
      { ...recorded1m, candles: [first, first] },
      { ...recorded1m, candles: [{ ...first, lowSqrtPriceX96: '0', highSqrtPriceX96: '0', openSqrtPriceX96: '0', closeSqrtPriceX96: '0' }] },
      { ...recorded1m, candles: [{ ...first, highSqrtPriceX96: '1' }] },
      { ...recorded1m, candles: [{ ...first, openSqrtPriceX96: '99999999999999999999999999999999999' }] },
      { ...recorded1m, candles: [{ ...first, volumeQ: 12 }] },
      { ...recorded1m, candles: [{ ...first, volumeQ: '-1' }] },
      { ...recorded1m, candles: [{ ...first, trades: -1 }] },
      { ...recorded1m, candles: [{ ...first, trades: 1.5 }] },
      { ...recorded1m, candles: [{ ...first, start: 1793150700 }] },
    ];
    for (const input of bad) expect(() => parseCandlesV2(input, '1m', 300), JSON.stringify(input)?.slice(0, 120)).toThrow();
  });
});

describe('the test route (test-support/candles-v2.ts)', () => {
  const items = (recordedLifeV2.gpuPoor.activity.items as Wire[]);
  it('buckets with the indexer’s own rule on the steps the live server has', () => {
    const trades = items.filter((item) => item.kind === 'trade').map((item) => ({ timestamp: BigInt(item.timestamp as string), block: BigInt(item.block as string), logIndex: item.logIndex as number, sqrtPriceX96After: BigInt(item.sqrtPriceX96After as string), qRaw: BigInt(item.qRaw as string), route: item.route as TradeRoute }));
    expect(trades.length).toBeGreaterThan(3);
    for (const interval of ['1m', '1h', '1d'] as const) expect(candlesOfItemsV2(items, interval), interval).toEqual(candlesFromTrades(trades, interval));
  });

  it('answers every step with its limit, and 400 for a step or a limit it does not serve', () => {
    const asOf = { block: '1' };
    const answer = (query: string, steps?: readonly string[]) => candleAnswerV2(items, new URL(`https://indexer.invalid/v2/boxes/1/0x1/candles?${query}`), asOf, steps);
    expect((answer('interval=12s&limit=1000').body as { candles: unknown[] }).candles.length).toBe(candlesOfItemsV2(items, '12s').length);
    expect((answer('interval=12s&limit=2').body as { candles: unknown[] }).candles).toEqual(candlesOfItemsV2(items, '12s').slice(-2));
    expect(answer('interval=10m&limit=120', ['1m', '1h', '1d']).status).toBe(400);
    expect(answer('interval=1m&limit=1001').status).toBe(400);
    expect(parseCandlesV2(answer('interval=10h&limit=120').body, '10h', 120).step).toBe('10h');
  });
});

describe('Max', () => {
  const hour = (start: bigint, tradeCount: bigint): HourlyCandleV2 => ({ start, open: 1n, high: 1n, low: 1n, close: 1n, volumeP: 0n, tradeCount });
  const stats = (tradeCount: bigint, hours: readonly HourlyCandleV2[]) => ({ tradeCount, hourlyCandles: hours }) as unknown as StatisticsV2;

  it('starts the box at its first hourly candle when the snapshot’s hours hold every trade; else the first daily candle decides', () => {
    expect(boxStartV2(stats(3n, [hour(7_200n, 2n), hour(10_800n, 1n)]))).toBe(7_200n);
    // Trades older than the 168 hours the indexer keeps.
    expect(boxStartV2(stats(9n, [hour(7_200n, 2n), hour(10_800n, 1n)]))).toBeNull();
    expect(boxStartV2(stats(0n, []))).toBeNull();
    expect(boxStartV2(null)).toBeNull();
    expect(boxStartV2(undefined)).toBeNull();
  });

  it('counts the epoch-aligned buckets of the box’s life', () => {
    expect(bucketsOverV2(60n, 60n, 60n)).toBe(1n);
    expect(bucketsOverV2(59n, 60n, 60n)).toBe(2n);
    expect(bucketsOverV2(0n, 86_399n, 3_600n)).toBe(24n);
    expect(bucketsOverV2(100n, 50n, 12n)).toBe(1n);
  });

  it('picks the finest step whose buckets over the box’s life fit the limit', () => {
    const start = 1_793_150_700n;
    const at = (seconds: bigint) => start + seconds;
    // A box an hour old: 301 buckets of 12 s are too many for a wide chart; its minutes fit.
    expect(maxStepV2(start, at(10n * 60n), 300)).toBe('12s');
    expect(maxStepV2(start, at(3_600n), 300)).toBe('1m');
    // The Alchemist box at 04:35 UTC, from its first hour (01:00): 210 minutes fit a wide chart, 21 ten-minute buckets a
    // narrow one.
    expect([maxStepV2(1_793_149_200n, 1_793_161_743n, 300), maxStepV2(1_793_149_200n, 1_793_161_743n, 120)]).toEqual(['1m', '10m']);
    // GPU Poor 22 hours in: 133 ten-minute buckets fit a wide chart, not a narrow one (23 hours do).
    const gpu = 1_793_080_800n;
    expect([maxStepV2(gpu, gpu + 22n * 3_600n, 300), maxStepV2(gpu, gpu + 22n * 3_600n, 120)]).toEqual(['10m', '1h']);
    expect(maxStepV2(start, at(40n * 86_400n), 120)).toBe('10h');
    // Older than any step's buckets: the coarsest.
    expect(maxStepV2(start, at(3_000n * 86_400n), 120)).toBe('1d');
  });
});

describe('the time axis', () => {
  const candle = (start: bigint): PriceCandleV2 => ({ start, open: 1n, high: 1n, low: 1n, close: 1n, volumeP: 0n, trades: 1 });
  it('runs evenly, an empty slot for a bucket without a swap, to the last candle, or on to now (Max)', () => {
    expect(timeSlotsV2([candle(120n), candle(300n)], '1m', null)).toEqual([120n, 180n, 240n, 300n]);
    expect(timeSlotsV2([candle(120n), candle(300n)], '1m', 479n)).toEqual([120n, 180n, 240n, 300n, 360n, 420n]);
    // Now before the last candle (a snapshot behind the candles): the last candle ends it.
    expect(timeSlotsV2([candle(120n), candle(300n)], '1m', 200n)).toEqual([120n, 180n, 240n, 300n]);
    expect(timeSlotsV2([], '1m', 479n)).toBeNull();
  });

  it('stands the candles side by side when the stretch is longer than the axis can hold; keeps a candle off the grid', () => {
    expect(timeSlotsV2([candle(0n), candle(12n * BigInt(TIME_SLOTS_MAX))], '12s', null)).toBeNull();
    expect(timeSlotsV2([candle(0n), candle(12n * BigInt(TIME_SLOTS_MAX - 1))], '12s', null)).toHaveLength(TIME_SLOTS_MAX);
    expect(timeSlotsV2([candle(0n), candle(90n)], '1m', null)).toEqual([0n, 60n, 90n]);
  });
});

describe('the numbers', () => {
  it('count the zeros of a tiny price', () => {
    expect(zeroCountV2('0.000000012')).toBe('0.0₇12');
    expect(zeroCountV2('0.0000123')).toBe('0.0₄123');
    expect(zeroCountV2('0.00012')).toBe('0.00012');
    expect(zeroCountV2('0.' + '0'.repeat(12) + '5')).toBe('0.0₁₂5');
    expect(zeroCountV2('483.8')).toBe('483.8');
    expect(zeroCountV2('1,234.5')).toBe('1,234.5');
  });

  it('show a price per 1M T exactly from the bigint, five significant digits', () => {
    // 1.2 × 10^-8 of the coin per 1M T, an 18-decimal coin: raw P per whole T × 10^18 is 1.2 × 10^22.
    expect(candlePriceV2(12_000_000_000_000_000_000_000n, 18)).toBe('0.0₇12');
    expect(candlePriceV2(483809987836201606114851694026802n, 18)).toBe('483.8');
    expect(candlePriceV2(3_354_812_345_000_000_000_000n, 6)).toBe('3,354.8');
  });

  it('hand the library numbers cut in bigint first (fix rounds 1 and 2, F3): each amount its own 15 digits, never a raw amount as a float', () => {
    const high = 483809987836201606114851694026802n;
    const scale = drawScaleV2([32655944502844340255738282104721n, high]);
    expect(scale).toBe(29);
    // The high at four digits before the point, its first 15 digits cut in bigint: where Number(high) alone would be the
    // float of a 33-digit integer.
    expect(drawValueV2(high, scale)).toBe(4838.09987836201);
    expect(drawValueV2(32655944502844340255738282104721n, scale)).toBe(326.559445028443);
    // A raw amount of 60 digits: its first 15 digits once scaled.
    const huge = 123456789012345678901234567890123456789012345678901234567890n;
    expect(drawValueV2(huge, drawScaleV2([huge]))).toBe(1234.56789012345);
    // Volumes take their own scale the same way.
    expect(drawValueV2(100974445980372006760603n, drawScaleV2([100974445980372006760603n]))).toBe(1009.74445980372);
    expect([drawScaleV2([]), drawValueV2(0n, 3)]).toEqual([0, 0]);
    expect(CHART_DIGITS_V2).toBe(15);
  });

  it('the reviewer\'s two cases (XR2-BOX-CANDLES, F3): a price above 10^12 and a small low next to a large high read the same on the axis and in the readout', () => {
    // pDecimals 18, a price of 1,234,567,890,123 per 1M T: the round-1 drawing kept 1234.56789 and the axis said
    // 1,234,567,890,000.
    const large = 1_234_567_890_123n * 10n ** 30n;
    const largeScale = drawScaleV2([large]);
    expect(largeScale).toBe(39);
    expect(drawValueV2(large, largeScale)).toBe(1234.567890123);
    expect(drawnPriceV2(drawValueV2(large, largeScale), largeScale)).toBe(large);
    expect(candlePriceV2(large, 18)).toBe('1,234,567,890,123');
    expect(axisPriceV2(drawValueV2(large, largeScale), largeScale, 18)).toBe('1,234,567,890,123');
    // A high of 1 per 1M T and a low of 0.0000000123456789 in one candle: the round-1 drawing kept 0.000012 and the axis
    // said 0.0₇12.
    const high = 10n ** 30n;
    const low = 123_456_789n * 10n ** 14n;
    const scale = drawScaleV2([high, low]);
    expect(scale).toBe(27);
    expect(drawValueV2(low, scale)).toBe(0.0000123456789);
    expect(drawnPriceV2(drawValueV2(low, scale), scale)).toBe(low);
    expect(candlePriceV2(low, 18)).toBe('0.0₇12345');
    expect(axisPriceV2(drawValueV2(low, scale), scale, 18)).toBe('0.0₇12345');
    expect(axisPriceV2(drawValueV2(high, scale), scale, 18)).toBe(candlePriceV2(high, 18));
  });

  it('round trips above 10^12 per 1M T, and small candles below 0.000001 next to a larger series high (F3 regressions)', () => {
    const per1M = (whole: bigint) => whole * 10n ** 30n;
    for (const price of [per1M(1_000_000_000_001n), per1M(987_654_321_987_654n), per1M(10n ** 14n) + 1n, per1M(5n * 10n ** 12n) + 123_456_789n * 10n ** 20n]) {
      const scale = drawScaleV2([price]);
      expect(axisPriceV2(drawValueV2(price, scale), scale, 18), String(price)).toBe(candlePriceV2(price, 18));
    }
    expect(candlePriceV2(per1M(987_654_321_987_654n), 18)).toBe('987,654,321,987,654');
    // Small candles beside a high of 4,838 per 1M T: 10^-13 to 10^-34 of it (1.2 × 10^-9 to 10^-30 per 1M T), each with its
    // own digits, none drawn as 0.
    const seriesHigh = per1M(4_838n);
    for (const low of [123_456_789n * 10n ** 13n, 1_234_567n * 10n ** 9n, 98_765n * 10n ** 7n, 7n * 10n ** 9n, 1n]) {
      const scale = drawScaleV2([seriesHigh, low]);
      const drawn = drawValueV2(low, scale);
      expect(drawn, String(low)).toBeGreaterThan(0);
      expect(drawnPriceV2(drawn, scale), String(low)).toBe(significantV2(low));
      expect(axisPriceV2(drawn, scale, 18), String(low)).toBe(candlePriceV2(low, 18));
    }
    expect(candlePriceV2(1_234_567n * 10n ** 9n, 18)).toBe('0.0₁₄12345');
    // 6 decimals too (a USDC-like coin).
    const small6 = 4_200_000_000_000n;
    const scale6 = drawScaleV2([3_354_812_345_000_000_000_000n, small6]);
    expect(axisPriceV2(drawValueV2(small6, scale6), scale6, 6)).toBe(candlePriceV2(small6, 6));
  });

  it('any amount comes back as its first 15 digits, and the axis then reads it as the readout does (20,000 seeded amounts of 1 to 75 digits)', () => {
    let seed = 20_261_028n;
    const next = () => (seed = (seed * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) & ((1n << 64n) - 1n));
    let checked = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const length = Number(next() % 75n) + 1;
      let amount = 0n;
      for (let d = 0; d < length; d += 1) amount = amount * 10n + (next() % 10n);
      if (amount === 0n) amount = 1n;
      const high = amount * 10n ** (next() % 40n) + (next() % 1_000n);
      const scale = drawScaleV2([amount, high]);
      const drawn = drawValueV2(amount, scale);
      if (!(drawn > 0) || drawnPriceV2(drawn, scale) !== significantV2(amount)) throw new Error(`round trip of ${amount} at 10^${scale}`);
      if (i % 50 === 0 && axisPriceV2(drawn, scale, i % 100 === 0 ? 18 : 6) !== candlePriceV2(amount, i % 100 === 0 ? 18 : 6)) throw new Error(`axis of ${amount}`);
      checked += 1;
    }
    expect(checked).toBe(20_000);
  });

  it('the chart\'s prices keep at most 15 digits, on the axis and in the readout alike; below 10^15 per 1M T the site\'s own text', () => {
    expect(significantV2(123_456_789_012_345_678n)).toBe(123_456_789_012_345_000n);
    expect([significantV2(999n), significantV2(0n)]).toEqual([999n, 0n]);
    const huge = 1_234_567_890_123_456_789n * 10n ** 30n;
    expect(candlePriceV2(huge, 18)).toBe('1,234,567,890,123,450,000');
    const scale = drawScaleV2([huge]);
    expect(axisPriceV2(drawValueV2(huge, scale), scale, 18)).toBe('1,234,567,890,123,450,000');
    for (const price of [483809987836201606114851694026802n, 12_000_000_000_000_000_000_000n, 1_234_567_890_123n * 10n ** 30n, 10n ** 44n - 1n]) {
      expect(candlePriceV2(price, 18), String(price)).toBe(zeroCountV2(pricePerMillionV2(price, 18)));
    }
  });

  it('the axis\'s finest step follows the smallest candle: 10^-4 from 1 up, five digits of a small one, at most 10^-12', () => {
    expect([drawBaseV2([]), drawBaseV2([0, 4838.1, 1]), drawBaseV2([9_999.99])]).toEqual([10 ** 4, 10 ** 4, 10 ** 4]);
    expect(drawBaseV2([1000, 0.5])).toBe(10 ** 5);
    expect(drawBaseV2([1000, 0.0000123456789])).toBe(10 ** 9);
    expect(drawBaseV2([1000, 1e-20])).toBe(10 ** 12);
  });

  it('label the axis with the readout\'s own helper, so a price reads the same on both (F3: 483.8, never 483.81 beside it)', () => {
    const answer = parseCandlesV2(recorded1m, '1m', 300);
    const scale = drawScaleV2(answer.candles.map((c) => c.high));
    for (const c of answer.candles) {
      const readout = candleReadoutV2(c, 18, 'tPEPE');
      expect(axisPriceV2(drawValueV2(c.close, scale), scale, 18), String(c.start)).toBe(readout[3]?.[1]);
      expect(axisPriceV2(drawValueV2(c.high, scale), scale, 18), String(c.start)).toBe(readout[1]?.[1]);
    }
    expect(axisPriceV2(drawValueV2(483809987836201606114851694026802n, scale), scale, 18)).toBe('483.8');
    expect(candlePriceV2(483809987836201606114851694026802n, 18)).toBe('483.8');
    // The axis's own marks: round prices per 1M T.
    expect(axisPriceV2(4000, scale, 18)).toBe('400');
    expect(axisPriceV2(0.5, scale, 18)).toBe('0.05');
    // A tiny price: 1.2 × 10^-8 per 1M T, zeros counted on the axis as in the readout.
    const tiny = 12_000_000_000_000_000_000_000n;
    const tinyScale = drawScaleV2([tiny]);
    expect(axisPriceV2(drawValueV2(tiny, tinyScale), tinyScale, 18)).toBe(candlePriceV2(tiny, 18));
    expect(axisPriceV2(drawValueV2(tiny, tinyScale), tinyScale, 18)).toBe('0.0₇12');
    // Whole numbers keep every integer digit, as the site's prices do.
    expect(axisPriceV2(12345678, 28, 6)).toBe('123,456,780,000,000,000');
    // Nothing below zero (the room under the lowest candle), and nothing for no number.
    expect([axisPriceV2(0, scale, 18), axisPriceV2(-1, scale, 18), axisPriceV2(Number.NaN, scale, 18)]).toEqual(['0', '', '']);
  });

  it('read out a candle from its exact numbers: open, high, low, close and the volume in the price coin', () => {
    const answer = parseCandlesV2(recorded1m, '1m', 300);
    expect(candleReadoutV2(answer.candles[1] as PriceCandleV2, 18, 'tPEPE')).toEqual([['O', '479.09'], ['H', '479.09'], ['L', '479.09'], ['C', '479.09'], ['Vol', '100,974.44 tPEPE']]);
  });
});
