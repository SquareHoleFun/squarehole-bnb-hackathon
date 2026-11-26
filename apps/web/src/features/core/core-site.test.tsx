/**
 * The site on core v1 (S10a § 5, § 6), on the gateway answers recorded from box 0's life on a local chain
 * (e2e/fixtures/core-local/life.json, packages/indexer/scripts/record-core-fixture.ts):
 * - BC-086: a box known only from its row: Q, decimals, order, deadline and template from the row (every Q class);
 * - BC-084 / BC-090 / BC-091 / BC-095: box 0's page in each phase (band, phase line, stats, cards), no deadline for box 0,
 *   a deadline line for a box that has one, safe wording, the Misfits pack by row (a look-alike named "The Misfits" gets
 *   none), the spec's placeholder SVG never inlined;
 * - BC-085 / BC-094: 2 and 50 cards from ONE feed request, each with its own state and figure; Stale and Unverified only
 *   on those boxes, with no FDV on the Unverified one;
 * - BC-089: a wallet across 5 boxes, two with the same ticker, grouped by box address, nothing summed.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boxRowFromJson, boxRowFromRecord, boxRowToJson, type BoxRowJson } from '@squarehole/chain';
import { specWithQ, syntheticBox, TEST_Q, testQList, type TestQName } from '@squarehole/chain/core/test-support';
import { BOX_0_MISFITS } from '@squarehole/box-spec';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { shLimit } from '../../../../../vitest.timeouts.mjs';
import { feeSummary, type CoreBoxView } from '@squarehole/indexer/client';
import { BoxFeedPage, feedSummaries } from '../../pages/BoxFeedPage';
import { BoxPage } from '../../pages/BoxPage';
import { collectionContract } from '../boxes/collection-contract';
import { rowSummary, staleByClock } from './row-summary';
import { loaded } from './useCore';
import { withCoreRows, boxesFor, misfitsPackFor, type CoreSourcesState } from '../boxes/box-sources';
import { coreWalletBox } from '../boxes/wallet-box';
import { WalletBoxView } from '../boxes/WalletBoxView';
import { chainShort } from '../boxes/BoxParts';
import { TAX_RANGE } from '../boxes/box-stats';
import { MISFITS_TAGLINE } from '../boxes/misfits-content';
import { DATA_SOURCE_KEY, DataSourceProvider, resetDataSourceForTests } from '../data-source';
import { appCopyFraming, renderedCopy } from '../legal/wording';
import type { CoreBuild } from './core-build';
import { CHAIN_READER, loadBox, loadFeed, loadWallet, parseOptionsOf, type DirectReader, type Fetcher, type ReadyCore } from './core-client';
import { coreSourceFor } from './core-build';
import { recordFromRow } from './row-record';
import { RowBoxPage } from './RowBoxPage';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../e2e/fixtures/core-local');
interface Stage {
  block: string;
  feed: { cards: { row: BoxRowJson }[] } & Record<string, unknown>;
  box: Record<string, unknown> & { row: BoxRowJson };
  activity: unknown;
  candles: unknown;
  wallets: Record<string, unknown>;
}
const LIFE = JSON.parse(readFileSync(resolve(FIXTURES, 'life.json'), 'utf8')) as { token: string; stages: Record<string, Stage>; accounts: Record<string, `0x${string}`> };
const MANIFEST = JSON.parse(readFileSync(resolve(FIXTURES, 'manifest-11155111.json'), 'utf8')) as { versions: { registry: { address: `0x${string}` } }[] };
const REGISTRY = MANIFEST.versions[0]?.registry.address as `0x${string}`;
const ORIGIN = 'http://indexer.test';
const BUILD: CoreBuild = { manifests: [MANIFEST], localRpcUrl: 'http://127.0.0.1:8599', indexers: { local: ORIGIN, sepolia: null } };
const CORE = coreSourceFor('local', BUILD, '') as ReadyCore;
const stage = (name: string): Stage => {
  const s = LIFE.stages[name];
  if (!s) throw new Error(`no stage ${name}`);
  return s;
};

function fetcherOf(answers: (path: string) => unknown, seen: string[] = []): Fetcher {
  return async (url) => {
    const path = url.replace(ORIGIN, '');
    seen.push(path);
    const body = answers(path);
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
  };
}

function stageFetcher(s: Stage, seen: string[] = []): Fetcher {
  return fetcherOf((path) => {
    if (path.startsWith('/v1/feed')) return s.feed;
    if (path.includes('/activity')) return s.activity;
    if (path.includes('/candles')) return s.candles;
    if (path.startsWith('/v1/wallets/')) return Object.values(s.wallets)[0];
    if (path.startsWith('/v1/boxes/')) return s.box;
    return undefined;
  }, seen);
}

function Providers({ children, path = '/', client = new QueryClient({ defaultOptions: { queries: { retry: false } } }) }: { children: ReactNode; path?: string; client?: QueryClient }) {
  window.localStorage.setItem(DATA_SOURCE_KEY, JSON.stringify({ source: 'local' }));
  return (
    <DataSourceProvider build={{ localManifest: null, sepoliaManifest: null, localRpcUrl: 'http://127.0.0.1:8560', coreLocal: true }}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </QueryClientProvider>
    </DataSourceProvider>
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetDataSourceForTests();
});

const rowOf = (json: BoxRowJson) => boxRowFromJson(json, { box0Registry: REGISTRY });

async function renderBox(name: string, json: BoxRowJson = stage(name).box.row, s: Stage = stage(name)) {
  const record = recordFromRow({ row: rowOf(json), network: 'local' }, { nowMs: 0 });
  render(
    <Providers>
      <RowBoxPage record={record} coreBuild={BUILD} fetcher={stageFetcher(s)} />
    </Providers>,
  );
  await screen.findByText((_, el) => el?.classList.contains('sh-box-band__label') === true && (el.textContent ?? '') !== '');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const header = () => document.querySelector('header.sh-box-head') as HTMLElement;
const bandLabel = () => header().querySelector('.sh-box-band__label')?.textContent;
const bandFigure = () => header().querySelector('.sh-box-band__figure')?.textContent?.replace(/^: /, '');
const phaseLine = () => header().querySelector('.sh-box-phase')?.textContent ?? null;

describe('BC-086: a box known only from its row', () => {
  it('INT-FIX5: the combined browser deployment makes the v1 reader ready', () => {
    expect(CORE).toMatchObject({ status: 'ready', rpcUrl: BUILD.localRpcUrl });
  });
  for (const q of Object.keys(TEST_Q) as TestQName[]) {
    it(`BC-086 ${q}: the pair asset, its decimals and the token order from the row`, () => {
      const box = syntheticBox({ spec: specWithQ(TEST_Q[q].token) });
      const row = boxRowFromRecord(box.record, box.encodedSpec, { chainId: 11_155_111, registry: REGISTRY, box0Registry: REGISTRY, qList: testQList(), qSymbols: { [TEST_Q.ERC20_6.token.toLowerCase()]: 'USDC' } });
      const record = recordFromRow({ row, network: 'sepolia' }, { nowMs: 0 });
      expect(record.pairDecimals).toBe(TEST_Q[q].decimals);
      expect(record.pairAsset).toBe(q === 'NATIVE_ETH' ? 'ETH' : q === 'ERC20_6' ? 'USDC' : 'Q');
      expect(record.row?.row.tIsCurrency0).toBe(row.tIsCurrency0);
      expect(record.row?.row.templateId).toBe(box.record.templateId);
      expect(record.spec?.deadlineDays).toBe(BOX_0_MISFITS.deadlineDays);
    });
  }

  it('BC-095: box 0 by registry and id: Genesis, Featured, the F77 setup, the Misfits pack; a look-alike named "The Misfits" has none of them', () => {
    const box0 = recordFromRow({ row: rowOf(stage('upcoming').box.row), network: 'local' }, { nowMs: 0 });
    expect([box0.kind, box0.featured, box0.name, box0.ticker, box0.itemCount]).toEqual(['genesis', true, 'The Misfits', 'FIT', 4269n]);
    expect(box0.setup).toMatch(/^Pool fee 1%: 11\/15 burns FIT/);
    const lookAlike = { ...stage('upcoming').box.row, record: { ...stage('upcoming').box.row.record, boxId: '7' } };
    const other = recordFromRow({ row: rowOf(lookAlike), network: 'local' }, { nowMs: 0 });
    expect([other.kind, other.featured, other.name]).toEqual(['new', false, 'The Misfits']);
    // The chain chip by source: the same row on Sepolia says Sepolia, on the local twin a local chain.
    expect(chainShort(box0)).toBe('Local chain');
    expect(chainShort(recordFromRow({ row: rowOf(stage('upcoming').box.row), network: 'sepolia' }, { nowMs: 0 }))).toBe('Sepolia');
    // The Misfits pack by box 0's row (its registry and id, so its collection), never by the name.
    expect(misfitsPackFor(box0)).toBe(true);
    expect(misfitsPackFor(other)).toBe(false);
  });
});

describe('BC-084 / BC-090 / BC-091 / BC-095: box 0’s page in every phase', () => {
  const PHASES: { stage: string; label: string; figure: RegExp; phase: RegExp | string | null }[] = [
    { stage: 'upcoming', label: 'Upcoming', figure: /^in (~\d+ (min|h)|<1 min)$/, phase: TAX_RANGE },
    { stage: 'window', label: 'Launch window', figure: /^tax \d+\.\d\d% · (~\d+ min|<1 min) left$/, phase: /^Launch tax \d+\.\d\d% on buys$/ },
    { stage: 'bonding', label: 'Bonding', figure: /^\d+\.\d% · [\d.]+ \/ 4\.206980085 ETH$/, phase: null },
    { stage: 'closed', label: 'Graduating', figure: /^filled · graduating$/, phase: 'Filled: waiting for anyone’s graduate()' },
    { stage: 'stream', label: 'Graduated', figure: /^[\d.]+ ETH per 1M FIT$/, phase: /^Graduated at block [\d,]+$/ },
  ];
  for (const p of PHASES) {
    it(`BC-084, BC-090, BC-091, BC-095 ${p.stage}: band, phase line (no deadline for box 0), stats and cards from the snapshot`, async () => {
      await renderBox(p.stage);
      expect(bandLabel()).toBe(p.label);
      expect(bandFigure()).toMatch(p.figure);
      if (p.phase === null) expect(phaseLine()).toBeNull();
      else if (typeof p.phase === 'string') expect(phaseLine()).toBe(p.phase);
      else expect(phaseLine()).toMatch(p.phase);
      expect(header().textContent).not.toMatch(/deadline|Ends \d+ d/i);
      expect([...header().querySelectorAll('.sh-box-stat dt')].map((dt) => dt.textContent)).toEqual(['Price', 'FDV', 'Burned', 'Items']);
      // The Misfits pack by row: the tagline (BC-095).
      expect(header().textContent).toContain(MISFITS_TAGLINE);
      // The local twin carries Sepolia's chain id, but the chip names the source: never "Sepolia" here.
      expect(header().querySelector('.sh-box-chain__short')?.textContent).toBe('Local chain');
      // Safe wording everywhere (BC-091) and nothing to trade with.
      expect(appCopyFraming(renderedCopy(document.body))).toEqual([]);
      expect(screen.queryAllByRole('button', { name: /\b(buy|sell|swap)\b/i })).toHaveLength(0);
      expect(document.querySelectorAll('input:not([type="search"]), textarea, iframe')).toHaveLength(0);
      // The spec's placeholder SVG is never inlined (images only through <img>).
      expect(document.body.innerHTML).not.toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"');
    });
  }

  it('BC-142: the Token tab: F77 fees with live totals, the pool row from the chain, the stream and the draws', async () => {
    const record = recordFromRow({ row: rowOf(stage('stream').box.row), network: 'local' }, { nowMs: 0 });
    render(
      <Providers path="/?tab=token">
        <RowBoxPage record={record} coreBuild={BUILD} fetcher={stageFetcher(stage('stream'))} />
      </Providers>,
    );
    await screen.findByRole('heading', { name: 'Fees' });
    const fees = document.querySelector('[data-card="core-fees"]') as HTMLElement;
    expect(fees.textContent).toMatch(/Fees so far: [\d.]+ ETH · [\d.,]+[KMB]? FIT/);
    expect(fees.textContent).toContain('11/15 burns FIT');
    expect(fees.textContent).toContain('2/15 platform');
    // F160, F209 (SH-245): no cap on the platform's share, in the card or behind its (i).
    expect(fees.textContent).not.toMatch(/\bcap\b|this month|of 32|per 30 days/);
    const pool = document.querySelector('[data-card="core-pool"]') as HTMLElement;
    expect(pool.textContent).toMatch(/In the pool[\d.]+ ETH \+ [\d.]+M FIT/);
    expect(pool.textContent).toMatch(/Waiting[\d.]+ ETH \+/);
    const stream = document.querySelector('[data-card="core-stream"]') as HTMLElement;
    expect(stream.textContent).toMatch(/Per Misfit so far[\d.]+ FIT/);
    expect(stream.textContent).toMatch(/Misfits outside2/);
    const draws = document.querySelector('[data-card="core-draws"]') as HTMLElement;
    expect(draws.textContent).toMatch(/Draws settled1 of 1/);
    expect(draws.textContent).toMatch(/Graduation wordstored/);
    expect(document.querySelector('[data-card="core-activity"]')?.textContent).toMatch(/Stream share claimed/);
    // Links follow the source: a local chain builds none; the address is always shown.
    expect(document.querySelectorAll('.sh-fit-link a')).toHaveLength(0);
    expect(document.querySelector('.sh-fit-ca__address')?.textContent).toBe(record.token);
    expect(appCopyFraming(renderedCopy(document.body))).toEqual([]);
  });

  it('BC-090: a box with a deadline says so; box 0 never does', async () => {
    const json = stage('bonding').box.row;
    const withDeadline = recordFromRow({ row: rowOf(json), network: 'local' }, { nowMs: 0 });
    expect(withDeadline.row?.row.spec.deadlineDays).toBe(0);
    // The phase line rule with a 30-day spec (a version-2 box; built here from the same row with the spec changed).
    const { rowPhaseLine } = await import('./row-header');
    const row = withDeadline.row?.row;
    if (!row) throw new Error('no row');
    const spec = { ...row.spec, deadlineDays: 30 };
    expect(rowPhaseLine({ record: withDeadline, row: { ...row, spec }, view: null })).toBe('Ends 30 d after the open if the curve does not fill');
    expect(rowPhaseLine({ record: withDeadline, row, view: null })).toBeNull();
  });
});

/** A feed answer with `count` boxes (box 0 and look-alikes of other ids), each with its own phase and figure. */
function feedOf(count: number, tweak: (i: number, card: Record<string, unknown>) => Record<string, unknown> = (_, c) => c): Record<string, unknown> {
  const phases = ['upcoming', 'window', 'bonding', 'graduating', 'graduated'] as const;
  const base = stage('bonding').feed as { cards: Record<string, unknown>[] } & Record<string, unknown>;
  const card0 = base.cards[0] as Record<string, unknown> & { row: BoxRowJson };
  const cards = Array.from({ length: count }, (_, i) => {
    const token = `0x${(0x1000 + i).toString(16).padStart(40, 'a')}`;
    const row = { ...card0.row, record: { ...card0.row.record, boxId: String(i), contracts: card0.row.record.contracts.map((a, role) => (role === 1 ? token : a)) } };
    const phase = phases[i % phases.length] as string;
    return tweak(i, { ...card0, token, row, phase, fillBps: phase === 'bonding' ? 1_000 + i : phase === 'upcoming' || phase === 'window' ? 0 : 10_000, retainedQ: String(10n ** 17n * BigInt(i + 1)), fdvQ: String(10n ** 18n * BigInt(i + 1)), volumeQ: String(i) });
  });
  return { ...base, cards };
}

describe('BC-085 / BC-094: the feed', () => {
  for (const count of [2, 50]) {
    it(`BC-085: ${count} boxes from ONE request, each card its own state and figure`, async () => {
      const seen: string[] = [];
      const feed = await loadFeed(CORE, fetcherOf((path) => (path.startsWith('/v1/feed') ? feedOf(count) : undefined), seen));
      expect(seen).toEqual([`/v1/feed?chain=${CORE.chainId}`]);
      expect(feed.cards).toHaveLength(count);
      const state: CoreSourcesState = { status: 'ready', via: 'indexer', summaries: new Map(), dropped: 0 };
      const sources = withCoreRows(boxesFor('local', { fitMarkets: [], localRpcUrl: '' }), state, feed, 'local', 0);
      const summaries = feedSummaries(sources, null).filter((s) => s.record.row);
      expect(summaries).toHaveLength(count);
      // Each card its own: every box's state follows its own card's phase, the figures differ.
      const byId = new Map(summaries.map((s) => [s.record.row?.row.boxId, s]));
      for (const { row, card } of feed.cards) expect(byId.get(row.boxId)?.state, `box ${row.boxId}`).toBe(card.phase);
      expect(new Set(summaries.map((s) => `${s.state}:${s.figure.text}`)).size).toBeGreaterThan(Math.min(count, 5) - 1);
      // Box 0 first (Featured), by registry and id.
      expect(sources.boxes[0]?.featured).toBe(true);
      expect(sources.boxes.filter((b) => b.featured)).toHaveLength(1);
    });
  }

  it('BC-094: one Stale and one Unverified box next to a healthy one: only those say so, the Unverified one has no FDV', async () => {
    const feedJson = feedOf(3, (i, card) => ({ ...card, phase: 'graduated', stale: i === 1, verified: i === 2 ? false : true, fdvQ: i === 2 ? null : card.fdvQ }));
    const feed = await loadFeed(CORE, fetcherOf(() => feedJson));
    const sources = withCoreRows(boxesFor('local', { fitMarkets: [], localRpcUrl: '' }), { status: 'ready', via: 'indexer', summaries: new Map(), dropped: 0 }, feed, 'local', 0);
    const summaries = feedSummaries(sources, null).filter((s) => s.record.row);
    const byId = (id: bigint) => summaries.find((s) => s.record.row?.row.boxId === id);
    expect([0n, 1n, 2n].map((id) => byId(id)?.notice)).toEqual([null, expect.stringMatching(/^Stale · since block [\d,]+$/), 'Unverified']);
    expect([0n, 1n, 2n].map((id) => byId(id)?.mcapRaw === null)).toEqual([false, false, true]);
    expect(byId(2n)?.figure.text).toBe('FDV not available');
    expect(byId(0n)?.figure.text).toMatch(/^FDV [\d.]+ ETH$/);
  });

  it('a malformed card is dropped and counted, never shown with guessed fields', async () => {
    const json = feedOf(3, (i, card) => (i === 1 ? { ...card, fillBps: 99_999 } : card));
    const feed = await loadFeed(CORE, fetcherOf(() => json));
    expect(feed.cards).toHaveLength(2);
    expect(feed.dropped).toBe(1);
  });
});

describe('BC-089: a wallet across boxes', () => {
  it('BC-089: 5 boxes, two with the same ticker: one holding per box address, nothing summed', async () => {
    const base = stage('stream').wallets as Record<string, { boxes: Record<string, unknown>[] } & Record<string, unknown>>;
    const alice = base['alice'] as { boxes: (Record<string, unknown> & { row: BoxRowJson })[] } & Record<string, unknown>;
    const first = alice.boxes[0] as Record<string, unknown> & { row: BoxRowJson };
    const boxes = Array.from({ length: 5 }, (_, i) => {
      const token = `0x${(0x2000 + i).toString(16).padStart(40, 'b')}`;
      const row = { ...first.row, record: { ...first.row.record, boxId: String(i), contracts: first.row.record.contracts.map((a, role) => (role === 1 ? token : a)) } };
      return { ...first, token, row, t: String(10n ** 21n * BigInt(i + 1)), items: i === 0 ? ['7'] : [], tickets: [] };
    });
    const wallet = await loadWallet(CORE, LIFE.accounts['alice'] as `0x${string}`, fetcherOf(() => ({ ...alice, boxes })));
    expect(wallet.boxes).toHaveLength(5);
    const records = wallet.boxes.map(({ row }) => recordFromRow({ row, network: 'local' }, { nowMs: 0 }));
    // Two (all five, here) carry FIT: each stays its own holding, keyed by its own token address.
    expect(records.filter((r) => r.ticker === 'FIT').length).toBeGreaterThanOrEqual(2);
    const view = coreWalletBox(LIFE.accounts['alice'] as `0x${string}`, wallet.boxes.map((b, i) => ({ record: records[i] as (typeof records)[number], state: null, t: BigInt(b.box.t), tickets: b.ticketCount, items: b.itemCount, itemIds: b.box.items.map(BigInt), streamOwed: null })), null);
    expect(new Set(view.holdings.map((h) => h.record.id)).size).toBe(5);
    render(
      <MemoryRouter>
        <WalletBoxView wallet={view} unavailable={null} address={LIFE.accounts['alice'] as `0x${string}`} own={false} demo={false} chainId={11_155_111} networkLabel="Local chain (Sepolia twin)" />
      </MemoryRouter>,
    );
    const sections = document.querySelectorAll('section.sh-box-holding');
    expect(sections).toHaveLength(5);
    // Each holding's own amount, never a total across boxes.
    const amounts = [...sections].map((s) => s.querySelector('.sh-box-wtile strong')?.textContent);
    expect(amounts).toEqual(['1K FIT', '2K FIT', '3K FIT', '4K FIT', '5K FIT']);
    expect(document.body.textContent).not.toMatch(/15K|15,000/);
    expect(parseOptionsOf(CORE).registries).toEqual([REGISTRY]);
    expect(boxRowToJson(rowOf(first.row)).record.boxId).toBe('0');
  });
});


// ------------------------------------------------------------------------------------------------ the S10a review

const STAGES = ['upcoming', 'window', 'bonding', 'closed', 'graduated', 'word', 'draw', 'busy', 'deepen', 'stream'] as const;
const viewOf = (name: string): CoreBoxView => stage(name).box as unknown as CoreBoxView;

describe('the Fees card adds up (S10a review: the held platform share, its part above the cap, the stream\'s 13/15)', () => {
  for (const name of STAGES) {
    it(`F77 ${name}: every row follows box 0's split exactly; the 2/15 depth + 13/15 burned or streamed equal Σ Collected.t less the carry`, () => {
      const view = viewOf(name);
      const fs = feeSummary(view);
      // Box 0's split per batch is 11/2/2 of one fifteenth (Q) and 13/2 (T); nothing here reached the 32 ETH cap, so
      // the platform's part and the pool's are each exactly qFit × 2/11, and the T burned or streamed tDepth × 13/2.
      expect(fs.qPlatform).toBe((fs.qFit * 2n) / 11n);
      expect(fs.qDepth).toBe((fs.qFit * 2n) / 11n);
      expect(fs.qFit % 11n).toBe(0n);
      expect(fs.tBurned + fs.tToStream).toBe((fs.tDepth * 13n) / 2n);
      expect(fs.qTotal).toBe(fs.qFit + fs.qDepth + fs.qPlatform);
      // The T side against what was collected: Σ Collected.t = the rows + the carry (< 15 raw units); the settlement's
      // split had no T in this life.
      const carry = BigInt(view.fees.collectedT) - (fs.tDepth + fs.tBurned + fs.tToStream);
      expect(carry >= 0n && carry < 15n, `carry ${carry}`).toBe(true);
      // "This month" never exceeds the platform's all-time figure.
      expect(fs.keptThisEpoch).toBeLessThanOrEqual(fs.qPlatform);
    });
  }

  it('F77: the Fees card\'s exact figures at each stage of the recorded life', async () => {
    const seen: Record<string, string[]> = {};
    for (const name of ['bonding', 'graduated', 'busy', 'stream'] as const) {
      const record = recordFromRow({ row: rowOf(stage(name).box.row), network: 'local' }, { nowMs: 0 });
      render(
        <Providers path="/?tab=token">
          <RowBoxPage record={record} coreBuild={BUILD} fetcher={stageFetcher(stage(name))} />
        </Providers>,
      );
      await screen.findByRole('heading', { name: 'Fees' });
      const fees = document.querySelector('[data-card="core-fees"]') as HTMLElement;
      seen[name] = [fees.querySelector('.sh-fit-fees__line')?.textContent ?? '', ...[...fees.querySelectorAll('.sh-core-facts__row')].map((r) => `${r.querySelector('dt')?.textContent}: ${r.querySelector('dd')?.textContent}`)];
      cleanup();
    }
    expect(seen).toEqual(EXPECTED_FEES);
  });
});

describe('figures read from views carry their block; the pool share and the Misfits outside come from events', () => {
  it('Waiting and Per Misfit so far say "at block N (last check)" only when older than the box\'s last event', async () => {
    const s = stage('stream');
    const box = { ...(s.box as Record<string, unknown>), readsCurrent: false, readsBlock: '440' };
    const record = recordFromRow({ row: rowOf(s.box.row), network: 'local' }, { nowMs: 0 });
    render(
      <Providers path="/?tab=token">
        <RowBoxPage record={record} coreBuild={BUILD} fetcher={stageFetcher({ ...s, box: box as unknown as Stage['box'] })} />
      </Providers>,
    );
    await screen.findByRole('heading', { name: 'Fees' });
    expect(document.querySelector('[data-card="core-pool"]')?.textContent).toMatch(/Waiting[\d.]+ ETH \+ [\d.]+[KM]? FIT · at block 440 \(last check\)/);
    expect(document.querySelector('[data-card="core-stream"]')?.textContent).toMatch(/Per Misfit so far[\d.]+ FIT · at block 440 \(last check\)/);
    // The Misfits outside: N − inside, the same figure as the Contents tab's "outside the vault".
    const v = viewOf('stream');
    expect(document.querySelector('[data-card="core-stream"]')?.textContent).toContain(`Misfits outside${BigInt(v.vault.outside ?? '0').toString()}`);
    expect(BigInt(v.vault.outside ?? '0')).toBe(4269n - BigInt(v.vault.inside ?? '0'));
  });

  it('before graduation the pool share waiting is the coordinator\'s T (from transfers), as poolShare() said at the audit', () => {
    const v = viewOf('bonding');
    expect(v.pool.poolShare).not.toBe('0');
    if (v.audit && v.audit.block === v.asOf.block) expect(v.pool.poolShare).toBe(v.audit.reads['coordinator.poolShare']);
  });
});

describe('C19: the indexer down never says a box does not exist (S10a review)', () => {
  const refused: Fetcher = async () => {
    throw new TypeError('Failed to fetch');
  };
  const directOf = (box: CoreBox | null): DirectReader & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      feed: async () => (calls.push('feed'), { via: 'direct', asOf: null, cards: [], dropped: 0 }),
      box: async () => (calls.push('box'), box),
      wallet: async () => (calls.push('wallet'), { via: 'direct', asOf: null, boxes: [] }),
    };
  };
  type CoreBox = Awaited<ReturnType<typeof loadBox>>;

  it('the feed, a box and a wallet are read from the chain when the indexer refuses, answers 5xx or fails its checks; its 404 stays its answer', async () => {
    const direct = directOf({ row: rowOf(stage('stream').box.row), view: viewOf('stream') });
    const feed = await loadFeed(CORE, refused, direct);
    expect([feed.via, feed.indexerError]).toEqual(['direct', 'The indexer did not answer: Failed to fetch']);
    const box = await loadBox(CORE, LIFE.stages['stream']?.box.row.record.contracts[1] as string, fetcherOf(() => undefined, []), direct);
    // 404: the indexer's own answer (no shown box with that token), not a failure.
    expect(box).toBeNull();
    const five = await loadBox(CORE, '0x' + '1'.repeat(40), async () => ({ ok: false, status: 502, json: async () => ({}) }), direct);
    expect(five?.indexerError).toBe('The indexer answered 502.');
    const malformed = await loadBox(CORE, '0x' + '1'.repeat(40), fetcherOf(() => ({ schema: 'something else' })), direct);
    expect(malformed?.indexerError).toMatch(/^The indexer's answer failed its checks: schema must be sh\.core-box\.v1/);
    const wallet = await loadWallet(CORE, LIFE.accounts['alice'] as `0x${string}`, refused, direct);
    expect(wallet.via).toBe('direct');
    expect(direct.calls).toEqual(['feed', 'box', 'box', 'wallet']);
  });

  it('a box page whose source could not be read at all says Unavailable with the reason, never "Not in …"; the feed says so, never "No boxes … in this build"', async () => {
    const token = LIFE.token;
    render(
      <Providers path={`/box/11155111/${token}`}>
        <Routes>
          <Route path="box/:chain/:address" element={<BoxPage build={{ fitMarkets: [], localRpcUrl: '' }} coreBuild={BUILD} fetcher={refused} />} />
        </Routes>
      </Providers>,
    );
    expect(await screen.findByRole('heading', { name: 'Unavailable' }, { timeout: 15_000 })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Not in Local chain|in this build/);
    cleanup();
    render(
      <Providers>
        <BoxFeedPage build={{ fitMarkets: [], localRpcUrl: '' }} coreBuild={BUILD} fetcher={refused} />
      </Providers>,
    );
    expect(await screen.findByText('The boxes did not load.', undefined, { timeout: 15_000 })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/in this build/);
  }, shLimit(40_000));

  it('a refresh that fails keeps the last good box on screen, marked Stale (react-query keeps the data on a refetch error)', async () => {
    let fail = false;
    const s = stage('stream');
    const base = stageFetcher(s);
    const flaky: Fetcher = async (url) => {
      if (fail && url.includes('/v1/boxes/')) throw new TypeError('Failed to fetch');
      return base(url);
    };
    // A direct reader that also fails (the chain unreachable too): the last good answer is all there is.
    const record = recordFromRow({ row: rowOf(s.box.row), network: 'local' }, { nowMs: 0 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <Providers client={client}>
        <RowBoxPage record={record} coreBuild={{ ...BUILD, localRpcUrl: 'http://127.0.0.1:8599' }} fetcher={flaky} />
      </Providers>,
    );
    await screen.findByText((_, el) => el?.classList.contains('sh-box-band__label') === true && el.textContent === 'Graduated');
    fail = true;
    await act(async () => {
      await client.refetchQueries({ queryKey: ['core-box'] });
    });
    await screen.findByText(/^Stale · since block [\d,]+ · could not refresh$/, undefined, { timeout: 15_000 });
    expect(header().querySelector('.sh-box-band__label')?.textContent).toBe('Graduated');
    expect(document.body.textContent).not.toMatch(/Box not found|Not in Local chain|is not on .* in this build/);
  }, shLimit(40_000));

  it('loaded(): data kept after a failed refresh is served with its reason; no data and an error is an error', () => {
    expect(loaded({ isPending: false, isError: true, data: 1, error: new Error('x') })).toEqual({ status: 'ready', value: 1, refreshError: 'x' });
    expect(loaded({ isPending: false, isError: true, data: undefined, error: new Error('x') })).toEqual({ status: 'error', reason: 'x' });
    expect(loaded({ isPending: true, isError: false, data: undefined, error: null })).toEqual({ status: 'loading' });
    expect(CHAIN_READER).toBeTruthy();
  });
});

describe('BC-094: a Stale card counts nothing down; Sepolia judges age by the clock, the local twin does not', () => {
  it('Stale: "Opens 18:00 UTC" instead of "Opens in ~N min"; the window by the time it ends', () => {
    const upcoming = stage('upcoming').feed.cards[0] as unknown as Parameters<typeof rowSummary>[2] & { row: BoxRowJson };
    const row = rowOf(upcoming.row);
    const record = recordFromRow({ row, network: 'local' }, { nowMs: 0 });
    // From the head's time to the open (a clock time): the recorded upcoming head is minutes before it.
    const left = row.openAt - BigInt(upcoming.asOf.timestamp);
    expect(left > 60n && left < 3_600n).toBe(true);
    expect(rowSummary(record, row, upcoming).figure.text).toBe(`Opens in ~${left / 60n} min`);
    const hhmm = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString().slice(11, 16);
    const stale = rowSummary(record, row, upcoming, { stale: true });
    expect(stale.figure.text).toBe(`Opens ${hhmm(row.openAt)} UTC`);
    expect(stale.notice).toMatch(/^Stale · since block [\d,]+$/);
    const window = stage('window').feed.cards[0] as unknown as Parameters<typeof rowSummary>[2];
    expect(rowSummary(record, row, window, { stale: true }).figure.text).toBe(`Window until ${hhmm(row.windowEndsAt)} UTC`);
    expect(rowSummary(record, row, window).figure.text).toMatch(/^Window · tax \d+\.\d\d% · (~\d+ min|<1 min)$/);
  });

  it('a Sepolia answer over a minute old is Stale; the local twin\'s clock is its own', () => {
    const now = 1_900_000_000_000;
    expect(staleByClock('sepolia', String(now / 1000 - 30), now)).toBe(false);
    expect(staleByClock('sepolia', String(now / 1000 - 61), now)).toBe(true);
    expect(staleByClock('local', String(now / 1000 - 10_000), now)).toBe(false);
  });
});

describe('labels and reasons by source, never by chain id (the twin carries Sepolia\'s)', () => {
  it('the collection row: the address from the row; on the local twin no explorer and no marketplace, on Sepolia the explorer', () => {
    const json = stage('stream').box.row;
    const local = collectionContract(recordFromRow({ row: rowOf(json), network: 'local' }, { nowMs: 0 }));
    expect(local.address?.toLowerCase()).toBe((rowOf(json).contracts.collection as string).toLowerCase());
    expect(local.explorer).toEqual({ href: null, reason: 'No explorer for a local chain' });
    expect(local.marketplace.reason).toBe('No marketplace on a local chain');
    const sepolia = collectionContract(recordFromRow({ row: rowOf(json), network: 'sepolia' }, { nowMs: 0 }));
    expect(sepolia.explorer.href).toMatch(/^https:\/\/sepolia\.etherscan\.io\/address\/0x/);
    expect(sepolia.marketplace.reason).toBe('Sepolia has no NFT marketplace view');
  });
});

/**
 * The Fees card's text per stage, worked out by hand from the recorded life's raw figures (e2e/fixtures/core-local/
 * life.json; ETH truncated to 4 decimals, FIT to hundredths of K/M): before graduation the platform's 2/15 is held
 * (0.0013 ETH = qFit × 2/11); after it the platform's figure is everything kept; the T side
 * shows what was burned and what funded the stream, so 2/15 + 13/15 add up to what was split.
 */
const EXPECTED_FEES: Record<string, string[]> = {
  bonding: [
    'Fees so far: 0.0103 ETH · 1.02M FIT',
    '11/15 burns FIT: 0.0075 ETH',
    '2/15 into this pool: 0.0013 ETH · 136.66K FIT',
    '2/15 platform: 0.0013 ETH held until graduation',
    '13/15 burned or to the per-Misfit stream: 888.31K FIT burned',
    'Launch tax: 0.0183 ETH waiting · into this pool after graduation',
  ],
  graduated: [
    'Fees so far: 0.0411 ETH · 1.02M FIT',
    '11/15 burns FIT: 0.0301 ETH',
    '2/15 into this pool: 0.0054 ETH · 136.66K FIT',
    '2/15 platform: 0.0054 ETH',
    '13/15 burned or to the per-Misfit stream: 888.31K FIT burned · 0 FIT to the stream',
    'Launch tax: 0.0183 ETH waiting · into this pool after graduation',
  ],
  busy: [
    'Fees so far: 0.1506 ETH · 1.22M FIT',
    '11/15 burns FIT: 0.1104 ETH',
    '2/15 into this pool: 0.02 ETH · 162.94K FIT',
    '2/15 platform: 0.02 ETH',
    '13/15 burned or to the per-Misfit stream: 888.31K FIT burned · 170.82K FIT to the stream',
    'Launch tax: 0 ETH waiting · into this pool after graduation',
  ],
  stream: [
    'Fees so far: 0.1896 ETH · 1.94M FIT',
    '11/15 burns FIT: 0.139 ETH',
    '2/15 into this pool: 0.0252 ETH · 259.06K FIT',
    '2/15 platform: 0.0252 ETH',
    '13/15 burned or to the per-Misfit stream: 888.31K FIT burned · 795.63K FIT to the stream',
    'Launch tax: 0 ETH waiting · into this pool after graduation',
  ],
};

/**
 * F142, desk R64-ROWS "hide" (2026-10-21, default applied): box 0's page shows no row for its backup start or fix
 * (the indexer's `backup_started` and `backup_fixed`, packages/indexer/src/core/derive-core.ts; the indexer keeps
 * them). No raw kind, no label, no change to which or how many rows show, no hint: the Activity card for an answer with
 * the two rows is the card for the same answer without them.
 */
describe('F142 R64-ROWS "hide": box 0’s Activity card shows no backup start or fix', () => {
  type Item = Record<string, unknown>;
  const row = (kind: string, block: number, logIndex: number, timestamp: string, data: Record<string, string>): Item => ({
    id: `${block}-${logIndex}`,
    kind,
    block: String(block),
    blockHash: `0x${'ab'.repeat(32)}`,
    timestamp,
    txHash: `0x${(block * 100 + logIndex).toString(16).padStart(64, '0')}`,
    logIndex,
    data,
  });
  // Between the word stage's newest rows, in its newest-first order (111-0 word_stored, 110-0 round_posted, 109-23 ...).
  const ROUND = '32654000';
  const by = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
  const fixed = row('backup_fixed', 110, 5, '1790765364', { round: ROUND, targetBlock: '366', mix: `0x${'12'.repeat(32)}`, by });
  const started = row('backup_started', 109, 30, '1790765352', { round: ROUND, targetBlock: '366', by });
  const withItems = (s: Stage, items: readonly Item[]): Stage => ({ ...s, activity: { ...(s.activity as Record<string, unknown>), items } });
  const itemsOf = (s: Stage): Item[] => (s.activity as { items: Item[] }).items;

  /** The Token tab's Activity card once its answer is in: its markup, its rows' kinds and its text. */
  async function activityCard(s: Stage) {
    const record = recordFromRow({ row: rowOf(s.box.row), network: 'local' }, { nowMs: 0 });
    render(
      <Providers path="/?tab=token">
        <RowBoxPage record={record} coreBuild={BUILD} fetcher={stageFetcher(s)} />
      </Providers>,
    );
    await screen.findByRole('heading', { name: 'Activity' });
    const card = () => document.querySelector('[data-card="core-activity"]') as HTMLElement;
    await waitFor(() => expect(card().textContent).not.toContain('With the indexer'));
    const out = { html: card().innerHTML, kinds: [...card().querySelectorAll('li')].map((li) => li.getAttribute('data-kind')), text: card().textContent ?? '' };
    cleanup();
    return out;
  }

  it('the rows of the answer without them, as many and in the same order: no raw kind, no label, no hint', async () => {
    const s = stage('word');
    const plain = itemsOf(s);
    // Newest first, where a backed round's rows would sit: the fix among the newest rows, the start below it.
    const backed = [plain[0] as Item, fixed, plain[1] as Item, started, ...plain.slice(2)];
    expect(plain.length).toBeGreaterThan(12);
    const want = await activityCard(withItems(s, plain));
    expect(want.kinds).toHaveLength(12);
    const got = await activityCard(withItems(s, backed));
    expect(got.kinds).toEqual(want.kinds);
    expect(got.kinds.filter((k) => k?.startsWith('backup'))).toEqual([]);
    expect(got.text).not.toMatch(/backup/i);
    expect(got.html).toBe(want.html);
  });

  it('an answer with only the backup rows reads like an empty one', async () => {
    const s = stage('word');
    const empty = await activityCard(withItems(s, []));
    expect(empty.text).toContain('Nothing yet');
    const only = await activityCard(withItems(s, [fixed, started]));
    expect(only.kinds).toEqual([]);
    expect(only.html).toBe(empty.html);
  });
});
