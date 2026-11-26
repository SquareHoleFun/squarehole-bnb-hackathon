/**
 * FINAL-OC01 through the real Claim all panel: the creator's fees are the receiver's next payment, read as the payee at
 * the displayed snapshot (`readCreatorClaimV2` over this site's RPC reads, answered by the M3 RPC double), never the
 * stored creatorOwed. After a claim the panel shows what `CreatorClaimed` paid, and the next snapshot's quote decides
 * what is left. A failed quote is "Unavailable", never 0. The index is unavailable here (the direct scan runs); the
 * wallet signs nothing and records what it was asked to send.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import { submitWrite } from '@squarehole/chain/write';
import { receiverV2Abi, rolesOfV2 } from '../../../../../../packages/chain/src/core/v2';
import { AppProviders } from '../../../app-providers';
import * as claimActions from './claim-all-actions';
import { ClaimAllV2 } from './ClaimAllV2';
import { claimsIndexIO } from './claims-index';
import { parseSnapshotV2, type V2Snapshot } from './indexer-v2';
import { A, H } from './test-support/m2-published';
import { publishedItems } from './test-support/m3-published';
import { m3RpcFixture } from './test-support/m3-rpc';
import { rpcFetch } from './test-support/rpc-fetch';
import { required } from './test-support/required';
import { TEST_FEE_READER } from '@squarehole/chain/write/test-support';

const wallet = vi.hoisted(() => ({ account: '' as string | null, status: 'connected', chainId: 31337, kind: 'injected', defaultDialog: 'browser', signer: { request: vi.fn() } }));
vi.mock('../../wallet', async (original) => ({ ...await original<object>(), useWallet: () => wallet }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const CAP = 4n * ((1n << 127n) - 1n);
type Tx = { from: Address; to: Address; data: Hex; value: Hex };

/** One graduated item box whose payee is this wallet, its stored creatorOwed `stored`, and a chain quoting `next`. */
async function rig(stored: bigint, next: bigint, { refuse = false } = {}) {
  const chain = { next, refuse, paid: null as bigint | null, head: 0n };
  wallet.account = A; wallet.status = 'connected'; wallet.chainId = 31337; wallet.kind = 'injected';
  wallet.signer.request.mockReset();
  let sent = 0;
  wallet.signer.request.mockImplementation(async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') return '0x7a69';
    if (method !== 'eth_sendTransaction') return [wallet.account];
    sent += 1; return H(80 + sent);
  });
  const { body, source, at } = await publishedItems();
  const parsed = parseSnapshotV2(body, source);
  let view: V2Snapshot = { ...parsed, money: { ...required(parsed.money), creatorPayee: A, creatorOwed: stored } };
  const receiver = rolesOfV2(view.record).contracts.receiver as Address;
  chain.head = view.block + 1n;
  const rpc = m3RpcFixture({ vault: at(3), creator: { payee: A, owed: stored, next: () => chain.next, refuse: () => chain.refuse } });
  vi.stubGlobal('fetch', rpcFetch(rpc.request));
  vi.spyOn(claimsIndexIO, 'read').mockRejectedValue(new Error('wallet claims HTTP 404'));
  // The send's own re-checks answer from the same chain; its receipt carries the receiver's CreatorClaimed.
  vi.spyOn(claimActions, 'claimAllIO').mockImplementation((src, v, request) => {
    const answer = async (_to: Address, _abi: unknown, fn: string) => ({ creatorPayee: A, graduated: v.graduated, failed: v.failed !== null } as Record<string, unknown>)[fn];
    const logs = () => (chain.paid === null ? [] : [{ address: receiver, topics: encodeEventTopics({ abi: receiverV2Abi, eventName: 'CreatorClaimed', args: { payee: A, token: v.record.q } }),
      data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [A, chain.paid]) }]);
    return { feeReader: TEST_FEE_READER, chainId: async () => src.manifest.chainId, request, simulate: async () => undefined, estimate: async () => 100000n, submit: submitWrite,
      receipt: async (hash: Hex) => ({ transactionHash: hash, blockNumber: chain.head, blockHash: H(99), status: 'success' as const, logs: logs() }),
      at: answer, now: answer, as: async (_from: Address, _to: Address, _abi: unknown, fn: string) => (fn === 'claimCreator' ? chain.next : undefined) };
  });
  const tree = () => <AppProviders><MemoryRouter>
    <ClaimAllV2 scope="box" boxes={[{ key: 'items', view, source, name: 'Item box', symbol: 'ETH', ticker: 'B352', disabled: false }]} />
  </MemoryRouter></AppProviders>;
  const rendered = render(tree());
  return { chain, receiver, view: () => view, rpc,
    advance: (block: bigint) => { view = { ...view, block, blockHash: H(Number(block)) }; rendered.rerender(tree()); } };
}

const panel = () => screen.getByRole('region', { name: 'Your claims' });
const sends = (): Tx[] => wallet.signer.request.mock.calls.map(([call]) => call as { method: string; params?: readonly Tx[] })
  .filter((call) => call.method === 'eth_sendTransaction').map((call) => required(call.params?.[0]));
const value = () => panel().querySelector('.sh-v2-value')?.textContent;
const claimedRows = () => Array.from(panel().querySelectorAll('details.sh-v2-claimed li')).map((li) => li.textContent);
const eth = (raw: bigint) => `${raw / 10n ** 18n}.${(raw % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '')} ETH`;
const confirmAll = async () => {
  fireEvent.click(within(panel()).getByRole('button', { name: 'Claim all' }));
  const group = within(panel()).getByRole('group', { name: 'Confirm Claim all' });
  const listed = Array.from(group.querySelectorAll('li')).map((li) => li.textContent);
  fireEvent.click(within(group).getByRole('button', { name: 'Confirm' }));
  return listed;
};

it('FINAL-OC01 lazy royalties: creatorOwed is 0, the receiver pays 1,234; Claim all lists and sends 1,234 raw units', async () => {
  const r = await rig(0n, 1234n);
  expect(await within(panel()).findByText('1 ready')).toBeTruthy();
  expect(value()).toBe('0.000000000000001234 ETH');
  // The quote is the payee's own simulated claimCreator, at the displayed hash.
  const simulated = r.rpc.calls.filter((c) => c.method === 'eth_call' && (c.params?.[0] as { data: Hex }).data.startsWith('0x') && (c.params?.[0] as { from?: string }).from?.toLowerCase() === A.toLowerCase());
  expect(simulated.length).toBeGreaterThan(0);
  expect(simulated.every((c) => (c.params?.[1] as { blockHash?: Hex }).blockHash === r.view().blockHash)).toBe(true);
  r.chain.paid = 1234n;
  expect(await confirmAll()).toEqual(['Creator fees0.000000000000001234 ETH']);
  expect(await within(panel()).findByText('1 / 1 done')).toBeTruthy();
  expect(sends()).toHaveLength(1);
  expect(sends()[0]?.to).toBe(r.receiver);
  expect(claimedRows()).toEqual(['Creator feesClaimed0.000000000000001234 ETH']);
});

it('FINAL-OC01 the four-part bound: stored CAP + 7, the claim pays CAP (its CreatorClaimed), then the next snapshot offers the 7-unit tail', async () => {
  const r = await rig(CAP + 7n, CAP);
  expect(await within(panel()).findByText('1 ready')).toBeTruthy();
  // The receipt says the receiver paid CAP - 1 (fees moved between the quote and the block): Claimed shows that.
  r.chain.paid = CAP - 1n;
  expect(await confirmAll()).toEqual([`Creator fees${eth(CAP)}`]);
  expect(await within(panel()).findByText('1 / 1 done')).toBeTruthy();
  expect(claimedRows()).toEqual([`Creator feesClaimed${eth(CAP - 1n)}`]);
  r.chain.next = 7n;
  await act(async () => r.advance(r.view().block + 1n));
  expect(await within(panel()).findByText('1 ready')).toBeTruthy();
  expect(value()).toBe('0.000000000000000007 ETH');
  r.chain.paid = 7n; r.chain.head = r.view().block + 1n;
  expect(await confirmAll()).toEqual(['Creator fees0.000000000000000007 ETH']);
  expect(await within(panel()).findByText('1 / 1 done')).toBeTruthy();
  // Exhausted: the receiver quotes 0 at the next snapshot, so there is nothing to claim.
  r.chain.next = 0n;
  await act(async () => r.advance(r.view().block + 1n));
  await waitFor(() => expect(within(panel()).getByText('Nothing to claim')).toBeTruthy());
  expect(sends()).toHaveLength(2);
});

it('FINAL-OC01: a quote the chain refuses is Unavailable with a Retry, never 0, and nothing is offered or sent', async () => {
  const r = await rig(5n, 5n, { refuse: true }); void r.view;
  expect(await within(panel()).findByText('Unavailable')).toBeTruthy();
  expect(value()).toBe('— ETH');
  expect(within(panel()).getByRole('button', { name: 'Some reads failed. Retry' })).toBeTruthy();
  expect((within(panel()).getByRole('button', { name: 'Claim all' }) as HTMLButtonElement).disabled).toBe(true);
  r.chain.refuse = false;
  fireEvent.click(within(panel()).getByRole('button', { name: 'Some reads failed. Retry' }));
  expect(await within(panel()).findByText('1 ready')).toBeTruthy();
  expect(sends()).toHaveLength(0);
});
