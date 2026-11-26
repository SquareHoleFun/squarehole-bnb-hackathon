/**
 * SH-TA-29: v2 numbers on the box page and the feed, from the indexer's statistics (SH-TA-28): the founder's "numbers
 * and visuals first" set (price, market cap, raise progress during the curve, holders, burned, 24 h volume; on the page
 * beside SH-BOX-CANDLES's chart), formatted with bigint helpers; a figure the indexer does not have is a dash, never a
 * zero. Fixture views: the indexer's own recorded statistics (test-support/statistics-v2.ts)
 * on its published v2 box.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../../app-providers';
import { BoxCard } from '../../boxes/BoxCard';
import { mixedAssets, priceCoinKey, sortSummaries } from '../../boxes/box-feed';
import { createDemoWalletAdapter } from '../../wallet';
import { parseSnapshotV2, type V2Snapshot } from './indexer-v2';
import { recordV2, summaryV2 } from './record-v2';
import { candleGeometryV2, HOURS_KEPT, NO_FIGURE, pAmountV2, parseStatisticsV2, pricePerMillionV2, statFiguresV2, tShortV2 } from './stats-v2';
import { V2BoxPage } from './V2BoxPage';
import { fakeCanvas } from './test-support/candle-canvas-fake';
import { publishedV2 } from './test-support/published-v2';
import { recordedStatisticsV2 } from './test-support/statistics-v2';
import { CLOSED_BOX_HEADINGS, headingsUpTo, pictureLoaded } from './test-support/picture-loaded';

vi.mock('./SafesV2', () => ({ SafesV2: () => null }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => null }));
// SH-BOX-CANDLES: the chart's drawing (jsdom has no canvas).
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); fakeCanvas.reset(); });

const BONDING = { failed: null, closing: null, closedAt: 0n, timestamp: 1000n, gate: { open: true, effectiveOpenAt: 1000n, deadline: 2000n } } as const;

/** The published v2 box, priced in native ETH (18 decimals) like the recorded life, with `statistics` on the wire. */
async function snapshot(statistics: unknown, patch: Partial<V2Snapshot> = {}, failed = false) {
  const { body, source } = await publishedV2(failed);
  const parsed = parseSnapshotV2({ ...body, statistics }, source);
  const view: V2Snapshot = { ...parsed, decimals: 18, record: { ...parsed.record, q: '0x0000000000000000000000000000000000000000' }, verified: true, ...patch };
  return { view, source, record: recordV2(view, source) };
}

describe('the statistics of a v2 answer', () => {
  it('parse from decimal strings into bigints, at every recorded stage; none published is null', async () => {
    for (const stage of ['buy', 'sell', 'filled', 'graduated', 'poolBuy', 'poolSellBurn'] as const) {
      const wire = recordedStatisticsV2(stage);
      const parsed = parseStatisticsV2(wire);
      expect(parsed?.totalSupplyT, stage).toBe(BigInt(wire.totalSupplyT as string));
      expect(parsed?.hourlyCandles.length, stage).toBe((wire.hourlyCandles as unknown[]).length);
    }
    expect(parseStatisticsV2(undefined)).toBeNull();
    expect(parseStatisticsV2(null)).toBeNull();
    const { view } = await snapshot(undefined);
    expect(view.statistics).toBeNull();
    const { view: withStats } = await snapshot(recordedStatisticsV2('buy'));
    expect(withStats.statistics?.raiseProgress?.progressBps).toBe(1983n);
  });

  it('refuse a malformed figure: a JS number, a negative, progress over 100%, hours out of order, a close outside its range', () => {
    const base = recordedStatisticsV2('filled');
    const bad = [
      { ...base, burnedT: 12 },
      { ...base, holderCount: '-1' },
      { ...base, pricePPerTX18: '1.5' },
      { ...base, raiseProgress: { raisedP: '2', raiseP: '1', progressBps: '20000' } },
      { ...base, hourlyCandles: [...(base.hourlyCandles as unknown[])].reverse() },
      { ...base, hourlyCandles: [{ start: '3600', open: '5', high: '4', low: '1', close: '2', volumeP: '0', tradeCount: '0' }] },
      { ...base, hourlyCandles: [{ start: '3601', open: '1', high: '1', low: '1', close: '1', volumeP: '0', tradeCount: '0' }] },
      { ...base, hourlyCandles: Array.from({ length: HOURS_KEPT + 1 }, (_, i) => ({ start: String(i * 3600), open: '1', high: '1', low: '1', close: '1', volumeP: '0', tradeCount: '1' })) },
      { ...base, hourlyCandles: null },
    ];
    for (const input of bad) expect(() => parseStatisticsV2(input), JSON.stringify(input).slice(0, 80)).toThrow(/statistics/);
  });
});

describe('the figures, bigint only', () => {
  it('the recorded bonding stage: price per 1M, market cap, raised of the raise, holders, burned, 24 h volume', () => {
    const f = statFiguresV2(parseStatisticsV2(recordedStatisticsV2('buy')), 18);
    // pricePPerTX18 3354870469954316790466430430 → 3.35487…e-9 ETH per whole T → 0.0033548 ETH per 1M (5 digits, truncated).
    expect(f).toEqual({ price: '0.0033548', marketCap: '3.35', progress: '19.8%', raised: '0.8344 / 4.206980085', progressBps: 1983, holders: '3', burned: '1.07M', volume24h: '0.8428', trades: '2' });
  });

  it('after graduation: no raise row; the burn of the public sale counted', () => {
    const f = statFiguresV2(parseStatisticsV2(recordedStatisticsV2('poolSellBurn')), 18);
    expect(f.progress).toBeNull();
    expect(f.raised).toBeNull();
    expect([f.price, f.marketCap, f.holders, f.burned, f.volume24h, f.trades]).toEqual(['0.015302', '15.28', '2', '1.46M', '5.44', '9']);
  });

  it('unknown is a dash, never a zero; an exact zero is a zero; amounts past 2^53 and six-decimal P stay exact', () => {
    expect(statFiguresV2(null, 18)).toMatchObject({ price: NO_FIGURE, marketCap: NO_FIGURE, holders: NO_FIGURE, burned: NO_FIGURE, volume24h: NO_FIGURE, progress: null });
    const before = statFiguresV2(parseStatisticsV2({ ...recordedStatisticsV2('buy'), pricePPerTX18: null, marketCapP: null }), 18);
    expect([before.price, before.marketCap]).toEqual([NO_FIGURE, NO_FIGURE]);
    expect(pAmountV2(0n, 18)).toBe('0');
    expect(tShortV2(0n)).toBe('0');
    // SH-297 notes: the shop's two short figures (Give budget, Left this week) CUT at every boundary, never round up: a
    // "22M" beside a disabled 22M card would be untrue at 21.99…M.
    const W = 10n ** 18n;
    expect(tShortV2(22_000_000n * W - 1n)).toBe('21.99M');
    expect(tShortV2(21_960_000n * W)).toBe('21.96M');
    expect(tShortV2(21_999_999n * W + W - 1n)).toBe('21.99M');
    expect(tShortV2(22_000_000n * W)).toBe('22M');
    expect(tShortV2(1_000n * W - 1n)).toBe('999.99');
    expect(tShortV2(1_000_000n * W - 1n)).toBe('999.99K');
    expect(tShortV2(1_000_000_000n * W - 1n)).toBe('999.99M');
    expect(tShortV2(W - 1n)).toBe('0.99');
    expect(pAmountV2(123_456_789_012_345_678_901_234_567_890n, 18)).toBe('123,456,789,012.34');
    expect(pAmountV2(1_500_000n, 6)).toBe('1.5');
    expect(pAmountV2(420n, 6)).toBe('0.00042');
    // 1 raw USDC per whole T: 10^18 X18 → 1e6 raw per 1M → "1" P per 1M; a huge price keeps its digits.
    expect(pricePerMillionV2(10n ** 18n, 6)).toBe('1');
    expect(pricePerMillionV2(10n ** 40n, 18)).toBe('10,000,000,000');
    // A refuted box: no price and no market cap; the counts stay.
    const hidden = statFiguresV2(parseStatisticsV2(recordedStatisticsV2('buy')), 18, false);
    expect([hidden.price, hidden.marketCap, hidden.holders]).toEqual([NO_FIGURE, NO_FIGURE, '3']);
  });

  it('the candles' + ' layout: one slot per hour (an hour without trades stays empty), scaled in bigint, a flat series in the middle', () => {
    const big = 10n ** 70n;
    const candles = [
      { start: 0n, open: big, high: big * 3n, low: big, close: big * 2n, volumeP: 1n, tradeCount: 1n },
      { start: 7200n, open: big * 2n, high: big * 2n, low: big, close: big, volumeP: 1n, tradeCount: 1n },
    ];
    const layout = candleGeometryV2(candles, 300, 100);
    expect(layout?.slot).toBe(100);
    expect(layout?.candles.map((c) => [c.x, c.high, c.low, c.close, c.up])).toEqual([[50, 0, 100, 50, true], [250, 50, 100, 100, false]]);
    const flat = candleGeometryV2([{ ...candles[0], open: 7n, high: 7n, low: 7n, close: 7n } as never], 100, 40);
    expect(flat?.candles[0]?.close).toBe(20);
    expect(candleGeometryV2([], 100, 40)).toBeNull();
  });
});

describe('a v2 card', () => {
  it('on the curve: the progress and its bar, then price, market cap, holders, burned and 24 h volume, and a price line', async () => {
    const { view, record } = await snapshot(recordedStatisticsV2('buy'), BONDING);
    const summary = summaryV2(record, view, false);
    expect(summary.state).toBe('bonding');
    expect(summary.figure).toEqual({ text: '19.8% · 0.8344 / 4.206980085 ETH', barBps: 1983 });
    expect([summary.mcapRaw, summary.progressBps, summary.volumeRaw]).toEqual([3351250223975805078n, 1983, 842896017000000000n]);
    const { container } = render(<MemoryRouter><ul><BoxCard summary={summary} to="/box/x" /></ul></MemoryRouter>);
    const cells = [...container.querySelectorAll('.sh-v2-card-stats__cell')].map((cell) => cell.textContent);
    expect(cells).toEqual(['Price0.0033548', 'Mcap3.35', 'Holders3', 'Burned1.07M', '24h0.8428']);
    expect(container.querySelector('svg.sh-v2-spark polyline')).not.toBeNull();
    expect(screen.getByRole('link').getAttribute('aria-label')).toContain('Price 0.0033548, Market cap 3.35, Holders 3, Burned 1.07M, 24h volume 0.8428');
  });

  it('graduated: the market cap is the figure; a box without statistics keeps its raise and shows dashes, never zeros', async () => {
    const graduated = await snapshot(recordedStatisticsV2('poolSellBurn'), { ...BONDING, graduated: true });
    const summary = summaryV2(graduated.record, graduated.view, false);
    expect(summary.figure.text).toBe('Mcap 15.28 ETH');
    expect(summary.progressBps).toBe(10_000);
    const { container } = render(<MemoryRouter><ul><BoxCard summary={summary} to="/box/x" /></ul></MemoryRouter>);
    expect([...container.querySelectorAll('.sh-v2-card-stats__label')].map((l) => l.textContent)).toEqual(['Price', 'Holders', 'Burned', '24h']);
    cleanup();
    const none = await snapshot(undefined, BONDING);
    const plain = summaryV2(none.record, none.view, false);
    expect(plain.figure.text).toMatch(/^Raise /);
    // SH-276: a raise a price row sets (eighteen digits) is short on the card; the decimals are the snapshot's own.
    const long = summaryV2(none.record, { ...none.view, decimals: 18, record: { ...none.view.record, raise: 1_854_565_578_800_516n } }, false);
    expect(long.figure.text).toBe(`Raise 0.001854 ${none.record.pairAsset}`);
    expect([plain.mcapRaw, plain.volumeRaw]).toEqual([null, null]);
    const { container: c2 } = render(<MemoryRouter><ul><BoxCard summary={plain} to="/box/x" /></ul></MemoryRouter>);
    expect([...c2.querySelectorAll('.sh-v2-card-stats__value')].map((v) => v.textContent)).toEqual([NO_FIGURE, NO_FIGURE, NO_FIGURE, NO_FIGURE, NO_FIGURE]);
    expect(c2.querySelector('.sh-v2-spark')).toBeNull();
  });
});

describe('the feed sort with two ERC20 price coins (finding 1)', () => {
  const COIN_A = '0x00000000000000000000000000000000000000aa' as const;
  const COIN_B = '0x00000000000000000000000000000000000000bb' as const;
  async function boxIn(coin: `0x${string}`, decimals: number, mcapRaw: bigint, ticker: string) {
    const base = await snapshot(recordedStatisticsV2('buy'), BONDING);
    const view: V2Snapshot = { ...base.view, decimals, record: { ...base.view.record, q: coin } };
    // Two different coins whose symbols read the same: the names collide, the addresses never do.
    const record = { ...recordV2(view, base.source, null, 'tUSD'), ticker };
    return { ...summaryV2(record, view, false), mcapRaw, volumeRaw: mcapRaw };
  }

  it('groups by chain and price-coin address, never comparing raw units of different coins', async () => {
    // A: a six-decimal coin; B: an eighteen-decimal one. Both carry the same symbol (SH-BOX-LIFE-VIEW: never "P").
    const a1 = await boxIn(COIN_A, 6, 5_000_000n, 'A1');
    const b1 = await boxIn(COIN_B, 18, 10n ** 18n, 'B1');
    const a2 = await boxIn(COIN_A, 6, 2n * 10n ** 18n, 'A2');
    expect([a1, b1, a2].map((s) => s.record.pairAsset)).toEqual(['tUSD', 'tUSD', 'tUSD']);
    expect(mixedAssets([a1, b1, a2])).toBe(true);
    expect(mixedAssets([a1, a2])).toBe(false);
    for (const sort of ['mcap', 'volume'] as const) {
      const order = sortSummaries([a1, b1, a2], sort).map((s) => s.record.ticker);
      expect(order, sort).toEqual(['A2', 'A1', 'B1']);
      expect(sortSummaries([b1, a2, a1], sort).map((s) => s.record.ticker), sort).toEqual(order);
    }
    // The same address on another chain is another coin.
    const other = { ...a1, record: { ...a1.record, chainId: a1.record.chainId + 1, ticker: 'A3' } };
    expect(mixedAssets([a1, other])).toBe(true);
    expect(priceCoinKey(a1.record)).toBe(`${a1.record.chainId}:${COIN_A}`);
  });
});

describe('the v2 box page', () => {
  async function page(statistics: unknown, patch: Partial<V2Snapshot> = {}, failed = false) {
    const { record } = await snapshot(statistics, patch, failed);
    const adapter = createDemoWalletAdapter({ latencyMs: 0 });
    const connect = vi.spyOn(adapter, 'connect');
    // SH-BOX-LIFE-VIEW: the page reads the box's activity, and SH-BOX-CANDLES its candles; this box has none yet.
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/candles')) return new Response(JSON.stringify({ asOf: null, candles: [], interval: url.searchParams.get('interval') }), { status: 200 });
      return new Response(JSON.stringify({ asOf: null, items: [], next: null }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    render(<AppProviders walletAdapter={adapter}><MemoryRouter><V2BoxPage record={record} /></MemoryRouter></AppProviders>);
    const candleReads = () => fetch.mock.calls.filter(([input]) => String(input).includes('/candles')).length;
    return { connect, candleReads };
  }
  // SH-224: the five figures are number tiles at the top; SH-255: the picture's (a lazy chunk); the market card keeps none.
  const figures = async () => {
    const top = await pictureLoaded();
    expect(screen.getByRole('region', { name: 'Market' }).querySelector('.sh-v2-stats__grid')).toBeNull();
    return [...top.querySelectorAll('.sh-box-stat')].map((cell) => [cell.querySelector('dt')?.textContent, cell.querySelector('dd')?.firstChild?.textContent]);
  };

  it('leads with the box’s life and then the numbers, the raise bar and the candles, before every other panel, and asks no wallet', async () => {
    const { connect } = await page(recordedStatisticsV2('buy'), BONDING);
    await pictureLoaded();
    const market = screen.getByRole('region', { name: 'Market' });
    // SH-BOX-LIFE-VIEW: the life strip first (SH-224: in the header), then the market (its numbers in the header's tiles).
    const panels = [...document.querySelectorAll('.sh-v2-page .sh-panel')];
    expect(panels[0]).toBe(screen.getByRole('region', { name: 'Box life' }));
    expect(panels[1]).toBe(market);
    expect(await figures()).toEqual([['Price', '0.0033548'], ['Market cap', '3.35'], ['Holders', '3'], ['Burned', '1.07M'], ['24h volume', '0.8428']]);
    expect(within(market).getByRole('progressbar', { name: 'Raised' }).getAttribute('aria-valuetext')).toBe('19.8%, 0.8344 / 4.206980085 ETH');
    // SH-BOX-CANDLES: the candle chart, Max by default; no candle yet, one line says so.
    expect(market.querySelector('.sh-candles')?.getAttribute('data-choice')).toBe('max');
    await waitFor(() => expect(within(market).getByText('No trades yet')).toBeTruthy());
    // Details on demand, closed by default; the hourly table is gone (the chart has the hours).
    expect((market.querySelector('details') as HTMLDetailsElement).open).toBe(false);
    expect(market.querySelector('details table')).toBeNull();
    expect(connect).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('after graduation no raise bar and the candles; without statistics every figure is a dash and the chart is the candle route’s', async () => {
    await page(recordedStatisticsV2('poolSellBurn'), { ...BONDING, graduated: true });
    expect((await figures()).map(([label]) => label)).toEqual(['Price', 'Market cap', 'Holders', 'Burned', '24h volume']);
    const market = screen.getByRole('region', { name: 'Market' });
    expect(market.querySelector('.sh-life-raise')).toBeNull();
    await waitFor(() => expect(fakeCanvas.scenes.length).toBeGreaterThan(0));
    cleanup();
    // XR fix round 1, finding 2: missing statistics is not an empty history: the chart says what the candle route
    // answers (here no candle yet), never a history made from missing figures.
    for (const missing of [undefined, null]) {
      const { candleReads } = await page(missing, BONDING);
      expect(await figures()).toEqual([['Price', NO_FIGURE], ['Market cap', NO_FIGURE], ['Holders', NO_FIGURE], ['Burned', NO_FIGURE], ['24h volume', NO_FIGURE]]);
      // The chart's own line (SH-255: the picture loads first, so the activity card's line may be there as well).
      await waitFor(() => expect(within(screen.getByRole('region', { name: 'Market' })).getByText('No trades yet')).toBeTruthy());
      expect(candleReads()).toBeGreaterThan(0);
      expect(screen.queryByText('No trades in the last 7 days')).toBeNull();
      cleanup();
    }
  });

  it('a box the audit refuted: no price, no chart, no hours table and no card price line (finding 3)', async () => {
    const refuted = { ...BONDING, audited: true, verified: false };
    const { candleReads } = await page(recordedStatisticsV2('buy'), refuted);
    const market = screen.getByRole('region', { name: 'Market' });
    expect((await figures()).slice(0, 2)).toEqual([['Price', NO_FIGURE], ['Market cap', NO_FIGURE]]);
    expect(market.querySelector('svg')).toBeNull();
    expect(market.querySelector('table')).toBeNull();
    // No candle chart, and its candles are not even read.
    expect(market.querySelector('.sh-candles')).toBeNull();
    expect(candleReads()).toBe(0);
    expect(market.textContent).not.toMatch(/0\.0033548/);
    expect(within(market).getByText('Price history unavailable')).toBeTruthy();
    cleanup();
    const { view, record } = await snapshot(recordedStatisticsV2('buy'), refuted);
    const summary = summaryV2(record, view, false);
    expect(summary.spark).toBeUndefined();
    const { container } = render(<MemoryRouter><ul><BoxCard summary={summary} to="/box/x" /></ul></MemoryRouter>);
    expect(container.querySelector('.sh-v2-spark')).toBeNull();
    // The same box once verified shows all three.
    cleanup();
    const ok = await snapshot(recordedStatisticsV2('buy'), { ...BONDING, audited: true, verified: true });
    expect(summaryV2(ok.record, ok.view, false).spark).toHaveLength(2);
  });

  it('a closed box leads with its closing price, not the market figures', async () => {
    await page(recordedStatisticsV2('poolSellBurn'), {}, true);
    expect(screen.queryByRole('region', { name: 'Market' })).toBeNull();
    // SH-255: the closing price leads the picture's tiles and the page under the picture.
    const top = await pictureLoaded();
    expect(top.querySelector('.sh-box-stat dt')?.textContent).toBe('Closing price');
    // Review R-16: the whole order up to the closing price, the picture's own cards first and nothing else.
    expect(headingsUpTo('Closing price')).toEqual(CLOSED_BOX_HEADINGS);
  });
});
