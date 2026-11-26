import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AppProviders } from '../../../app-providers';
import { createDemoWalletAdapter } from '../../wallet';
import { V2BoxPage } from './V2BoxPage';
import { parseSnapshotV2 } from './indexer-v2';
import { recordV2 } from './record-v2';
import { publishedM2, H } from './test-support/m2-published';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
vi.mock('./SafesV2', () => ({ SafesV2: () => null }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => null }));
// SH-BOX-CANDLES: the chart's drawing (jsdom has no canvas).
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));
import { CLOSED_BOX_HEADINGS, headingsUpTo, pictureLoaded } from './test-support/picture-loaded';
afterEach(cleanup);
async function page(failed = false, missing = false) {
  const { body, source } = await publishedM2(failed);
  const adapter = createDemoWalletAdapter({ latencyMs: 0 }); const connect = vi.spyOn(adapter, 'connect');
  const view = parseSnapshotV2(missing ? { ...body, money: null } : body, source);
  render(<AppProviders walletAdapter={adapter}><MemoryRouter><V2BoxPage record={recordV2(view, source)} /></MemoryRouter></AppProviders>);
  return { connect };
}
it('M253-READS: refuses M2 custody from another hash or a numeric budget', async () => {
  const { body, source } = await publishedM2();
  expect(() => parseSnapshotV2({ ...body, money: { ...body.money, m2: { ...body.money.m2, hash: H(999) } } }, source)).toThrow(/block/i);
  expect(() => parseSnapshotV2({ ...body, money: { ...body.money, m2: { ...body.money.m2, shop: { ...body.money.m2.shop, budgetT: 100 } } } }, source)).toThrow(/decimal/i);
});
it('M253-SHOP: shows exact budget, tier prices, list powers and actual starter progress', async () => {
  const { connect } = await page();
  const shop = screen.getByRole('region', { name: 'Shop' });
  // SH-297: beside the cards the budget short and cut ("900.71K B52"); every digit (SH-283) behind the (?), closed.
  expect(within(shop).getByText('Give budget', { selector: 'dt' }).nextElementSibling?.textContent).toBe('900.71K B52');
  expect(within(shop).getByRole('button', { name: 'About the shop' }).getAttribute('aria-expanded')).toBe('false');
  expect(within(shop).getByText(/^Give budget · 900,719\.925474099300000001 B52 · 3 items inside$/)).toBeTruthy();
  fireEvent.click(within(shop).getByRole('button', { name: 'About the shop' }));
  expect(within(shop).getByRole('table', { name: 'Fixed prices in B52' }).textContent).toContain('1.5');
  expect(within(shop).getByText(/10% per week/)).toBeTruthy();
  expect(within(shop).getByText(/2.5% per collection/)).toBeTruthy();
  // F132: both weekly limits never fall below one cheapest active give, within the week's budget snapshot.
  expect(within(shop).getByText(/2\.5% per collection · each at least one cheapest active give, within the week’s budget · 7 days/)).toBeTruthy();
  expect(within(shop).getByText(/7 days/)).toBeTruthy();
  expect(within(shop).getByText(/Renouncing freezes the list/)).toBeTruthy();
  expect(screen.getByRole('progressbar', { name: 'Starter items loaded' }).getAttribute('value')).toBe('3');
  expect(screen.getByText('3 / 10 items')).toBeTruthy();
  expect(screen.getByText('Waiting for starter items')).toBeTruthy();
  expect(connect).not.toHaveBeenCalled(); expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button', { name: /^(buy|sell|swap)$/i })).toBeNull();
});
it('M253-EXITS: closing price comes first; holder P and quarantined shop T stay separate', async () => {
  await page(true);
  // SH-255 round 3 (D13): the settled page (the picture loaded), its whole order up to the closing price.
  await pictureLoaded();
  expect(headingsUpTo('Closing price')).toEqual(CLOSED_BOX_HEADINGS);
  expect(screen.getByRole('region', { name: 'Holder fee share' }).textContent).toContain('No expiry');
  expect(screen.getByText('1,000 B52 awaiting burn')).toBeTruthy();
  expect(screen.getByText(/Starter items return only to the creator/)).toBeTruthy();
  expect(screen.getByText(/Holder fees stay separate from the closing claim/)).toBeTruthy();
});
it('M253-READS: unavailable custody stays unavailable, never a zero budget', async () => {
  await page(false, true);
  // SH-297: the budget figure beside the cards says Unavailable (was "Budget unavailable" in the panel's first line).
  expect(within(screen.getByRole('region', { name: 'Shop' })).getByText('Give budget', { selector: 'dt' }).nextElementSibling?.textContent).toBe('Unavailable');
  expect(screen.getByText('Loading progress unavailable')).toBeTruthy();
});
it('M253-WALLET: navigation does not connect; Claim all opens the wallet only when pressed', async () => {
  const { connect } = await page();
  expect(connect).not.toHaveBeenCalled(); expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Claim all' }));
  expect(await screen.findByRole('dialog')).toBeTruthy();
  expect(connect).not.toHaveBeenCalled();
});
it('M253-COPY: the M2 page uses the existing fee-share wording rule, including details', async () => {
  await page(true);
  expect(appCopyFraming(renderedCopy(document.body).map(text => text.replace(/\bGrow the pool\b/g, 'Add to the pool')))).toEqual([]);
});
