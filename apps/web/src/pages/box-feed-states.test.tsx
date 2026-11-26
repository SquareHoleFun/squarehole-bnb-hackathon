/**
 * SH-246 (finding 11.4): the front page and My Box's claims in every state of the two feeds the site merges (box 0 from
 * the core v1 feed, every other box from the v2 feed). On the real BoxFeedPage and useBoxSources, with both feeds
 * answered by a fetcher this test holds (core v1's recorded life and a v2 box on the same chain, mixed-deployment.ts,
 * as box-page-states.test.tsx does); the chain itself is unreachable, so a refused v1 feed has no direct-read fallback.
 * "No boxes" only once both feeds answered without a box; a feed that could not be read says the list may be missing
 * boxes (or did not load), with Retry; Retry reads the failed feed again.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEED_WORDS } from '../features/boxes/feed-words';
import type { LookupPart } from '../features/boxes/box-sources';
import { useBoxSources } from '../features/boxes/useBoxSources';
import type { CoreBuild } from '../features/core/core-build';
import type { Fetcher } from '../features/core/core-client';
import { mixedDeployment } from '../features/core/v2/test-support/mixed-deployment';
import { claimsWaiting } from '../features/core/v2/WalletClaimsV2';
import { DATA_SOURCE_KEY, DataSourceProvider, resetDataSourceForTests } from '../features/data-source';
import { resetSetChecksForTests } from '../features/set/set-build';
import { BoxFeedPage } from './BoxFeedPage';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(resolve(HERE, '../../e2e/fixtures/core-local/manifest-11155111.json'), 'utf8')) as unknown;
const ORIGIN = 'http://indexer.test';
const BUILD: CoreBuild = { manifests: [MANIFEST], localRpcUrl: 'http://127.0.0.1:8599', indexers: { local: ORIGIN, sepolia: null } };
const data = await mixedDeployment();
const V2_FEED = { ...data.feed, cards: [data.body] };
const V1_EMPTY = { ...data.v1.feed, cards: [] };
const V2_EMPTY = { ...data.feed, cards: [] };
const BOX0 = `/box/${data.manifest.chainId}/${data.v1Token.toLowerCase()}`;
const V2BOX = `/box/${data.manifest.chainId}/${data.body.token.toLowerCase()}`;

type Answer = 'refuse' | 'hang' | unknown;
/** The two feeds as the test says (changed while the page runs); every other request fails at once. */
function feeds(answers: { v1: Answer; v2: Answer }) {
  const fetcher: Fetcher = async (url) => {
    const path = new URL(url).pathname;
    const answer = path === '/v1/feed' ? answers.v1 : path === '/v2/feed' ? answers.v2 : undefined;
    if (answer === 'hang') return new Promise(() => undefined);
    if (answer === 'refuse' || answer === undefined) throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, json: async () => answer };
  };
  return { fetcher, answers };
}

function Providers({ children }: { children: React.ReactNode }) {
  window.localStorage.setItem(DATA_SOURCE_KEY, JSON.stringify({ source: 'local' }));
  return (
    <DataSourceProvider build={{ localManifest: null, sepoliaManifest: null, localRpcUrl: 'http://127.0.0.1:8560', coreLocal: true }}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    </DataSourceProvider>
  );
}

function renderFeed(fetcher: Fetcher) {
  render(<Providers><BoxFeedPage build={{ fitMarkets: [], localRpcUrl: '' }} coreBuild={BUILD} fetcher={fetcher} /></Providers>);
}

const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** Ticks until `ready` holds (up to a minute of the page's time: a refused feed is read twice before it counts). */
async function until(ready: () => boolean): Promise<void> {
  for (let waited = 0; !ready() && waited < 60_000; waited += 250) await tick(250);
  expect(ready()).toBe(true);
}
const listed = () => [...document.querySelectorAll('ul[aria-label="Boxes"] a[href^="/box/"]')].map((a) => a.getAttribute('href'));
const partial = () => document.querySelector('[data-feed="partial"]');
const empty = () => document.querySelector('.sh-box-empty');
const main = () => document.body.textContent ?? '';
/** A card's whole label: name, ticker, kind, state and figure (BoxCard.tsx cardLabel). */
const label = (path: string) => document.querySelector(`ul[aria-label="Boxes"] a[href="${path}"]`)?.getAttribute('aria-label') ?? null;
const count = () => document.querySelector('.sh-box-feed__count')?.textContent;
const chips = () => screen.queryByRole('group', { name: 'State' });

beforeEach(() => {
  vi.useFakeTimers();
  // The chain itself (core v1's direct reads, coin symbols) is not reachable in this test.
  vi.stubGlobal('fetch', async () => { throw new TypeError('no network in this test'); });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetDataSourceForTests();
  resetSetChecksForTests();
});

describe('SH-246 the front page in every state of its two feeds', () => {
  it('both answer: box 0 and the v2 box, no line about missing boxes', async () => {
    renderFeed(feeds({ v1: data.v1.feed, v2: V2_FEED }).fetcher);
    await until(() => listed().includes(BOX0) && listed().includes(V2BOX));
    await tick(2_000);
    expect(partial()).toBeNull();
    expect(empty()).toBeNull();
    expect(main()).not.toMatch(/may be missing|did not load|could not be read/);
  });

  it('SH-306: the list asks no box\'s own answer (only an open box page reads its prices)', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => { asked.push(String(url)); throw new TypeError('no network in this test'); });
    const f = feeds({ v1: data.v1.feed, v2: V2_FEED });
    renderFeed((url, init) => { asked.push(url); return f.fetcher(url, init); });
    await until(() => listed().includes(BOX0) && listed().includes(V2BOX));
    await tick(130_000);
    expect(asked.some((url) => url.endsWith(`/v2/feed?chain=${data.manifest.chainId}`))).toBe(true);
    expect(asked.filter((url) => url.includes('/v2/boxes/'))).toEqual([]);
  });

  it('v1 answers, v2 refused: box 0 with "Some boxes may be missing from this list." and Retry; Retry brings the v2 box', async () => {
    const f = feeds({ v1: data.v1.feed, v2: 'refuse' });
    renderFeed(f.fetcher);
    await until(() => partial() !== null);
    expect(listed()).toEqual([BOX0]);
    expect(partial()?.querySelector('[role="status"]')?.textContent).toBe('Some boxes may be missing from this list.');
    expect(main()).not.toMatch(/No boxes/);
    // Through later polls it stays said (a poll does not take it back to nothing).
    for (let t = 0; t < 20_000; t += 250) { await tick(250); expect(partial()).not.toBeNull(); }
    f.answers.v2 = V2_FEED;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(document.activeElement?.id).toBe('page-title');
    await until(() => listed().includes(V2BOX));
    expect(partial()).toBeNull();
  });

  it('v2 answers, v1 refused (box 0 unreadable, the chain too): the v2 box with the same line and Retry; Retry brings box 0', async () => {
    const f = feeds({ v1: 'refuse', v2: V2_FEED });
    renderFeed(f.fetcher);
    await until(() => partial() !== null);
    expect(listed()).toEqual([V2BOX]);
    expect(partial()?.textContent).toBe(`${FEED_WORDS.partial}${FEED_WORDS.retry}`);
    f.answers.v1 = data.v1.feed;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await until(() => listed().includes(BOX0));
    expect(partial()).toBeNull();
  });

  it('both refused: "The boxes did not load." with Retry, never "No boxes" and no technical reason; no count, no chips', async () => {
    const f = feeds({ v1: 'refuse', v2: 'refuse' });
    renderFeed(f.fetcher);
    await until(() => empty()?.getAttribute('data-feed') === 'none');
    // Review M3: no "0 boxes" and no "All 0" chips above a list that did not load.
    expect(count()).toBe('');
    expect(chips()).toBeNull();
    // Review L2: the line is the live region; Retry is outside it.
    expect(empty()?.querySelector('[role="status"]')?.textContent).toBe('The boxes did not load.');
    expect(screen.getByRole('button', { name: 'Retry' }).closest('[role="status"]')).toBeNull();
    expect(empty()?.querySelector('p')?.textContent).toBe('The boxes did not load.');
    expect(empty()?.textContent).toBe(`${FEED_WORDS.none}${FEED_WORDS.retry}`);
    expect(main()).not.toMatch(/No boxes|V2 data unavailable|Failed to fetch|indexer/);
    f.answers.v1 = data.v1.feed;
    f.answers.v2 = V2_FEED;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await until(() => listed().includes(BOX0) && listed().includes(V2BOX));
    expect(empty()).toBeNull();
  });

  it('both answer with no box: the empty line (the development build’s; the production line is "No boxes yet."), no Retry', async () => {
    renderFeed(feeds({ v1: V1_EMPTY, v2: V2_EMPTY }).fetcher);
    await until(() => empty()?.getAttribute('data-feed') === 'empty');
    expect(empty()?.querySelector('p')?.textContent).toMatch(/^No boxes on Local chain.* in this build\.$/);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(partial()).toBeNull();
    // Both answered: the count and the chips are true again.
    expect(count()).toBe('0 boxes');
    expect(chips()).not.toBeNull();
  });

  it('review M1: v1 refused, v2 answered, then Retry while box 0’s feed hangs: the v2 card keeps its figure throughout', async () => {
    const f = feeds({ v1: 'refuse', v2: V2_FEED });
    renderFeed(f.fetcher);
    await until(() => partial() !== null);
    const before = label(V2BOX);
    expect(before).not.toBeNull();
    expect(before).not.toMatch(/Unavailable/);
    f.answers.v1 = 'hang';
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await tick(250);
    // While box 0's feed reads again its line waits (the part is being read); nothing says "No boxes".
    expect(partial()).toBeNull();
    expect(main()).not.toMatch(/No boxes/);
    // Through the whole re-read (its deadline, then the chain, unreachable here, until it fails again) the card stays.
    for (let t = 0; t < 10_000; t += 250) {
      await tick(250);
      expect(label(V2BOX)).toBe(before);
    }
  });

  it('review M1, the mirror: v2 refused, v1 answered, then Retry while the v2 feed hangs: box 0’s card keeps its figure', async () => {
    const f = feeds({ v1: data.v1.feed, v2: 'refuse' });
    renderFeed(f.fetcher);
    await until(() => partial() !== null);
    const before = label(BOX0);
    expect(before).not.toBeNull();
    f.answers.v2 = 'hang';
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    for (let t = 0; t < 10_000; t += 250) {
      await tick(250);
      expect(label(BOX0)).toBe(before);
    }
  });

  it('v1 answered with no box while v2 still reads: "Reading the boxes…", never "No boxes" before v2 answered', async () => {
    let release: () => void = () => undefined;
    const late = new Promise<void>((resolve) => { release = resolve; });
    const fetcher: Fetcher = async (url) => {
      const path = new URL(url).pathname;
      if (path === '/v1/feed') return { ok: true, status: 200, json: async () => V1_EMPTY };
      if (path === '/v2/feed') { await late; return { ok: true, status: 200, json: async () => V2_EMPTY }; }
      throw new TypeError('Failed to fetch');
    };
    renderFeed(fetcher);
    await tick(1_000);
    expect(empty()?.querySelector('p')?.textContent).toBe('Reading the boxes…');
    expect(main()).not.toMatch(/No boxes/);
    expect(count()).toBe('');
    expect(chips()).toBeNull();
    release();
    await until(() => empty()?.getAttribute('data-feed') === 'empty');
    expect(empty()?.querySelector('p')?.textContent).toMatch(/^No boxes on Local chain.* in this build\.$/);
  });
});

/** What My Box's claims read off the sources: the v2 part as useBoxSources gives it. */
function V2Part({ fetcher }: { fetcher: Fetcher }) {
  const sources = useBoxSources({ fitMarkets: [], localRpcUrl: '' }, BUILD, fetcher);
  const part = sources.v2 ?? null;
  return <p data-testid="v2">{part === null ? 'none' : `loading ${part.loading}, answered ${part.answered}, error ${part.error}`}</p>;
}

describe('SH-246 the v2 part that My Box’s claims depend on', () => {
  it('useBoxSources gives the v2 feed’s own state: reading, then answered; or never answered with its error', async () => {
    let release: () => void = () => undefined;
    const late = new Promise<void>((resolve) => { release = resolve; });
    const fetcher: Fetcher = async (url) => {
      const path = new URL(url).pathname;
      if (path === '/v1/feed') return { ok: true, status: 200, json: async () => data.v1.feed };
      if (path === '/v2/feed') { await late; return { ok: true, status: 200, json: async () => V2_FEED }; }
      throw new TypeError('Failed to fetch');
    };
    render(<Providers><V2Part fetcher={fetcher} /></Providers>);
    await tick(500);
    expect(screen.getByTestId('v2').textContent).toBe('loading true, answered false, error null');
    release();
    await until(() => screen.getByTestId('v2').textContent === 'loading false, answered true, error null');
    cleanup();
    render(<Providers><V2Part fetcher={feeds({ v1: data.v1.feed, v2: 'refuse' }).fetcher} /></Providers>);
    await until(() => screen.getByTestId('v2').textContent === 'loading false, answered false, error V2 data unavailable');
  });

  const part = (overrides: Partial<LookupPart>): LookupPart => ({ loading: false, answered: true, error: null, ...overrides });

  it('claimsWaiting: nothing to add without a v2 part or once the feed answered (a failed refresh after an answer too)', () => {
    expect(claimsWaiting(null)).toBeNull();
    expect(claimsWaiting(part({}))).toBeNull();
    expect(claimsWaiting(part({ error: 'V2 data unavailable' }))).toBeNull();
  });

  it('claimsWaiting: "Reading…" while the v2 feed reads (before: "Claims are not built yet.")', () => {
    const claims = claimsWaiting(part({ loading: true, answered: false }));
    expect(claims?.lead).toBe('Reading…');
    render(<>{claims?.ready}{claims?.panel}</>);
    expect(document.body.textContent).toBe('Reading…');
  });

  it('claimsWaiting: the v2 feed never answered: "Not available", "Claims did not load." and Retry, which reads again', async () => {
    const retry = vi.fn();
    const claims = claimsWaiting(part({ answered: false, error: 'V2 data unavailable' }), retry);
    expect(claims?.lead).toBe('Not available');
    render(<><h1 id="page-title" tabIndex={-1}>My Box</h1><dd>{claims?.ready}</dd>{claims?.panel}</>);
    expect(screen.getByText('Claims did not load.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Claims did not load.');
    expect(document.querySelector('dd')?.textContent).toBe('Not available');
    expect(document.body.textContent).not.toMatch(/not built yet/i);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(document.activeElement?.id).toBe('page-title');
  });
});
