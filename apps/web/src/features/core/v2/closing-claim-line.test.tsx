/**
 * SH-255 round 3b (job294 finding 3, G1): the chain suites' failure check looks for the exact claim line; this holds
 * the builder they use (e2e/core-v2-chain/claim-line.mjs) to what the page prints in Claim details, coin included.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AppProviders } from '../../../app-providers';
import { createDemoWalletAdapter } from '../../wallet';
import { V2BoxPage } from './V2BoxPage';
import { parseSnapshotV2 } from './indexer-v2';
import { recordV2 } from './record-v2';
import { publishedM2 } from './test-support/m2-published';
import { pictureLoaded } from './test-support/picture-loaded';
import { required } from './test-support/required';
import { claimPotLine } from '../../../../e2e/core-v2-chain/claim-line.mjs';
vi.mock('./SafesV2', () => ({ SafesV2: () => null }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => null }));
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));
afterEach(cleanup);

it('the failed box’s Claim details line is the chain helper’s, coin included', async () => {
  const { body, source } = await publishedM2(true);
  const view = parseSnapshotV2(body, source);
  const record = recordV2(view, source);
  render(<AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}><MemoryRouter><V2BoxPage record={record} /></MemoryRouter></AppProviders>);
  await pictureLoaded();
  const closing = required(view.closing ?? null);
  const line = claimPotLine({ pot: closing.pot, left: closing.tLeft, decimals: view.decimals, coin: record.pairAsset });
  expect(line).toMatch(/^Claim pot \S+ \S+ · \S+ coins left$/);
  expect(within(screen.getByRole('region', { name: 'Failure claim' })).getByText(line)).toBeTruthy();
});
