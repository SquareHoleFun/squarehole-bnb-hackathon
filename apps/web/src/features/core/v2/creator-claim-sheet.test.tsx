/**
 * SH-255 review fixes (8): the creator's claim in its sheet with a connected sample wallet. The sheet's figure is the
 * payee's own quote whoever is connected (cq11-page.test.tsx walks nothing to claim, ready, unavailable and Claimed);
 * this adds the payee connected on the wrong network (the page's line, the sheet's figure unchanged, Confirm shut) and
 * the payee connected on the box's network (Confirm open). (A failed box's "held until graduation." is SH-253's to
 * change, on the text-fixes branch.)
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AppProviders } from '../../../app-providers';
import { createDemoWalletAdapter } from '../../wallet';
import { V2BoxPage } from './V2BoxPage';
import { parseSnapshotV2, type V2Snapshot } from './indexer-v2';
import { recordV2 } from './record-v2';
import { publishedV2 } from './test-support/published-v2';
import { m3RpcFixture } from './test-support/m3-rpc';
import { rpcFetch } from './test-support/rpc-fetch';
import { openPart } from './test-support/picture-loaded';
const wallet = vi.hoisted(() => ({ account: null as string | null, status: 'disconnected', chainId: 0, kind: 'injected', defaultDialog: 'browser', signer: { request: vi.fn() } }));
vi.mock('../../wallet', async (original) => ({ ...await original<object>(), useWallet: () => wallet }));
vi.mock('./SafesV2', () => ({ SafesV2: () => null }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => null }));
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Object.assign(wallet, { account: null, status: 'disconnected', chainId: 0 }); });

async function page(patch: Partial<V2Snapshot>) {
  const { body, source } = await publishedV2();
  const view = { ...parseSnapshotV2(body, source), verified: true, ...patch };
  render(<AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}><MemoryRouter><V2BoxPage record={recordV2(view, source, null, 'tUSDC')} /></MemoryRouter></AppProviders>);
  return { view, source };
}
const panel = () => screen.getByRole('heading', { level: 2, name: 'Creator’s claim' }).closest('section') as HTMLElement;

it('the payee on the wrong network: the page says so, the sheet keeps the quote, Confirm stays shut; on the box’s network it opens', async () => {
  const { body, source } = await publishedV2();
  const payee = body.money?.values['receiver.creatorPayee'] as `0x${string}`;
  vi.stubGlobal('fetch', rpcFetch(m3RpcFixture({ creator: { payee, owed: 0n, next: () => 1234n } }).request));
  Object.assign(wallet, { account: payee, status: 'connected', chainId: source.manifest.chainId + 1 });
  await page({ failed: null, graduated: true, closing: null });
  await openPart('creator');
  expect(await within(panel()).findByText('0.001234 tUSDC')).toBeTruthy();
  // The page's actions say it (and Claim all, beside them, says the same for its own claims).
  expect(screen.getAllByText('Connect a browser wallet on this box’s network.').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Claim creator fees' }));
  expect((within(screen.getByRole('group', { name: 'Confirm transaction' })).getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(true);
  cleanup();
  Object.assign(wallet, { chainId: source.manifest.chainId });
  await page({ failed: null, graduated: true, closing: null, block: 104n, blockHash: `0x${'0'.repeat(62)}68` });
  await openPart('creator');
  expect(await within(panel()).findByText('0.001234 tUSDC')).toBeTruthy();
  expect(screen.queryAllByText('Connect a browser wallet on this box’s network.')).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Claim creator fees' }));
  expect((within(screen.getByRole('group', { name: 'Confirm transaction' })).getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(false);
});
