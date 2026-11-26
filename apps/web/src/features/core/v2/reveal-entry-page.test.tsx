/**
 * SH-203 on the line: where the reveal pieces sit in the box page of SH-224. The creator's entry is in the Items card
 * (on a closed box, whose page has no Items card, on its own in the parts), never in the header; `?view=reveal` shows
 * the Reveal items view in place of everything under the header, for the creator only; a visitor's page, header and all,
 * is the box as before. The wallet, the chain's counts and the view itself are doubles; nothing answers RPC here.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { getAddress, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, createQueryClient } from '../../../app-providers';
import { V2BoxPage } from './V2BoxPage';
import { parseSnapshotV2 } from './indexer-v2';
import { recordV2 } from './record-v2';
import { publishedItems } from './test-support/m3-published';
import { REVEAL_WORDS as W } from './reveal-words';
import { pictureLoaded } from './test-support/picture-loaded';

const wallet = vi.hoisted(() => ({ account: null as string | null, status: 'disconnected', chainId: 0, kind: 'injected', defaultDialog: 'browser', signer: null }));
vi.mock('../../wallet', async (original) => ({ ...(await original<object>()), useWallet: () => wallet }));
// The chain's counts for the entry: items left (RevealEntryV2 reads them through RevealCopyV2's reader). The copy card
// shares that query and has its own tests (reveal-copy.test.tsx); it is left out so the double answers the entry.
vi.mock('./RevealCopyV2', async (original) => ({ ...(await original<object>()), RevealCopyV2: () => null, readRevealCounts: async () => ({ revealed: 0n, size: 4n }) }));
// The view itself has its own tests (RevealItemsV2.test.tsx); here only where it is shown.
vi.mock('./RevealItemsV2', () => ({ RevealItemsV2: () => <section aria-label="Reveal items view double" /> }));
vi.mock('./SafesV2', () => ({ SafesV2: () => null }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => null }));
// SH-BOX-CANDLES: the chart's drawing (jsdom has no canvas).
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));

const ROOT = `0x${'70'.repeat(32)}` as Hex;
const VISITOR = getAddress(`0x${'51'.repeat(20)}`);

async function page({ who = 'creator' as 'creator' | 'visitor' | 'nobody', at = '/', failed = false, artMode = 1 } = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  const published = await publishedItems({ failed, spec: { artMode, revealRoot: ROOT } });
  const view = parseSnapshotV2(published.body, published.source);
  const creator = view.record.creator;
  Object.assign(wallet, who === 'nobody' ? { account: null, status: 'disconnected' } : { account: who === 'creator' ? creator : VISITOR, status: 'connected' });
  wallet.chainId = published.source.manifest.chainId;
  render(<MemoryRouter initialEntries={[at]}><AppProviders queryClient={createQueryClient()}><V2BoxPage record={recordV2(view, published.source)} /></AppProviders></MemoryRouter>);
  await screen.findByRole('heading', { level: 1 });
  return { view };
}
const entries = () => screen.queryAllByRole('button', { name: W.entry });
// SH-255: the top of the page is the box's picture (a lazy chunk, awaited after each page): its head and the picture.
const header = () => document.querySelector('.sh-bpic') as HTMLElement;
const head = () => document.querySelector('.sh-bpic-head') as HTMLElement;
const items = () => screen.queryByRole('region', { name: 'Items in the vault' });

beforeEach(() => { Object.assign(wallet, { account: null, status: 'disconnected' }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('SH-203 on the line: the reveal pieces in the box page', () => {
  it('the creator: one entry, in the Items card, above its items; none in the header', async () => {
    await page();
    await pictureLoaded();
    await waitFor(() => expect(entries()).toHaveLength(1));
    const entry = entries()[0] as HTMLElement;
    expect(items()?.contains(entry)).toBe(true);
    expect(header().contains(entry)).toBe(false);
    expect(within(header()).queryByText(W.entry)).toBeNull();
  });

  it('a visitor and nobody connected: no entry, and the same header', async () => {
    await page({ who: 'visitor' });
    await pictureLoaded();
    expect(entries()).toEqual([]);
    expect(items()).not.toBeNull();
    const visitorHeader = head().outerHTML;
    cleanup();
    await page({ who: 'nobody' });
    await pictureLoaded();
    expect(entries()).toEqual([]);
    expect(head().outerHTML).toBe(visitorHeader);
  });

  it('?view=reveal for the creator: the view in place of everything under the header; the header stays', async () => {
    await page({ at: '/?view=reveal' });
    await pictureLoaded();
    expect(screen.getByRole('region', { name: 'Reveal items view double' })).toBeTruthy();
    expect(header()).not.toBeNull();
    expect(items()).toBeNull();
    expect(screen.queryAllByRole('heading', { level: 2 }).map((h) => h.textContent)).not.toContain('Fees');
    expect(document.querySelector('.sh-v2-top, .sh-v2-parts, .sh-v2-cards, .sh-v2-more')).toBeNull();
  });

  it('?view=reveal for a visitor, or on hidden art: the box as before', async () => {
    await page({ who: 'visitor', at: '/?view=reveal' });
    await pictureLoaded();
    expect(screen.queryByRole('region', { name: 'Reveal items view double' })).toBeNull();
    expect(items()).not.toBeNull();
    cleanup();
    await page({ at: '/?view=reveal', artMode: 2 });
    await pictureLoaded();
    expect(screen.queryByRole('region', { name: 'Reveal items view double' })).toBeNull();
    expect(items()).not.toBeNull();
    expect(entries()).toEqual([]);
  });

  it('a closed box (no Items card): the creator’s entry on its own in the parts', async () => {
    await page({ failed: true });
    await pictureLoaded();
    await waitFor(() => expect(entries()).toHaveLength(1));
    expect(items()).toBeNull();
    const entry = entries()[0] as HTMLElement;
    expect(header().contains(entry)).toBe(false);
    expect(entry.closest('.sh-v2-parts')).not.toBeNull();
  });
});
