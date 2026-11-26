/**
 * RC6RR-FC-3 through the real Claim all panel (SH-V21-RC6-INT part 5): a failed box nobody bought, whose creator was
 * paid once, and P that reached the box's inbox afterwards. Since RC6-RR-INBOX the coordinator's claimState and
 * quoteClaim(0) preview readable inbox P, as claim(0) takes it, so the wallet claims index and the bounded direct scan
 * both list the creator remainder again, with the inbox P its claim first moves into the pot; the claim is
 * claim(0, creator) on the coordinator, and Claimed shows what the coordinator's Claimed event paid, not the preview.
 * Native and ERC-20 P; empty controls. Only the RPC edge (claimAllIO), the index's answer and the wallet are doubles.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress, zeroAddress, type Address, type Hex } from 'viem';
import { submitWrite } from '@squarehole/chain/write';
import { coordinatorV2Abi, rolesOfV2 } from '../../../../../../packages/chain/src/core/v2';
import { AppProviders } from '../../../app-providers';
import * as claimActions from './claim-all-actions';
import { ClaimAllV2 } from './ClaimAllV2';
import { claimsIndexIO } from './claims-index';
import { parseSnapshotV2, type V2Snapshot } from './indexer-v2';
import { claimsBoxOfView, claimsPage } from './test-support/claims-page';
import { publishedV2 } from './test-support/published-v2';
import { required } from './test-support/required';
import { TEST_FEE_READER } from '@squarehole/chain/write/test-support';

const wallet = vi.hoisted(() => ({ account: '' as string | null, status: 'connected', chainId: 31337, kind: 'injected', defaultDialog: 'browser', signer: { request: vi.fn() } }));
vi.mock('../../wallet', async (original) => ({ ...await original<object>(), useWallet: () => wallet }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const A = '0x00000000000000000000000000000000000000a1' as Address;
const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
type Tx = { from: Address; to: Address; data: Hex; value: Hex };
type Coin = { readonly q: Address | null; readonly decimals: number; readonly symbol: string };
const USDC: Coin = { q: null, decimals: 6, symbol: 'USDC' };
const NATIVE: Coin = { q: zeroAddress, decimals: 18, symbol: 'ETH' };

/**
 * The box nobody bought: its creator is this wallet, the first claim paid `first` at an earlier block, and `late` raw P
 * waits in the inbox (claimState and quoteClaim(0) both count it). `index`: the claims index answers (else the scan).
 */
async function rig(coin: Coin, late: bigint, first: bigint, options: { index?: boolean; open?: boolean; paid?: bigint } = {}) {
  wallet.account = A; wallet.status = 'connected'; wallet.chainId = 31337; wallet.kind = 'injected';
  wallet.signer.request.mockReset();
  let sent = 0;
  wallet.signer.request.mockImplementation(async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') return '0x7a69';
    if (method !== 'eth_sendTransaction') return [wallet.account];
    sent += 1; return H(80 + sent);
  });
  const { body, source } = await publishedV2(true);
  const parsed = parseSnapshotV2(body, source);
  const record = { ...parsed.record, creator: A, ...(coin.q !== null ? { q: coin.q } : {}) };
  const view: V2Snapshot = { ...parsed, verified: true, stale: false, record, decimals: coin.decimals,
    closing: { pot: late, initialT: 0n, tLeft: 0n, creatorEntitlement: late, inboxP: late } };
  const coordinator = required(rolesOfV2(view.record).contracts.coordinator);
  const head = view.block + 2n;
  const box = claimsBoxOfView(view);
  vi.spyOn(claimsIndexIO, 'read').mockImplementation(async () => {
    if (!options.index) throw new Error('wallet claims HTTP 404');
    return claimsPage({ chainId: 31337, wallet: A, block: view.block, hash: view.blockHash, rows: [
      ...(options.open === false ? [] : [{ box, row: { kind: 'no_buyer' as const, amount: late, inboxP: late } }]),
      { box, row: { kind: 'no_buyer' as const, amount: first, paid: { block: view.block - 3n, tx: H(61) } } },
    ] });
  });
  // The coordinator's views as merged: the late inbox P is previewed; the receipt's Claimed says what was paid.
  const paid = options.paid ?? late;
  vi.spyOn(claimActions, 'claimAllIO').mockImplementation((src, _view, request) => {
    const answer = async (_to: Address, _abi: unknown, fn: string) => ({ claimState: [late, 0n], quoteClaim: late, failed: true } as Record<string, unknown>)[fn];
    const logs = [{ address: coordinator, topics: encodeEventTopics({ abi: coordinatorV2Abi, eventName: 'Claimed', args: { holder: A, to: A } }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [0n, paid]) }];
    return { feeReader: TEST_FEE_READER, chainId: async () => src.manifest.chainId, request, simulate: async () => undefined, estimate: async () => 100000n, submit: submitWrite,
      receipt: async (hash: Hex) => ({ transactionHash: hash, blockNumber: head, blockHash: H(99), status: 'success' as const, logs }),
      at: answer, now: answer, as: async () => { throw new Error('not a creator fee claim'); } } as unknown as claimActions.ClaimAllIO;
  });
  render(<AppProviders><MemoryRouter>
    <ClaimAllV2 scope="box" boxes={[{ key: 'late', view, source, name: 'Late box', symbol: coin.symbol, ticker: 'B9', disabled: false }]} />
  </MemoryRouter></AppProviders>);
  return { view, coordinator };
}

const panel = () => screen.getByRole('region', { name: 'Your claims' });
const sends = (): Tx[] => wallet.signer.request.mock.calls.map(([call]) => call as { method: string; params?: readonly Tx[] })
  .filter((call) => call.method === 'eth_sendTransaction').map((call) => required(call.params?.[0]));
const claimedRows = () => Array.from(panel().querySelectorAll('details.sh-v2-claimed li')).map((li) => li.textContent);
const confirmList = () => {
  fireEvent.click(within(panel()).getByRole('button', { name: 'Claim all' }));
  const group = within(panel()).getByRole('group', { name: 'Confirm Claim all' });
  return { group, listed: Array.from(group.querySelectorAll('li')).map((li) => li.textContent) };
};

it.each([[USDC, 77_000_000n, '77 USDC', 997_000n, '0.997 USDC'], [NATIVE, 77n * 10n ** 18n, '77 ETH', 10n ** 18n, '1 ETH']] as const)(
  'RC6RR-FC-3 (%s): a creator paid before sees the late inbox P from the index, with its note, and claims it with claim(0)', async (coin, late, shown, first, firstShown) => {
    const r = await rig(coin, late, first, { index: true });
    expect(await within(panel()).findByText('1 ready')).toBeTruthy();
    expect(within(panel()).queryByText('Direct chain read')).toBeNull();
    // The index's newer read (amount at block A after the receipt at A - 3) decides: the remainder is ready again.
    expect(claimedRows()).toEqual([]);
    void firstShown;
    const { group, listed } = confirmList();
    expect(listed).toEqual([`Creator remainder${shown}Includes ${shown} the claim first moves from the inbox.`]);
    fireEvent.click(within(group).getByRole('button', { name: 'Confirm' }));
    expect(await within(panel()).findByText('1 / 1 done')).toBeTruthy();
    expect(sends().map((tx) => [tx.to, decodeFunctionData({ abi: coordinatorV2Abi, data: tx.data })])).toEqual([[r.coordinator, { functionName: 'claim', args: [0n, getAddress(A)] }]]);
    expect(sends()[0]?.value).toBe('0x0');
    await waitFor(() => expect(claimedRows()).toEqual([`Creator remainderClaimed${shown}`]));
  });

it('RC6RR-FC-3: with the index unavailable, the direct scan lists the same remainder and note from the snapshot', async () => {
  await rig(USDC, 77_000_000n, 997_000n);
  expect(await within(panel()).findByText('1 ready')).toBeTruthy();
  expect(within(panel()).getByText('Direct chain read')).toBeTruthy();
  expect(confirmList().listed).toEqual(['Creator remainder77 USDCIncludes 77 USDC the claim first moves from the inbox.']);
});

it('RC6RR-FC-3: a blocked intake pays only the established part, and Claimed shows the coordinator’s Claimed, not the preview', async () => {
  await rig(USDC, 77_000_000n, 997_000n, { index: true, paid: 40_000_000n });
  expect(await within(panel()).findByText('1 ready')).toBeTruthy();
  fireEvent.click(within(confirmList().group).getByRole('button', { name: 'Confirm' }));
  expect(await within(panel()).findByText('1 / 1 done')).toBeTruthy();
  await waitFor(() => expect(claimedRows()).toEqual(['Creator remainderClaimed40 USDC']));
});

it('RC6RR-FC-3 empty control: with nothing late in the inbox the index lists only the receipt, and nothing is offered or sent', async () => {
  await rig(USDC, 77_000_000n, 997_000n, { index: true, open: false });
  await waitFor(() => expect(within(panel()).getByText('Nothing to claim')).toBeTruthy());
  expect(claimedRows()).toEqual(['Creator remainderClaimed0.997 USDC']);
  expect((within(panel()).getByRole('button', { name: 'Claim all' }) as HTMLButtonElement).disabled).toBe(true);
  expect(sends()).toHaveLength(0);
});
