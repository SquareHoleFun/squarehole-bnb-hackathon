import { required } from './test-support/required';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../../app-providers';
import { parseSnapshotV2 } from './indexer-v2';
import { publishedV2 } from './test-support/published-v2';
import { SafesV2, readSafesV2 } from './SafesV2';
import { safeHistory } from './test-support/safe-history';
const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), readContract: vi.fn(), getBlock: vi.fn() }));
vi.mock('viem', async (original) => ({ ...await original<typeof import('viem')>(), createPublicClient: () => rpc }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('history offline')));
  const { source, body } = await publishedV2(); const view = parseSnapshotV2(body, source);
  const owners = [view.record.creator, view.token, view.record.q];
  rpc.getChainId.mockResolvedValue(source.manifest.chainId);
  rpc.getBlock.mockResolvedValue({ hash: view.blockHash });
  rpc.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => functionName === 'getOwners' ? owners : functionName === 'getThreshold' ? 2n : '1.4.1');
  return { source, view, owners };
}
describe('CQ11-E4 Safe ownership reads', () => {
  it('lists the two Safes\' actual payouts and reserves a plain place for the later bot log', async () => {
    await fixture();
    const { funded: { source, view } } = await safeHistory();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('history offline')));
    // SH-BOX-LIFE-VIEW: the page hands the panel its price coin's name.
    render(<AppProviders><SafesV2 source={source} view={view} coin="tUSDC" /></AppProviders>);
    expect(screen.getByRole('heading', { name: 'Safe payouts', hidden: true })).toBeTruthy();
    expect(screen.queryByText('Payment and conversion log')).toBeNull();
    expect(screen.getByText('Paid to FIT Safe · 900719925474099300.000001 tUSDC')).toBeTruthy();
    expect(screen.getByText('Paid to platform Safe · 2.000001 tUSDC')).toBeTruthy();
    expect(screen.queryByText(/conversion Safe/)).toBeNull();
    for (const p of view.safePayments) expect(screen.getAllByText(p.txHash).length).toBeGreaterThan(0);
    // Part 2 fix round (review finding 1): royalty P pays these Safes their fee shares; other royalty coins never.
    expect(screen.getByText('A payout is not a burn. After graduation, these Safes also get 2/15 and 1/15 of royalties in tUSDC; royalty coins other than tUSDC never reach a Safe.')).toBeTruthy();
    expect(screen.queryByText(/never in a Safe/)).toBeNull();
    expect(screen.getByText('Burns from the FIT Safe need a second owner’s signature.')).toBeTruthy();
    // Founder, 2026-11-12 (desk R79-WORDS): the site does not mention a platform cap, nor the lack of one.
    expect(screen.queryByText(/platform cap|cap on the platform/i)).toBeNull();
    expect(screen.getByText('The bot’s sales, funding and Safe burns will appear here once published.')).toBeTruthy();
    expect(screen.getByText(/need a second owner’s signature/).closest('details')?.open).toBe(false);
    // SH-V2-FE3: the closed disclosure hides the native marker, so its summary carries the chevron.
    expect(document.querySelector('details.sh-fit-details > summary > .sh-fit-details__chevron svg')).not.toBeNull();
  });

  it('shows exact on-chain FIT burns separately, and replaces orphaned burns after a corrected publication', async () => {
    await fixture();
    const { burned, corrected } = await safeHistory();
    for (const [data, amount] of [[burned, '900719.925474099300000003 FIT'], [corrected, '0.000000000000000007 FIT']] as const) {
      const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/activity') ? data.activity : data.feed)));
      vi.stubGlobal('fetch', fetcher);
      render(<AppProviders><SafesV2 source={data.source} view={data.view} /></AppProviders>);
      const log = await screen.findByRole('region', { name: 'FIT executor burns', hidden: true });
      expect(await within(log).findByText(amount)).toBeTruthy();
      expect(within(log).getByText('Shared across boxes; these burns are not attributed to this box.')).toBeTruthy();
      const burn = required(data.activity.items.find((item) => item.kind === 'buyback'));
      expect(within(log).getByText(String(burn.txHash))).toBeTruthy();
      expect(within(log).queryByText('999 FIT')).toBeNull();
      if (data === corrected) expect(within(log).queryByText('900719.925474099300000003 FIT')).toBeNull();
      cleanup();
    }
  });

  it('never counts a Safe payout or executor funding as a FIT burn', async () => {
    await fixture();
    const { funded } = await safeHistory();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/activity') ? funded.activity : funded.feed))));
    render(<AppProviders><SafesV2 source={funded.source} view={funded.view} /></AppProviders>);
    expect(await screen.findByText('No FIT executor burns in the latest 100 burn records.')).toBeTruthy();
  });

  it('reads both Safes at the indexer block and exposes owners, threshold and version', async () => {
    const { source, view, owners } = await fixture();
    render(<AppProviders><SafesV2 source={source} view={view} /></AppProviders>);
    expect(await screen.findAllByText('2 of 3 signatures · Safe 1.4.1')).toHaveLength(2);
    expect(screen.getAllByText(required(owners[0]))).toHaveLength(2);
    expect(rpc.readContract.mock.calls).toHaveLength(6);
    for (const [call] of rpc.readContract.mock.calls) expect(call.blockNumber).toBe(view.block);
  });
  it('refuses a different network, a changed block, or an impossible threshold', async () => {
    const { source, view } = await fixture();
    rpc.getChainId.mockResolvedValue(1); await expect(readSafesV2(source, view)).rejects.toThrow('Wrong RPC chain');
    rpc.getChainId.mockResolvedValue(source.manifest.chainId); rpc.getBlock.mockResolvedValue({ hash: '0x00' });
    await expect(readSafesV2(source, view)).rejects.toThrow('Safe read block changed');
    rpc.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => functionName === 'getOwners' ? [] : functionName === 'getThreshold' ? 2n : '1.4.1');
    await expect(readSafesV2(source, view)).rejects.toThrow('Invalid Safe threshold');
  });
});

describe('SH-245: the Safes card’s royalty sentence rests on these contract lines', () => {
  it('royalties are held until graduation and booked then; every booking pays FIT 2/15 and the platform 1/15', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
    const sol = (path: string) => readFileSync(join(root, 'packages/contracts/src/box-v2', path), 'utf8');
    expect(sol('BoxReceiverV2.sol')).toMatch(/if \(_failureSettled\) _toPot\(\);\s*else if \(_graduationSettled\) _bookRoyalty\(amount\);\s*else _p\[ROYALTY\] \+= amount;/);
    const books = sol('libraries/ReceiverBooksV21.sol');
    expect(books).toMatch(/uint256 amount = st\._p\[ROYALTY\];\s*st\._p\[ROYALTY\] = 0;\s*bookRoyalty\(st, pm, amount\);/);
    expect(books).toMatch(/function bookRoyalty\([^)]*\) public \{\s*split\(st, pm, amount, false\);/);
    expect(books).toMatch(/st\._p\[FIT\] \+= 2 \* unit;\s*st\._p\[PLATFORM\] \+= unit;/);
  });
});
