import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AppProviders } from '../../../app-providers';
import { createDemoWalletAdapter } from '../../wallet';
import { V2BoxPage } from './V2BoxPage';
import { parseSnapshotV2, type V2Snapshot, type V2Source } from './indexer-v2';
import { recordV2 } from './record-v2';
import { publishedV2 } from './test-support/published-v2';
import { mixedDeployment } from './test-support/mixed-deployment';
import { shortAddress } from '../../fit-pair/fit-format';
import { pictureLoaded } from './test-support/picture-loaded';
vi.mock('./SafesV2', () => ({ SafesV2: () => <p>Safe read panel</p> }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => <p>Burn log panel</p> }));
// SH-BOX-CANDLES: the chart's drawing (jsdom has no canvas).
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));

/**
 * SH-224 phase 3 (review XR-SH-224, N2), refitted for SH-255 (the top of the page is the box's picture,
 * picture/BoxPagePicture.tsx, a lazy chunk awaited here): what the v2 box page's head does, asserted directly: the creator's description in full (and nothing without one), Copy copying the box token's address, a closed
 * box's three tiles with their units, and the chain chip naming the source's network (a local twin of Sepolia is a local
 * chain, F2), with no rehearsal chip on a v2 box.
 */
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/**
 * `twin`: the same box on a deployment with Sepolia's chain id (mixed-deployment.ts, the recorded local twin), read from
 * `network`'s source.
 */
async function page(patch: Partial<V2Snapshot> = {}, options: { network?: V2Source['network']; description?: string; twin?: boolean } = {}) {
  const published = await publishedV2();
  const twin = options.twin ? await mixedDeployment() : null;
  const body = twin ? twin.body : published.body;
  const source: V2Source = { ...published.source, ...(twin ? { manifest: twin.manifest } : {}), network: options.network ?? published.source.network };
  const parsed = { ...parseSnapshotV2(body, source), verified: true, ...patch };
  const view = options.description === undefined ? parsed : { ...parsed, spec: { ...parsed.spec, description: options.description } };
  const record = recordV2(view, source, null, 'tUSDC');
  render(<AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}><MemoryRouter><V2BoxPage record={record} /></MemoryRouter></AppProviders>);
  // The picture's chunk loads once the page mounts; its head carries the name, the chips, the address and the tiles.
  const header = await pictureLoaded();
  expect(header).not.toBeNull();
  return { header, record, view };
}

/** A tile's label, value (its cell's first text) and unit (the small line under it). */
const tiles = (header: HTMLElement) => [...header.querySelectorAll('.sh-box-stat')].map((cell) => [cell.querySelector('dt')?.textContent, cell.querySelector('dd')?.firstChild?.textContent, cell.querySelector('dd > small')?.textContent ?? null]);

describe('SH-224: the v2 box page header', () => {
  it('shows the creator’s whole description under the name, once, never cut', async () => {
    const description = `${'A long line about the box, '.repeat(40)}${'x'.repeat(1024)} and the end.`;
    const { header } = await page({}, { description });
    expect([...header.querySelectorAll('.sh-bpic-line')].map((line) => line.textContent)).toEqual([description]);
  });

  it('renders no description line when the spec has none (an empty string: the record says null)', async () => {
    const { header, view, record } = await page({}, { description: '' });
    expect(view.spec.description).toBe('');
    expect(record.line).toBeNull();
    expect(header.querySelector('.sh-bpic-line')).toBeNull();
  });

  it('Copy copies the box token’s address, and the line shows the ticker and the short address', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    // jsdom has no clipboard: the page's own navigator gets one for this test.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    onTestFinished(() => { Reflect.deleteProperty(navigator, 'clipboard'); });
    const { header, record } = await page();
    const line = header.querySelector('.sh-fit-ca--compact') as HTMLElement;
    expect(line.querySelector('strong')?.textContent).toBe(record.ticker);
    expect(line.querySelector('code')?.getAttribute('title')).toBe(record.token);
    expect(line.querySelector('code')?.textContent).toBe(shortAddress(record.token));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Copy the ${record.ticker} contract address` })); });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(record.token);
    expect(line.querySelector('.sh-copy')?.getAttribute('data-copy-state')).toBe('copied');
  });

  it('a closed box: its three tiles, the closing price per 1M, the claim pot and the coins left, each with its unit', async () => {
    // The published fixture's box is closed with a pot of 10 tUSDC and 3 coins left (cq11-page.test.tsx's closing card).
    const { header, record, view } = await page();
    expect(view.failed).not.toBeNull();
    expect(tiles(header)).toEqual([
      ['Closing price', '3,333,333', `tUSDC per 1M ${record.ticker}`],
      ['Claim pot', '10', 'tUSDC'],
      ['Coins left', '3', record.ticker],
    ]);
    expect(header.querySelector('.sh-bpic-phase')?.textContent).toBe('Closed');
  });

  it('an open box: the market’s five figures as tiles, with their units', async () => {
    const { header, record } = await page({ failed: null, closing: null, closedAt: 0n, timestamp: 1000n, gate: { open: true, effectiveOpenAt: 1000n, deadline: 2000n } });
    expect(tiles(header).map(([label, , unit]) => [label, unit])).toEqual([
      ['Price', `tUSDC per 1M ${record.ticker}`], ['Market cap', 'tUSDC'], ['Holders', null], ['Burned', record.ticker], ['24h volume', 'tUSDC'],
    ]);
  });

  it('without its data: the fallback names the box in a heading that wraps like the header’s (.sh-v2-fallback)', async () => {
    const { body, source } = await publishedV2();
    const record = { ...recordV2(parseSnapshotV2(body, source), source), name: 'Supercalifragilistic'.repeat(6), v2Chain: { source, snapshot: null } };
    render(<AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}><MemoryRouter><V2BoxPage record={record} /></MemoryRouter></AppProviders>);
    const section = document.querySelector('section.sh-v2-fallback') as HTMLElement;
    expect(section).not.toBeNull();
    expect(section.querySelector('h1')?.textContent).toBe(record.name);
    expect(screen.getByRole('status').textContent).toBe('V2 box data unavailable');
  });

  it.each([
    ['sepolia', 'Sepolia', 'Sepolia testnet'],
    ['local', 'Local chain', 'Local chain'],
  ] as const)('the chain chip of a box read from the %s source says %s, as its title does; no rehearsal chip on a v2 box', async (network, short, title) => {
    const { header, record } = await page({}, { network, twin: true });
    expect(record.chainId).toBe(11_155_111);
    const chip = header.querySelector('.sh-box-chain') as HTMLElement;
    expect(chip.querySelector('.sh-box-chain__short')?.textContent).toBe(short);
    expect(chip.getAttribute('title')).toBe(title);
    expect(header.querySelector('.sh-box-rehearsal')).toBeNull();
    expect(header.textContent).not.toMatch(/Rehearsal/);
  });
});
