/**
 * SH-BOX-LIFE-VIEW: the top of a v2 box's page at every moment of its life, on GPU Poor's real answers and its earlier
 * moments (test-support/life-v2.ts): what the strip, the market and the activity show first; the price coin named
 * (tNVDA), never "P"; the raise bar full at 100%; the candle chart (SH-BOX-CANDLES, its drawing faked: jsdom has no
 * canvas), graduation's progress the raise bar's alone; who traded, with the box's own events as the story; the
 * holders; Details closed; a new trade arriving without a reload; no wallet asked and no trading control.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { getAddress } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../../app-providers';
import { createDemoWalletAdapter } from '../../wallet';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import type { Fetcher } from '../core-client';
import { parseSnapshotV2, type V2Snapshot } from './indexer-v2';
import { LifeViewV2 } from './LifeViewV2';
import type { LifeStageV2 } from './life-state';
import { recordV2, summaryV2 } from './record-v2';
import { candleAnswerV2, candlesOfItemsV2 } from './test-support/candles-v2';
import { fakeCanvas } from './test-support/candle-canvas-fake';
import { gpuPoorLifeV2, LIFE_BUYER, LIFE_CREATOR, sepoliaLifeSourceV2, type LifeFixtureV2 } from './test-support/life-v2';

vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));

const source = sepoliaLifeSourceV2();
type Wire = Record<string, unknown>;

/**
 * The activity route over a fixture's items, paged like the gateway (newest first, `before=<block>-<logIndex>`, a `next`
 * cursor on a full page). `asOf`: the indexer's head its answers name; `hold`: answers wait for `release()` (a slow
 * connection); `failOlder`: that many older pages answer 503 first. `urls`: each read's query, in order. The candle
 * route (SH-BOX-CANDLES) over the same items: its reads in `candleUrls`.
 */
function activityRoute(activity: Wire) {
  const state = { items: structuredClone(activity.items as Wire[]), asOf: activity.asOf as Wire, calls: 0, urls: [] as string[], candleUrls: [] as string[], hold: false, failOlder: 0 };
  const waiting: (() => void)[] = [];
  const release = () => { for (const go of waiting.splice(0)) go(); };
  const fetcher: Fetcher = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/candles')) {
      state.candleUrls.push(parsed.searchParams.toString());
      const answer = candleAnswerV2(state.items, parsed, state.asOf);
      return { ok: answer.status === 200, status: answer.status, json: async () => answer.body };
    }
    state.calls += 1;
    const params = parsed.searchParams;
    state.urls.push(params.toString());
    if (state.hold) await new Promise<void>((resolve) => waiting.push(resolve));
    const before = params.get('before');
    if (before && state.failOlder > 0) {
      state.failOlder -= 1;
      return { ok: false, status: 503, json: async () => ({ error: 'busy' }) };
    }
    const limit = Number(params.get('limit') ?? '50');
    const [b, l] = before ? before.split('-').map(BigInt) : [null, null];
    const older = state.items.filter((item) => b === null || l === null || BigInt(item.block as string) < b || (BigInt(item.block as string) === b && BigInt(item.logIndex as number) < l));
    const page = older.slice(0, limit);
    const last = page.at(-1);
    return { ok: true, status: 200, json: async () => ({ asOf: state.asOf, items: page, next: page.length === limit && last ? `${last.block as string}-${last.logIndex as number}` : null }) };
  };
  return { state, fetcher, release };
}

async function show(stage: LifeStageV2, fixture: LifeFixtureV2 = gpuPoorLifeV2(stage), options: { readonly hold?: boolean } = {}) {
  const view: V2Snapshot = parseSnapshotV2(fixture.body, source);
  vi.setSystemTime(Number(view.timestamp) * 1000);
  const record = recordV2(view, source, null, 'tNVDA');
  const adapter = createDemoWalletAdapter({ latencyMs: 0 });
  const connect = vi.spyOn(adapter, 'connect');
  const route = activityRoute(fixture.activity);
  route.state.hold = options.hold === true;
  const closing = <section className="sh-panel" aria-label="Failure claim"><h2>Closing price</h2></section>;
  const tree = (v: V2Snapshot) => <AppProviders walletAdapter={adapter}><LifeViewV2 record={recordV2(v, source, null, 'tNVDA')} view={v} source={source} fetcher={route.fetcher} closing={closing} /></AppProviders>;
  const result = render(tree(view));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return { view, record, connect, route, rerender: (v: V2Snapshot) => result.rerender(tree(v)) };
}

const strip = () => screen.getByRole('region', { name: 'Box life' });
const stepTexts = () => [...strip().querySelectorAll('.sh-life__step')].map((li) => [li.getAttribute('data-step'), li.getAttribute('data-status'), li.querySelector('.sh-life__value')?.textContent, li.querySelector('.sh-life__sub')?.textContent ?? null]);
const market = () => screen.getByRole('region', { name: 'Market' });
const activity = () => screen.getByRole('region', { name: 'Activity' });
const rows = () => [...activity().querySelectorAll('.sh-life-row')].map((row) => (row.getAttribute('data-kind') === 'trade' ? `${row.getAttribute('data-side')}` : row.getAttribute('data-event')));
/** One row's cells: what, who (its short address and role chip), the amounts, when. */
const cells = (index: number) => {
  const row = activity().querySelectorAll('.sh-life-row')[index];
  const text = (selector: string) => row?.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  return { what: text('.sh-life-row__what'), who: text('.sh-life-who__address code'), role: text('.sh-life-chip'), detail: text('.sh-life-row__detail'), p: text('.sh-life-row__p'), t: text('.sh-life-row__t'), when: text('.sh-life-row__when time') };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  fakeCanvas.reset();
});
/** What the candle chart was last asked to draw. */
const scene = () => fakeCanvas.scenes.at(-1);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Every rendered state: no "P" unit, no trading control, Details closed, the wording rule, no wallet asked. */
function common(connect: ReturnType<typeof vi.spyOn>) {
  const text = document.body.textContent ?? '';
  expect(text).not.toMatch(/(^|[^A-Za-z0-9])P([^A-Za-z0-9]|$)/);
  expect(screen.queryAllByRole('button', { name: /\b(buy|sell|swap)\b/i })).toHaveLength(0);
  expect(screen.queryAllByRole('link', { name: /\b(buy|sell|swap)\b/i })).toHaveLength(0);
  expect(document.querySelectorAll('input, textarea')).toHaveLength(0);
  for (const details of document.querySelectorAll('details')) expect((details as HTMLDetailsElement).open).toBe(false);
  expect(appCopyFraming(renderedCopy(document.body).map((t) => t.replace(/\bGrow the pool\b/g, 'Add to the pool')))).toEqual([]);
  expect(connect).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
}

describe('the top of the page, per state', () => {
  it('scheduled: Launch is the box’s step with its countdown; the raise at 0%, as the bar says; the candle chart; Created', async () => {
    const { connect } = await show('scheduled');
    // The strip's Raise says what the bar says (the bootstrap buy's part of the raise).
    expect(stepTexts()).toEqual([['launch', 'current', 'in 2 h 14 min', '27 Oct, 08:38 UTC'], ['raise', 'next', '0.0%', '0.03529 / 100 tNVDA'], ['graduate', 'next', 'at 100%', null], ['pool', 'next', '—', null]]);
    expect(within(market()).getByRole('progressbar', { name: 'Raised' }).getAttribute('aria-valuetext')).toBe('0.0%, 0.03529 / 100 tNVDA');
    // SH-BOX-CANDLES: the candles of the bootstrap buy, Max by default.
    expect(market().querySelector('.sh-candles')?.getAttribute('data-choice')).toBe('max');
    expect(scene()?.candles.map((c) => c.trades)).toEqual([1]);
    expect(rows()).toEqual(['created']);
    // The box's creation (BoxLaunched) is "Created", never a second "Launch" beside the strip's opening: its bootstrap
    // buy's P (the 1% fee included) and its VRAM, burned.
    expect(cells(0)).toMatchObject({ what: 'Created', detail: 'bootstrap', p: '0.03565 tNVDA', t: '1.07M VRAM', when: '1 min ago' });
    expect(activity().textContent).not.toMatch(/Launch/);
    // The countdown runs with the clock.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(stepTexts()[0]?.[2]).toBe('in 2 h 13 min');
    common(connect);
  });

  it('the launch window: the minutes left and the launch tax; a taxed buy by its buyer with its tax apart', async () => {
    const { connect } = await show('window');
    expect(stepTexts()[0]).toEqual(['launch', 'current', '3:36 left', 'tax 76.02%']);
    expect(rows()).toEqual(['buy', 'created']);
    expect(cells(0)).toMatchObject({ what: '▲ Buy', who: '0x5e1f…5E1f', role: null, p: '42.06 tNVDA + 165.43 tax', t: '586.68M VRAM', when: '12 s ago' });
    common(connect);
  });

  it('raising: Raise is the box’s step at 42.1%; the bar fills in the box’s colour; the candles of its trades', async () => {
    const { connect, route } = await show('raising');
    expect(stepTexts()).toEqual([['launch', 'done', '53 min ago', null], ['raise', 'current', '42.1%', '42.1 / 100 tNVDA'], ['graduate', 'next', 'at 100%', null], ['pool', 'next', '—', null]]);
    const bar = market().querySelector('.sh-life-raise');
    expect(bar?.getAttribute('data-full')).toBe('false');
    expect((bar?.querySelector('.sh-life-raise__fill') as HTMLElement).style.width).toBe('42.1%');
    // The bootstrap buy and the buy, at Max's step.
    const step = scene()?.step ?? '12s';
    expect(route.state.candleUrls).toEqual([`interval=${step}&limit=120`]);
    expect(scene()?.candles.map((c) => String(c.start))).toEqual(candlesOfItemsV2(route.state.items, step).map((c) => c.start));
    expect(scene()?.candles.reduce((sum, c) => sum + c.trades, 0)).toBe(2);
    expect(rows()).toEqual(['buy', 'created']);
    expect(cells(0)).toMatchObject({ what: '▲ Buy', who: '0xb0B0…0B0B', p: '42.06 tNVDA', t: '586.68M VRAM', when: '23 min ago' });
    common(connect);
  });

  it('raise full, graduating: Graduate pending; the bar full in the graduation colour with when it filled; Raise full above the filling buy', async () => {
    const { connect } = await show('graduating');
    expect(stepTexts()).toEqual([['launch', 'done', '10 min ago', null], ['raise', 'done', '100 tNVDA', 'full 40 s ago'], ['graduate', 'current', 'Pending', null], ['pool', 'next', '—', null]]);
    const bar = market().querySelector('.sh-life-raise');
    expect(bar?.getAttribute('data-full')).toBe('true');
    expect((bar?.querySelector('.sh-life-raise__fill') as HTMLElement).style.width).toBe('100%');
    expect(bar?.querySelector('.sh-life-raise__full')?.textContent).toBe(' Full · 40 s ago');
    expect(rows()).toEqual(['full', 'buy', 'created']);
    expect(cells(0)).toMatchObject({ what: 'Raise full', p: '100 tNVDA', t: '', when: '40 s ago' });
    // The filling buy: the founder's deployer, from the same transaction's VRAM transfer.
    expect(cells(1)).toMatchObject({ what: '▲ Buy', who: '0x1F14…4eeE', p: '100.97 tNVDA', t: '797.52M VRAM', when: '40 s ago' });
    // The transaction on Sepolia Etherscan (the raise full and the buy are one transaction).
    const tx = within(activity()).getAllByRole('link', { name: 'Transaction 0x2c14…b9f8 on Etherscan, opens in a new tab' });
    expect(tx.map((link) => link.getAttribute('href'))).toEqual(Array(2).fill('https://sepolia.etherscan.io/tx/0x2c14a15762315c0867621dd5f76b956185d248e29fa2dcb57936130dbcbfb9f8'));
    expect(tx[0]?.getAttribute('target')).toBe('_blank');
    // Holders: three, as the founder's screenshot counted; the box's coordinator and the pool named.
    fireEvent.click(within(activity()).getByRole('tab', { name: /^Holders/ }));
    const holders = [...activity().querySelectorAll('.sh-life-holder')].map((li) => [li.querySelector('.sh-life-who__address code')?.textContent, li.querySelector('.sh-life-chip')?.textContent ?? null, li.querySelector('.sh-life-holder__share')?.textContent, li.querySelector('.sh-life-holder__amount')?.textContent]);
    // The curve sold all but 3 wei of its VRAM: the pool still holds some, so it is a holder.
    expect(holders).toEqual([['0x1F14…4eeE', null, '79.8%', '797.52M VRAM'], ['0x3c59…03f8', 'Box', '20.1%', '201.39M VRAM'], ['0xE03A…3543', 'Pool', '0.0%', '<0.01 VRAM']]);
    common(connect);
  });

  it('graduated: Pool is the box’s step with its price; no raise bar; the candles of every swap; the story newest first', async () => {
    const { connect, route } = await show('graduated');
    expect(stepTexts()).toEqual([['launch', 'done', '17 min ago', null], ['raise', 'done', '100 tNVDA', null], ['graduate', 'done', '6 min ago', null], ['pool', 'current', '0.4872', 'tNVDA per 1M VRAM']]);
    expect(market().querySelector('.sh-life-raise')).toBeNull();
    const step = scene()?.step ?? '12s';
    expect(scene()?.candles.map((c) => String(c.start))).toEqual(candlesOfItemsV2(route.state.items, step).map((c) => c.start));
    expect(rows()).toEqual(['deepened', 'buyBack', 'buyBack', 'fees', 'graduated', 'full', 'buy', 'created']);
    expect(cells(4)).toMatchObject({ what: 'Graduated', who: '0x1F14…4eeE', p: '0.1 tNVDA tip', when: '6 min ago' });
    expect(cells(1)).toMatchObject({ what: 'Buy-back', detail: 'burned', p: '0.2401 tNVDA', t: '491.58K VRAM', when: '5 min ago' });
    expect(within(activity()).getByRole('tab', { name: 'Holders 2' })).toBeTruthy();
    common(connect);
  });

  it('closed: the strip marks where it ended; the closing price card leads in the market’s place; Closed and the claim', async () => {
    const { connect, record, view } = await show('failed');
    // The feed card names the claim price short, per 1M coins, like every other price (never 36 digits "per coin").
    expect(summaryV2(record, view, false).figure.text).toBe('0.071758 tNVDA per 1M VRAM');
    expect(stepTexts().map(([id, status, value]) => [id, status, value])).toEqual([['launch', 'done', '30 d ago'], ['raise', 'failed', 'Closed'], ['graduate', 'next', '—'], ['pool', 'next', '—']]);
    expect(screen.queryByRole('region', { name: 'Market' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Failure claim' })).toBeTruthy();
    expect(rows().slice(0, 2)).toEqual(['claim', 'closed']);
    expect(cells(1)).toMatchObject({ what: 'Closed', who: '0x1F14…4eeE', when: '8 min ago' });
    expect(cells(1).detail).toMatch(/^deadline passed/);
    common(connect);
  });
});

describe('the creator, named', () => {
  it('a buy by the box’s creator carries the Creator chip, in Trades and in Holders', async () => {
    await show('raising', gpuPoorLifeV2('raising', { buyer: LIFE_CREATOR }));
    expect(cells(0)).toMatchObject({ what: '▲ Buy', who: '0x5583…6658', role: 'Creator', p: '42.06 tNVDA' });
    fireEvent.click(within(activity()).getByRole('tab', { name: /^Holders/ }));
    const creator = [...activity().querySelectorAll('.sh-life-holder')].find((li) => li.querySelector('.sh-life-who__address code')?.textContent === '0x5583…6658');
    expect(creator?.querySelector('.sh-life-chip')?.textContent).toBe('Creator');
    expect(creator?.getAttribute('data-role')).toBe('creator');
  });
});

describe('live, without a reload', () => {
  it('a new trade arrives on top while the page is open, marked as new, each row once', async () => {
    const { view, route, rerender } = await show('raising');
    expect(rows()).toEqual(['buy', 'created']);
    const next = { ...structuredClone(route.state.items.find((item) => item.kind === 'trade' && item.route === 'other') as Wire), id: `${view.block + 1n}-4`, block: String(view.block + 1n), logIndex: 4, timestamp: String(view.timestamp + 12n), txHash: `0x${'4'.repeat(64)}` };
    const transfer = { ...structuredClone(route.state.items[0] as Wire), id: `${view.block + 1n}-7`, block: String(view.block + 1n), logIndex: 7, timestamp: String(view.timestamp + 12n), txHash: `0x${'4'.repeat(64)}` };
    route.state.items = [transfer, next, ...route.state.items];
    const stats = view.statistics;
    // The indexer's figures after the buy: one trade more, in its hour too.
    const hours = stats ? stats.hourlyCandles.map((hour, i) => (i === stats.hourlyCandles.length - 1 ? { ...hour, tradeCount: hour.tradeCount + 1n } : hour)) : [];
    rerender({ ...view, block: view.block + 1n, timestamp: view.timestamp + 12n, statistics: stats ? { ...stats, tradeCount: stats.tradeCount + 1n, hourlyCandles: hours } : null });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(rows()).toEqual(['buy', 'buy', 'created']);
    expect(activity().querySelector('.sh-life-row')?.hasAttribute('data-new')).toBe(true);
    expect(new Set([...activity().querySelectorAll('.sh-life-row')].map((row) => row.textContent)).size).toBe(3);
    // SH-BOX-CANDLES: the chart read its step again on the moved figures, the new buy in its candles.
    expect(route.state.candleUrls).toHaveLength(2);
    expect(scene()?.candles.reduce((sum, c) => sum + c.trades, 0)).toBe(3);
    expect(activity().querySelector('.sh-life-live__word')?.textContent).toBe('Live');
    // A polite live region of its own, never a second role=status beside the page's action status.
    expect(within(activity()).queryByRole('status')).toBeNull();
  });
});

describe('the holders, live', () => {
  it('a block whose rows the history has not stored yet keeps the last list that matched, never an empty or a wrong one', async () => {
    const { view, rerender } = await show('graduated');
    fireEvent.click(within(activity()).getByRole('tab', { name: /^Holders/ }));
    expect(activity().querySelectorAll('.sh-life-holder')).toHaveLength(2);
    // The next block: a third holder in the snapshot, its transfer not in the activity yet.
    const stats = view.statistics;
    rerender({ ...view, block: view.block + 1n, statistics: stats ? { ...stats, holderCount: 3n } : null });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(activity().querySelectorAll('.sh-life-holder')).toHaveLength(2);
    expect(within(activity()).getByRole('tab', { name: 'Holders 3' })).toBeTruthy();
  });
});

const holderRows = () => activity().querySelectorAll('.sh-life-holder');
const holdersText = () => activity().querySelector('.sh-life-empty')?.textContent ?? null;
const openTab = (name: RegExp) => fireEvent.click(within(activity()).getByRole('tab', { name }));
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

/** GPU Poor raising in 30 buys: 71 items (more than one read of 50) and 32 holders. */
const crowd = () => gpuPoorLifeV2('raising', { buys: 30 });

/** One more buy of the fixture's last one, at `block`, for `buyer`: its trade and the transfer that names who. */
function nextBuy(items: readonly Wire[], block: bigint, buyer: string, at: bigint): Wire[] {
  const trade = structuredClone(items.find((item) => item.kind === 'trade' && item.route === 'other') as Wire);
  const transfer = structuredClone(items.find((item) => item.kind === 'v2_event' && (item.data as Wire).event === 'Transfer' && item.block === trade.block) as Wire);
  const ref = (logIndex: number) => ({ id: `${block}-${logIndex}`, block: String(block), logIndex, timestamp: String(at), txHash: `0x${block.toString(16).padStart(64, '0')}` });
  return [{ ...transfer, ...ref(9), data: { ...(transfer.data as Wire), to: buyer } }, { ...trade, ...ref(6) }];
}

describe('the holders of a box whose history is longer than one read (review round 2)', () => {
  it('on a live chain (a new head every 12 s, the box idle): Holders opened between two idle reads lists every holder at once', async () => {
    const fixture = crowd();
    expect((fixture.activity.items as Wire[]).length).toBe(71);
    const { view, route, rerender } = await show('raising', fixture);
    expect(route.state.urls).toEqual(['limit=50']);
    // 32 s: the snapshot read every 4 s, new heads at 0, 12 and 24 s, the idle read at 15 s (it names the head of 12 s).
    let head = view.block;
    for (let t = 0; t < 32; t += 4) {
      if (t % 12 === 0) head += 1n;
      route.state.asOf = { ...route.state.asOf, block: String(head) };
      rerender({ ...view, block: head, timestamp: view.timestamp + BigInt(t) });
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    }
    expect(route.state.urls).toEqual(['limit=50', 'limit=50']);
    // The snapshot is three heads past the first read and one past the idle read; the box's figures stand as at the first.
    openTab(/^Holders/);
    await flush();
    expect(route.state.urls).toEqual(['limit=50', 'limit=50', 'limit=200&before=12003431-10']);
    expect(holderRows()).toHaveLength(10);
    expect([...holderRows()].slice(0, 2).map((li) => li.querySelector('.sh-life-chip')?.textContent)).toEqual(['Pool', 'Box']);
    expect(within(activity()).getByRole('button', { name: 'Show all 32' })).toBeTruthy();
    expect(within(activity()).getByRole('tab', { name: 'Holders 32' })).toBeTruthy();

    // A new buyer: the snapshot's figures move (33 holders, one trade more). The list that matched stays while the new
    // rows are read, at once; then the new holder is in.
    head += 1n;
    const buyer = getAddress('0x00000000000000000000000000000000000c0ffe');
    route.state.items = [...nextBuy(route.state.items, head, buyer, view.timestamp + 40n), ...route.state.items];
    route.state.asOf = { ...route.state.asOf, block: String(head) };
    const stats = view.statistics;
    if (!stats) throw new Error('statistics expected');
    rerender({ ...view, block: head, timestamp: view.timestamp + 40n, statistics: { ...stats, holderCount: 33n, tradeCount: stats.tradeCount + 1n } });
    expect(within(activity()).getByRole('button', { name: 'Show all 32' })).toBeTruthy();
    await flush();
    expect(route.state.urls.at(-1)).toBe('limit=50');
    expect(within(activity()).getByRole('button', { name: 'Show all 33' })).toBeTruthy();
    fireEvent.click(within(activity()).getByRole('button', { name: 'Show all 33' }));
    expect([...holderRows()].map((li) => li.querySelector('.sh-life-who__address')?.getAttribute('title'))).toContain(buyer);
  });

  it('Holders opened before the first read answers (a slow connection): the history is read as soon as it does', async () => {
    const { route } = await show('raising', crowd(), { hold: true });
    openTab(/^Holders/);
    expect(holdersText()).toBe('Reading holders…');
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(route.state.urls).toEqual(['limit=50']);
    route.state.hold = false;
    route.release();
    await flush();
    expect(route.state.urls).toEqual(['limit=50', 'limit=200&before=12003431-10']);
    expect(holderRows()).toHaveLength(10);
    expect(within(activity()).getByRole('button', { name: 'Show all 32' })).toBeTruthy();
  });

  it('a history page that fails: Reading holders… while it is read again on the error back-off (2 s), then the list', async () => {
    const { route } = await show('raising', crowd());
    route.state.failOlder = 1;
    openTab(/^Holders/);
    await flush();
    expect(route.state.urls).toEqual(['limit=50', 'limit=200&before=12003431-10']);
    expect(holdersText()).toBe('Reading holders…');
    await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
    expect(route.state.urls).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(route.state.urls).toEqual(['limit=50', 'limit=200&before=12003431-10', 'limit=200&before=12003431-10']);
    expect(holderRows()).toHaveLength(10);
  });
});

describe('a new row flashes once (review round 2)', () => {
  it('shown for its flash (2.4 s), it is no longer new: a tab switch does not flash it again; a row that came while Holders was open flashes when Trades shows it', async () => {
    const { view, route, rerender } = await show('raising');
    const stats = view.statistics;
    if (!stats) throw new Error('statistics expected');
    const first = () => activity().querySelector('.sh-life-row');
    route.state.items = [...nextBuy(route.state.items, view.block + 1n, LIFE_BUYER, view.timestamp + 12n), ...route.state.items];
    rerender({ ...view, block: view.block + 1n, timestamp: view.timestamp + 12n, statistics: { ...stats, tradeCount: stats.tradeCount + 1n } });
    await flush();
    expect(rows()).toEqual(['buy', 'buy', 'created']);
    expect(first()?.hasAttribute('data-new')).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_399); });
    expect(first()?.hasAttribute('data-new')).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(first()?.hasAttribute('data-new')).toBe(false);
    openTab(/^Holders/);
    openTab(/^Trades/);
    expect(activity().querySelectorAll('.sh-life-row[data-new]')).toHaveLength(0);
    // Another buy lands while Holders is open: new until Trades shows it, then once.
    openTab(/^Holders/);
    route.state.items = [...nextBuy(route.state.items, view.block + 2n, LIFE_BUYER, view.timestamp + 24n), ...route.state.items];
    rerender({ ...view, block: view.block + 2n, timestamp: view.timestamp + 24n, statistics: { ...stats, tradeCount: stats.tradeCount + 2n } });
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    openTab(/^Trades/);
    expect(rows()).toEqual(['buy', 'buy', 'buy', 'created']);
    expect([...activity().querySelectorAll('.sh-life-row')].map((row) => row.hasAttribute('data-new'))).toEqual([true, false, false, false]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_400); });
    expect(activity().querySelectorAll('.sh-life-row[data-new]')).toHaveLength(0);
  });
});

describe('the display-only snapshot fields fail soft (review round 2)', () => {
  it('a malformed position and pool: the candles (they need neither), the strip, the bar and the story as usual', async () => {
    const fixture = gpuPoorLifeV2('raising');
    const body = { ...fixture.body, position: { ...(fixture.body.position as Wire), kind: 'concentrated' }, pool: { sqrtPriceX96: '0', tick: 0 } };
    const { view, connect } = await show('raising', { ...fixture, body });
    expect([view.position, view.pool]).toEqual([null, null]);
    expect(scene()?.candles.length).toBeGreaterThan(0);
    expect(stepTexts()[1]).toEqual(['raise', 'current', '42.1%', '42.1 / 100 tNVDA']);
    expect(within(market()).getByRole('progressbar', { name: 'Raised' }).getAttribute('aria-valuetext')).toBe('42.1%, 42.1 / 100 tNVDA');
    expect(rows()).toEqual(['buy', 'created']);
    common(connect);
  });
});

describe('the raise bar has its colour on the v2 page (SH-BOX-LIFE-VIEW § 4)', () => {
  it('the box tokens are declared on :root, so a box part outside the feed and the v1 box page has them', () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../boxes/box-base.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    for (const name of ['--sh-box-graduating', '--sh-box-eth', '--sh-box-bonding', '--sh-box-graduated', '--sh-box-failed']) expect(root, name).toContain(`${name}:`);
    // No container redeclares them (the v2 page is neither the feed nor the v1 box page).
    for (const block of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) if (!/:root/.test(block[1] ?? '')) expect(block[2] ?? '', block[1]).not.toMatch(/--sh-box-(graduating|eth|bonding)\s*:/);
  });
});
