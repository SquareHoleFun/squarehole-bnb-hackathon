/**
 * M3-53 actions through the real reads (M3-52's readItemClaimV2 / readPileQuoteV2 over a viem client) and the real
 * shared sender. Since 69204e00 its guard (write-calls-v2.ts) admits item claims and sync to role 16 and the pile's
 * approval, redemption and seed return to role 3 of a PILE box, so each send reaches the wallet: the tests read the
 * exact transaction the wallet was asked to send, and pin what the guard still refuses before the wallet.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import { decodeFunctionData, encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { NotSendableError, submitWrite } from '@squarehole/chain/write';
import { itemLedgerV2Abi, pileVaultV2Abi } from '../../../../../../packages/chain/src/core/v2';
import type { WriteTargetV2 } from '../../../../../../packages/chain/src/core/v2/write-calls-v2';
import { parseSnapshotV2, type V2Snapshot } from './indexer-v2';
import { m3ActionIO, m3Target, sendItemClaimV2, sendItemSyncV2, sendPileApproveV2, sendPileRedeemV2, sendSeedReturnV2 } from './m3-actions';
import { m3RpcFixture, type M3RpcOptions } from './test-support/m3-rpc';
import { A, B, ETH, H, publishedItems, publishedPile } from './test-support/m3-published';
import { rpcFetch } from './test-support/rpc-fetch';
import { required } from './test-support/required';
import { TEST_FEE_READER } from '@squarehole/chain/write/test-support';

/** What the shared sender asks the wallet to send (eth_sendTransaction's one parameter). */
type Tx = { from: Address; to: Address; data: Hex; value: Hex; gas: Hex; chainId: Hex };
let wallet: Mock<Eip1193Request>;
beforeEach(() => { wallet = vi.fn<Eip1193Request>(async ({ method }) => method === 'eth_chainId' ? '0x7a69' : method === 'eth_sendTransaction' ? H(77) : [A]); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function items(rpc: M3RpcOptions = {}, patch: Partial<V2Snapshot> = {}) {
  const { body, source, at } = await publishedItems();
  const view = { ...parseSnapshotV2(body, source), ...patch };
  const fixture = m3RpcFixture({ owners: { '1': A, '2': A }, credits: { '1': [ETH / 4n, ETH], '2': [ETH / 4n + 1n, 0n] }, vault: at(3), ...rpc });
  vi.stubGlobal('fetch', rpcFetch(fixture.request));
  return { view, source, at, fixture };
}
async function pile(options: Parameters<typeof publishedPile>[0] = {}, rpc: Partial<M3RpcOptions> = {}) {
  const published = await publishedPile(options);
  const view = parseSnapshotV2(published.body, published.source);
  const money = required(view.m3?.pileMoney);
  const fixture = m3RpcFixture({ pile: { asset: published.asset, seeder: view.record.creator, seed: published.seed, balance: money.balance ?? 0n, supply: money.supply }, coinsT: 10n * ETH, allowanceT: 0n, ...rpc });
  vi.stubGlobal('fetch', rpcFetch(fixture.request));
  return { ...published, view, money, fixture };
}
const sends = (): Tx[] => wallet.mock.calls.filter(([call]) => call.method === 'eth_sendTransaction').map(([call]) => (call.params as readonly Tx[])[0] as Tx);
/** The one transaction the wallet was asked to send: from the caller, to `to`, zero value, on the box's chain. */
function sentOnce(to: Address | null | undefined): Tx {
  const all = sends();
  expect(all).toHaveLength(1);
  const tx = required(all[0]);
  expect(tx.to).toBe(required(to)); expect(tx.from).toBe(A); expect(tx.value).toBe('0x0'); expect(tx.chainId).toBe('0x7a69');
  return tx;
}

describe('M3-53 item claims', () => {
  it('reads the backed credit at the displayed hash, then the wallet is asked to send exactly claim([id], wallet) to the item ledger', async () => {
    const { view, source } = await items();
    const receipt = await sendItemClaimV2(source, view, A, 1n, ETH / 4n + ETH, m3ActionIO(source, view, wallet));
    expect(receipt).toMatchObject({ transactionHash: H(77), status: 'success' });
    const tx = sentOnce(view.claimRow?.contracts.itemLedger);
    expect(decodeFunctionData({ abi: itemLedgerV2Abi, data: tx.data })).toMatchObject({ functionName: 'claim', args: [[1n], A] });
    expect(m3Target(source, view)).toMatchObject({ itemLedger: view.claimRow?.contracts.itemLedger });
  });
  it.each<[string, M3RpcOptions, Partial<V2Snapshot>, bigint]>([
    ['another owner', { owners: { '1': B } }, {}, ETH / 4n + ETH],
    ['a changed amount', {}, {}, ETH],
    ['a ledger behind its records', { synced: false }, {}, ETH / 4n + ETH],
    ['a paused payout', { payout: 'paused' }, {}, ETH / 4n + ETH],
    ['an unanswered simulation', { payout: 'offline' }, {}, ETH / 4n + ETH],
    ['an unbacked credit', { backing: 1n }, {}, ETH / 4n + ETH],
    ['a stale read', {}, { stale: true }, ETH / 4n + ETH],
    ['an unverified read', {}, { verified: false }, ETH / 4n + ETH],
  ])('refuses %s before the wallet is asked to send', async (_name, rpc, patch, expected) => {
    const { view, source } = await items(rpc, patch);
    await expect(sendItemClaimV2(source, view, A, 1n, expected, m3ActionIO(source, view, wallet))).rejects.toThrow();
    expect(sends()).toHaveLength(0);
  });
  it('re-checks the wallet right before sending', async () => {
    const { view, source } = await items();
    const io = m3ActionIO(source, view, wallet);
    const simulate = io.simulate;
    await expect(sendItemClaimV2(source, view, A, 1n, ETH / 4n + ETH, { ...io, simulate: async (...args) => { await simulate(...args); wallet.mockImplementation(async ({ method }) => method === 'eth_chainId' ? '0x7a69' : [B]); } })).rejects.toThrow(/Wallet changed/);
    expect(sends()).toHaveLength(0);
  });
  it('sync is sync(32) on the item ledger, and it reaches the wallet', async () => {
    const { view, source } = await items({ synced: false });
    await sendItemSyncV2(source, view, A, m3ActionIO(source, view, wallet));
    const tx = sentOnce(view.claimRow?.contracts.itemLedger);
    expect(decodeFunctionData({ abi: itemLedgerV2Abi, data: tx.data })).toMatchObject({ functionName: 'sync', args: [32n] });
  });
});

describe('M3-53 pile redemption and seed return', () => {
  it('approves exactly the coins for the pile, then redeems them for exactly the quote, paid to the caller; both reach the wallet', async () => {
    const p = await pile();
    const tIn = 3n * ETH; const quote = (required(p.money.balance) * tIn) / p.money.supply;
    const pileAddress = required(p.view.claimRow?.contracts.vault);
    await sendPileApproveV2(p.source, p.view, A, tIn, m3ActionIO(p.source, p.view, wallet));
    const approval = sentOnce(p.view.token);
    expect(decodeFunctionData({ abi: erc20Abi, data: approval.data })).toMatchObject({ functionName: 'approve', args: [pileAddress, tIn] });
    // Not approved yet on chain: the redemption stops before any send.
    await expect(sendPileRedeemV2(p.source, p.view, A, tIn, quote, m3ActionIO(p.source, p.view, wallet))).rejects.toThrow(/Approve these coins first/);
    expect(sends()).toHaveLength(1);
    vi.stubGlobal('fetch', rpcFetch(m3RpcFixture({ pile: { asset: p.asset, seeder: p.view.record.creator, seed: p.seed, balance: required(p.money.balance), supply: p.money.supply }, coinsT: 10n * ETH, allowanceT: tIn }).request));
    await sendPileRedeemV2(p.source, p.view, A, tIn, quote, m3ActionIO(p.source, p.view, wallet));
    const redemption = required(sends()[1]);
    expect(sends()).toHaveLength(2);
    expect(redemption.to).toBe(pileAddress); expect(redemption.from).toBe(A); expect(redemption.value).toBe('0x0');
    expect(decodeFunctionData({ abi: pileVaultV2Abi, data: redemption.data })).toMatchObject({ functionName: 'redeem', args: [tIn, quote, A] });
    expect(m3Target(p.source, p.view)).toMatchObject({ pile: pileAddress });
  });
  it('refuses a minimum other than the exact quote, more coins than the wallet holds, and redemption before graduation', async () => {
    const p = await pile({}, { allowanceT: 10n ** 40n });
    const tIn = 3n * ETH; const quote = (required(p.money.balance) * tIn) / p.money.supply;
    const io = m3ActionIO(p.source, p.view, wallet);
    await expect(sendPileRedeemV2(p.source, p.view, A, tIn, quote - 1n, io)).rejects.toThrow(/quote changed/);
    await expect(sendPileApproveV2(p.source, p.view, A, 11n * ETH, io)).rejects.toThrow(/More coins/);
    const early = await pile({ graduated: false });
    await expect(sendPileApproveV2(early.source, early.view, A, ETH, m3ActionIO(early.source, early.view, wallet))).rejects.toThrow(/after graduation/);
    expect(sends()).toHaveLength(0);
  });
  it('after failure anyone sends the recorded seed back with returnSeed(), and it reaches the wallet; nothing when none is due', async () => {
    const p = await pile({ failed: true });
    // The caller is any wallet; the pile pays only its recorded seeder (the creator).
    expect(p.view.record.creator).not.toBe(A);
    await sendSeedReturnV2(p.source, p.view, A, m3ActionIO(p.source, p.view, wallet));
    const tx = sentOnce(p.view.claimRow?.contracts.vault);
    expect(decodeFunctionData({ abi: pileVaultV2Abi, data: tx.data })).toMatchObject({ functionName: 'returnSeed' });
    const none = await pile({ failed: true, loaded: false });
    await expect(sendSeedReturnV2(none.source, none.view, A, m3ActionIO(none.source, none.view, wallet))).rejects.toThrow(/No seed return/);
    expect(sends()).toHaveLength(1);
  });
});

describe('M3-53 the shared sender still refuses, before the wallet', () => {
  type Box = { readonly target: WriteTargetV2 };
  const itemCall = (fn: 'claim' | 'sync', args: readonly unknown[]) => encodeFunctionData({ abi: itemLedgerV2Abi, functionName: fn, args } as never) as Hex;
  const pileCall = (args?: readonly [bigint, bigint, Address]) => (args ? encodeFunctionData({ abi: pileVaultV2Abi, functionName: 'redeem', args }) : encodeFunctionData({ abi: pileVaultV2Abi, functionName: 'returnSeed' })) as Hex;
  const approve = (spender: Address, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] });
  const itemBox = async (): Promise<Box> => { const { view, source } = await items(); return { target: m3Target(source, view) }; };
  const pileBox = async (): Promise<Box> => { const p = await pile(); return { target: m3Target(p.source, p.view) }; };
  const ledger = (t: WriteTargetV2) => required(t.itemLedger);
  const vault = (t: WriteTargetV2) => required(t.pile);
  const cases: readonly [string, () => Promise<Box>, (t: WriteTargetV2) => { to: Address; data: Hex; value?: bigint }, RegExp][] = [
    ['an item claim naming two items', itemBox, (t) => ({ to: ledger(t), data: itemCall('claim', [[1n, 2n], A]) }), /one item and pay the caller/],
    ['an item claim for item 0', itemBox, (t) => ({ to: ledger(t), data: itemCall('claim', [[0n], A]) }), /one item and pay the caller/],
    ['an item claim paid to another wallet', itemBox, (t) => ({ to: ledger(t), data: itemCall('claim', [[1n], B]) }), /one item and pay the caller/],
    ['an item claim sent to the coordinator', itemBox, (t) => ({ to: t.coordinator, data: itemCall('claim', [[1n], A]) }), /must be a number/],
    ['an item claim carrying value', itemBox, (t) => ({ to: ledger(t), data: itemCall('claim', [[1n], A]), value: 1n }), /never carry value/],
    ['sync(0)', itemBox, (t) => ({ to: ledger(t), data: itemCall('sync', [0n]) }), /1 to 32 records/],
    ['sync(33)', itemBox, (t) => ({ to: ledger(t), data: itemCall('sync', [33n]) }), /1 to 32 records/],
    ['sync sent to the receiver', itemBox, (t) => ({ to: t.receiver, data: itemCall('sync', [32n]) }), /prepared box role/],
    ['a redemption with minimum 0', pileBox, (t) => ({ to: vault(t), data: pileCall([ETH, 0n, A]) }), /positive minimum, paid to the caller/],
    ['a redemption of 0 coins', pileBox, (t) => ({ to: vault(t), data: pileCall([0n, 1n, A]) }), /positive minimum, paid to the caller/],
    ['a redemption paid to another wallet', pileBox, (t) => ({ to: vault(t), data: pileCall([ETH, 1n, B]) }), /positive minimum, paid to the caller/],
    ['a redemption sent to the box coin', pileBox, (t) => ({ to: t.token, data: pileCall([ETH, 1n, A]) }), /prepared box role/],
    ['an approval of 0 coins for the pile', pileBox, (t) => ({ to: t.token, data: approve(vault(t), 0n) }), /coordinator or the pile/],
    ['an approval for another spender', pileBox, (t) => ({ to: t.token, data: approve(B, ETH) }), /coordinator or the pile/],
    ['a seed return sent to the coordinator', pileBox, (t) => ({ to: t.coordinator, data: pileCall() }), /prepared box role/],
    // A box without the role: an item box has no pile, a pile box has no item ledger.
    ['a redemption on a box without a pile', itemBox, (t) => ({ to: ledger(t), data: pileCall([ETH, 1n, A]) }), /needs the coin pile/],
    ['a seed return on a box without a pile', itemBox, (t) => ({ to: ledger(t), data: pileCall() }), /needs the coin pile/],
    ['an approval for the item ledger, on a box without a pile', itemBox, (t) => ({ to: t.token, data: approve(ledger(t), ETH) }), /coordinator or the pile/],
    ['sync on a box without an item ledger', pileBox, (t) => ({ to: vault(t), data: itemCall('sync', [32n]) }), /needs the item ledger/],
    ['an item claim on a box without an item ledger', pileBox, (t) => ({ to: vault(t), data: itemCall('claim', [[1n], A]) }), /must be a number/],
  ];
  it.each(cases)('%s', async (_name, box, make, why) => {
    const { target } = await box();
    const call = make(target);
    const attempt = submitWrite({ feeReader: TEST_FEE_READER, protocol: 'core-v2', target, call: { to: call.to, data: call.data, value: call.value ?? 0n }, wallet, from: A, gasLimit: 200000n });
    await expect(attempt).rejects.toBeInstanceOf(NotSendableError);
    await expect(attempt).rejects.toThrow(why);
    expect(wallet).not.toHaveBeenCalled();
  });
  it('the same target admits the well-formed calls, so each refusal above is the named rule', async () => {
    const { target: t } = await itemBox(); const { target: p } = await pileBox();
    for (const [target, call] of [
      [t, { to: ledger(t), data: itemCall('claim', [[1n], A]) }], [t, { to: ledger(t), data: itemCall('sync', [32n]) }],
      [p, { to: p.token, data: approve(vault(p), ETH) }], [p, { to: vault(p), data: pileCall([ETH, 1n, A]) }], [p, { to: vault(p), data: pileCall() }],
    ] as const) await expect(submitWrite({ feeReader: TEST_FEE_READER, protocol: 'core-v2', target, call: { ...call, value: 0n }, wallet, from: A, gasLimit: 200000n })).resolves.toBe(H(77));
    expect(sends()).toHaveLength(5);
  });
});
