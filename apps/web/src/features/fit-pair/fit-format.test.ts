import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAUNCH_TAX_TABLE_PIPS, MISFITS_CURVE } from '@squarehole/indexer/client';
import { describe, expect, it } from 'vitest';
import { CHART, curveChartModel } from './curve-chart';
import { blocks, ethDecimal, formatAgo, formatBlock, formatBps, formatEth, formatFit, formatFitShort, formatTaxPips, formatUtc, isoTime, shiftDecimal, shortAddress, significant } from './fit-format';
import { FIT_ICON_PATHS } from './FitParts';

describe('display helpers: amounts truncate, charges round up', () => {
  it('formats ETH, FIT and bps', () => {
    expect(formatEth(4_206_980_085_000_000_000n, 9)).toBe('4.206980085 ETH');
    expect(formatEth(1_999_999_999_999_999_999n, 2)).toBe('1.99 ETH');
    expect(formatFit(798_137_969_320_803_416_571_965_883n, { compact: true })).toBe('798.1M FIT');
    expect(formatFit(1_079_101_560_000_000_000_000_000n)).toBe('1,079,101.56 FIT');
    expect(formatBps(3_059)).toBe('30.5%');
    expect(formatBps(10_000)).toBe('100.0%');
    expect(formatBps(-3)).toBe('0.0%');
    expect(formatBlock(21_000_960n)).toBe('21,000,960');
    expect(blocks(1n)).toBe('1 block');
    expect(blocks(12n)).toBe('12 blocks');
  });

  it('shortens FIT figures for a phone-width tile without overstating them, and gives the tape a clock time', () => {
    expect(formatFitShort(1_079_101_560_000_000_000_000_000n)).toBe('1.07M FIT');
    expect(formatFitShort(501_369_999_000_000_000_000_000_000n)).toBe('501.36M FIT');
    expect(formatFitShort(1_000_000_000_000_000_000_000_000_000n)).toBe('1B FIT');
    expect(formatFitShort(4_209_990_000_000_000_000_000n)).toBe('4.2K FIT');
    expect(formatFitShort(999_990_000_000_000_000_000n)).toBe('999.99 FIT');
    expect(formatFitShort(0n)).toBe('0 FIT');
    expect(ethDecimal(1_286_731_993_000_000_000n)).toBe('1.2867');
  });

  it('gives the tape a time relative to the newest block, truncated, with the exact time as ISO for <time>', () => {
    expect(formatAgo(0n)).toBe('now');
    expect(formatAgo(-12n)).toBe('now');
    expect(formatAgo(36n)).toBe('36 s ago');
    expect(formatAgo(59n)).toBe('59 s ago');
    expect(formatAgo(60n)).toBe('1 min ago');
    expect(formatAgo(3_599n)).toBe('59 min ago');
    expect(formatAgo(3_600n)).toBe('1 h ago');
    expect(formatAgo(86_399n)).toBe('23 h ago');
    expect(formatAgo(2n * 86_400n + 5n)).toBe('2 d ago');
    expect(isoTime(1_790_737_908n)).toBe('2026-09-30T03:11:48.000Z');
  });

  it('never understates a charge: tax pips get two decimals, rounded up (the router rounds the tax up too)', () => {
    expect(formatTaxPips(931_974)).toBe('93.20%');
    expect(formatTaxPips(80_565)).toBe('8.06%');
    expect(formatTaxPips(154_639)).toBe('15.47%');
    expect(formatTaxPips(10_000)).toBe('1.00%');
    expect(formatTaxPips(10_001)).toBe('1.01%');
    expect(formatTaxPips(0)).toBe('0.00%');
    expect(formatTaxPips(1_000_000)).toBe('100.00%');
    expect(formatTaxPips(-5)).toBe('0.00%');
    // F33 (DECISION-LOG): "93.20% → 8.06% over 32 blocks".
    expect(formatTaxPips(LAUNCH_TAX_TABLE_PIPS[0] ?? 0)).toBe('93.20%');
    expect(formatTaxPips(LAUNCH_TAX_TABLE_PIPS.at(-1) ?? 0)).toBe('8.06%');
  });

  it('cuts decimals to significant digits and shifts them exactly', () => {
    expect(significant('0.00000000137466052811')).toBe('0.0000000013746');
    expect(significant('0.000000020209', 3)).toBe('0.0000000202');
    expect(significant('123.456789', 5)).toBe('123.45');
    expect(significant('0')).toBe('0');
    expect(shiftDecimal('0.0000000013746', 6)).toBe('0.0013746');
    expect(shiftDecimal('1.5', 6)).toBe('1500000');
    expect(shiftDecimal('0.000001', 6)).toBe('1');
  });

  it('shortens addresses and prints block times in UTC', () => {
    expect(shortAddress('0x2D9fB39AA944E8ba72285D6777AaDC1cE3b2BE01')).toBe('0x2D9f…BE01');
    expect(formatUtc(1_790_726_400n)).toBe('30 Sept, 00:00:00 UTC');
    expect(formatUtc(1_790_726_400n + 3_723n, false)).toBe('30 Sept, 01:02 UTC');
  });
});

describe('the curve drawing', () => {
  it('runs from the start price at 0 ETH to the completion price at the target, with no fill before a buy', () => {
    const start = curveChartModel(MISFITS_CURVE, { retainedWei: 0n, tick: MISFITS_CURVE.tickUpper }, { retainedWei: 0n, tick: MISFITS_CURVE.tickUpper });
    expect(start.filled).toBe('');
    expect(start.head).toBeNull();
    expect(start.confirmed).toEqual({ x: CHART.left, y: CHART.height - CHART.bottom });
    expect(start.targetX).toBe(CHART.width - CHART.right);
    expect(start.line.startsWith(`M${CHART.left} ${CHART.height - CHART.bottom}`)).toBe(true);
    const full = curveChartModel(MISFITS_CURVE, { retainedWei: MISFITS_CURVE.targetWei, tick: MISFITS_CURVE.tickLower }, { retainedWei: MISFITS_CURVE.targetWei, tick: MISFITS_CURVE.tickLower });
    expect(full.confirmed).toEqual({ x: CHART.width - CHART.right, y: CHART.top });
    expect(full.filled.endsWith('Z')).toBe(true);
  });

  it('draws a ring for the newest block only while it differs from the confirmed one', () => {
    const half = MISFITS_CURVE.targetWei / 2n;
    const model = curveChartModel(MISFITS_CURVE, { retainedWei: half, tick: 190_000 }, { retainedWei: half + 10n ** 17n, tick: 189_000 });
    expect(model.head).not.toBeNull();
    expect((model.head?.x ?? 0) > model.confirmed.x).toBe(true);
  });
});

describe('the FIT icon', () => {
  it('uses exactly the approved small icon’s paths and colours (F20 (5), (6))', () => {
    const svg = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/design/art/fit/fit-icon-small.svg'), 'utf8');
    const paths = [...svg.matchAll(/<path fill="([^"]+)" fill-rule="evenodd" d="([^"]+)"\/>/g)].map((m) => ({ fill: m[1], d: m[2] }));
    expect(paths).toEqual(FIT_ICON_PATHS);
  });
});
