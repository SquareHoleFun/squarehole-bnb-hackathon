/**
 * SH-306: the box page's dollar figures on the BNB Chain testnet site. The indexer publishes `prices` only on the
 * single-box answer; the page loads its box from the list, whose cards carry none, so before this fix no dollar figure
 * ever showed. Now the open box page reads its own box's answer for `prices` and lays them over the listed view. Real
 * answers recorded from the live test site on 26 November 2026 (test-support/live-bnb-v2.ts): GPU Poor (tNVDA) and The
 * Alchemist (tUSDC, with a tNVDA pile), each listed from the recorded list and priced from its recorded own answer.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../../app-providers';
import { createDemoWalletAdapter } from '../../wallet';
import type { Fetcher } from '../core-client';
import { BOX_PRICES_POLL_MS, boxPricesUrlV2, readBoxPricesV2, useBoxPricesV2 } from './box-prices-v2';
import { parseSnapshotV2 } from './indexer-v2';
import { recordV2 } from './record-v2';
import { pictureLoaded } from './test-support/picture-loaded';
import { listedCardV2, liveBnbAnswersV2, liveBnbSourceV2 } from './test-support/live-bnb-v2';
import { usdNote, usdPriceFor, usdPricesOf, usdText } from './usd-v2';
import { headerStatsV2, V2BoxPage } from './V2BoxPage';

const TNVDA = '0x2F8029A6447663e0881b0E21F5E4aD0f1717627e';
const TUSDC = '0x25C5789b269D8f76309CE961759d643dce291347';
vi.mock('./SafesV2', () => ({ SafesV2: () => null }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => null }));
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));
// The pile coin's listing (its symbol and decimals), as chain 97's registry lists the two test coins.
vi.mock('../../create/v2/indexer-listings', async (original) => ({ ...await original<object>(),
  loadListingsV2: async () => [
    { id: 1, token: TNVDA, decimals: 18, class: 5, kind: 1, raise: 10n ** 18n, symbol: 'tNVDA', name: 'tNVDA', powers: [] },
    { id: 2, token: TUSDC, decimals: 6, class: 5, kind: 1, raise: 10n ** 6n, symbol: 'tUSDC', name: 'tUSDC', powers: [] },
  ] }));

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Json = Record<string, unknown>;
const GPU_POOR = '0x734c884b480159b3c993f2a95a45e81a36a13a27';
const ALCHEMIST = '0x750a40a83a37d473211a270d0cc8fc400ed758bb';
const source = liveBnbSourceV2();
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

/**
 * The page as the site opens it: the box from the recorded list, the page's clock at `nowSec` (Date only; timers stay
 * real), and every request answered by `answer` (undefined: refused). Returns the requests made.
 */
async function openPage(token: string, coin: string, nowSec: bigint, answer: (url: string) => unknown) {
  vi.useFakeTimers({ toFake: ['Date'], now: Number(nowSec) * 1000 });
  const listed = parseSnapshotV2(listedCardV2(token), source);
  const record = recordV2(listed, source, null, coin);
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(String(url));
    const body = answer(String(url));
    if (body === undefined) throw new TypeError('Failed to fetch');
    return body;
  });
  const page = (shown: typeof record) => <AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}><MemoryRouter><V2BoxPage record={shown} /></MemoryRouter></AppProviders>;
  const { rerender } = render(page(record));
  const picture = await pictureLoaded();
  return { picture, listed, record, calls, show: (shown: typeof record) => rerender(page(shown)) };
}
/** The prices read has been asked and its answer (or failure) has had time to land. */
async function settled(calls: readonly string[], url: string) {
  await waitFor(() => expect(calls).toContain(url));
  await act(() => new Promise((done) => setTimeout(done, 50)));
}
/** The figures row beside the picture: [label, unit] per tile. */
const units = (picture: HTMLElement) => [...picture.querySelectorAll('.sh-bpic-side .sh-box-stat')].map((cell) => [cell.querySelector('dt')?.textContent, cell.querySelector('dd > small')?.textContent ?? null]);
const unitOf = (picture: HTMLElement, label: string) => units(picture).find(([l]) => l === label)?.[1] ?? null;

describe('SH-306: the recorded answers say why the page showed no dollars', () => {
  it('the list carries no prices; the single-box answers do', () => {
    const cards = liveBnbAnswersV2.feed().cards as Json[];
    expect(cards).toHaveLength(7);
    expect(cards.filter((card) => 'prices' in card)).toEqual([]);
    expect(parseSnapshotV2(listedCardV2(GPU_POOR), source).prices).toBeUndefined();
    expect(usdPricesOf(liveBnbAnswersV2.gpuPoor().prices)?.coins.map((c) => [c.role, c.symbol, c.feed])).toEqual([['price', 'tNVDA', 'NVDAB/USD']]);
    expect(usdPricesOf(liveBnbAnswersV2.alchemist().prices)?.coins.map((c) => [c.role, c.symbol, c.feed])).toEqual([['price', 'tUSDC', 'USDC/USD'], ['pile', 'tNVDA', 'NVDAB/USD']]);
  });
});

describe('SH-306: the open box page reads its own prices', () => {
  const gpu = liveBnbAnswersV2.gpuPoor();
  const gpuUrl = boxPricesUrlV2(source, GPU_POOR);
  const gpuPrice = usdPricesOf(gpu.prices)?.coins[0];
  if (!gpuPrice) throw new Error('The recorded answer has no price');
  const asOf = BigInt((gpu.asOf as Json).timestamp as string);

  it('GPU Poor: market cap in dollars at a clock inside the price\'s limit, with the stand-in note behind the (i)', async () => {
    expect(asOf - gpuPrice.onchainAt).toBe(268n);
    const { picture, listed, calls } = await openPage(GPU_POOR, 'tNVDA', asOf, (url) => (url === gpuUrl ? ok(gpu) : undefined));
    const cap = listed.statistics?.marketCapP;
    expect(cap).toBe(399508253056856254n);
    await waitFor(() => expect(unitOf(picture, 'Market cap')).toBe('tNVDA, about $59.67'));
    expect(usdText(cap ?? 0n, 18, gpuPrice)).toBe('about $59.67');
    expect(unitOf(picture, '24h volume')).toBe(`tNVDA, ${usdText(listed.statistics?.volume24hP ?? 0n, 18, gpuPrice)}`);
    expect(picture.textContent).toContain(usdNote(gpuPrice, asOf));
    expect(usdNote(gpuPrice, asOf)).toBe('Price from Atlas (NVDAB/USD), 268 s old. tNVDA is a test coin priced as NVDAB, the tokenized NVIDIA stock on BNB mainnet.');
    // One request for prices when the page opens, to the box's own answer.
    expect(calls.filter((url) => url.includes('/v2/boxes/') && !url.includes('/activity') && !url.includes('/candles'))).toEqual([gpuUrl]);
  });

  it('GPU Poor: none at a clock past the price\'s limit (910 s)', async () => {
    const late = gpuPrice.onchainAt + gpuPrice.maxAgeSeconds + 1n;
    const { picture, record, listed, calls } = await openPage(GPU_POOR, 'tNVDA', late, (url) => (url === gpuUrl ? ok(gpu) : undefined));
    await settled(calls, gpuUrl);
    expect(unitOf(picture, 'Market cap')).toBe('tNVDA');
    expect(units(picture)).toEqual(headerStatsV2(record, listed, late).map((s) => [s.label, s.unit ?? null]));
    expect(document.querySelector('.sh-v2-usd')).toBeNull();
    expect(document.body.textContent).not.toMatch(/about \$/);
  });

  it('a failed prices read leaves the page exactly as the list alone draws it', async () => {
    for (const answer of [() => undefined, () => ({ ok: false, status: 503, json: async () => ({}) }), () => ok({ ...gpu, token: ALCHEMIST })]) {
      const { picture, record, listed, calls } = await openPage(GPU_POOR, 'tNVDA', asOf, (url) => (url === gpuUrl ? answer() : undefined));
      await settled(calls, gpuUrl);
      expect(units(picture)).toEqual(headerStatsV2(record, listed, asOf).map((s) => [s.label, s.unit ?? null]));
      expect(unitOf(picture, 'Market cap')).toBe('tNVDA');
      expect(document.querySelector('.sh-v2-usd')).toBeNull();
      expect(document.body.textContent).not.toMatch(/about \$|Price from Atlas/);
      cleanup(); vi.useRealTimers(); vi.unstubAllGlobals();
    }
  });

  it('The Alchemist: the pile line in dollars from the "pile" price, the header from the "price" price', async () => {
    const answer = liveBnbAnswersV2.alchemist();
    const url = boxPricesUrlV2(source, ALCHEMIST);
    const prices = usdPricesOf(answer.prices);
    const at = BigInt((answer.asOf as Json).timestamp as string);
    const pilePrice = usdPriceFor(prices, TNVDA, at);
    expect(pilePrice?.role).toBe('pile');
    const { picture, listed } = await openPage(ALCHEMIST, 'tUSDC', at, (u) => (u === url ? ok(answer) : undefined));
    const balance = listed.m3?.pileMoney?.balance;
    expect(balance).toBe(9852266841364508n);
    const pile = () => document.querySelector('.sh-m3-pile .sh-v2-usd');
    await waitFor(() => expect(pile()).not.toBeNull());
    expect(pile()?.firstChild?.textContent).toBe(usdText(balance ?? 0n, 18, pilePrice as NonNullable<typeof pilePrice>));
    expect(pile()?.firstChild?.textContent).toBe('about $1.47');
    expect(pile()?.textContent).toContain('tNVDA is a test coin priced as NVDAB, the tokenized NVIDIA stock on BNB mainnet.');
    const price = usdPriceFor(prices, TUSDC, at);
    expect(price?.role).toBe('price');
    expect(unitOf(picture, 'Market cap')).toBe(`tUSDC, ${usdText(listed.statistics?.marketCapP ?? 0n, 6, price as NonNullable<typeof price>)}`);
  });
});

describe('SH-306 step 2: a price ages out, and a box page never shows another box\'s price', () => {
  const gpu = liveBnbAnswersV2.gpuPoor();
  const gpuUrl = boxPricesUrlV2(source, GPU_POOR);
  const gpuPrice = usdPricesOf(gpu.prices)?.coins[0];
  if (!gpuPrice) throw new Error('The recorded answer has no price');
  const asOf = BigInt((gpu.asOf as Json).timestamp as string);

  it('GPU Poor: "about $" while fresh, gone once the page clock passes onchainAt + 910 s, with no new read', async () => {
    const { picture, calls } = await openPage(GPU_POOR, 'tNVDA', asOf, (url) => (url === gpuUrl ? ok(gpu) : undefined));
    await waitFor(() => expect(unitOf(picture, 'Market cap')).toBe('tNVDA, about $59.67'));
    expect(document.body.textContent).toMatch(/about \$/);
    const asked = calls.filter((url) => url === gpuUrl).length;
    expect(asked).toBe(1);
    // The page's clock (useClockMs, a 1 s tick on real timers) moves past the price's own limit.
    vi.setSystemTime(Number(gpuPrice.onchainAt + gpuPrice.maxAgeSeconds + 1n) * 1000);
    await waitFor(() => expect(unitOf(picture, 'Market cap')).toBe('tNVDA'), { timeout: 5_000 });
    expect(unitOf(picture, '24h volume')).toBe('tNVDA');
    expect(document.querySelector('.sh-v2-usd')).toBeNull();
    expect(document.body.textContent).not.toMatch(/about \$/);
    expect(calls.filter((url) => url === gpuUrl)).toHaveLength(asked);
  });

  it('moving to another box while the first box\'s answer is in flight: the late answer prices nothing there; its own answer does', async () => {
    const alchemist = liveBnbAnswersV2.alchemist();
    const alchemistUrl = boxPricesUrlV2(source, ALCHEMIST);
    const at = BigInt((alchemist.asOf as Json).timestamp as string);
    // At this clock GPU Poor's tNVDA price is fresh too (556 s of 910): leaked onto The Alchemist, whose pile is
    // tNVDA, it would show a pile line.
    expect(usdPriceFor(usdPricesOf(gpu.prices), TNVDA, at)).not.toBeNull();
    const later = () => { let answer!: (body: unknown) => void; const promise = new Promise((done) => { answer = done; }); return { promise, answer }; };
    const first = later(); const second = later();
    const { picture, calls, show } = await openPage(GPU_POOR, 'tNVDA', at, (url) => (url === gpuUrl ? first.promise : url === alchemistUrl ? second.promise : undefined));
    await waitFor(() => expect(calls).toContain(gpuUrl));
    const listed = parseSnapshotV2(listedCardV2(ALCHEMIST), source);
    // Same component instance (no key), the strictest case; the site's BoxPage keys the page by the record as well.
    show(recordV2(listed, source, null, 'tUSDC'));
    await waitFor(() => expect(calls).toContain(alchemistUrl));
    await waitFor(() => expect(document.querySelector('.sh-m3-pile')).not.toBeNull());
    await act(async () => { first.answer(ok(gpu)); await new Promise((done) => setTimeout(done, 100)); });
    expect(document.querySelector('.sh-v2-usd')).toBeNull();
    expect(document.body.textContent).not.toMatch(/about \$/);
    expect(unitOf(picture.isConnected ? picture : await pictureLoaded(), 'Market cap')).toBe('tUSDC');
    await act(async () => { second.answer(ok(alchemist)); await new Promise((done) => setTimeout(done, 50)); });
    const pile = () => document.querySelector('.sh-m3-pile .sh-v2-usd');
    await waitFor(() => expect(pile()).not.toBeNull());
    const own = usdPricesOf(alchemist.prices);
    expect(pile()?.firstChild?.textContent).toBe(usdText(listed.m3?.pileMoney?.balance ?? 0n, 18, usdPriceFor(own, TNVDA, at) as NonNullable<ReturnType<typeof usdPriceFor>>));
    expect(pile()?.textContent).toContain('Price from Atlas (NVDAB/USD), 256 s old.');
    expect(unitOf(await pictureLoaded(), 'Market cap')).toBe(`tUSDC, ${usdText(listed.statistics?.marketCapP ?? 0n, 6, usdPriceFor(own, TUSDC, at) as NonNullable<ReturnType<typeof usdPriceFor>>)}`);
  });
});

describe('SH-306: the prices read is calm', () => {
  function wrapper() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const visibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  afterEach(() => { visibility('visible'); });

  it('once when the page opens, then once a minute while visible; none while hidden; none after the page is left', async () => {
    vi.useFakeTimers();
    const answer = liveBnbAnswersV2.gpuPoor();
    const fetcher = vi.fn<Fetcher>(async () => ok(answer));
    const { result, unmount, rerender } = renderHook(() => useBoxPricesV2(source, GPU_POOR, fetcher), { wrapper: wrapper() });
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current?.coins[0]?.symbol).toBe('tNVDA');
    // Renders ask nothing.
    for (let i = 0; i < 20; i++) rerender();
    await act(() => vi.advanceTimersByTimeAsync(BOX_PRICES_POLL_MS - 1_000));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(fetcher).toHaveBeenCalledTimes(2);
    visibility('hidden');
    await act(() => vi.advanceTimersByTimeAsync(5 * BOX_PRICES_POLL_MS));
    expect(fetcher).toHaveBeenCalledTimes(2);
    visibility('visible');
    await act(() => vi.advanceTimersByTimeAsync(BOX_PRICES_POLL_MS));
    expect(fetcher).toHaveBeenCalledTimes(3);
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(10 * BOX_PRICES_POLL_MS));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every(([url]) => url === boxPricesUrlV2(source, GPU_POOR))).toBe(true);
  });

  it('a later failed read keeps the prices it had (shown only while inside their limit at the page\'s clock)', async () => {
    vi.useFakeTimers();
    let fail = false;
    const fetcher: Fetcher = async () => { if (fail) throw new TypeError('Failed to fetch'); return ok(liveBnbAnswersV2.gpuPoor()); };
    const { result } = renderHook(() => useBoxPricesV2(source, GPU_POOR, fetcher), { wrapper: wrapper() });
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(result.current).not.toBeNull();
    fail = true;
    await act(() => vi.advanceTimersByTimeAsync(BOX_PRICES_POLL_MS));
    expect(result.current?.coins[0]?.feed).toBe('NVDAB/USD');
  });

  it('reads only `prices`, only from this box\'s answer on this chain', async () => {
    const gpu = liveBnbAnswersV2.gpuPoor();
    await expect(readBoxPricesV2(source, GPU_POOR, async () => ok(gpu))).resolves.toMatchObject({ coins: [{ symbol: 'tNVDA' }] });
    await expect(readBoxPricesV2(source, GPU_POOR, async () => ok({ ...gpu, prices: undefined }))).resolves.toBeNull();
    await expect(readBoxPricesV2(source, GPU_POOR, async () => ok({ ...gpu, chainId: 56 }))).rejects.toThrow('Not this box');
    await expect(readBoxPricesV2(source, GPU_POOR, async () => ok({ ...gpu, token: ALCHEMIST }))).rejects.toThrow('Not this box');
    await expect(readBoxPricesV2(source, GPU_POOR, async () => ok(null))).rejects.toThrow('Not this box');
  });
});
