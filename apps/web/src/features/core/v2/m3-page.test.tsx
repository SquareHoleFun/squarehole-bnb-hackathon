/** M3-53 on the v2 box page: each side's in-vault rule in Fees, the item and pile panels, and no wallet on navigation. */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AppProviders } from '../../../app-providers';
import { createDemoWalletAdapter } from '../../wallet';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import { V2BoxPage } from './V2BoxPage';
import { parseSnapshotV2 } from './indexer-v2';
import { recordV2 } from './record-v2';
import { publishedItems, publishedPile } from './test-support/m3-published';
import { CLOSED_BOX_HEADINGS, feePlace, headingsUpTo, openPart, pictureLoaded } from './test-support/picture-loaded';
vi.mock('./SafesV2', () => ({ SafesV2: () => null }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => null }));
// SH-BOX-CANDLES: the chart's drawing (jsdom has no canvas).
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function page(published: Awaited<ReturnType<typeof publishedItems>> | Awaited<ReturnType<typeof publishedPile>>) {
  // No RPC answers here: the page must render from the publication alone and never ask a wallet.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  const adapter = createDemoWalletAdapter({ latencyMs: 0 }); const connect = vi.spyOn(adapter, 'connect');
  const view = parseSnapshotV2(published.body, published.source);
  render(<AppProviders walletAdapter={adapter}><MemoryRouter><V2BoxPage record={recordV2(view, published.source)} /></MemoryRouter></AppProviders>);
  return { connect };
}

it('M353-PAGE: an every-item box names each side’s in-vault rule and shows Item payouts, with no wallet request', async () => {
  const { connect } = await page(await publishedItems());
  // SH-255: each side's rule in Where the fees go (the Fees card's rows before it).
  expect(await feePlace('buyers')).toBe('To items · Keep');
  expect(await feePlace('sellers')).toBe('To items · Buy back and burn B352');
  const items = screen.getByRole('region', { name: 'Item payouts' });
  expect(within(items).getByText('Choose a wallet')).toBeTruthy();
  expect(within(items).getByText('1.25 ETH')).toBeTruthy();
  const vaultDetails = within(items).getByText('In the vault: Keep holds an item’s share as its stash until the item is out. Buy back and burn B352: the share buys and burns B352 in this box’s own pool.');
  expect(vaultDetails.closest('details')?.open).toBe(false);
  expect(screen.queryByRole('region', { name: 'Coin pile' })).toBeNull();
  expect(connect).not.toHaveBeenCalled(); expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button', { name: /^(buy|sell|swap)$/i })).toBeNull();
  expect(appCopyFraming(renderedCopy(document.body).map((text) => text.replace(/\bGrow the pool\b/g, 'Add to the pool')))).toEqual([]);
});

it('M353-PAGE: a coin pile box shows the pile and no item panel, with no wallet request', async () => {
  const { connect } = await page(await publishedPile());
  const pile = screen.getByRole('region', { name: 'Coin pile' });
  expect(within(pile).getByText('Redeem open')).toBeTruthy();
  expect(within(pile).getByText('Coins sent to the pile by mistake cannot be recovered.')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Item payouts' })).toBeNull();
  expect(connect).not.toHaveBeenCalled();
  expect(appCopyFraming(renderedCopy(document.body).map((text) => text.replace(/\bGrow the pool\b/g, 'Add to the pool')))).toEqual([]);
});

it('M353-PAGE: a failed pile puts the closing price first and the seed return beside it', async () => {
  await page(await publishedPile({ failed: true }));
  // SH-255: the closing price leads the picture's tiles and the page under the picture.
  const head = await pictureLoaded();
  expect(head.querySelector('.sh-box-stat dt')?.textContent).toBe('Closing price');
  // Review R-16: the whole order up to the closing price, the picture's own cards first and nothing else.
  expect(headingsUpTo('Closing price')).toEqual(CLOSED_BOX_HEADINGS);
  expect(within(screen.getByRole('region', { name: 'Coin pile' })).getByText('1000 ETH due')).toBeTruthy();
});

it('SH-V2-FE3: the price coin is named by its own name (SH-BOX-LIFE-VIEW: no "P = ETH" key), page disclosures show their marker, and the in-vault rule gets its own figure row', async () => {
  await page(await publishedItems());
  // SH-255: the Fees card's line is the buyers' sheet's on the picture.
  const panel = await openPart('buyers');
  expect(within(panel).getByText(/^1% of every trade: in ETH on buys, in .+ on sales$/)).toBeTruthy();
  expect(within(panel).queryByText(/^P = /)).toBeNull();
  expect(within(panel).queryByText(/P is /)).toBeNull();
  // The page's own closed disclosures hide the native marker (sh-fit-details), so each carries the chevron.
  const own = [...document.querySelectorAll('details.sh-fit-details')];
  expect(own.length).toBe(2); // held royalties, contract details (the burn log and Safes are mocked here; their own tests check theirs)
  for (const details of own) expect(details.querySelector(':scope > summary > .sh-fit-details__chevron svg')).not.toBeNull();
  const figures = [...screen.getByRole('region', { name: 'Item payouts' }).querySelectorAll('.sh-m3-figures > div')];
  expect(figures.map((figure) => figure.querySelector('dt')?.textContent)).toEqual(['Paid per item', 'Item ledger', 'In the vault']);
  expect(figures[2]?.classList.contains('sh-m3-figures__wide')).toBe(true);
});
