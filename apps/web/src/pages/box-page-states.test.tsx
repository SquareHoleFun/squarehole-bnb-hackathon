/**
 * SH-SITE-FIXES-10: a box link while the source's boxes load (ship 9 prep, 2026-10-27: a phone's fresh box link showed
 * "Not in Sepolia testnet" for 100-300 ms, and until a reload when the v2 feed request never answered). On the real
 * BoxPage and useBoxSources, with the core v1 and v2 feeds answered by a fetcher this test holds: core v1's recorded
 * life and a v2 box on the same chain (mixed-deployment.ts). The box pages themselves are doubles (their own tests
 * cover them); every other request fails at once (no network). XR-ITEM-3D-V2: a local build with the existing-NFTs
 * add-on (its factory check this test's, its feed answered by the same fetcher) waits on the add-on's boxes too.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { decodeFunctionData, toHex, type Hex } from 'viem';
import { setFactoryV2Abi } from '@squarehole/chain/core/set-v2';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boxPath, formatBoxId } from '../features/boxes/box-id';
import type { CoreBuild } from '../features/core/core-build';
import type { Fetcher } from '../features/core/core-client';
import { FEED_DEADLINE_MS } from '../features/core/v2/indexer-v2';
import { FEED_RETRY_MS } from '../features/core/v2/useV2';
import { mixedDeployment } from '../features/core/v2/test-support/mixed-deployment';
import { DATA_SOURCE_KEY, DataSourceProvider, resetDataSourceForTests } from '../features/data-source';
import { FACTORY_CHECK_DEADLINE_MS, resetSetChecksForTests, setSourceOf, type FactoryCheck } from '../features/set/set-build';
import { setManifestJson } from '../features/set/test-support/set-chain';
import { BoxFeedPage } from './BoxFeedPage';
import { BoxPage } from './BoxPage';

// The box pages' doubles carry the page heading as the real ones do (PageHeading, BoxHeader: id page-title, tabIndex -1).
vi.mock('../features/core/v2/V2BoxPage', () => ({ V2BoxPage: ({ record }: { record: { name: string } }) => <h1 id="page-title" tabIndex={-1}>{`v2 page · ${record.name}`}</h1> }));
vi.mock('../features/core/RowBoxPage', () => ({ RowBoxPage: ({ record }: { record: { name: string } }) => <h1 id="page-title" tabIndex={-1}>{`v1 page · ${record.name}`}</h1> }));

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(resolve(HERE, '../../e2e/fixtures/core-local/manifest-11155111.json'), 'utf8')) as unknown;
const ORIGIN = 'http://indexer.test';
const BUILD: CoreBuild = { manifests: [MANIFEST], localRpcUrl: 'http://127.0.0.1:8599', indexers: { local: ORIGIN, sepolia: null } };
const data = await mixedDeployment();
const V2_FEED = { ...data.feed, cards: [data.body] };
const BOX = boxPath(formatBoxId(data.manifest.chainId, data.body.token));
const ELSEWHERE = boxPath(formatBoxId(data.manifest.chainId, `0x${'5'.repeat(40)}`));
/**
 * XR-ITEM-3D-V2: the same local build with the existing-NFTs add-on (local builds only), its manifest bound to this
 * core's chain, pool manager and platform Safe; and the add-on's feed answering no box.
 */
const CORE = MANIFEST as { readonly chainId: number; readonly chain: { readonly poolManager: unknown; readonly platformSafe: unknown } };
const WITH_SET: CoreBuild = { ...BUILD, set: { ...setManifestJson(), chainId: CORE.chainId, poolManager: CORE.chain.poolManager, platformSafe: CORE.chain.platformSafe } };
const SET_FEED = { schema: 'sh.core-set-feed.v1', chainId: CORE.chainId, asOf: { block: '1', hash: `0x${'ab'.repeat(32)}`, tier: 'latest' }, boxes: [] };

type Answer = 'hang' | 'refuse' | unknown;
/**
 * The feeds as this test says, each request kept with its path and signal. A request that never answers ends only when
 * its signal aborts (as a browser's fetch does); `inFlight` and `most` count, per path, the requests not ended yet.
 */
function feeds(answers: { v1: Answer; v2: Answer; sets?: Answer }) {
  const asked: { path: string; signal: AbortSignal | null }[] = [];
  const inFlight = new Map<string, number>();
  const most = new Map<string, number>();
  const fetcher: Fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    const signal = init?.signal ?? null;
    asked.push({ path, signal });
    const answer = path === '/v1/feed' ? answers.v1 : path === '/v2/feed' ? answers.v2 : path === '/v2/sets/feed' ? answers.sets : undefined;
    if (answer === 'hang') {
      inFlight.set(path, (inFlight.get(path) ?? 0) + 1);
      most.set(path, Math.max(most.get(path) ?? 0, inFlight.get(path) ?? 0));
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => { inFlight.set(path, (inFlight.get(path) ?? 1) - 1); reject(signal.reason); }, { once: true });
      });
    }
    if (answer === 'refuse' || answer === undefined) throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, json: async () => answer };
  };
  return { fetcher, asked, answers, inFlight: (path: string) => inFlight.get(path) ?? 0, most: (path: string) => most.get(path) ?? 0 };
}

function renderAt(path: string, fetcher: Fetcher, coreBuild: CoreBuild = BUILD) {
  window.localStorage.setItem(DATA_SOURCE_KEY, JSON.stringify({ source: 'local' }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  render(
    <DataSourceProvider build={{ localManifest: null, sepoliaManifest: null, localRpcUrl: 'http://127.0.0.1:8560', coreLocal: true }}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes><Route path="box/:chain/:address" element={<BoxPage build={{ fitMarkets: [], localRpcUrl: '' }} coreBuild={coreBuild} fetcher={fetcher} />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </DataSourceProvider>,
  );
}

const heading = () => screen.getByRole('heading', { level: 1 }).textContent;
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

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

describe('SH-SITE-FIXES-10 a box link while its sources load', () => {
  it('core v1 answered, v2 not yet: "Reading the box…", never "Not in …"; then the box', async () => {
    let release: (value: unknown) => void = () => undefined;
    const v2 = new Promise((resolve) => { release = resolve; });
    const fetcher: Fetcher = async (url) => {
      const path = new URL(url).pathname;
      if (path === '/v1/feed') return { ok: true, status: 200, json: async () => data.v1.feed };
      if (path === '/v2/feed') { await v2; return { ok: true, status: 200, json: async () => V2_FEED }; }
      throw new TypeError('Failed to fetch');
    };
    renderAt(BOX, fetcher);
    await tick(500);
    expect(heading()).toBe('Reading the box…');
    expect(document.body.textContent).not.toMatch(/Not in |Box not found/);
    release(null);
    await tick(10);
    expect(heading()).toMatch(/^v2 page · /);
  });

  it('v2 answered with the box while core v1 still loads: the box at once', async () => {
    const { fetcher } = feeds({ v1: 'hang', v2: V2_FEED });
    renderAt(BOX, fetcher);
    await tick(10);
    expect(heading()).toMatch(/^v2 page · /);
  });

  it('a v2 feed request never answered: aborted at the deadline, asked again a second later; then Unavailable with Retry, never "Not in …"', async () => {
    const f = feeds({ v1: data.v1.feed, v2: 'hang' });
    renderAt(BOX, f.fetcher);
    await tick(FEED_DEADLINE_MS - 1);
    expect(heading()).toBe('Reading the box…');
    const first = f.asked.filter((a) => a.path === '/v2/feed');
    expect(first).toHaveLength(1);
    expect(first[0]?.signal?.aborted).toBe(false);
    await tick(1);
    expect(first[0]?.signal?.aborted).toBe(true);
    expect(heading()).toBe('Reading the box…');
    await tick(FEED_RETRY_MS);
    expect(f.asked.filter((a) => a.path === '/v2/feed')).toHaveLength(2);
    expect(heading()).toBe('Reading the box…');
    await tick(FEED_DEADLINE_MS);
    expect(heading()).toBe('Unavailable');
    expect(screen.getByRole('status').textContent).toBe('The box could not be read.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    // The reason is a detail, behind Details, never open by default.
    const details = screen.getByText('Details').closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('V2 data unavailable');
    expect(document.body.textContent).not.toMatch(/Not in |Box not found/);
  });

  it('Retry reads the feed again (the page reads while it waits) and shows the box once it answers', async () => {
    const f = feeds({ v1: data.v1.feed, v2: 'refuse' });
    renderAt(BOX, f.fetcher);
    await tick(10);
    expect(heading()).toBe('Reading the box…');
    await tick(FEED_RETRY_MS);
    expect(heading()).toBe('Unavailable');
    const before = f.asked.filter((a) => a.path === '/v2/feed').length;
    expect(before).toBe(2);
    f.answers.v2 = V2_FEED;
    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus();
    await act(async () => { fireEvent.click(retry); });
    // The pressed button is gone with the content it was in: focus is on the new heading, so it is announced.
    expect(heading()).toBe('Reading the box…');
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    await tick(10);
    expect(f.asked.filter((a) => a.path === '/v2/feed').length).toBeGreaterThan(before);
    expect(heading()).toMatch(/^v2 page · /);
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  });

  it('Unavailable recovers by itself when a later poll answers', async () => {
    const f = feeds({ v1: data.v1.feed, v2: 'refuse' });
    renderAt(BOX, f.fetcher);
    await tick(FEED_RETRY_MS + 10);
    expect(heading()).toBe('Unavailable');
    f.answers.v2 = V2_FEED;
    await tick(4_000);
    expect(heading()).toMatch(/^v2 page · /);
  });

  it('a link that is no box address says so at once, even while a feed never answers', async () => {
    const { fetcher } = feeds({ v1: 'hang', v2: 'hang' });
    renderAt('/box/sepolia/not-an-address', fetcher);
    await tick(10);
    expect(heading()).toBe('Not a box address');
  });

  it('both feeds answered and the box is in neither: "Not in …" (not found), and only then', async () => {
    const { fetcher } = feeds({ v1: data.v1.feed, v2: V2_FEED });
    renderAt(ELSEWHERE, fetcher);
    await tick(10);
    expect(heading()).toMatch(/^Not in /);
  });

  it('box 0 (core v1) while the v1 feed request never answers and the chain cannot be read: unavailable after the deadline, never "Not in …"', async () => {
    const { fetcher } = feeds({ v1: 'hang', v2: V2_FEED });
    renderAt(boxPath(formatBoxId(data.manifest.chainId, data.v1Token)), fetcher);
    await tick(10);
    expect(heading()).toBe('Reading the box…');
    await tick(FEED_DEADLINE_MS + 30_000);
    expect(heading()).toBe('Unavailable');
    expect(document.body.textContent).not.toMatch(/Not in |Box not found/);
  });
});

describe('XR-ITEM-3D-V2 a box link in a local build with the existing-NFTs add-on', () => {
  const setFeedAsks = (asked: readonly { path: string; signal: AbortSignal | null }[]) => asked.filter((a) => a.path === '/v2/sets/feed');

  it('F1: both core feeds answered, the add-on’s feed request never answered: aborted at the deadline, asked again a second later; then Unavailable with Retry, never "Not in …"', async () => {
    resetSetChecksForTests(async () => undefined);
    const f = feeds({ v1: data.v1.feed, v2: V2_FEED, sets: 'hang' });
    renderAt(ELSEWHERE, f.fetcher, WITH_SET);
    await tick(10);
    expect(heading()).toBe('Reading the box…');
    expect(f.asked.filter((a) => a.path === '/v1/feed' || a.path === '/v2/feed').length).toBeGreaterThanOrEqual(2);
    expect(setFeedAsks(f.asked)).toHaveLength(1);
    await tick(FEED_DEADLINE_MS - 20);
    expect(setFeedAsks(f.asked)[0]?.signal?.aborted).toBe(false);
    expect(heading()).toBe('Reading the box…');
    await tick(20);
    expect(setFeedAsks(f.asked)[0]?.signal?.aborted).toBe(true);
    expect(heading()).toBe('Reading the box…');
    await tick(FEED_RETRY_MS);
    expect(setFeedAsks(f.asked)).toHaveLength(2);
    expect(heading()).toBe('Reading the box…');
    await tick(FEED_DEADLINE_MS);
    expect(setFeedAsks(f.asked)[1]?.signal?.aborted).toBe(true);
    expect(heading()).toBe('Unavailable');
    expect(screen.getByRole('status').textContent).toBe('The box could not be read.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    const details = screen.getByText('Details').closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('The add-on’s boxes could not be read.');
    expect(document.body.textContent).not.toMatch(/Not in |Box not found/);
  });

  it('F2: the add-on’s factory cannot be checked (an RPC timeout): Unavailable with Retry, never "Not in …"; Retry checks the factory again, then reads the add-on’s feed', async () => {
    const checker = vi.fn<FactoryCheck>(async () => { throw new Error('The request took too long to respond.'); });
    resetSetChecksForTests(checker);
    const f = feeds({ v1: data.v1.feed, v2: V2_FEED, sets: SET_FEED });
    renderAt(ELSEWHERE, f.fetcher, WITH_SET);
    await tick(10);
    expect(checker).toHaveBeenCalledTimes(1);
    expect(heading()).toBe('Unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect((screen.getByText('Details').closest('details') as HTMLDetailsElement).textContent).toContain('The add-on’s boxes could not be read.');
    expect(document.body.textContent).not.toMatch(/Not in |Box not found/);
    // Its boxes were never read: nothing was asked of the add-on's feed.
    expect(setFeedAsks(f.asked)).toHaveLength(0);
    // The RPC answers again; Retry checks the factory at once (not 30 s later) and reads while it does.
    let pass: () => void = () => undefined;
    checker.mockImplementation(() => new Promise<void>((resolve) => { pass = resolve; }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(checker).toHaveBeenCalledTimes(2);
    expect(heading()).toBe('Reading the box…');
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    await act(async () => { pass(); });
    await tick(10);
    expect(setFeedAsks(f.asked)).toHaveLength(1);
    expect(heading()).toMatch(/^Not in /);
  });

  it('XR2 F1: the real factory check, its pin reads answered with a body that never ends: "Reading the box…" until the check’s deadline, then Unavailable with Retry, never "Not in …"', async () => {
    const resolved = setSourceOf('local', WITH_SET);
    if (resolved.status !== 'ready') throw new Error(resolved.reason);
    const factory = resolved.source.release.factory.address.toLowerCase();
    const pinReads: AbortSignal[] = [];
    // The source's RPC as the real check (rpcFactoryCheck) reads it; every other chain read fails at once, as above.
    vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? 'null')) as { id: number; method: string; params?: readonly { to?: string; data?: Hex }[] } | null;
      const json = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body?.id, result }), { headers: { 'content-type': 'application/json' } });
      if (body?.method === 'eth_chainId') return json(toHex(resolved.source.chainId));
      if (body?.method === 'eth_blockNumber') return json('0x10');
      const call = body?.method === 'eth_call' ? body.params?.[0] : undefined;
      if (call?.to?.toLowerCase() === factory && init?.signal) {
        const signal = init.signal;
        pinReads.push(signal);
        decodeFunctionData({ abi: setFactoryV2Abi, data: call.data as Hex });
        return new Response(new ReadableStream({ start(stream) { signal.addEventListener('abort', () => stream.error(signal.reason), { once: true }); } }), { headers: { 'content-type': 'application/json' } });
      }
      throw new TypeError('no network in this test');
    });
    resetSetChecksForTests();
    const f = feeds({ v1: data.v1.feed, v2: V2_FEED, sets: SET_FEED });
    renderAt(ELSEWHERE, f.fetcher, WITH_SET);
    await tick(10);
    expect(heading()).toBe('Reading the box…');
    expect(pinReads).toHaveLength(3);
    await tick(FACTORY_CHECK_DEADLINE_MS - 20);
    expect(heading()).toBe('Reading the box…');
    await tick(20);
    expect(heading()).toBe('Unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(pinReads.every((signal) => signal.aborted)).toBe(true);
    expect(setFeedAsks(f.asked)).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/Not in |Box not found/);
  });

  it('the add-on’s feed answered without the box (as both core feeds did): "Not in …", and only then', async () => {
    resetSetChecksForTests(async () => undefined);
    const f = feeds({ v1: data.v1.feed, v2: V2_FEED, sets: SET_FEED });
    renderAt(ELSEWHERE, f.fetcher, WITH_SET);
    await tick(10);
    expect(setFeedAsks(f.asked)).toHaveLength(1);
    expect(heading()).toMatch(/^Not in /);
  });
});

describe('XR2-ITEM-3D-V2 F2: Unavailable and its Retry stay while the polls go on, until an answer or Retry', () => {
  const v2Asks = (f: ReturnType<typeof feeds>) => f.asked.filter((a) => a.path === '/v2/feed');
  /** The heading every 250 ms for `ms`: each change, with the second it was seen at. */
  async function headings(ms: number): Promise<string[]> {
    const seen: string[] = [];
    let last = heading();
    for (let t = 250; t <= ms; t += 250) {
      await tick(250);
      const now = heading();
      if (now !== last) seen.push(`${t / 1000} s: ${now}`);
      last = now;
    }
    return seen;
  }

  it('v2 never answers: Unavailable from 17 s through four more poll cycles (84 s), Retry focused and Details open the whole time, one request at a time; the box once a poll answers', async () => {
    const f = feeds({ v1: data.v1.feed, v2: 'hang' });
    renderAt(BOX, f.fetcher);
    await tick(FEED_DEADLINE_MS + FEED_RETRY_MS + FEED_DEADLINE_MS + 10);
    expect(heading()).toBe('Unavailable');
    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus();
    const details = screen.getByText('Details').closest('details') as HTMLDetailsElement;
    details.open = true;
    const asked = v2Asks(f).length;
    expect(await headings(84_000)).toEqual([]);
    // The same button, still focused, and the same Details, still open: nothing was replaced.
    expect(screen.getByRole('button', { name: 'Retry' })).toBe(retry);
    expect(document.activeElement).toBe(retry);
    expect(screen.getByText('Details').closest('details')).toBe(details);
    expect(details.open).toBe(true);
    expect(details.textContent).toContain('V2 data unavailable');
    // The polls went on (each a read and its retry), never two requests at once.
    expect(v2Asks(f).length).toBeGreaterThanOrEqual(asked + 8);
    expect(f.most('/v2/feed')).toBe(1);
    f.answers.v2 = V2_FEED;
    await tick(FEED_DEADLINE_MS + FEED_RETRY_MS + 4_000 + 10);
    expect(heading()).toMatch(/^v2 page · /);
  });

  it('Retry while a poll is reading joins that read (no second request): "Reading the box…" until it ends, then Unavailable again; never two requests at once', async () => {
    const f = feeds({ v1: data.v1.feed, v2: 'hang' });
    renderAt(BOX, f.fetcher);
    await tick(FEED_DEADLINE_MS + FEED_RETRY_MS + FEED_DEADLINE_MS + 10);
    expect(heading()).toBe('Unavailable');
    // The next poll starts 4 s after the failure; a second later it is still reading, and the page still says Unavailable.
    await tick(5_000);
    expect(f.inFlight('/v2/feed')).toBe(1);
    expect(heading()).toBe('Unavailable');
    const before = v2Asks(f).length;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(heading()).toBe('Reading the box…');
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    expect(v2Asks(f)).toHaveLength(before);
    expect(f.inFlight('/v2/feed')).toBe(1);
    // That read ends at its deadline, its retry a second later at its own: then Unavailable, with Retry, again.
    await tick(FEED_DEADLINE_MS - 1_000 - 20);
    expect(heading()).toBe('Reading the box…');
    await tick(FEED_RETRY_MS + FEED_DEADLINE_MS + 40);
    expect(heading()).toBe('Unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(v2Asks(f)).toHaveLength(before + 1);
    expect(f.most('/v2/feed')).toBe(1);
  });

  it('v2 refused at once: Unavailable through six poll cycles, Retry focused, no "Reading the box…" between them; the box once a poll answers', async () => {
    const f = feeds({ v1: data.v1.feed, v2: 'refuse' });
    renderAt(BOX, f.fetcher);
    await tick(FEED_RETRY_MS + 10);
    expect(heading()).toBe('Unavailable');
    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus();
    const asked = v2Asks(f).length;
    expect(await headings(30_000)).toEqual([]);
    expect(document.activeElement).toBe(retry);
    expect(v2Asks(f).length).toBeGreaterThanOrEqual(asked + 10);
    f.answers.v2 = V2_FEED;
    await tick(5_010);
    expect(heading()).toMatch(/^v2 page · /);
  });

  it('core v1 (box 0) refused and the chain unreadable: Unavailable through several of its polls with the same reason; box 0 once the v1 feed answers', async () => {
    const f = feeds({ v1: 'refuse', v2: V2_FEED });
    renderAt(boxPath(formatBoxId(data.manifest.chainId, data.v1Token)), f.fetcher);
    let waited = 0;
    while (heading() !== 'Unavailable' && waited < 60_000) { await tick(250); waited += 250; }
    expect(heading()).toBe('Unavailable');
    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus();
    const details = screen.getByText('Details').closest('details') as HTMLDetailsElement;
    const reason = details.textContent;
    expect(reason).not.toBe('Details');
    const asked = f.asked.filter((a) => a.path === '/v1/feed').length;
    expect(await headings(36_000)).toEqual([]);
    expect(document.activeElement).toBe(retry);
    expect(screen.getByText('Details').closest('details')).toBe(details);
    expect(details.textContent).toBe(reason);
    expect(f.asked.filter((a) => a.path === '/v1/feed').length).toBeGreaterThanOrEqual(asked + 3);
    f.answers.v1 = data.v1.feed;
    waited = 0;
    while (!/^v1 page · /.test(heading() ?? '') && waited < 60_000) { await tick(250); waited += 250; }
    expect(heading()).toMatch(/^v1 page · /);
  });

  it('the feed page, core v1 and v2 refused and the chain unreadable: "The boxes did not load." through several polls, never "Reading the boxes…" between them; the boxes once both answer', async () => {
    const f = feeds({ v1: 'refuse', v2: 'refuse' });
    window.localStorage.setItem(DATA_SOURCE_KEY, JSON.stringify({ source: 'local' }));
    render(
      <DataSourceProvider build={{ localManifest: null, sepoliaManifest: null, localRpcUrl: 'http://127.0.0.1:8560', coreLocal: true }}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })}>
          <MemoryRouter><BoxFeedPage build={{ fitMarkets: [], localRpcUrl: '' }} coreBuild={BUILD} fetcher={f.fetcher} /></MemoryRouter>
        </QueryClientProvider>
      </DataSourceProvider>,
    );
    const line = () => document.querySelector('.sh-box-empty p')?.textContent ?? 'boxes listed';
    let waited = 0;
    while (line() !== 'The boxes did not load.' && waited < 60_000) { await tick(250); waited += 250; }
    expect(line()).toBe('The boxes did not load.');
    const seen: string[] = [];
    for (let t = 250; t <= 36_000; t += 250) {
      await tick(250);
      if (line() !== 'The boxes did not load.') seen.push(`${t / 1000} s: ${line()}`);
    }
    expect(seen).toEqual([]);
    f.answers.v1 = data.v1.feed;
    f.answers.v2 = V2_FEED;
    waited = 0;
    while (line() !== 'boxes listed' && waited < 60_000) { await tick(250); waited += 250; }
    expect(line()).toBe('boxes listed');
  });

  it('the add-on’s feed refused (a local build with the add-on): Unavailable through several of its polls; "Not in …" once it answers without the box', async () => {
    resetSetChecksForTests(async () => undefined);
    const f = feeds({ v1: data.v1.feed, v2: V2_FEED, sets: 'refuse' });
    renderAt(ELSEWHERE, f.fetcher, WITH_SET);
    await tick(FEED_RETRY_MS + 10);
    expect(heading()).toBe('Unavailable');
    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus();
    const asked = f.asked.filter((a) => a.path === '/v2/sets/feed').length;
    expect(await headings(30_000)).toEqual([]);
    expect(document.activeElement).toBe(retry);
    expect(f.asked.filter((a) => a.path === '/v2/sets/feed').length).toBeGreaterThanOrEqual(asked + 6);
    f.answers.sets = SET_FEED;
    await tick(7_010);
    expect(heading()).toMatch(/^Not in /);
  });
});
