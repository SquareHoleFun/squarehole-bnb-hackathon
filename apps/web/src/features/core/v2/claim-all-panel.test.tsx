/**
 * F128 "Your claims": one Claim all for every claim a wallet has, through the real panel, query cache, claim-state
 * rules and shared sender (`submitWrite`). Only the RPC edge (holderActionIO, claimAllIO, the M3 RPC double), the
 * wallet claims index's answer (claimsIndexIO) and the wallet are doubles; the wallet signs nothing and records what it
 * was asked to send. Unless a test gives the index an answer, it is unavailable (an older gateway without the route),
 * so those tests run the bounded direct scan (SH-V2-FE4), marked "Direct chain read" (SH-V2-FE5).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { decodeFunctionData, encodeErrorResult, erc20Abi, type Address, type Hex } from 'viem';
import { submitWrite } from '@squarehole/chain/write';
import { coordinatorV2Abi, holderLedgerV2Abi, itemLedgerV2Abi, receiverV2Abi, rolesOfV2 } from '../../../../../../packages/chain/src/core/v2';
import { assertSendableCallV2 } from '../../../../../../packages/chain/src/core/v2/write-calls-v2';
import { AppProviders } from '../../../app-providers';
import * as actions from './actions-v2';
import * as claimActions from './claim-all-actions';
import { ClaimAllV2 } from './ClaimAllV2';
import { claimsIndexIO } from './claims-index';
import type { WalletClaimsPageV2 } from '../../../../../../packages/chain/src/core/v2/claims-reader';
import { claimsBoxOfView, claimsPage, claimsPageJson } from './test-support/claims-page';
import { walletClaimsPageSchemaV2 } from '../../../../../../packages/chain/src/core/v2/claims-types';
import type { ClaimBoxV2 } from './claim-reads';
import { HolderEarningsV2 } from './HolderEarningsV2';
import { parseSnapshotV2, type V2Snapshot, type V2Source } from './indexer-v2';
import { m3Target } from './m3-actions';
import { publishedM2, A, H } from './test-support/m2-published';
import { ETH, publishedItems } from './test-support/m3-published';
import { m3RpcFixture } from './test-support/m3-rpc';
import { rpcFetch } from './test-support/rpc-fetch';
import { required } from './test-support/required';
import { TEST_FEE_READER, testFeeReader } from '@squarehole/chain/write/test-support';

const wallet = vi.hoisted(() => ({ account: '' as string | null, status: 'connected', chainId: 31337, kind: 'injected', defaultDialog: 'browser', signer: { request: vi.fn() } }));
vi.mock('../../wallet', async (original) => ({ ...await original<object>(), useWallet: () => wallet }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

type Tx = { from: Address; to: Address; data: Hex; value: Hex };
const COINS = 3n * ETH;
const QUOTE = 3333333n;

function gate() {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/** The chain the doubles answer from; an approval the wallet sends raises what the coordinator may take. */
function chainState() {
  return { credit: new Map<bigint, bigint>(), allowance: 0n, head: 0n, gates: new Map<number, Promise<void>>(), rejectAt: 0,
    /** What the payee's own claimCreator pays (FINAL-OC01: the only basis); null: the receiver's creatorOwed. */
    creatorPayout: null as bigint | null,
    /** The holder reads' hashes, in order: the scan's and each send's re-check. */
    holderReads: [] as Hex[] };
}
type Views = { readonly holder: V2Snapshot; readonly items: V2Snapshot | null };
type Index = (views: Views) => WalletClaimsPageV2;

/** `collectFirst`: P waiting in the failed box's inbox, so the chain's quoteClaim refuses the final share (RC6 R1-3). */
async function rig(options: { batches?: readonly string[]; paid?: readonly string[]; items?: boolean; payeeIsWallet?: boolean; index?: Index; holderPanel?: boolean; collectFirst?: bigint; balance?: bigint } = {}) {
  const chain = chainState();
  wallet.account = A; wallet.status = 'connected'; wallet.chainId = 31337; wallet.kind = 'injected';
  wallet.signer.request.mockReset();
  let sent = 0;
  wallet.signer.request.mockImplementation(async ({ method, params }: { method: string; params?: readonly Tx[] }) => {
    if (method === 'eth_chainId') return '0x7a69';
    if (method !== 'eth_sendTransaction') return [wallet.account];
    sent += 1;
    await chain.gates.get(sent);
    if (chain.rejectAt === sent) throw Object.assign(new Error('User rejected'), { code: 4001 });
    const tx = required(params?.[0]);
    if (tx.data.startsWith('0x095ea7b3')) chain.allowance = decodeFunctionData({ abi: erc20Abi, data: tx.data }).args[1] as bigint;
    return H(80 + sent);
  });
  // The failed holder box (M2): batches, and coins to hand in.
  const m2 = await publishedM2(true); const parsed = parseSnapshotV2(m2.body, m2.source);
  const history = required(parsed.m2?.history); const recorded = required(history.batches['1']);
  const batches = options.batches ?? ['1', '2', '3'];
  for (const id of batches) chain.credit.set(BigInt(id), options.paid?.includes(id) ? 0n : 60000001n);
  let holderView: V2Snapshot = { ...parsed, m2: { money: parsed.m2?.money ?? null, history: { ...history, batches: Object.fromEntries(batches.map((id) => [id, recorded])) } } };
  // RC6 (R1-3): a box with an income inbox at role 8 (the synthetic M2 box has none), whose P waits.
  if (options.collectFirst !== undefined) holderView = { ...holderView, record: { ...holderView.record, contracts: holderView.record.contracts.map((a, i) => (i === 8 ? '0x00000000000000000000000000000000000ee008' : a)) } };
  chain.head = holderView.block + 2n;
  const receipt = async (hash: Hex) => ({ transactionHash: hash, blockNumber: chain.head, blockHash: H(99), status: 'success' as const });
  vi.spyOn(actions, 'holderActionIO').mockImplementation((_source, v, request) => ({
    feeReader: options.balance === undefined ? TEST_FEE_READER : testFeeReader({ balance: options.balance }), chainId: async () => m2.source.manifest.chainId, request, simulate: async () => undefined, estimate: async () => 100000n, submit: submitWrite, receipt,
    claim: async (batch: bigint, holder: Address): Promise<actions.HolderClaimV2> => {
      const claimableP = chain.credit.get(batch) ?? 0n; chain.holderReads.push(v.blockHash);
      return { hash: v.blockHash, batchId: batch, holder, status: 'settled', hookClosed: true, fundingFinal: true, fundingP: 100000000n, complete: true,
        holderCursor: 3n, noticeCursor: 0n, residueP: 20000000n, claimableP, failedBox: true, payout: claimableP > 0n ? 'available' : 'empty' };
    },
  }) as unknown as actions.HolderActionIO);
  // The creator's claims and the hand-in read what each box's snapshot says, and the coins as the chain has them.
  vi.spyOn(claimActions, 'claimAllIO').mockImplementation((source, v, request) => {
    const answer = async (_to: Address, _abi: unknown, fn: string, args: readonly unknown[] = []) => {
      if (fn === 'quoteClaim' && options.collectFirst !== undefined && args[0] === (v.closing?.tLeft ?? 0n)) {
        throw Object.assign(new Error('execution reverted'), { data: encodeErrorResult({ abi: coordinatorV2Abi, errorName: 'ClaimFailed' }) });
      }
      return ({
        balanceOf: COINS, allowance: chain.allowance, quoteClaim: args[0] === 0n ? 0n : QUOTE, claimState: [v.closing?.pot ?? 0n, v.closing?.tLeft ?? 0n],
        failed: v.failed !== null, graduated: v.graduated, creatorPayee: v.money?.creatorPayee, creatorOwed: [v.money?.creatorOwed ?? 0n, 0n],
        pendingPriceCoin: options.collectFirst ?? 0n,
      } as Record<string, unknown>)[fn];
    };
    return { feeReader: options.balance === undefined ? TEST_FEE_READER : testFeeReader({ balance: options.balance }), chainId: async () => source.manifest.chainId, request, simulate: async () => undefined, estimate: async () => 100000n, submit: submitWrite, receipt, at: answer, now: answer,
      as: async (_from: Address, to: Address, abi: unknown, fn: string, args: readonly unknown[] = []) => (fn === 'claimCreator' ? chain.creatorPayout ?? v.money?.creatorOwed ?? 0n : answer(to, abi, fn, args)) };
  });
  const holderSource = m2.source as V2Source;
  const boxes: ClaimBoxV2[] = [{ key: 'holders', view: holderView, source: holderSource, name: 'Shop box', symbol: 'USDC', ticker: 'B52', disabled: false }];
  let itemsView: V2Snapshot | null = null;
  if (options.items) {
    const { body, source, at } = await publishedItems();
    const view = parseSnapshotV2(body, source);
    itemsView = options.payeeIsWallet && view.money ? { ...view, money: { ...view.money, creatorPayee: A } } : view;
    // FINAL-OC01: the receiver books 5 more on the claim than its creatorOwed view says; the chain's quote decides.
    const next = (view.money?.creatorOwed ?? 0n) + 5n;
    if (options.payeeIsWallet) chain.creatorPayout = next;
    const rpc = m3RpcFixture({ owners: { '1': A, '2': A }, credits: { '1': [ETH / 4n, ETH], '2': [ETH / 4n + 1n, 0n] }, vault: at(3), receiptBlock: 500n,
      ...(options.payeeIsWallet ? { creator: { payee: A, owed: next } } : {}) });
    vi.stubGlobal('fetch', rpcFetch(rpc.request));
    boxes.push({ key: 'items', view: itemsView, source, name: 'Item box', symbol: 'ETH', ticker: 'B352', disabled: false });
  }
  // The wallet claims index: unavailable unless the test answers it (then every answer is the test's current page).
  const index = vi.spyOn(claimsIndexIO, 'read').mockImplementation(async () => {
    if (!options.index) throw new Error('wallet claims HTTP 404');
    return options.index({ holder: holderView, items: itemsView });
  });
  const scope = options.items ? 'wallet' as const : 'box' as const;
  const tree = () => <AppProviders><MemoryRouter>
    <ClaimAllV2 scope={scope} boxes={boxes.map((b) => (b.key === 'holders' ? { ...b, view: holderView } : b))} />
    {options.holderPanel === false ? null : <HolderEarningsV2 view={holderView} source={holderSource} symbol="USDC" disabled={false} />}
  </MemoryRouter></AppProviders>;
  const rendered = render(tree());
  return {
    chain, index, holderView: () => holderView, itemsView, holderSource,
    rerender: () => rendered.rerender(tree()),
    advance: (block: bigint) => { holderView = { ...holderView, block, blockHash: H(Number(block)) }; rendered.rerender(tree()); },
  };
}

const panel = () => screen.getByRole('region', { name: 'Your claims' });
const holders = () => screen.getByRole('region', { name: 'Holder fee share' });
const holderRow = (batch: number) => required(within(holders()).getByText(`Batch ${batch}`).closest('li'));
const sends = (): Tx[] => wallet.signer.request.mock.calls.map(([call]) => call as { method: string; params?: readonly Tx[] })
  .filter((call) => call.method === 'eth_sendTransaction').map((call) => required(call.params?.[0]));
const decoded = (tx: Tx) => { for (const abi of [holderLedgerV2Abi, itemLedgerV2Abi, erc20Abi, receiverV2Abi, coordinatorV2Abi]) { try { return decodeFunctionData({ abi, data: tx.data }); } catch { /* next */ } } throw new Error('unknown call'); };
const listed = (group: Element) => Array.from(group.querySelectorAll('li')).map((li) => li.textContent);
const open = () => { fireEvent.click(within(panel()).getByRole('button', { name: 'Claim all' })); return within(panel()).getByRole('group', { name: 'Confirm Claim all' }); };

it('F128: lists every claim with its amount before the first signature, the hand-in with coins in and P out; no wallet request yet', async () => {
  await rig();
  expect(await within(panel()).findByText('4 ready')).toBeTruthy();
  expect(within(panel()).getByText('183.333336 USDC')).toBeTruthy();
  // The index is unavailable here: the bounded direct scan stands in, marked as such.
  expect(within(panel()).getByText('Direct chain read')).toBeTruthy();
  expect(wallet.signer.request).not.toHaveBeenCalled();
  const confirm = open();
  expect(listed(confirm)).toEqual(['Batch 160.000001 USDC', 'Batch 260.000001 USDC', 'Batch 360.000001 USDC', 'Approve coins3 B52', 'Hand in coins3 B52 → for 3.333333 USDC']);
  expect(confirm.textContent).toContain('5 signatures · one each');
  expect(confirm.textContent).toContain(`To ${A}`);
  expect(wallet.signer.request).not.toHaveBeenCalled();
});

it('F128: through the real shared sender, one signature per transaction in list order: three holder claims, the approval, the hand-in', async () => {
  const r = await rig();
  await within(panel()).findByText('4 ready');
  const second = gate(); r.chain.gates.set(2, second.promise);
  fireEvent.click(within(open()).getByRole('button', { name: 'Confirm' }));
  expect(await within(panel()).findByText('Claiming 2 / 5')).toBeTruthy();
  expect(within(holderRow(1)).getByText('Claimed')).toBeTruthy();
  await act(async () => { second.open(); await second.promise; });
  expect(await within(panel()).findByText('5 / 5 done')).toBeTruthy();
  const view = r.holderView(); const target = m3Target(r.holderSource, view);
  const roles = rolesOfV2(view.record).contracts;
  expect(sends().map((tx) => [tx.to, decoded(tx).functionName, decoded(tx).args])).toEqual([
    [roles.holderLedger, 'claim', [1n, A]], [roles.holderLedger, 'claim', [2n, A]], [roles.holderLedger, 'claim', [3n, A]],
    [view.token, 'approve', [roles.coordinator, COINS]], [roles.coordinator, 'claim', [COINS, A]],
  ]);
  for (const tx of sends()) { expect(tx.from).toBe(A); expect(tx.value).toBe('0x0'); expect(() => assertSendableCallV2({ to: tx.to, data: tx.data, value: 0n }, target, A)).not.toThrow(); }
  // The holder rows follow the same session: each payout shows Claimed, and nothing is left for Claim all.
  for (const batch of [1, 2, 3]) expect(within(holderRow(batch)).getByText('Claimed')).toBeTruthy();
  await waitFor(() => expect(within(panel()).getByText('Nothing to claim')).toBeTruthy());
  expect((within(panel()).getByRole('button', { name: 'Claim all' }) as HTMLButtonElement).disabled).toBe(true);
});

it('F128 stop rule: the first transaction that does not confirm stops the run; nothing after it is sent and it all stays claimable', async () => {
  const r = await rig(); await within(panel()).findByText('4 ready');
  r.chain.rejectAt = 2;
  fireEvent.click(within(open()).getByRole('button', { name: 'Confirm' }));
  expect(await within(panel()).findByText('Batch 2 not confirmed · 1 / 5 done · the rest stay claimable')).toBeTruthy();
  expect(sends()).toHaveLength(2);
  expect(within(holderRow(1)).getByText('Claimed')).toBeTruthy();
  expect(within(holderRow(2)).getByText('Ready')).toBeTruthy(); expect(within(holderRow(3)).getByText('Ready')).toBeTruthy();
  expect(within(panel()).getByText('3 ready')).toBeTruthy();
  expect(r.chain.allowance).toBe(0n);
});

it('F128: a changed amount since the confirmation sends nothing and asks for a fresh look', async () => {
  const r = await rig({ batches: ['1', '2'] }); await within(panel()).findByText('3 ready');
  const confirm = open();
  r.chain.credit.set(2n, 5n);
  await act(async () => r.advance(r.holderView().block + 1n));
  await waitFor(() => expect(within(holderRow(2)).getByText('0.000005 USDC')).toBeTruthy());
  fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm' }));
  expect(await within(panel()).findByText('Changed. Review and confirm again.')).toBeTruthy();
  expect(sends()).toHaveLength(0);
});

it('F128: no wallet means the wallet window on Claim all, never a request; another network cannot claim', async () => {
  const r = await rig(); await within(panel()).findByText('4 ready');
  wallet.chainId = 1; await act(async () => r.rerender());
  expect((within(panel()).getByRole('button', { name: 'Claim all' }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(panel()).getByText('Use a browser wallet on this box’s network.')).toBeTruthy();
  wallet.chainId = 31337; wallet.status = 'disconnected'; wallet.account = null; await act(async () => r.rerender());
  expect(within(panel()).getByText('Choose a wallet')).toBeTruthy();
  fireEvent.click(within(panel()).getByRole('button', { name: 'Claim all' }));
  expect(await screen.findByRole('dialog')).toBeTruthy();
  expect(wallet.signer.request).not.toHaveBeenCalled();
});

it('F128 across the wallet: box after box, each box’s claims together, items and the creator’s fees included', async () => {
  const r = await rig({ items: true, payeeIsWallet: true });
  expect(await within(panel()).findByText('7 ready')).toBeTruthy();
  // Different coins are never added up. The creator's fees are the receiver's next payment (creatorOwed + 5), FINAL-OC01.
  expect(panel().querySelector('.sh-v2-value')?.textContent).toBe('183.333336 USDC · 900721.425474099300000007 ETH');
  const confirm = open();
  expect(within(confirm).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Shop box', 'Item box']);
  expect(listed(within(confirm).getByRole('list', { name: 'Claims on Item box' }))).toEqual(['Item #11.25 ETH', 'Item #20.250000000000000001 ETH', 'Creator fees900719.925474099300000006 ETH']);
  expect(confirm.textContent).toContain('8 signatures · one each');
  fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm' }));
  expect(await within(panel()).findByText('8 / 8 done')).toBeTruthy();
  const items = required(r.itemsView); const itemRoles = rolesOfV2(items.record).contracts; const holderRoles = rolesOfV2(r.holderView().record).contracts;
  expect(sends().map((tx) => [tx.to, decoded(tx).functionName])).toEqual([
    [holderRoles.holderLedger, 'claim'], [holderRoles.holderLedger, 'claim'], [holderRoles.holderLedger, 'claim'],
    [r.holderView().token, 'approve'], [holderRoles.coordinator, 'claim'],
    [itemRoles.itemLedger, 'claim'], [itemRoles.itemLedger, 'claim'], [itemRoles.receiver, 'claimCreator'],
  ]);
  expect(decoded(required(sends()[5])).args).toEqual([[1n], A]);
  expect(decoded(required(sends()[7])).args).toEqual([items.record.q, A]);
});

/** The index's answer for the holder box: batches 1..3 and the hand-in, as the FE4 scan reads them, at block `block`. */
const holderRows = (holder: V2Snapshot, batches: readonly bigint[]) => [
  ...batches.map((batch) => ({ box: claimsBoxOfView(holder), row: { kind: 'holder' as const, batch, amount: 60000001n } })),
  { box: claimsBoxOfView(holder), row: { kind: 'failure' as const, coins: COINS, amount: QUOTE } },
];

it('SH-V2-FE5: from the claims index, one answer lists every claim; nothing is scanned, and each send re-checks at the index block', async () => {
  let paid = false;
  const r = await rig({ holderPanel: false, index: ({ holder }) => (paid
    // After the run: the index has the payments, at a later block, and nothing left to claim.
    ? claimsPage({ chainId: 31337, wallet: A, block: holder.block + 3n, rows: [1n, 2n, 3n].map((batch) => ({ box: claimsBoxOfView(holder), row: { kind: 'holder' as const, batch, amount: 60000001n, paid: { block: holder.block + 2n, tx: H(80 + Number(batch)) } } })) })
    : claimsPage({ chainId: 31337, wallet: A, block: holder.block, hash: H(71), rows: holderRows(holder, [1n, 2n, 3n]) })) });
  expect(await within(panel()).findByText('4 ready')).toBeTruthy();
  expect(within(panel()).queryByText('Direct chain read')).toBeNull();
  // No scan read: the list is the index's.
  expect(r.chain.holderReads).toEqual([]);
  expect(listed(open())).toEqual(['Batch 160.000001 USDC', 'Batch 260.000001 USDC', 'Batch 360.000001 USDC', 'Approve coins3 B52', 'Hand in coins3 B52 → for 3.333333 USDC']);
  fireEvent.click(within(panel()).getByRole('button', { name: 'Confirm' }));
  expect(await within(panel()).findByText('5 / 5 done')).toBeTruthy();
  // Each holder claim re-read its batch at the index's own hash before the wallet was asked.
  expect(r.chain.holderReads).toEqual([H(71), H(71), H(71)]);
  expect(sends()).toHaveLength(5);
  paid = true;
  await act(async () => { await r.index.mock.results.at(-1)?.value; });
  await waitFor(() => expect(within(panel()).getByText('Nothing to claim')).toBeTruthy());
  expect(r.index).toHaveBeenCalledTimes(2);
});

it('SH-V2-FE5: the index’s recent payments keep "Claimed" after a reload, on Claim all and on the holder rows', async () => {
  // A fresh page (no session): batches 1 and 2 were paid at earlier blocks, batch 3 is still claimable.
  await rig({ paid: ['1', '2'], index: ({ holder }) => claimsPage({ chainId: 31337, wallet: A, block: holder.block, rows: [
    { box: claimsBoxOfView(holder), row: { kind: 'holder', batch: 1n, amount: 60000001n, paid: { block: holder.block - 5n, tx: H(61) } } },
    { box: claimsBoxOfView(holder), row: { kind: 'holder', batch: 2n, amount: 60000001n, paid: { block: holder.block - 4n, tx: H(62) } } },
    { box: claimsBoxOfView(holder), row: { kind: 'holder', batch: 3n, amount: 60000001n } },
  ] }) });
  expect(await within(panel()).findByText('1 ready')).toBeTruthy();
  const claimed = required(panel().querySelector('details.sh-v2-claimed'));
  expect(claimed.querySelector('summary')?.textContent).toBe('2 claimed');
  expect(listed(claimed)).toEqual(['Batch 1Claimed60.000001 USDC', 'Batch 2Claimed60.000001 USDC']);
  await waitFor(() => { for (const batch of [1, 2]) expect(within(holderRow(batch)).getByText('Claimed')).toBeTruthy(); });
  expect(listed(open())).toEqual(['Batch 360.000001 USDC']);
});

it('SH-V2-FE5: an unavailable index falls back to the scan, marked; after a run it is asked again and takes over', async () => {
  let up = false;
  const r = await rig({ batches: ['1'], holderPanel: false, index: ({ holder }) => {
    if (!up) throw new Error('wallet claims HTTP 503');
    const box = claimsBoxOfView(holder); const paid = { block: holder.block + 2n, tx: H(81) };
    return claimsPage({ chainId: 31337, wallet: A, block: holder.block + 3n, rows: [
      { box, row: { kind: 'holder', batch: 1n, amount: 60000001n, paid } },
      { box, row: { kind: 'failure', coins: COINS, amount: QUOTE, paid: { ...paid, logIndex: 1 } } },
    ] });
  } });
  expect(await within(panel()).findByText('2 ready')).toBeTruthy();
  expect(within(panel()).getByText('Direct chain read')).toBeTruthy();
  up = true;
  fireEvent.click(within(open()).getByRole('button', { name: 'Confirm' }));
  expect(await within(panel()).findByText('3 / 3 done')).toBeTruthy();
  await waitFor(() => expect(within(panel()).queryByText('Direct chain read')).toBeNull());
  expect(within(panel()).getByText('Nothing to claim')).toBeTruthy();
  expect(required(panel().querySelector('details.sh-v2-claimed summary')).textContent).toBe('2 claimed');
  expect(r.index.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it('SH-V2-FE5 across the wallet: the index lists both boxes; the creator’s fees are the payee’s own claim, re-simulated before sending', async () => {
  const r = await rig({ items: true, payeeIsWallet: true, holderPanel: false, index: ({ holder, items }) => claimsPage({ chainId: 31337, wallet: A, block: holder.block, rows: [
    ...holderRows(holder, [1n, 2n, 3n]),
    { box: claimsBoxOfView(required(items)), row: { kind: 'item', id: 1n, amount: ETH / 4n + ETH, stash: ETH } },
    { box: claimsBoxOfView(required(items)), row: { kind: 'item', id: 2n, amount: ETH / 4n + 1n } },
    // The receiver books royalties on the claim itself: more than its creatorOwed view says.
    { box: claimsBoxOfView(required(items)), row: { kind: 'creator', amount: 900719925474099300000001n + 5n } },
  ] }) });
  r.chain.creatorPayout = 900719925474099300000001n + 5n;
  expect(await within(panel()).findByText('7 ready')).toBeTruthy();
  const confirm = open();
  expect(listed(within(confirm).getByRole('list', { name: 'Claims on Item box' }))).toEqual(['Item #11.25 ETH', 'Item #20.250000000000000001 ETH', 'Creator fees900719.925474099300000006 ETH']);
  fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm' }));
  expect(await within(panel()).findByText('8 / 8 done')).toBeTruthy();
  const items = required(r.itemsView);
  expect(decoded(required(sends()[7]))).toMatchObject({ functionName: 'claimCreator', args: [items.record.q, A] });
  expect(sends()[7]?.to).toBe(rolesOfV2(items.record).contracts.receiver);
});

it('SH-RC7 item 29: an index page with an unpriced collect-first row is refused whole, and the chain’s refused quote is a failed read: nothing is listed, summed or sent', async () => {
  const PENDING = 2_000_000n;
  // The page an older index would answer: the final share pending with no price, naming the inbox P. The chain reader
  // parses every page with the shared schema (claims-reader.ts), which refuses that row since SH-RC7 item 29.
  const unpriced = ({ holder }: Views) => {
    const json = claimsPageJson({ chainId: 31337, wallet: A, block: holder.block, rows: [
      { box: claimsBoxOfView(holder), row: { kind: 'failure', coins: COINS, amount: 10000001n, inboxP: PENDING } },
    ] });
    const row = required(json.items[0]);
    return walletClaimsPageSchemaV2.parse({ ...json, items: [{ ...row, status: 'pending', amountP: null, payout: 'not_ready', pot: '10000001' }] });
  };
  const r = await rig({ batches: [], holderPanel: false, collectFirst: PENDING, index: unpriced });
  expect(await within(panel()).findByText('Unavailable')).toBeTruthy();
  expect(r.index).toHaveBeenCalled();
  // Never 0 and never an unpriced share: a dash while the read failed, and no step.
  expect(panel().querySelector('.sh-v2-value')?.textContent).toBe('— USDC');
  expect(panel().querySelector('.sh-v2-claim-list')).toBeNull();
  expect(sends()).toEqual([]);
});

it('SH-RC7 item 29: with the index unavailable, a final quote the chain refuses is a failed read (Retry), never an unpriced hand-in', async () => {
  await rig({ batches: [], holderPanel: false, collectFirst: 2_000_000n });
  expect(await within(panel()).findByText('Unavailable')).toBeTruthy();
  expect(within(panel()).getByRole('button', { name: 'Some reads failed. Retry' })).toBeTruthy();
  // Never 0 and never an unpriced share: a dash while the read failed, and no step.
  expect(panel().querySelector('.sh-v2-value')?.textContent).toBe('— USDC');
  expect(panel().querySelector('.sh-v2-claim-list')).toBeNull();
  expect(sends()).toEqual([]);
});

it('SH-SEND-FEES: a wallet short of gas stops Claim all at its first step: not sent, the gas line, nothing reaches the wallet', async () => {
  await rig({ balance: 1n }); await within(panel()).findByText('4 ready');
  fireEvent.click(within(open()).getByRole('button', { name: 'Confirm' }));
  expect(await within(panel()).findByText(/^Batch 1 not sent · Needs a little more ETH for gas\. · 0 \/ \d+ done · the rest stay claimable$/)).toBeTruthy();
  expect(sends()).toHaveLength(0);
});
