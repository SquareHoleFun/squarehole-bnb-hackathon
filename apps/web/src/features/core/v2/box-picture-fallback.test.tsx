/**
 * SH-255 second review (job288 R-14, R-21): when the picture's chunk cannot load, the page keeps today's header AND
 * today's three money cards (Fees, Buy-back progress, the Creator's claim), with their figures; the page's controls keep
 * their own places (no empty place for an entry, the actions group a direct child of its column as its rule expects).
 * The import fails here as a failed chunk does.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { formatUnits } from '@squarehole/domain';
import { AppProviders } from '../../../app-providers';
import { createDemoWalletAdapter } from '../../wallet';
import { V2BoxPage } from './V2BoxPage';
import { parseSnapshotV2 } from './indexer-v2';
import { recordV2 } from './record-v2';
import { publishedV2 } from './test-support/published-v2';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('./picture/BoxPagePicture', () => { throw new Error('Failed to fetch dynamically imported module'); });
vi.mock('./SafesV2', () => ({ SafesV2: () => <p>Safe read panel</p> }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => <p>Burn log panel</p> }));
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('R-14: a failed picture chunk keeps every figure of the cards it replaced', () => {
  it('today’s header, then Fees, Buy-back progress and the Creator’s claim with their figures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const published = await publishedV2();
    const view = { ...parseSnapshotV2(published.body, published.source), verified: true };
    const record = recordV2(view, published.source, null, 'tUSDC');
    render(<AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}><MemoryRouter><V2BoxPage record={record} /></MemoryRouter></AppProviders>);
    const cards = await waitFor(() => { const found = document.querySelector('[data-fallback-cards]'); if (!found) throw new Error('no fallback yet'); return found as HTMLElement; });
    expect(document.querySelector('.sh-v2-head')).not.toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const titles = [...cards.querySelectorAll('h2')].map((h) => h.textContent);
    expect(titles.slice(0, 2)).toEqual(['Fees', 'Buy-back progress']);
    expect(titles).toContain('Creator’s claim');
    expect(cards.textContent).toContain(`${formatUnits(view.buyBack.pSpent, view.decimals)} tUSDC`);
    expect(cards.textContent).toContain('Fee details');
  });
});

describe('R-21: an entry’s place never adds an empty grid item', () => {
  it('no place around the actions group; places only around controls that are there', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const published = await publishedV2();
    const view = { ...parseSnapshotV2(published.body, published.source), verified: true };
    render(<AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}><MemoryRouter><V2BoxPage record={recordV2(view, published.source, null, 'tUSDC')} /></MemoryRouter></AppProviders>);
    await waitFor(() => { if (!document.querySelector('.sh-v2-top__aside')) throw new Error('not yet'); });
    expect(document.getElementById('sh-box-place-actions')).toBeNull();
    // A place whose control draws nothing is :empty, which the page's rule takes out of the grid.
    for (const place of document.querySelectorAll('.sh-v2-place')) expect(place.childElementCount > 0 || place.matches(':empty'), place.id).toBe(true);
    const css = ['src/features/core/v2/v2-page.css', 'apps/web/src/features/core/v2/v2-page.css'].map((path) => resolve(process.cwd(), path)).find((path) => existsSync(path));
    const pageCss = readFileSync(css ?? 'v2-page.css', 'utf8');
    expect(pageCss.replace(/\s+/g, ' ')).toContain('.sh-v2-place:empty { display: none; }');
    // Round 3 (D17): the money cards' row, empty on a raising box without a hatch or a sweep, takes no grid gap either.
    expect(pageCss.replace(/\s+/g, ' ')).toContain('.sh-v2-cards:empty { display: none; }');
  });
});
