/**
 * SH-BOX0-LIVE-CURVE: box 0 on a chain source (its row page, RowBoxPage) shows the same live "Bonding curve" card as the
 * sample launch page, first on its Token tab, fed by the box's snapshot (the live gateway, or a direct chain read):
 * the price, the fill of the raise and ETH in the curve from the gateway's own answer (the recorded life of box 0 on
 * the local Sepolia twin, e2e/fixtures/core-local/life.json), with the card's freshness chip and its Data line. The
 * curve is information only: no control, no wallet request. Nothing else on the page moves; another box's page gets
 * no curve card.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boxRowFromJson, type BoxRowJson } from '@squarehole/chain';
import type { CoreBoxView } from '@squarehole/indexer/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { DATA_SOURCE_KEY, DataSourceProvider, resetDataSourceForTests } from '../data-source';
import { visibleText } from '../fit-pair/test-support/visible-text';
import { appCopyFraming, renderedCopy } from '../legal/wording';
import { box0Curve } from './box0-curve';
import type { CoreBuild } from './core-build';
import type { Fetcher } from './core-client';
import { recordFromRow } from './row-record';
import { RowBoxPage } from './RowBoxPage';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../e2e/fixtures/core-local');
interface Stage {
  box: CoreBoxView & { row: BoxRowJson };
  activity: unknown;
  candles: unknown;
}
const LIFE = JSON.parse(readFileSync(resolve(FIXTURES, 'life.json'), 'utf8')) as { stages: Record<string, Stage> };
const MANIFEST = JSON.parse(readFileSync(resolve(FIXTURES, 'manifest-11155111.json'), 'utf8')) as { versions: { registry: { address: `0x${string}` } }[] };
const REGISTRY = MANIFEST.versions[0]?.registry.address as `0x${string}`;
const ORIGIN = 'http://indexer.test';
const BUILD: CoreBuild = { manifests: [MANIFEST], localRpcUrl: 'http://127.0.0.1:8599', indexers: { local: ORIGIN, sepolia: null } };
const stage = (name: string): Stage => {
  const s = LIFE.stages[name];
  if (!s) throw new Error(`no stage ${name}`);
  return s;
};
const rowOf = (json: BoxRowJson) => boxRowFromJson(json, { box0Registry: REGISTRY });

function fetcherFor(box: unknown, s: Stage): Fetcher {
  return async (url) => {
    const path = url.replace(ORIGIN, '');
    const body = path.includes('/activity') ? s.activity : path.includes('/candles') ? s.candles : path.startsWith('/v1/boxes/') ? box : undefined;
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
  };
}

function Providers({ children }: { children: ReactNode }) {
  window.localStorage.setItem(DATA_SOURCE_KEY, JSON.stringify({ source: 'local' }));
  return (
    <DataSourceProvider build={{ localManifest: null, sepoliaManifest: null, localRpcUrl: 'http://127.0.0.1:8560', coreLocal: true }}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/?tab=token']}>{children}</MemoryRouter>
      </QueryClientProvider>
    </DataSourceProvider>
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetDataSourceForTests();
});

async function renderToken(name: string, box: unknown = stage(name).box, rowJson: BoxRowJson = stage(name).box.row) {
  const record = recordFromRow({ row: rowOf(rowJson), network: 'local' }, { nowMs: 0 });
  render(
    <Providers>
      <RowBoxPage record={record} coreBuild={BUILD} fetcher={fetcherFor(box, stage(name))} />
    </Providers>,
  );
  await screen.findByRole('heading', { name: 'Fees' });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return record;
}

const curve = () => screen.getByRole('region', { name: 'Bonding curve' });
const mainCards = () => [...document.querySelectorAll('.sh-fit-grid__main > section')].map((card) => card.getAttribute('data-card') ?? card.getAttribute('aria-labelledby'));
const bar = () => within(curve()).getByRole('progressbar');
const dataLine = () => curve().querySelector('.sh-info-panel__data')?.textContent ?? '';

describe('SH-BOX0-LIVE-CURVE: box 0’s Token tab on a chain source', () => {
  it('draws the live curve card first, from the gateway’s answer: price, fill and ETH in the curve of the raise', async () => {
    await renderToken('bonding');
    expect(mainCards()).toEqual(['fit-curve-title', 'core-fees', 'core-pool', 'core-stream', 'core-draws', 'core-activity']);
    const card = curve();
    expect(card.getAttribute('data-freshness')).toBe('live');
    // The gateway at block 107: qPerT 0.000000004337130543 ETH, retainedQ 1.152172034645046223 of 4.206980085 ETH, 2738 bps.
    expect(visibleText(card)).toMatch(/^Bonding curve Live Price 0\.0043371 ETH per 1M FIT Progress to graduation 27\.3% 1\.1521 of 4\.206980085 ETH now Sold [\d.]+M FIT Burned 1\.96M FIT Total tax 0\.0183 ETH$/);
    expect(bar().getAttribute('aria-valuenow')).toBe('27');
    expect(bar().getAttribute('aria-valuetext')).toBe('1.152172034 ETH of 4.206980085 ETH (27.3%) · after sells');
    // The freshness line: the block, and that the gateway's audit read the same price from the chain at that block.
    expect(dataLine()).toBe('Data: block 107, from the live service; its price matched a direct chain read at block 107. 1 FIT = 0.0000000043371 ETH. Drawing: price on a log scale.');
    // Information only.
    expect(within(card).queryAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['About the bonding curve']);
    expect(card.querySelectorAll('input, a, iframe')).toHaveLength(0);
    expect(appCopyFraming(renderedCopy(document.body))).toEqual([]);
  });

  it('before the open and in the window: the curve at its start; graduating: full; graduated: "Curve complete"', async () => {
    await renderToken('upcoming');
    expect(visibleText(curve())).toMatch(/^Bonding curve Live Price 0\.0013775 ETH per 1M FIT Progress to graduation 0\.0% 0\.0014 of 4\.206980085 ETH now /);
    cleanup();
    await renderToken('closed');
    expect(bar().getAttribute('aria-valuenow')).toBe('100');
    expect(visibleText(curve())).toMatch(/Progress to graduation 100\.0% 4\.2069 of 4\.206980085 ETH/);
    cleanup();
    await renderToken('graduated');
    expect(bar().getAttribute('aria-valuetext')).toBe('Graduated at block 109');
    expect(visibleText(curve())).toMatch(/^Bonding curve Live Price 0\.020209 ETH per 1M FIT Curve complete 100\.0% now Burned 1\.96M FIT Total tax 0\.0183 ETH$/);
  });

  it('Stale: the chip says since which block; Unverified: no price; a direct read says so', async () => {
    const s = stage('bonding').box;
    await renderToken('bonding', { ...s, stale: true });
    expect(curve().getAttribute('data-freshness')).toBe('stale');
    expect(curve().querySelector('.sh-fit-chip')?.textContent).toBe('Stale · since block 107');
    cleanup();
    await renderToken('bonding', { ...s, verified: false });
    expect(curve().getAttribute('data-freshness')).toBe('unverified');
    expect(visibleText(curve())).toContain('Price Not shown while unverified');
    expect(visibleText(curve())).not.toContain('0.0043371');
    cleanup();
    await renderToken('bonding', { ...s, source: 'direct' });
    expect(curve().getAttribute('data-freshness')).toBe('direct');
    expect(dataLine()).toMatch(/^Data: block 107, read directly from the chain\./);
  });

  it('a gateway answer whose ETH in the curve disagrees with its own price is Unverified, never shown as live', async () => {
    const s = stage('bonding').box;
    await renderToken('bonding', { ...s, curve: { ...s.curve, retainedQ: '2000000000000000000', fillBps: 4754 } });
    expect(curve().getAttribute('data-freshness')).toBe('unverified');
    expect(visibleText(curve())).toContain('Not shown while unverified');
  });

  it('another box (not box 0 by registry and id) gets no curve card; its Token tab is as before', async () => {
    const json = stage('bonding').box.row;
    const other = { ...json, record: { ...json.record, boxId: '7' } };
    await renderToken('bonding', { ...stage('bonding').box, row: other }, other);
    expect(screen.queryByRole('region', { name: 'Bonding curve' })).toBeNull();
    expect(mainCards()).toEqual(['core-fees', 'core-pool', 'core-stream', 'core-draws', 'core-activity']);
  });

  it('the adapter refuses a row it cannot draw honestly (T as currency0, or not native ETH)', () => {
    const row = rowOf(stage('bonding').box.row);
    expect(box0Curve(row, stage('bonding').box, { stale: false })).not.toBeNull();
    expect(box0Curve({ ...row, tIsCurrency0: true }, stage('bonding').box, { stale: false })).toBeNull();
    expect(box0Curve({ ...row, qAsset: { ...row.qAsset, qClass: 'ERC20', decimals: 6 } }, stage('bonding').box, { stale: false })).toBeNull();
  });
});
