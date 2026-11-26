/**
 * SH-EXISTING-NFTS-E08C: where the add-on joins the site. Its entry on Basics and its boxes in the feed show only
 * where the add-on is (the local source of a build naming its manifest, the factory checked); everywhere else the
 * site is exactly as before. The feed takes its boxes from one indexer answer, each with its own card summary.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { synthManifestV2Json } from '../../../../../packages/chain/src/core/v2/test-support/synth-v2';
import type { BoxSources } from '../boxes/box-sources';
import { withSetBoxes } from '../boxes/useBoxSources';
import type { CoreBuild } from '../core/core-build';
import { SetEntryTile } from '../create/set/SetEntryTile';
import { DATA_SOURCE_KEY, DataSourceProvider, resetDataSourceForTests, type DataSourceBuild } from '../data-source';
import { resetSetChecksForTests } from './set-build';
import { SET_ROUTES } from './set-indexer';
import { setRecord, setSummary } from './set-model';
import { FakeSetChain, asOfOf, setManifestJson, sparseIds, specFor, wireOf } from './test-support/set-chain';
import { useSetFeed } from './useSetFeed';
import { setBoxDataSchema } from '@squarehole/chain/core/set-v2';

const LOCAL: DataSourceBuild = { localManifest: null, sepoliaManifest: null, localRpcUrl: 'http://127.0.0.1:8599', coreLocal: true };
const build = (set: unknown): CoreBuild => ({ manifests: [synthManifestV2Json()], localRpcUrl: 'http://127.0.0.1:8599', indexers: { local: 'http://127.0.0.1:8597', sepolia: null }, artGateways: { local: [], sepolia: [] }, set });

afterEach(() => {
  cleanup();
  resetSetChecksForTests();
  window.localStorage.clear();
  resetDataSourceForTests();
});

function onLocal(node: React.ReactNode) {
  window.localStorage.setItem(DATA_SOURCE_KEY, JSON.stringify({ source: 'local' }));
  return render(<DataSourceProvider build={LOCAL}><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider></DataSourceProvider>);
}

describe('the add-on in the site', () => {
  it('the entry on Basics shows only once the factory checked out, and opens the add-on’s own flow', async () => {
    resetSetChecksForTests(async () => undefined);
    onLocal(<SetEntryTile build={build(setManifestJson())} />);
    const link = await screen.findByRole('link', { name: /Existing NFTs/ });
    expect(link.getAttribute('href')).toBe('/create/set-basics');
    expect(link.textContent).toContain('Your NFTs · one collection');
    cleanup();
    resetSetChecksForTests(async () => { throw new Error('factory RELEASE mismatch'); });
    onLocal(<SetEntryTile build={build(setManifestJson())} />);
    await act(async () => undefined);
    expect(screen.queryByRole('link')).toBeNull();
    cleanup();
    onLocal(<SetEntryTile build={build(null)} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('SH-SITE-FIXES-10: while the factory is checked the add-on’s boxes are loading (a box link waits), never none', async () => {
    let finish: () => void = () => undefined;
    resetSetChecksForTests(() => new Promise<void>((resolve) => { finish = resolve; }));
    const asked: string[] = [];
    const fetcher = async (url: string) => { asked.push(url); return { ok: false, status: 404, json: async () => null }; };
    function Probe() {
      const feed = useSetFeed(build(setManifestJson()), fetcher);
      return <p>{feed === null ? 'none' : `loading ${feed.loading}, answered ${feed.answered}, error ${feed.error}`}</p>;
    }
    onLocal(<Probe />);
    expect(await screen.findByText('loading true, answered false, error null')).toBeTruthy();
    expect(asked).toEqual([]);
    await act(async () => { finish(); });
    // The factory checked out; its feed then answers (here a 404: failed, asked once more a second later as the core
    // feeds are (XR-ITEM-3D-V2 F1), with nothing kept).
    expect(await screen.findByText('loading false, answered false, error The add-on’s boxes could not be read.', undefined, { timeout: 3_000 })).toBeTruthy();
    expect(asked).toHaveLength(2);
  });

  it('XR-ITEM-3D-V2 F2: a factory check that cannot be read (an RPC timeout) leaves the add-on unread, with its error, never none; its feed is not asked', async () => {
    resetSetChecksForTests(async () => { throw new Error('The request took too long to respond.'); });
    const asked: string[] = [];
    const fetcher = async (url: string) => { asked.push(url); return { ok: true, status: 200, json: async () => null }; };
    function Probe({ set }: { set: unknown }) {
      const feed = useSetFeed(build(set), fetcher);
      return <p>{feed === null ? 'none' : `loading ${feed.loading}, answered ${feed.answered}, error ${feed.error}`}</p>;
    }
    onLocal(<Probe set={setManifestJson()} />);
    expect(await screen.findByText('loading false, answered false, error The add-on’s boxes could not be read.')).toBeTruthy();
    expect(asked).toEqual([]);
    cleanup();
    // Only a source without the add-on is none.
    onLocal(<Probe set={null} />);
    expect(screen.getByText('none')).toBeTruthy();
  });

  it('the feed reads the add-on’s boxes from one answer, each with its own summary', async () => {
    const ids = sparseIds(20);
    const chain = new FakeSetChain({ ids });
    chain.seed(specFor(chain, ids), ids, { loaded: 8 });
    resetSetChecksForTests(async () => undefined);
    const answers: Record<string, unknown> = { [SET_ROUTES.feed(chain.chainIdValue)]: { schema: 'sh.core-set-feed.v1', chainId: chain.chainIdValue, asOf: asOfOf(chain), boxes: [wireOf(chain)] } };
    const fetcher = async (url: string) => {
      const body = answers[url.replace('http://127.0.0.1:8597', '')];
      return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
    };
    function Probe() {
      const feed = useSetFeed(build(setManifestJson()), fetcher);
      return <p>{feed === null ? 'none' : feed.summaries.map((s) => `${s.record.ticker}: ${s.figure.text}`).join(', ') || 'empty'}</p>;
    }
    onLocal(<Probe />);
    expect(await screen.findByText('OUT: Loading 8/20')).toBeTruthy();
  });

  it('a card is Open only once the trading gate read on chain says so; all items in without complete is Loading N/N (XR F1)', async () => {
    const ids = sparseIds(12);
    const chain = new FakeSetChain({ ids });
    chain.seed(specFor(chain, ids), ids, {});
    chain.seed(specFor(chain, ids, { tokenSymbol: 'WAIT' }), ids, { complete: false });
    resetSetChecksForTests(async () => undefined);
    const answers: Record<string, unknown> = { [SET_ROUTES.feed(chain.chainIdValue)]: { schema: 'sh.core-set-feed.v1', chainId: chain.chainIdValue, asOf: asOfOf(chain), boxes: chain.boxes.map((box) => wireOf(chain, box)) } };
    const fetcher = async (url: string) => {
      const body = answers[url.replace('http://127.0.0.1:8597', '')];
      return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
    };
    function Probe() {
      const feed = useSetFeed(build(setManifestJson()), fetcher, chain);
      return <p>{feed === null ? 'none' : feed.summaries.map((s) => `${s.record.ticker}: ${s.figure.text}`).join(', ') || 'empty'}</p>;
    }
    onLocal(<Probe />);
    expect(await screen.findByText('OUT: Raise 4.206980085 ETH, WAIT: Loading 12/12')).toBeTruthy();
  });

  it('joins the feed after the other boxes, never while box 0’s feed loads, never twice', () => {
    const ids = sparseIds(12);
    const chain = new FakeSetChain({ ids });
    chain.seed(specFor(chain, ids), ids, {});
    const row = setBoxDataSchema.parse(wireOf(chain));
    const record = setRecord(row, chain.source, asOfOf(chain));
    const sets = { records: [record], summaries: [setSummary(record, row, false, { open: true })], error: null, loading: false };
    const base: BoxSources = { boxes: [], launch: null, missing: 'none here', core: { status: 'none', reason: 'No core deployment.' } };
    const joined = withSetBoxes(base, sets);
    expect(joined.boxes.map((b) => b.id)).toEqual([record.id]);
    expect(joined.core.status === 'ready' && joined.core.summaries.get(record.id)?.figure.text).toBe('Raise 4.206980085 ETH');
    expect(withSetBoxes(joined, sets)).toBe(joined);
    const loading: BoxSources = { ...base, core: { status: 'loading' } };
    expect(withSetBoxes(loading, sets)).toBe(loading);
    expect(withSetBoxes(base, null)).toBe(base);
    expect(withSetBoxes(base, { ...sets, records: [] })).toBe(base);
  });
});
