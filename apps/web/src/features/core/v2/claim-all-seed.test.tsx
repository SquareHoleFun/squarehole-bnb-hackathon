/**
 * M363-OC03 in Claim all: a failed coin pile's seed, owed to its recorded seeder, is one more claim of Claim all, in the
 * pile's own coin (never added to P), sent as returnSeed() to the pile role through the real shared sender. Only the
 * RPC answers, the claims index's answer, the listing book and the wallet are doubles; the wallet signs nothing.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { decodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { submitWrite } from '@squarehole/chain/write';
import { coordinatorV2Abi, pileVaultV2Abi, rolesOfV2 } from '../../../../../../packages/chain/src/core/v2';
import { assertSendableCallV2 } from '../../../../../../packages/chain/src/core/v2/write-calls-v2';
import { AppProviders } from '../../../app-providers';
import * as claimActions from './claim-all-actions';
import { ClaimAllV2 } from './ClaimAllV2';
import { claimsIndexIO } from './claims-index';
import { parseSnapshotV2 } from './indexer-v2';
import { m3Target } from './m3-actions';
import { B, ETH, H, publishedPile } from './test-support/m3-published';
import { m3RpcFixture } from './test-support/m3-rpc';
import { claimsBoxOfView, claimsPage } from './test-support/claims-page';
import { rpcFetch } from './test-support/rpc-fetch';
import { required } from './test-support/required';
import { TEST_FEE_READER } from '@squarehole/chain/write/test-support';

const USDC = '0x00000000000000000000000000000000000005dc' as Address;
const COINS = 3n * ETH;
const QUOTE = 3333333n;
const wallet = vi.hoisted(() => ({ account: '' as string | null, status: 'connected', chainId: 31337, kind: 'injected', defaultDialog: 'browser', signer: { request: vi.fn() } }));
vi.mock('../../wallet', async (original) => ({ ...await original<object>(), useWallet: () => wallet }));
vi.mock('../../create/v2/indexer-listings', async (original) => ({ ...await original<object>(),
  loadListingsV2: async () => [{ id: 2, token: USDC, decimals: 6, class: 3, kind: 1, raise: 15_986_524_323n, symbol: 'USDC', name: 'USDC', powers: [] }] }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
type Tx = { from: Address; to: Address; data: Hex; value: Hex };

/** A failed pile box seeded with 1000 USDC; the wallet is `who` (its seeder by default) and holds 3 of its coins. */
async function rig(who?: Address) {
  const published = await publishedPile({ failed: true, loaded: true, asset: USDC, seed: 1000_000000n });
  const view = parseSnapshotV2(published.body, published.source);
  const account = who ?? view.record.creator;
  wallet.account = account; wallet.status = 'connected'; wallet.chainId = 31337; wallet.kind = 'injected';
  wallet.signer.request.mockReset();
  let count = 0; let allowance = 0n;
  wallet.signer.request.mockImplementation(async ({ method, params }: { method: string; params?: readonly Tx[] }) => {
    if (method === 'eth_chainId') return '0x7a69';
    if (method !== 'eth_sendTransaction') return [wallet.account];
    const tx = required(params?.[0]);
    if (tx.data.startsWith('0x095ea7b3')) allowance = decodeFunctionData({ abi: erc20Abi, data: tx.data }).args[1] as bigint;
    return H(80 + ++count);
  });
  // The pile's own reads and the seed return go through the real M3 IO over this RPC double.
  const money = required(view.m3?.pileMoney);
  const rpc = m3RpcFixture({ pile: { asset: USDC, seeder: view.record.creator, seed: published.seed, balance: money.balance ?? 0n, supply: money.supply }, failed: true, receiptBlock: view.block + 3n });
  vi.stubGlobal('fetch', rpcFetch(rpc.request));
  // The hand-in's checks answer what the snapshot says, and the coins as the chain has them.
  vi.spyOn(claimActions, 'claimAllIO').mockImplementation((source, v, request) => {
    const answer = async (_to: Address, _abi: unknown, fn: string, args: readonly unknown[] = []) => ({
      balanceOf: COINS, allowance, quoteClaim: args[0] === 0n ? 0n : QUOTE, claimState: [v.closing?.pot ?? 0n, v.closing?.tLeft ?? 0n], failed: true,
    } as Record<string, unknown>)[fn];
    return { feeReader: TEST_FEE_READER, chainId: async () => source.manifest.chainId, request, simulate: async () => undefined, estimate: async () => 100000n, submit: submitWrite,
      receipt: async (hash: Hex) => ({ transactionHash: hash, blockNumber: v.block + 2n, blockHash: H(99), status: 'success' as const }), at: answer, now: answer, as: (_from: Address, to: Address, abi: unknown, fn: string, args?: readonly unknown[]) => answer(to, abi, fn, args) };
  });
  // The claims index lists this wallet's hand-in; the seed return is the snapshot's (the index has no seed row).
  vi.spyOn(claimsIndexIO, 'read').mockImplementation(async () => claimsPage({ chainId: 31337, wallet: account, block: view.block,
    rows: [{ box: claimsBoxOfView(view), row: { kind: 'failure', coins: COINS, amount: QUOTE } }] }));
  render(<AppProviders><MemoryRouter>
    <ClaimAllV2 scope="box" boxes={[{ key: 'pile', view, source: published.source, name: "Dragon's Hoard", symbol: 'ETH', ticker: 'HOARD', disabled: false }]} />
  </MemoryRouter></AppProviders>);
  return { view, source: published.source, account };
}
const panel = () => screen.getByRole('region', { name: 'Your claims' });
const listed = (group: Element) => Array.from(group.querySelectorAll('li')).map((li) => li.textContent);
const sends = (): Tx[] => wallet.signer.request.mock.calls.map(([call]) => call as { method: string; params?: readonly Tx[] })
  .filter((call) => call.method === 'eth_sendTransaction').map((call) => required(call.params?.[0]));

it('M363-OC03: the seeder’s Claim all includes the owed seed, in its own coin and total, after the hand-in, sent as returnSeed() to the pile', async () => {
  const { view, source, account } = await rig();
  expect(await within(panel()).findByText('2 ready')).toBeTruthy();
  // Two coins, two totals: P out of the pot, and the seed in USDC; never added up.
  expect(Array.from(panel().querySelectorAll('.sh-v2-claims__sum')).map((sum) => sum.textContent)).toEqual(['0.000000000003333333 ETH', ' · 1000 USDC']);
  fireEvent.click(within(panel()).getByRole('button', { name: 'Claim all' }));
  const confirm = within(panel()).getByRole('group', { name: 'Confirm Claim all' });
  expect(listed(confirm)).toEqual(['Approve coins3 HOARD', 'Hand in coins3 HOARD → for 0.000000000003333333 ETH', 'Seed return1000 USDC']);
  expect(confirm.textContent).toContain('3 signatures · one each');
  expect(confirm.textContent).toContain(`To ${account}`);
  expect(sends()).toHaveLength(0);
  fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm' }));
  expect(await within(panel()).findByText('3 / 3 done')).toBeTruthy();
  const roles = rolesOfV2(view.record).contracts; const target = m3Target(source, view);
  expect(sends().map((tx) => tx.to)).toEqual([view.token, roles.coordinator, roles.vault]);
  expect(decodeFunctionData({ abi: coordinatorV2Abi, data: required(sends()[1]).data })).toMatchObject({ functionName: 'claim', args: [COINS, account] });
  expect(decodeFunctionData({ abi: pileVaultV2Abi, data: required(sends()[2]).data })).toMatchObject({ functionName: 'returnSeed' });
  for (const tx of sends()) { expect(tx.from).toBe(account); expect(tx.value).toBe('0x0'); expect(() => assertSendableCallV2({ to: tx.to, data: tx.data, value: 0n }, target, account)).not.toThrow(); }
  // Recorded: nothing left to claim, and both show under Claimed.
  expect(await within(panel()).findByText('Nothing to claim')).toBeTruthy();
  const claimed = required(panel().querySelector('details.sh-v2-claimed'));
  expect(claimed.querySelector('summary')?.textContent).toBe('2 claimed');
  expect(listed(claimed)).toEqual(['Hand in coinsClaimed3 HOARD → for 0.000000000003333333 ETH', 'Seed returnClaimed1000 USDC']);
});

it('M363-OC03: another wallet’s Claim all never lists the seed (anyone may return it on chain; it is the seeder’s claim)', async () => {
  await rig(B);
  expect(await within(panel()).findByText('1 ready')).toBeTruthy();
  fireEvent.click(within(panel()).getByRole('button', { name: 'Claim all' }));
  expect(listed(within(panel()).getByRole('group', { name: 'Confirm Claim all' }))).toEqual(['Approve coins3 HOARD', 'Hand in coins3 HOARD → for 0.000000000003333333 ETH']);
  expect(screen.queryByText(/Seed return/)).toBeNull();
});
