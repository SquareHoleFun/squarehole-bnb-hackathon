/**
 * SH-255 round 3 (job290 findings 8 and 9; the coordinator's D10, D11): each entry of What you can do here, pressed on
 * the real page with its real cards, puts focus on the control marked for it (the pile's Redeem amount, Claim all), and
 * is offered exactly where its card's own predicate says the action is there. No wallet is asked.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AppProviders } from '../../../app-providers';
import { createDemoWalletAdapter } from '../../wallet';
import { V2BoxPage } from './V2BoxPage';
import { parseSnapshotV2 } from './indexer-v2';
import { recordV2 } from './record-v2';
import { publishedPile } from './test-support/m3-published';
import { pictureLoaded } from './test-support/picture-loaded';
vi.mock('./SafesV2', () => ({ SafesV2: () => null }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => null }));
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function page(published: Awaited<ReturnType<typeof publishedPile>>) {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  const adapter = createDemoWalletAdapter({ latencyMs: 0 }); const connect = vi.spyOn(adapter, 'connect');
  const view = parseSnapshotV2(published.body, published.source);
  render(<AppProviders walletAdapter={adapter}><MemoryRouter><V2BoxPage record={recordV2(view, published.source)} /></MemoryRouter></AppProviders>);
  const picture = await pictureLoaded();
  const entries = picture.querySelector<HTMLElement>('.sh-bpic-do__entry')?.closest('section') ?? null;
  return { connect, picture, entries };
}

it('a graduated pile with Redeem open: Hand in lands on the Redeem amount, Claim on Claim all', async () => {
  const { connect, entries } = await page(await publishedPile());
  expect(entries).not.toBeNull();
  const handIn = within(entries as HTMLElement).getByRole('button', { name: /^Hand in / });
  fireEvent.click(handIn);
  const pile = screen.getByRole('region', { name: 'Coin pile' });
  expect(document.activeElement).toBe(within(pile).getByRole('textbox'));
  expect(document.activeElement?.getAttribute('data-entry-target')).toBe('pile');
  fireEvent.click(within(entries as HTMLElement).getByRole('button', { name: /^Claim/ }));
  expect(document.activeElement?.textContent).toBe('Claim all');
  expect(connect).not.toHaveBeenCalled();
});

it('a failed pile: no Redeem form, so no Hand in; Claim still leads to Claim all', async () => {
  const { entries } = await page(await publishedPile({ failed: true }));
  expect(screen.queryByRole('textbox', { name: /to redeem/ })).toBeNull();
  expect(within(entries as HTMLElement).queryByRole('button', { name: /^Hand in / })).toBeNull();
  fireEvent.click(within(entries as HTMLElement).getByRole('button', { name: /^Claim/ }));
  expect(document.activeElement?.textContent).toBe('Claim all');
});
