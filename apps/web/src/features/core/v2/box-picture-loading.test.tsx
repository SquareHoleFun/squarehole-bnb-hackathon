/**
 * SH-255 round 3 (job290 finding 18, D17): while the picture's chunk loads, the page has one box header with its h1,
 * as both settled states have (the picture's head, or today's header when the chunk fails). The import never settles here.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AppProviders } from '../../../app-providers';
import { createDemoWalletAdapter } from '../../wallet';
import { V2BoxPage } from './V2BoxPage';
import { parseSnapshotV2 } from './indexer-v2';
import { recordV2 } from './record-v2';
import { publishedV2 } from './test-support/published-v2';

vi.mock('./picture/BoxPagePicture', () => new Promise(() => undefined));
vi.mock('./SafesV2', () => ({ SafesV2: () => null }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => null }));
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));
afterEach(cleanup);

it('loading: one header around the one h1, the box’s name', async () => {
  const published = await publishedV2();
  const view = { ...parseSnapshotV2(published.body, published.source), verified: true };
  render(<AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}><MemoryRouter><V2BoxPage record={recordV2(view, published.source, null, 'tUSDC')} /></MemoryRouter></AppProviders>);
  const h1 = await screen.findByRole('heading', { level: 1 });
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(h1.closest('header')).not.toBeNull();
  expect(document.querySelectorAll('section.sh-v2-page header')).toHaveLength(1);
});
