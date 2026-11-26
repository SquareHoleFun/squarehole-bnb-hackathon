/**
 * The item payouts panel (M3-53, F127 claim-only): one row and one Claim per item this wallet holds (Claim all moved to
 * the page's "Your claims" panel, F128: claim-all-panel.test.tsx), Sync when the ledger is behind, and item-claims.ts's rule, through the real panel, query cache, M3-52
 * readers (over a viem client) and the shared sender. Only the RPC answers and the wallet are doubles.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { decodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import { InsufficientGasFundsError, NotSendableError } from '@squarehole/chain/write';
import { AppProviders } from '../../../app-providers';
import { encodeBoxSpecV2, itemLedgerV2Abi } from '../../../../../../packages/chain/src/core/v2';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import { ItemPayoutsV2 } from './ItemPayoutsV2';
import { parseSnapshotV2 } from './indexer-v2';
import * as m3 from './m3-actions';
import { m3RpcFixture, type M3RpcOptions } from './test-support/m3-rpc';
import { A, B, ETH, H, publishedItems } from './test-support/m3-published';
import { rpcFetch } from './test-support/rpc-fetch';
import { required } from './test-support/required';

const wallet = vi.hoisted(() => ({ account: '' as string | null, status: 'connected', chainId: 31337, kind: 'injected', defaultDialog: 'browser', signer: { request: vi.fn() } }));
vi.mock('../../wallet', async (original) => ({ ...await original<object>(), useWallet: () => wallet }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const original = m3.m3ActionIO;

async function rig(options: { rpc?: M3RpcOptions; decimals?: number; rejectAt?: number; refuse?: boolean; poor?: boolean } = {}) {
  wallet.account = A; wallet.status = 'connected'; wallet.chainId = 31337; wallet.kind = 'injected';
  wallet.signer.request.mockReset();
  // The test wallet signs nothing: it answers a fresh hash per send, or declines the `rejectAt`-th one (4001).
  let count = 0;
  wallet.signer.request.mockImplementation(async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') return '0x7a69';
    if (method !== 'eth_sendTransaction') return [wallet.account];
    count += 1;
    if (options.rejectAt === count) throw Object.assign(new Error('User rejected'), { code: 4001 });
    return H(80 + count);
  });
  const { body, source, at } = await publishedItems({ decimals: options.decimals });
  const view = parseSnapshotV2(body, source);
  const rpc = m3RpcFixture({ owners: { '1': A, '2': A }, credits: { '1': [ETH / 4n, ETH], '2': [ETH / 4n + 1n, 0n] }, vault: at(3), ...options.rpc });
  vi.stubGlobal('fetch', rpcFetch(rpc.request));
  // With `refuse`, the shared sender's guard refuses the call before the wallet (as for any call it does not admit).
  if (options.refuse) vi.spyOn(m3, 'm3ActionIO').mockImplementation((s, v, r) => ({ ...original(s, v, r), submit: (async () => {
    throw new NotSendableError('v2 action must target its prepared box role');
  }) as m3.M3ActionIO['submit'] }));
  // With `poor`, the shared sender's funds check refuses the call before the wallet (SH-SEND-FEES).
  if (options.poor) vi.spyOn(m3, 'm3ActionIO').mockImplementation((s, v, r) => ({ ...original(s, v, r), submit: (async () => {
    throw new InsufficientGasFundsError(2n, 1n, 11_155_111);
  }) as m3.M3ActionIO['submit'] }));
  const tree = () => <AppProviders><MemoryRouter><ItemPayoutsV2 view={view} source={source} symbol="ETH" ticker="B352" disabled={false} /></MemoryRouter></AppProviders>;
  const rendered = render(tree());
  return { view, rpc, rerender: () => rendered.rerender(tree()) };
}
const panel = () => screen.getByRole('region', { name: 'Item payouts' });
const row = (id: number) => required(Array.from(panel().querySelectorAll('li')).find((li) => new RegExp(`^Item #${id}\\b`).test(li.querySelector('.sh-m2-batch')?.textContent ?? '')));
const findRow = (id: number) => waitFor(() => row(id));
const claimButton = (id: number) => screen.queryByRole('button', { name: `Claim item ${id}` });
type Tx = { from: Address; to: Address; data: Hex; value: Hex };
/** Every transaction the wallet was asked to send, in order (a declined one included). */
const sends = (): Tx[] => wallet.signer.request.mock.calls.map(([call]) => call as { method: string; params?: readonly Tx[] })
  .filter((call) => call.method === 'eth_sendTransaction').map((call) => required(call.params?.[0]));
async function claim(id: number) {
  fireEvent.click(required(claimButton(id)));
  fireEvent.click(within(screen.getByRole('group', { name: 'Confirm claim' })).getByRole('button', { name: 'Confirm' }));
}

it('M353-ITEMS: reads without the wallet; only this wallet’s items out of the vault, each with its exact claimable and stash', async () => {
  const { rpc } = await rig();
  expect(await within(panel()).findByText('2 ready')).toBeTruthy();
  expect(within(row(1)).getByText('1.25 ETH')).toBeTruthy();
  expect(within(row(1)).getByText(/stash 1 ETH/)).toBeTruthy();
  expect(within(row(2)).getByText('0.250000000000000001 ETH')).toBeTruthy();
  expect(within(panel()).queryByText(/^Item #3/)).toBeNull();
  expect(within(panel()).getByText('1.500000000000000001 ETH')).toBeTruthy();
  expect(within(panel()).getByText('Paid per item').nextElementSibling?.textContent).toBe('1.25 ETH');
  expect(within(panel()).getByText('In the vault').nextElementSibling?.textContent).toBe('Buyers Keep · Sellers Buy back and burn B352');
  expect(within(panel()).getByText('Item ledger').nextElementSibling?.textContent).toBe('5.5 ETH');
  expect(wallet.signer.request).not.toHaveBeenCalled();
  const reads = rpc.calls.filter((c) => c.method === 'eth_call');
  expect(reads.length).toBeGreaterThan(0);
  for (const call of reads) expect(call.params?.[1]).toEqual({ blockHash: (await publishedItems()).body.asOf.hash, requireCanonical: true });
});

it.each([[6, '1250000000000', '250000000000.000001'], [8, '12500000000', '2500000000.00000001']] as const)('M353-ITEMS: exact %i-decimal P', async (decimals, one, two) => {
  await rig({ decimals });
  await within(panel()).findByText('2 ready');
  expect(within(row(1)).getByText(`${one} ETH`)).toBeTruthy();
  expect(within(row(2)).getByText(`${two} ETH`)).toBeTruthy();
});

it.each<[string, string, M3RpcOptions]>([
  ['a ledger behind its records', 'Needs sync', { synced: false }],
  ['a paused payout', 'Paused', { payout: 'paused' }],
  ['an unanswered simulation', 'Not checked', { payout: 'offline' }],
])('M353-STATES: %s shows %s and no Claim button', async (_name, label, rpc) => {
  await rig({ rpc });
  expect(await within(await findRow(1)).findByText(label)).toBeTruthy();
  expect(claimButton(1)).toBeNull();
  // F128: Claim all lives on the page's "Your claims" panel, not here.
  expect(screen.queryByRole('button', { name: 'Claim all' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Sync' }) !== null).toBe(label === 'Needs sync');
});

it('M353-STATES: an item moved to another wallet has no row here', async () => {
  await rig({ rpc: { owners: { '1': B, '2': A } } });
  await within(panel()).findByText('1 ready');
  expect(within(panel()).queryByText(/^Item #1/)).toBeNull();
  expect(row(2)).toBeTruthy();
});

it('M353-INTEGRATION: a guard refusal sends nothing, and the note says nothing reached the wallet', async () => {
  await rig({ refuse: true }); await within(panel()).findByText('2 ready');
  await claim(1);
  expect(await within(panel()).findByText('Item #1 not sent. Nothing reached your wallet.')).toBeTruthy();
  expect(sends()).toHaveLength(0);
  expect(within(row(1)).getByText('Ready')).toBeTruthy();
  expect(within(panel()).queryByText(/cannot send/)).toBeNull();
});

it('F127 / M353-INTEGRATION: one claim per item through the shared sender: the wallet sends claim([id], wallet) to the item ledger; then Claimed', async () => {
  const r = await rig(); await within(panel()).findByText('2 ready');
  expect(wallet.signer.request).not.toHaveBeenCalled();
  await claim(1);
  expect(await within(row(1)).findByText('Claimed')).toBeTruthy();
  expect(claimButton(1)).toBeNull();
  expect(sends()).toHaveLength(1);
  const tx = required(sends()[0]);
  expect(tx.to).toBe(r.view.claimRow?.contracts.itemLedger); expect(tx.from).toBe(A); expect(tx.value).toBe('0x0');
  expect(decodeFunctionData({ abi: itemLedgerV2Abi, data: tx.data })).toMatchObject({ functionName: 'claim', args: [[1n], A] });
  expect(within(panel()).getByText('1 ready')).toBeTruthy();
});

it('M353-SYNC: Sync reaches the wallet as sync(32) to the item ledger; a guard refusal sends nothing', async () => {
  const r = await rig({ rpc: { synced: false } });
  await within(await findRow(1)).findByText('Needs sync');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sync' })));
  expect(await within(panel()).findByText('Synced. Reading the updated box…')).toBeTruthy();
  expect(sends()).toHaveLength(1);
  const tx = required(sends()[0]);
  expect(tx.to).toBe(r.view.claimRow?.contracts.itemLedger); expect(tx.from).toBe(A); expect(tx.value).toBe('0x0');
  expect(decodeFunctionData({ abi: itemLedgerV2Abi, data: tx.data })).toMatchObject({ functionName: 'sync', args: [32n] });
  cleanup(); vi.restoreAllMocks();
  await rig({ rpc: { synced: false }, refuse: true });
  await within(await findRow(1)).findByText('Needs sync');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sync' })));
  expect(await within(panel()).findByText('Sync not sent. Nothing reached your wallet.')).toBeTruthy();
  expect(sends()).toHaveLength(0);
});

it('M353-WALLET: another network cannot claim; no wallet means no rows and no request', async () => {
  const r = await rig(); await within(panel()).findByText('2 ready');
  wallet.chainId = 1; await act(async () => r.rerender());
  expect((required(claimButton(1)) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Use a browser wallet on this box’s network.')).toBeTruthy();
  wallet.chainId = 31337; wallet.status = 'disconnected'; wallet.account = null; await act(async () => r.rerender());
  expect(within(panel()).getByText('Choose a wallet')).toBeTruthy();
  expect(within(panel()).queryByRole('button')).toBeNull();
  expect(wallet.signer.request).not.toHaveBeenCalled();
});

it('M353-COPY: the panel and its details pass the app wording rule; explanations stay behind Details', async () => {
  await rig(); await within(panel()).findByText('2 ready');
  expect(appCopyFraming(renderedCopy(panel()))).toEqual([]);
  const details = required(panel().querySelector('details'));
  expect(details.open).toBe(false);
  expect(details.textContent).toMatch(/one hidden pool/);
  expect(details.textContent).toMatch(/picked just before a payout/);
  expect(details.textContent).toContain('In the vault: Keep holds an item’s share as its stash until the item is out. Buy back and burn B352: the share buys and burns B352 in this box’s own pool.');
  const visible = Array.from(panel().querySelectorAll('p')).filter((p) => !p.closest('details'));
  expect(visible.every((p) => (p.textContent ?? '').split(/[.!?]\s/).length <= 1)).toBe(true);
});

it('M363-OC01: 26 items of this wallet (the indexer’s owner list) are read twelve at a time; More items reaches every one; another wallet’s item is never asked for', async () => {
  wallet.account = A; wallet.status = 'connected'; wallet.chainId = 31337; wallet.kind = 'injected';
  wallet.signer.request.mockReset();
  const { body, source, at } = await publishedItems();
  // A 30-item collection: the spec and the record's spec hash follow, as on a real box.
  const boxRow = body.row as unknown as { encodedSpec: Hex; record: { specHash: Hex } } & Record<string, unknown>;
  const decodedRow = parseSnapshotV2(body, source).claimRow;
  const spec = { ...required(decodedRow).spec, n: 30 };
  const encodedSpec = encodeBoxSpecV2(spec);
  const ids = Array.from({ length: 27 }, (_, i) => i + 1);
  const m3 = body.m3 as unknown as { items: Record<string, unknown> };
  const items = { ...m3.items,
    items: Object.fromEntries(ids.map((id) => [String(id), { inside: false, sequence: String(id) }])),
    // M3-52b: the indexer's current owners. Item 27 is another wallet's.
    owners: Object.fromEntries(ids.map((id) => [String(id), (id === 27 ? B : A).toLowerCase()])) };
  const published = { ...body, row: { ...boxRow, encodedSpec, record: { ...boxRow.record, specHash: keccak256(encodedSpec) } }, m3: { ...m3, items } };
  const view = parseSnapshotV2(published, source);
  const owners = Object.fromEntries(ids.map((id) => [String(id), id === 27 ? B : A]));
  const credits = Object.fromEntries(ids.map((id) => [String(id), [BigInt(id), 0n] as const]));
  const rpc = m3RpcFixture({ owners, credits, vault: at(3) });
  vi.stubGlobal('fetch', rpcFetch(rpc.request));
  render(<AppProviders><MemoryRouter><ItemPayoutsV2 view={view} source={source} symbol="ETH" ticker="B352" disabled={false} /></MemoryRouter></AppProviders>);
  const rows = () => panel().querySelectorAll('ul[aria-label="Items"] > li').length;
  await waitFor(() => expect(rows()).toBe(12));
  // The items whose owner was read (the scan, then each full read checks its owner again).
  const ownerReads = () => new Set(rpc.calls.filter((c) => c.method === 'eth_call' && (c.params?.[0] as { data: Hex }).data.startsWith('0x6352211e'))
    .map((c) => BigInt(`0x${(c.params?.[0] as { data: Hex }).data.slice(10)}`)));
  expect(ownerReads().size).toBe(12);
  fireEvent.click(screen.getByRole('button', { name: 'More items, page 2 of 3' }));
  await waitFor(() => expect(rows()).toBe(24));
  fireEvent.click(screen.getByRole('button', { name: 'More items, page 3 of 3' }));
  await waitFor(() => expect(rows()).toBe(26));
  // Every one of this wallet's items has its row; item 27's owner was never read.
  for (const id of ids.slice(0, 26)) expect(row(id)).toBeTruthy();
  expect([...ownerReads()].sort((a, b) => (a < b ? -1 : 1))).toEqual(ids.slice(0, 26).map(BigInt));
  expect(within(panel()).getByText('26 ready')).toBeTruthy();
  expect(wallet.signer.request).not.toHaveBeenCalled();
});

it('SH-SEND-FEES: a wallet short of gas: the claim and Sync say not sent and the gas line, and nothing reaches the wallet', async () => {
  await rig({ poor: true }); await within(panel()).findByText('2 ready');
  await claim(1);
  expect(await within(panel()).findByText('Item #1 not sent. Needs a little more SepETH for gas.')).toBeTruthy();
  expect(sends()).toHaveLength(0);
  cleanup(); vi.restoreAllMocks();
  await rig({ rpc: { synced: false }, poor: true });
  await within(await findRow(1)).findByText('Needs sync');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sync' })));
  expect(await within(panel()).findByText('Sync not sent. Needs a little more SepETH for gas.')).toBeTruthy();
  expect(sends()).toHaveLength(0);
});
