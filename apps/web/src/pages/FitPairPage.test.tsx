import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toJson } from '@squarehole/indexer/client';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataSourceProvider, DATA_SOURCE_KEY, resetDataSourceForTests, type DataSourceBuild } from '../features/data-source';
import { DemoChain } from '../features/fit-pair/demo-chain';
import { UNISWAP_TESTNET_MODE_WARNING } from '@squarehole/links';
import { FitPairView } from '../features/fit-pair/FitPairView';
import { DEMO_FIT_TARGET, FIT_NOT_CONFIGURED_LOCAL, parseFitMarket, type FitMarketTarget } from '../features/fit-pair/fit-target';
import { LAUNCH_HINTS } from '../features/fit-pair/market-names';
import type { LiveDeps, StreamLike } from '../features/fit-pair/live-controller';
import { budgetText, sentenceCount, visibleText, wordCount } from '../features/fit-pair/test-support/visible-text';
import { appCopyFraming, renderedCopy } from '../features/legal/wording';
import { location, renderM3 } from '../test-support/m3';
import { FitPairPage } from './FitPairPage';

const RECORD = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../e2e/fixtures/fit-market-31337.json'), 'utf8')) as unknown;
/** The committed Sepolia record (the full v2 deployment) and what its live service and RPC answered (recorded). */
const SEPOLIA_RECORD = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../fit-markets/fit-market-11155111.json'), 'utf8')) as unknown;
const SEPOLIA_LIVE = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../e2e/fixtures/fit-live-11155111.json'), 'utf8')) as {
  head: string;
  snapshot: string;
  rpc: { latest: { number: string; hash: `0x${string}`; timestamp: string }; calls: Record<string, string> };
};
const writeText = vi.fn<(text: string) => Promise<void>>();
const FORBIDDEN = /\b(buy|sell|swap)\b/i;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetDataSourceForTests();
});

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function renderPage(path = '/misfits', build?: DataSourceBuild) {
  render(
    <DataSourceProvider build={build}>
      <MemoryRouter initialEntries={[path]}>
        <FitPairPage build={build ? { fitMarkets: [], localRpcUrl: build.localRpcUrl } : undefined} />
      </MemoryRouter>
    </DataSourceProvider>,
  );
  await settle(0);
}

const region = (name: string | RegExp) => screen.getByRole('region', { name });

function noTradingControls() {
  expect(screen.queryAllByRole('button', { name: FORBIDDEN })).toEqual([]);
  expect(screen.queryAllByRole('link', { name: FORBIDDEN })).toEqual([]);
  expect(document.querySelectorAll('input, select, textarea, iframe')).toHaveLength(0);
}

describe('the FIT pair page on the Demo data (T19)', () => {
  it('puts the contract address first, with a working copy button and a Demo badge beside it', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('FIT');
    expect(document.title).toBe('FIT · The Misfits · Square Hole');
    const header = document.querySelector('header.sh-fit-head');
    if (!(header instanceof HTMLElement)) throw new Error('no header');
    expect(within(header).getByText(DEMO_FIT_TARGET.token)).toBeTruthy();
    const ca = header.querySelector('.sh-fit-ca');
    if (!(ca instanceof HTMLElement)) throw new Error('no contract address block');
    // F130: no Demo badge, chip or word on the address, the curve's chip, the trades or the vault counts.
    expect(visibleText(ca)).toMatch(/^Contract address 0x[0-9a-f]{40} Copy$/);
    expect(ca.querySelector('.sh-fit-demo')).toBeNull();
    for (const card of [ca, region('Bonding curve'), region('Recent trades'), region('The Misfits vault')]) expect(card.textContent, card.className).not.toMatch(/\bdemo\b/i);
    expect(document.body.textContent).not.toMatch(/\b(demo|mock)\b/i);
    await act(async () => {
      fireEvent.click(within(header).getByRole('button', { name: 'Copy the FIT contract address' }));
    });
    expect(writeText).toHaveBeenCalledWith(DEMO_FIT_TARGET.token);
  });

  it('shows the live curve from one block: phase chip, one freshness chip, price, band and three figures', async () => {
    await renderPage();
    const header = document.querySelector('header.sh-fit-head');
    expect(header?.querySelector('.sh-fit-head__phase')?.textContent).toBe('Curve open');
    // An open curve needs no phase line; the launch window, the open and graduation get one.
    expect(header?.querySelector('.sh-fit-phase')).toBeNull();
    const curve = region('Bonding curve');
    const band = within(curve).getByRole('progressbar', { name: 'Progress to graduation' });
    expect(band.getAttribute('aria-valuetext')).toMatch(/ of 4\.206980085 ETH \(\d+\.\d%\) · after sells$/);
    expect(document.querySelectorAll('.sh-fit-chip')).toHaveLength(1);
    const chip = curve.querySelector('.sh-fit-chip');
    // The word only; the block number is news only when stale, so it sits in the title and the (i).
    expect(chip?.textContent).toBe('Live');
    expect(chip?.getAttribute('title')).toBe('Block 21,000,960');
    expect(visibleText(curve)).toMatch(/^Bonding curve Live Price [\d.]+ ETH per 1M FIT Progress to graduation \d+\.\d% [\d.]+ of 4\.206980085 ETH now Sold [\d.]+M FIT Burned [\d.]+M FIT Total tax [\d.]+ ETH$/);
    for (const label of ['Price', 'Progress to graduation', 'Sold', 'Burned', 'Total tax']) {
      expect(within(curve).getByText(label)).toBeTruthy();
    }
    // The legend is heard in full; the drawing itself is decoration.
    expect(curve.querySelector('figcaption .sh-visually-hidden')?.textContent).toMatch(/^The curve: ETH in the curve across, from 0 to the 4\.206980085 ETH target, price up\. Solid dot: the confirmed state/);
    expect(curve.querySelector('.sh-fit-chart__legend')?.getAttribute('aria-hidden')).toBe('true');
    // The explanation is behind the (i), closed at first.
    const info = within(curve).getByRole('button', { name: 'About the bonding curve' });
    expect(info.getAttribute('aria-expanded')).toBe('false');
    expect(visibleText(curve)).not.toContain('The price follows this curve');
    fireEvent.click(info);
    expect(visibleText(curve)).toContain('The price follows this curve: the more ETH in it, the higher the price.');
    expect(visibleText(curve)).toContain('Data: block 21,000,959, from the block stream, with the exact pool math. 1 FIT = ');
    // One 12-second slot later the stream has moved on by one block.
    await settle(12_000);
    expect(curve.querySelector('.sh-fit-chip')?.getAttribute('title')).toBe('Block 21,000,961');
  });

  it('keeps the first look short: labels and numbers, at most one sentence a card, every explanation closed', async () => {
    await renderPage();
    const cards = [...document.querySelectorAll('header.sh-fit-head, section.sh-detail-card')];
    // F77 added the Pool card (box 0's pool grows from its fees and launch tax, BC-142).
    expect(cards).toHaveLength(8);
    for (const card of cards) {
      const text = budgetText(card);
      expect(sentenceCount(text), text).toBeLessThanOrEqual(1);
    }
    for (const button of screen.getAllByRole('button', { name: /^About / })) expect(button.getAttribute('aria-expanded')).toBe('false');
    for (const details of document.querySelectorAll('details')) expect(details.open).toBe(false);
    // The text budget of the whole page at first load with the sample data (2026-10-01: 1,029 words before the text
    // diet, about 147 after its first pass). Honesty text ([data-disclosure]) is not budgeted, so no budget can push it
    // out; it is checked on its own. F49 D3 took the fee-share notice out; F130 the four Demo badges.
    expect(wordCount(budgetText(document.body))).toBeLessThanOrEqual(150);
    expect([...document.querySelectorAll('[data-disclosure]')].map((node) => visibleText(node))).toEqual([]);
  });

  it('opens an info panel by button and closes it with Escape, giving focus back (keyboard and touch)', async () => {
    await renderPage();
    const button = screen.getByRole('button', { name: 'About the links' });
    const panel = document.getElementById(button.getAttribute('aria-controls') ?? '');
    if (!panel) throw new Error('no panel');
    expect(panel.hidden).toBe(true);
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hidden).toBe(false);
    expect(visibleText(panel)).toBe(
      'No links on a local chain. On a public chain each site gets a link only after it is tested with this exact FIT. Square Hole has no trade form. Links open in a new tab; this page never asks your wallet.',
    );
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('links out only where a route is verified: one muted line for the sample data, and no trading controls anywhere', async () => {
    await renderPage();
    const links = region('Open on');
    expect(visibleText(links)).toBe('Open on No links');
    expect(links.querySelectorAll('a[href], li')).toHaveLength(0);
    // Requirement ids stay in the docs.
    expect(document.body.textContent).not.toMatch(/\((?:EXT|B-DISC)-/);
    noTradingControls();
  });

  it('shows the fee line without a fee-share notice (F49 D3), and the vault read-only', async () => {
    await renderPage();
    const fees = region('Fees');
    expect(visibleText(fees)).toBe('Fees 1% pool fee');
    expect(fees.querySelector('details')).toBeNull();
    expect(fees.textContent).not.toMatch(/fee share|outside liquidity/i);
    const vault = region('The Misfits vault');
    // A placeholder is a ticket: it leaves the count inside (MisfitsVault.openTickets, n falls by k).
    expect(visibleText(vault)).toBe('The Misfits vault Misfits inside 4,232 of 4,269 Reserved 37 Opens at graduation');
    expect(vault.textContent).toContain('Reserved: placeholders taken for FIT during the curve');
    expect(vault.textContent).not.toMatch(/demo/i);
    expect(within(vault).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['About the vault']);
  });

  it('names the launch tax on the first card during the window, and counts down in blocks', async () => {
    await renderPage('/misfits?scenario=window');
    const header = document.querySelector('header.sh-fit-head');
    expect(header?.querySelector('.sh-fit-head__phase')?.textContent).toBe('Launch window');
    expect(header?.querySelector('.sh-fit-phase')?.textContent).toMatch(/^Launch tax \d+\.\d\d% on buys · 22 blocks left$/);
    expect(visibleText(region('Fees'))).toBe('Fees 1% pool fee + launch tax on buys until block 21,000,331');
    const window = region('Launch window');
    expect(visibleText(window)).toMatch(/^Launch window Ends after block 21,000,331 · ~[\w ,:]+ UTC \(estimate\) Launch tax per block \+ 0 ✓ 93\.20%/);
    // Past cells keep their text (no fading) and say "passed" to a screen reader; the next one says so too.
    expect(window.querySelectorAll('[data-state="past"]')).toHaveLength(10);
    expect(window.querySelector('[data-state="past"]')?.textContent).toContain('passed');
    expect(window.querySelector('[aria-current="step"]')?.textContent).toContain('next block');
    expect(window.querySelector('[aria-current="step"]')?.textContent).toContain('+10');
    expect(window.querySelector('ol')?.getAttribute('aria-labelledby')).toBe(window.querySelector('.sh-fit-window__caption')?.id);
    expect(screen.getByText('Scenario: window')).toBeTruthy();
  });

  it('names the launch tax before the open too: in the header, on the cells and in the fee line', async () => {
    await renderPage('/misfits?scenario=before_open');
    const header = document.querySelector('header.sh-fit-head');
    expect(header?.querySelector('.sh-fit-head__phase')?.textContent).toBe('Not open yet');
    expect(header?.querySelector('.sh-fit-phase')?.textContent).toMatch(/^Opens in \d+ blocks · launch tax 93\.20% → 8\.06% on buys$/);
    const window = visibleText(region('Launch window'));
    expect(window).toMatch(/^Launch window Opens at block 21,000,300 · ~[\w ,:]+ UTC \(estimate\) Launch tax per block \+ 0 93\.20%/);
    expect(visibleText(region('Fees'))).toContain('+ launch tax on buys until block 21,000,331');
  });

  it('folds the 32 cells away once the window has closed, under the same label', async () => {
    await renderPage();
    const window = region('Launch window');
    expect(visibleText(window)).toBe('Launch window Closed · 1% pool fee only Launch tax per block');
    const details = window.querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelectorAll('li')).toHaveLength(32);
    fireEvent.click(within(window).getByText('Launch tax per block'));
    expect(details?.open).toBe(true);
    // The block range moved into the (i).
    expect(window.textContent).toContain('Blocks 21,000,300 – 21,000,331: buys go only through the launch router');
  });

  it('shows trade times relative to the newest block and "not final" only where it is news', async () => {
    await renderPage();
    const tape = region('Recent trades');
    const times = [...tape.querySelectorAll('time')];
    expect(times.length).toBeGreaterThan(0);
    for (const time of times) {
      expect(time.textContent).toMatch(/^(now|\d+ s ago|\d+ min ago|\d+ h ago|\d+ d ago)$/);
      expect(time.getAttribute('title')).toMatch(/^\d+ \w+, \d\d:\d\d:\d\d UTC$/);
      expect(time.getAttribute('datetime')).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/);
    }
    // A visible tier chip only for "not final"; the other tiers are said to screen readers.
    for (const chip of tape.querySelectorAll('.sh-fit-tier')) expect(chip.textContent).toBe('not final');
    expect(visibleText(tape)).not.toMatch(/\b(confirmed|final|safe)\b(?<!not final)/);
    expect(tape.querySelector('[data-tier="finalized"], [data-tier="confirmed"], [data-tier="safe"]')?.className).toBe('sh-visually-hidden');
    expect(within(tape).getByRole('button', { name: /^Show all \d+ trades$/ })).toBeTruthy();
  });

  it('says target reached, not graduated, and then graduated, with no fee-share notice (F49 D3)', async () => {
    await renderPage('/misfits?scenario=completed');
    const header = () => document.querySelector('header.sh-fit-head');
    expect(header()?.querySelector('.sh-fit-head__phase')?.textContent).toBe('Target reached');
    expect(header()?.querySelector('.sh-fit-phase')?.textContent).toMatch(/^Graduation pending/);
    expect(document.body.textContent).not.toMatch(/migration/i);
    expect(within(region('Bonding curve')).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    expect(region('Fees').querySelector('details')).toBeNull();
    cleanup();
    await renderPage('/misfits?scenario=migrated');
    expect(header()?.querySelector('.sh-fit-head__phase')?.textContent).toBe('Graduated');
    expect(header()?.querySelector('.sh-fit-phase')?.textContent).toMatch(/^Since block [\d,]+$/);
    const curve = region('Bonding curve');
    // The full band says it once: no "Graduated" line under it, no "Ended" figure beside it.
    expect(within(curve).getByRole('progressbar', { name: 'Curve complete' }).getAttribute('aria-valuetext')).toMatch(/^Graduated at block [\d,]+$/);
    expect(visibleText(curve)).not.toMatch(/Graduated|Ended| of 4\.206980085 ETH/);
    const fees = region('Fees');
    expect(visibleText(fees)).toBe('Fees 1% pool fee');
    expect(document.body.textContent).not.toMatch(/fee share|outside liquidity/i);
    expect(visibleText(region('The Misfits vault'))).toContain('Open since graduation');
    expect(visibleText(region('The Misfits vault'))).not.toContain('fixed');
    expect(region('The Misfits vault').textContent).toContain('The vault opened at graduation');
  });

  it('marks a stale or unverified stream in words on its one chip, never as live, and hides an unverified price', async () => {
    const curve = () => region('Bonding curve');
    const chipText = () => curve().querySelector('.sh-fit-chip')?.textContent ?? '';
    await renderPage('/misfits');
    expect(visibleText(curve())).toMatch(/ETH per 1M FIT/);
    cleanup();
    await renderPage('/misfits?scenario=stale');
    expect(chipText()).toBe('Stale · since block 21,000,960');
    expect(visibleText(curve())).toMatch(/ETH per 1M FIT/);
    expect(document.querySelector('.sh-fit')?.getAttribute('data-stale')).toBe('true');
    cleanup();
    await renderPage('/misfits?scenario=unverified');
    expect(chipText()).toBe('Unverified');
    // The reason stays visible, in one short sentence.
    expect(visibleText(curve())).toContain('Live data doesn’t match the chain.');
    // An unverified price is not shown, not even behind the (i).
    expect(visibleText(curve())).toContain('Not shown while unverified');
    expect(curve().querySelector('.sh-fit-hero__value')).toBeNull();
    expect(curve().textContent).not.toMatch(/1 FIT =|ETH per FIT/);
    // The page cannot confirm the window has ended: nothing says "not live yet".
    expect(visibleText(region('Open on'))).not.toContain('not live yet');
  });

  it('follows the safe wording rule in every scenario (F23)', async () => {
    for (const scenario of ['curve', 'window', 'before_open', 'completed', 'migrated', 'stale', 'unverified', 'reorg']) {
      await renderPage(`/misfits?scenario=${scenario}`);
      await settle(12_000);
      expect(appCopyFraming([...renderedCopy(document.body), document.title]), scenario).toEqual([]);
      noTradingControls();
      cleanup();
    }
  });
});

describe('routes', () => {
  it('/fit-pair is the lazy FIT pair page (the /fit and /misfits redirects to the box are in App.navigation.test.tsx)', async () => {
    await import('./FitPairPage');
    renderM3('/fit-pair');
    await settle(0);
    await settle(0);
    expect(location()).toBe('/fit-pair');
    expect(document.querySelector('.sh-fit-ca__address')?.textContent).toBe(DEMO_FIT_TARGET.token);
  });
});

describe('the FIT pair page on a chain source', () => {
  it('says so when the build has no FIT market for the local chain', async () => {
    window.localStorage.setItem(DATA_SOURCE_KEY, JSON.stringify({ source: 'local' }));
    await renderPage('/misfits', { localManifest: {}, sepoliaManifest: null, localRpcUrl: 'http://127.0.0.1:8599' });
    expect(screen.getByRole('heading', { level: 1, name: 'FIT · The Misfits' })).toBeTruthy();
    expect(screen.getByText(FIT_NOT_CONFIGURED_LOCAL)).toBeTruthy();
  });

  it('is live on the gateway’s stream, then shows the chain read when the service turns unverified', async () => {
    const target: FitMarketTarget = parseFitMarket(RECORD, 'http://127.0.0.1:8599');
    const chain = new DemoChain(target);
    chain.mineTo(target.openBlock + 120n);
    const listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
    const stream: StreamLike = {
      readyState: 1,
      addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
      close: () => undefined,
    };
    const emit = (type: string, data: string) => act(() => (listeners.get(type) ?? []).forEach((listener) => listener({ data })));
    const { liveDataFromDirect } = await import('../features/fit-pair/direct-source');
    const deps: LiveDeps = {
      now: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
      openStream: () => stream,
      fetchSnapshot: null,
      readDirect: async () =>
        liveDataFromDirect(
          {
            block: { number: chain.head.header.number, hash: chain.head.header.hash, timestamp: chain.head.header.timestamp },
            safeBlock: null,
            finalizedBlock: null,
            sqrtPriceX96: chain.head.state.sqrtPriceX96,
            tick: chain.head.state.tick,
            phase: 'curve',
            completedBlock: null,
            migratedBlock: null,
            liquidityOpensAtBlock: null,
            openBlock: target.openBlock,
            totalSupplyRaw: 10n ** 27n - chain.head.state.burnedRaw,
          },
          target,
        ),
    };
    const readVault = async () => ({ source: 'chain' as const, block: chain.head.header.number, inside: 4_200n, collectionSize: 4_200n, gateOpen: false, placeholdersTaken: 9n });
    render(
      <MemoryRouter>
        <FitPairView target={target} scenario="curve" deps={deps} readVault={readVault} />
      </MemoryRouter>,
    );
    await settle(0);
    emit('snapshot', toJson(chain.snapshot(0)));
    emit('status', '{"indexer":"live","reason":null}');
    const curve = region('Bonding curve');
    expect(curve.querySelector('.sh-fit-chip')?.textContent).toBe('Live');
    expect(curve.querySelector('.sh-fit-chip')?.getAttribute('title')).toBe('Block 1,420');
    expect(curve.textContent).toContain('its figures agree with the price it reports, which is not yet checked against the chain');
    // The first check against a direct chain read runs on the next tick and agrees.
    await settle(2_100);
    expect(curve.textContent).toContain('from the live service; its price matched a direct chain read at block 1,420');
    expect(region('Recent trades').querySelectorAll('li').length).toBeGreaterThan(0);
    expect(visibleText(region('The Misfits vault'))).toContain('Chain read · block 1,420');
    // The local chain has no public venue: nothing is linked; the network is named beside the address, and no card
    // says Demo.
    expect(visibleText(region('Open on'))).toBe('Open on No links on a local chain');
    expect(region('Open on').querySelectorAll('a[href]')).toHaveLength(0);
    expect(document.querySelector('.sh-fit-ca__network')?.textContent).toBe('Local chain 31337');
    expect(document.querySelector('.sh-fit-demo')).toBeNull();
    expect(visibleText(document.body)).not.toMatch(/\bDemo\b/);
    emit('status', '{"indexer":"unverified","reason":"the indexer state differs from the chain"}');
    await settle(2_100);
    expect(curve.querySelector('.sh-fit-chip')?.textContent).toBe('Direct chain read');
    expect(visibleText(curve)).toContain('Live data doesn’t match the chain.');
    expect(visibleText(region('Recent trades'))).toContain('No trades: a direct chain read carries none.');
  });
});

describe('the Sepolia record: the full v2 deployment in its neutral names', () => {
  it('shows the live pool as its contracts name it, with every address, the explorer link and no launch name', async () => {
    // The committed record names no indexer (none is hosted); a build can point it at one (SH_SEPOLIA_INDEXER_ORIGIN).
    const target = parseFitMarket({ ...(SEPOLIA_RECORD as object), indexer: { origin: 'http://127.0.0.1:5393' } }, 'https://ethereum-sepolia-rpc.publicnode.com');
    const snapshot = JSON.parse(SEPOLIA_LIVE.snapshot) as { state: { sqrtPriceX96: string; tick: number; burnedRaw: string } };
    const listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
    const stream: StreamLike = {
      readyState: 1,
      addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
      close: () => undefined,
    };
    const emit = (type: string, data: string) => act(() => (listeners.get(type) ?? []).forEach((listener) => listener({ data })));
    const { liveDataFromDirect } = await import('../features/fit-pair/direct-source');
    const latest = SEPOLIA_LIVE.rpc.latest;
    const head = BigInt(latest.number);
    // The direct read at the recorded head: the chain's own answers (recorded with eth_call at that block).
    const supply = BigInt(SEPOLIA_LIVE.rpc.calls[`${target.token.toLowerCase()}:0x18160ddd`] ?? '0x0');
    const deps: LiveDeps = {
      now: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
      openStream: () => stream,
      fetchSnapshot: null,
      readDirect: async () =>
        liveDataFromDirect(
          {
            block: { number: head, hash: latest.hash, timestamp: BigInt(latest.timestamp) },
            safeBlock: null,
            finalizedBlock: null,
            sqrtPriceX96: BigInt(snapshot.state.sqrtPriceX96),
            tick: snapshot.state.tick,
            phase: 'curve',
            completedBlock: null,
            migratedBlock: null,
            liquidityOpensAtBlock: null,
            openBlock: target.openBlock,
            totalSupplyRaw: supply,
          },
          target,
        ),
    };
    const readVault = async () => ({ source: 'chain' as const, block: head, inside: 4_200n, collectionSize: 4_200n, gateOpen: false, placeholdersTaken: 0n });
    render(
      <MemoryRouter>
        <FitPairView target={target} scenario="curve" deps={deps} readVault={readVault} />
      </MemoryRouter>,
    );
    await settle(0);
    emit('snapshot', SEPOLIA_LIVE.snapshot);
    emit('status', '{"indexer":"live","reason":null}');
    await settle(2_100);
    const header = document.querySelector('header.sh-fit-head');
    if (!(header instanceof HTMLElement)) throw new Error('no header');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('RHT2 Rehearsal Collection');
    // What the token is sits behind the (i), in the names its contracts carry; the badge beside the address says
    // "Rehearsal · test set" (heard: neutral names, test tokens with no value).
    expect(header.textContent).toContain('Rehearsal Token 2 (RHT2) is the fraction token of the Rehearsal Collection (RHC)');
    expect(header.textContent).toContain('Test tokens have no value.');
    expect(header.textContent).toContain('Sepolia testnet (chain id 11155111)');
    const ca = header.querySelector('.sh-fit-ca');
    if (!(ca instanceof HTMLElement)) throw new Error('no contract address block');
    expect(visibleText(ca)).toBe('Contract address Sepolia testnet Rehearsal · test set 0x07cB5710D589c9763192E76694FCd3E8F5a0B353 Copy');
    expect(ca.querySelector('.sh-fit-head__rehearsal')?.textContent).toBe('Rehearsal · test set: neutral names, test tokens with no value');
    expect(within(header).getByText('0x07cB5710D589c9763192E76694FCd3E8F5a0B353')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(header).getByRole('button', { name: 'Copy the RHT2 contract address' }));
    });
    expect(writeText).toHaveBeenCalledWith('0x07cB5710D589c9763192E76694FCd3E8F5a0B353');
    const curve = region('Bonding curve');
    // The one chip says the state; the block is in its title and the (i).
    expect(curve.querySelector('.sh-fit-chip')?.textContent).toBe('Live');
    expect(curve.querySelector('.sh-fit-chip')?.getAttribute('title')).toBe('Block 11,818,257');
    expect(curve.textContent).toContain('its price matched a direct chain read at block 11,818,257');
    // The target comes from the record's curve (the Misfits launch curve: 4.206980085 ETH).
    expect(within(curve).getByRole('progressbar').getAttribute('aria-valuetext')).toBe('0.001484999 ETH of 4.206980085 ETH (0.0%) · after sells');
    expect(visibleText(curve)).toBe('Bonding curve Live Price 0.0013775 ETH per 1M RHT2 Progress to graduation 0.0% 0.0014 of 4.206980085 ETH now Sold 1.07M RHT2 Burned 1.07M RHT2 Total tax 0 ETH');
    expect(visibleText(region('Recent trades'))).toContain('Genesis · RHT2 burned');
    const vault = region('Rehearsal Collection vault');
    expect(visibleText(vault)).toBe('Rehearsal Collection vault Items inside 4,200 of 4,200 Reserved 0 Opens at graduation Test set only: made-up traits, no art. Chain read · block 11,818,257');
    expect(vault.textContent).toContain('commit to made-up traits with no art behind them');
    // Links: the explorer page of the exact token; Uniswap stays unchecked (no route evidence yet: nobody has traded);
    // DEX Screener lists no Sepolia pools, so it has no link at all.
    const links = region('Open on');
    const anchors = [...links.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
    expect(anchors).toEqual(['https://sepolia.etherscan.io/token/0x07cB5710D589c9763192E76694FCd3E8F5a0B353']);
    expect(visibleText(links)).toBe('Open on Uniswap web app not checked DEX Screener no link Etherscan (Sepolia) sepolia.etherscan.io');
    expect(links.textContent).toContain('RHT2 on a block explorer');
    expect(links.textContent).toContain('This app has no trade form.');
    // The Testnet-mode caveat once: Uniswap is not a link, so it is said with Uniswap's reason in the (i), not twice.
    expect((links.textContent ?? '').split(UNISWAP_TESTNET_MODE_WARNING)).toHaveLength(2);
    expect(links.querySelector('.sh-info-panel')?.textContent).toContain(UNISWAP_TESTNET_MODE_WARNING);
    // Every address of the deployment, each with its copy button.
    const contracts = region('All contract addresses');
    for (const [label, address] of [
      ['RHT2 token', '0x07cB5710D589c9763192E76694FCd3E8F5a0B353'],
      ['Vault', '0x2453B9a2073C62c5fd64CB0C811843a087256b29'],
      ['Placeholders (RHC-P)', '0xc79B538010200a8aABA5E2fA4B0A991A36351073'],
      ['Rehearsal Collection (RHC)', '0x9CdEfAeAb0ebcaA72e6CC41dF15200327935Bf92'],
      ['Genesis', '0x26d6e5De7f5F8803EB40d3b9c4CCaF565279e108'],
      ['Fee collector', '0xc80043F3e50836A8274f876ECFBb8E165a0eA354'],
      ['Executor (buyback and burn)', '0xfe0D753C01d5330e4D17775643D83FF3280a8aa6'],
      ['Randomness source', '0x617f7E7349393992b0cf5F4D42F1c090A171d432'],
    ] as const) {
      expect(contracts.textContent).toContain(`${label}${address}`);
    }
    expect(within(contracts).getAllByRole('button', { name: /^Copy the /, hidden: true })).toHaveLength(12);
    // The launch's names appear nowhere the market is described: the names rule's own list (LAUNCH_HINTS: fit, misfit,
    // square, hole, stonk, sorter, so "Square Hole" too), case-insensitive. With the Terms 5.7 (e) quotes gone (F49 D3)
    // the Fees card is checked like every other card.
    for (const part of [header, curve, region('Recent trades'), vault, links, contracts, region('Launch window'), region('Fees')]) {
      expect(part.textContent ?? '').not.toMatch(LAUNCH_HINTS);
    }
    expect(region('Fees').textContent).toContain('in ETH on a buy, in RHT2 on a sell.');
    expect(appCopyFraming(renderedCopy(document.body))).toEqual([]);
    noTradingControls();
  });

  it('reads the chain directly with the committed record (no live service), and says it has none', async () => {
    const target = parseFitMarket(SEPOLIA_RECORD, 'https://ethereum-sepolia-rpc.publicnode.com');
    expect(target.indexerOrigin).toBeNull();
    const snapshot = JSON.parse(SEPOLIA_LIVE.snapshot) as { state: { sqrtPriceX96: string; tick: number } };
    const { liveDataFromDirect } = await import('../features/fit-pair/direct-source');
    const latest = SEPOLIA_LIVE.rpc.latest;
    const deps: LiveDeps = {
      now: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
      openStream: null,
      fetchSnapshot: null,
      readDirect: async () =>
        liveDataFromDirect(
          {
            block: { number: BigInt(latest.number), hash: latest.hash, timestamp: BigInt(latest.timestamp) },
            safeBlock: null,
            finalizedBlock: null,
            sqrtPriceX96: BigInt(snapshot.state.sqrtPriceX96),
            tick: snapshot.state.tick,
            phase: 'curve',
            completedBlock: null,
            migratedBlock: null,
            liquidityOpensAtBlock: null,
            openBlock: target.openBlock,
            totalSupplyRaw: BigInt(SEPOLIA_LIVE.rpc.calls[`${target.token.toLowerCase()}:0x18160ddd`] ?? '0x0'),
          },
          target,
        ),
    };
    render(
      <MemoryRouter>
        <FitPairView target={target} scenario="curve" deps={deps} readVault={async () => ({ source: 'chain' as const, block: BigInt(latest.number), inside: 4_200n, collectionSize: 4_200n, gateOpen: false, placeholdersTaken: 0n })} />
      </MemoryRouter>,
    );
    await settle(0);
    await settle(0);
    const curve = region('Bonding curve');
    expect(curve.querySelector('.sh-fit-chip')?.textContent).toBe('Direct chain read');
    expect(curve.querySelector('.sh-fit-chip')?.getAttribute('title')).toBe('Block 11,818,257');
    expect(visibleText(curve)).toContain('No live service is configured for this market.');
    expect(curve.textContent).not.toContain('cannot be reached');
    expect(visibleText(region('Recent trades'))).toContain('No trades: a direct chain read carries none.');
  });
});
