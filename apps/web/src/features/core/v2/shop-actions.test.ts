/**
 * SH-V21-FE13 shop actions through the site's one v2 send path (m3-actions.ts `sendCheckedV2`) and the real shared
 * sender (`submitWrite` and its guard): the exact transaction the wallet is asked to send for an item approval, a give,
 * a T approval, a pick and a curator's addition, and what is refused before the wallet.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { BaseError, ExecutionRevertedError, decodeFunctionData, erc20Abi, getAddress, toHex, type Abi, type Address, type Hex } from 'viem';
import { NotSendableError, WalletRejectedError, submitWrite } from '@squarehole/chain/write';
import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import { rolesOfV2, shopVaultV2Abi } from '../../../../../../packages/chain/src/core/v2';
import { parseSnapshotV2, type V2Snapshot } from './indexer-v2';
import { AfterApprovalError, ERC721_ABI, pressGiveV2, pressPickV2, type ShopPhase, type ShopProgress, sendAddCollectionV2, sendGiveV2, sendItemApproveV2, sendPickV2, sendShopApproveV2, shopErrorText, shopTargetV2, type ShopActionIO } from './shop-actions';
import { shopBookV2, type ShopEventV2 } from './shop-book';
import { A, B, H, publishedM2 } from './test-support/m2-published';
import { required } from './test-support/required';
import { COLLECTION } from '../../../../../../packages/indexer/src/core/v2/m2-fixture.test-support';
import { TEST_FEE_READER } from '@squarehole/chain/write/test-support';

type Tx = { from: Address; to: Address; data: Hex; value: Hex };
const E18 = 10n ** 18n;
const NOW = 2_000_000n;
const OPEN = NOW - 1_000n;
const OTHER = getAddress('0x00000000000000000000000000000000000000c3') as Address;
let wallet: Mock<Eip1193Request>;
let chainId = 0;

async function fixture(events: (shop: Address) => ShopEventV2[] = () => [], patch: Partial<V2Snapshot> = {}) {
  const m2 = await publishedM2(false);
  const parsed = parseSnapshotV2(m2.body, m2.source);
  chainId = m2.source.manifest.chainId;
  const shop = required(rolesOfV2(parsed.record).contracts.vault) as Address;
  const view: V2Snapshot = { ...parsed, graduated: true, timestamp: NOW, ...patch };
  // The money read's budget (900719.925474099300000001) is the seed this book replays; three items are inside.
  const budget = required(view.m2?.money?.shop).budgetT;
  const base: ShopEventV2[] = [
    { kind: 'seed', amountT: budget, block: 101n },
    { kind: 'added', collection: COLLECTION, tier: 0, activeAt: OPEN - 1n, block: 101n },
    { kind: 'loaded', collection: COLLECTION, id: 1n, block: 101n }, { kind: 'loaded', collection: COLLECTION, id: 2n, block: 101n }, { kind: 'loaded', collection: COLLECTION, id: 3n, block: 101n },
    { kind: 'opened', timestamp: OPEN, block: 102n },
  ];
  const book = shopBookV2([...base, ...events(shop)], new Map([[103n, OPEN + 5n]]), NOW, view.block);
  const io = {
    feeReader: TEST_FEE_READER, chainId: vi.fn(async () => chainId), request: wallet,
    simulate: vi.fn(async () => undefined), estimate: vi.fn(async () => 100_000n), submit: submitWrite,
    receipt: vi.fn(async (hash: Hex) => ({ transactionHash: hash, blockNumber: 200n, blockHash: H(200), status: 'success' as const })),
    item: vi.fn(async () => ({ owner: A as Address | null, approved: true })),
    coins: vi.fn(async (fn: 'balanceOf' | 'allowance') => (fn === 'balanceOf' ? 10n * E18 : 10n * E18)),
    collection: vi.fn(async () => 'erc721' as const),
  } satisfies ShopActionIO;
  return { ...m2, view, book, shop, io };
}
const sends = (): Tx[] => wallet.mock.calls.filter(([call]) => call.method === 'eth_sendTransaction').map(([call]) => (call.params as readonly Tx[])[0] as Tx);
function sentOnce(to: Address): Tx {
  const all = sends();
  expect(all).toHaveLength(1);
  const tx = required(all[0]);
  expect(tx.to.toLowerCase()).toBe(to.toLowerCase()); expect(tx.from).toBe(A); expect(tx.value).toBe('0x0');
  return tx;
}

beforeEach(() => { wallet = vi.fn<Eip1193Request>(async ({ method }) => method === 'eth_chainId' ? toHex(chainId) : method === 'eth_sendTransaction' ? H(77) : [A]); });
afterEach(() => { vi.restoreAllMocks(); });

describe('SH-V21-FE13 give', () => {
  it('your approved item, for exactly its tier’s T: give(collection, id, price) to the shop', async () => {
    const f = await fixture();
    const receipt = await sendGiveV2(f.source, f.view, f.book, A, COLLECTION, 7n, E18, f.io);
    expect(receipt.status).toBe('success');
    const tx = sentOnce(f.shop);
    expect(decodeFunctionData({ abi: shopVaultV2Abi as Abi, data: tx.data })).toMatchObject({ functionName: 'give', args: [COLLECTION, 7n, E18] });
    expect(f.io.simulate).toHaveBeenCalledWith(f.shop, tx.data, A);
  });

  it('first the item’s approval: approve(shop, id) on its collection, never on another', async () => {
    const f = await fixture();
    f.io.item.mockResolvedValue({ owner: A, approved: false });
    await sendItemApproveV2(f.source, f.view, f.book, A, COLLECTION, 0n, f.io);
    const tx = sentOnce(COLLECTION);
    expect(decodeFunctionData({ abi: ERC721_ABI, data: tx.data })).toMatchObject({ functionName: 'approve', args: [f.shop, 0n] });
  });

  it.each<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>, RegExp]>([
    ['not your item', async (f) => { f.io.item.mockResolvedValue({ owner: B, approved: true }); return sendGiveV2(f.source, f.view, f.book, A, COLLECTION, 7n, E18, f.io); }, /not in your wallet/],
    ['not approved', async (f) => { f.io.item.mockResolvedValue({ owner: A, approved: false }); return sendGiveV2(f.source, f.view, f.book, A, COLLECTION, 7n, E18, f.io); }, /The give was not sent yet. Try again in a moment./],
    ['a price the page did not show', (f) => sendGiveV2(f.source, f.view, f.book, A, COLLECTION, 7n, 2n * E18, f.io), /price changed/],
    ['an unlisted collection', (f) => sendGiveV2(f.source, f.view, f.book, A, OTHER, 7n, E18, f.io), /price changed/],
    ['an approval of an item already approved', (f) => sendItemApproveV2(f.source, f.view, f.book, A, COLLECTION, 7n, f.io), /already take this item/],
    ['a stale read', (f) => sendGiveV2(f.source, { ...f.view, stale: true }, f.book, A, COLLECTION, 7n, E18, f.io), /Refresh/],
    ['before graduation', (f) => sendGiveV2(f.source, { ...f.view, graduated: false }, f.book, A, COLLECTION, 7n, E18, f.io), /after graduation/],
  ])('refuses %s before the wallet', async (_name, run, message) => {
    const f = await fixture();
    await expect(run(f)).rejects.toThrow(message);
    expect(sends()).toEqual([]);
  });

  it('this week’s limit per collection, as the shop counts it: 2.5% of the week’s budget, given so far', async () => {
    // 2.5% of the week's budget (900719.925474099300000001) is 22517.998136852482500000: after gives of 22517 this week,
    // less than one more give of 1 is left for this collection.
    const f = await fixture(() => [{ kind: 'given', collection: COLLECTION, id: 9n, amountT: 22_517n * E18, block: 103n }]);
    expect(f.book.week?.givenT).toBe(22_517n * E18);
    await expect(sendGiveV2(f.source, f.view, f.book, A, COLLECTION, 7n, E18, f.io)).rejects.toThrow('Over this week’s limit for this collection.');
    expect(sends()).toEqual([]);
  });
});

describe('SH-V21-FE13 pick', () => {
  it('an item inside for exactly its pick price, to your wallet: approve(shop, price) on T, then pick(collection, id, price, you)', async () => {
    const f = await fixture();
    await sendShopApproveV2(f.source, f.view, f.book, A, 3n * E18 / 2n, f.io);
    const approve = sentOnce(f.view.token);
    expect(decodeFunctionData({ abi: erc20Abi, data: approve.data })).toMatchObject({ functionName: 'approve', args: [f.shop, 3n * E18 / 2n] });
    wallet.mockClear();
    await sendPickV2(f.source, f.view, f.book, A, { collection: COLLECTION, id: 2n }, 3n * E18 / 2n, f.io);
    const pick = sentOnce(f.shop);
    expect(decodeFunctionData({ abi: shopVaultV2Abi as Abi, data: pick.data })).toMatchObject({ functionName: 'pick', args: [COLLECTION, 2n, 3n * E18 / 2n, A] });
  });

  it.each<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>, RegExp]>([
    ['an item not inside', (f) => sendPickV2(f.source, f.view, f.book, A, { collection: COLLECTION, id: 8n }, 3n * E18 / 2n, f.io), /no longer in the shop/],
    ['a price the page did not show', (f) => sendPickV2(f.source, f.view, f.book, A, { collection: COLLECTION, id: 2n }, E18, f.io), /price changed/],
    ['without the approval', async (f) => { f.io.coins.mockImplementation(async (fn) => (fn === 'balanceOf' ? 10n * E18 : 0n)); return sendPickV2(f.source, f.view, f.book, A, { collection: COLLECTION, id: 2n }, 3n * E18 / 2n, f.io); }, /The pick was not sent yet. Try again in a moment./],
    ['more than the wallet holds', async (f) => { f.io.coins.mockImplementation(async () => E18); return sendPickV2(f.source, f.view, f.book, A, { collection: COLLECTION, id: 2n }, 3n * E18 / 2n, f.io); }, /More than this wallet holds/],
    ['an approval above the balance', async (f) => { f.io.coins.mockImplementation(async () => E18); return sendShopApproveV2(f.source, f.view, f.book, A, 3n * E18 / 2n, f.io); }, /More than this wallet holds/],
    ['the last item', (f) => sendPickV2(f.source, { ...f.view, m2: { history: f.view.m2?.history ?? null, money: { ...required(f.view.m2?.money), shop: { ...required(f.view.m2?.money?.shop), inside: 1n } } } }, f.book, A, { collection: COLLECTION, id: 2n }, 3n * E18 / 2n, f.io), /last item stays/],
  ])('refuses %s before the wallet', async (_name, run, message) => {
    const f = await fixture();
    await expect(run(f)).rejects.toThrow(message);
    expect(sends()).toEqual([]);
  });
});

describe('SH-V21-FE13 the curator adds a collection', () => {
  it('addCollection(collection, tier) to the shop; the shared sender knows every listed collection', async () => {
    const f = await fixture();
    await sendAddCollectionV2(f.source, f.view, f.book, A, OTHER, 2, f.io);
    const tx = sentOnce(f.shop);
    expect(decodeFunctionData({ abi: shopVaultV2Abi as Abi, data: tx.data })).toMatchObject({ functionName: 'addCollection', args: [OTHER, 2] });
    // Once added (its CollectionAdded in the book), a give and an item approval can name it.
    const later = shopBookV2([...[{ kind: 'seed', amountT: 1n, block: 1n } as ShopEventV2], { kind: 'added', collection: OTHER, tier: 2, activeAt: NOW + 7n * 86_400n, block: 300n }], new Map(), NOW, 300n);
    expect(shopTargetV2(f.source, f.view, later).shopCollections?.map((c) => c.toLowerCase())).toEqual([COLLECTION.toLowerCase(), OTHER.toLowerCase()]);
  });

  it.each<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>, RegExp]>([
    ['by someone else', (f) => sendAddCollectionV2(f.source, f.view, f.book, B, OTHER, 0, f.io), /Only the curator/],
    ['a listed collection', (f) => sendAddCollectionV2(f.source, f.view, f.book, A, COLLECTION, 0, f.io), /listed already/],
    ['before the next addition is due', (f) => sendAddCollectionV2(f.source, { ...f.view, timestamp: 1_000n }, f.book, A, OTHER, 0, f.io), /not due yet/],
    ['not an ERC-721', async (f) => { f.io.collection.mockResolvedValue('not-erc721' as never); return sendAddCollectionV2(f.source, f.view, f.book, A, OTHER, 0, f.io); }, /Not an ERC-721/],
    ['a tier past 4', (f) => sendAddCollectionV2(f.source, f.view, f.book, A, OTHER, 4, f.io), /Choose a tier/],
  ])('refuses an addition %s before the wallet', async (_name, run, message) => {
    const f = await fixture();
    await expect(run(f)).rejects.toThrow(message);
    expect(sends()).toEqual([]);
  });
});

describe('SH-V21-FE13 plain error lines', () => {
  it('nothing sent, declined, refused by the shop, not confirmed', () => {
    expect(shopErrorText(new NotSendableError('x'), 'give')).toBe('Not sent. Nothing reached your wallet.');
    expect(shopErrorText(new WalletRejectedError(), 'pick')).toBe('Declined in your wallet. Nothing was sent.');
    expect(shopErrorText(new ExecutionRevertedError({ message: 'execution reverted' }), 'give')).toBe('The shop refused this give. Nothing was sent.');
    expect(shopErrorText(new Error('Not confirmed'), 'addition')).toBe('Sent, but not confirmed. Check your wallet before trying again.');
    expect(shopErrorText(new Error('Wrong network'), 'approval')).toBe('Wrong network');
    expect(shopErrorText(new BaseError('rpc down'), 'give')).toBe('Nothing confirmed. Try again.');
  });
});

/** A press's hooks, recording what the button and the ticks were told; no real waits. */
function hooks() {
  const phases: ShopPhase[] = []; const ticks: (ShopProgress | null)[] = [];
  return { phases, ticks, h: { phase: (p: ShopPhase) => { phases.push(p); }, progress: (p: ShopProgress | null) => { ticks.push(p); }, wait: async () => undefined } };
}
const PRICE = 3n * E18 / 2n;
const ITEM = { collection: COLLECTION, id: 2n };

describe('SH-297 one press: Pick', () => {
  it('allowance short: exactly the price approved to this shop, mined, then the pick at most that price (harm: an approval above the price, or to another spender, would let a later call take more)', async () => {
    const f = await fixture();
    let allowance = 0n;
    f.io.coins.mockImplementation(async (fn) => (fn === 'balanceOf' ? 10n * E18 : allowance));
    f.io.receipt.mockImplementation(async (hash: Hex) => { allowance = PRICE; return { transactionHash: hash, blockNumber: 200n, blockHash: H(200), status: 'success' as const }; });
    const { phases, ticks, h } = hooks();
    await pressPickV2(f.source, f.view, f.book, A, ITEM, PRICE, f.io, h);
    const [approve, pick] = sends();
    expect(sends()).toHaveLength(2);
    expect(approve?.to.toLowerCase()).toBe(f.view.token.toLowerCase());
    expect(decodeFunctionData({ abi: erc20Abi, data: required(approve).data })).toMatchObject({ functionName: 'approve', args: [f.shop, PRICE] });
    expect(pick?.to.toLowerCase()).toBe(f.shop.toLowerCase());
    expect(decodeFunctionData({ abi: shopVaultV2Abi as Abi, data: required(pick).data })).toMatchObject({ functionName: 'pick', args: [COLLECTION, 2n, PRICE, A] });
    expect(phases).toEqual(['confirm', 'mining', 'approval', 'confirm', 'mining']);
    expect(ticks).toEqual([{ approve: 'active', act: 'waiting' }, { approve: 'done', act: 'active' }, { approve: 'done', act: 'done' }]);
  });

  it('allowance present (an earlier press stopped after its approval): only the pick, no ticks (harm: a second approval for nothing)', async () => {
    const f = await fixture();
    f.io.coins.mockImplementation(async (fn) => (fn === 'balanceOf' ? 10n * E18 : PRICE));
    const { ticks, h } = hooks();
    await pressPickV2(f.source, f.view, f.book, A, ITEM, PRICE, f.io, h);
    const tx = sentOnce(f.shop);
    expect(decodeFunctionData({ abi: shopVaultV2Abi as Abi, data: tx.data })).toMatchObject({ functionName: 'pick', args: [COLLECTION, 2n, PRICE, A] });
    expect(ticks).toEqual([null]);
  });

  it('the approval mined, the pick refused: the ticks stop at the pick, and the next press sends the pick only', async () => {
    const f = await fixture();
    let allowance = 0n;
    f.io.coins.mockImplementation(async (fn) => (fn === 'balanceOf' ? 10n * E18 : allowance));
    f.io.receipt.mockImplementation(async (hash: Hex) => { allowance = PRICE; return { transactionHash: hash, blockNumber: 200n, blockHash: H(200), status: 'success' as const }; });
    f.io.simulate.mockImplementationOnce(async () => undefined).mockImplementationOnce(async () => { throw new BaseError('reverted', { cause: new ExecutionRevertedError() }); });
    const first = hooks();
    const error = await pressPickV2(f.source, f.view, f.book, A, ITEM, PRICE, f.io, first.h).catch((e: unknown) => e);
    // The approval was mined: never "Nothing was sent" (SH-297 1b).
    expect(shopErrorText(error, 'pick')).toBe('The shop refused this pick; your approval stays for the next press.');
    expect(sends()).toHaveLength(1);
    expect(first.ticks.at(-1)).toEqual({ approve: 'done', act: 'stopped' });
    wallet.mockClear();
    const again = hooks();
    await pressPickV2(f.source, f.view, f.book, A, ITEM, PRICE, f.io, again.h);
    expect(decodeFunctionData({ abi: shopVaultV2Abi as Abi, data: sentOnce(f.shop).data })).toMatchObject({ functionName: 'pick' });
  });

  it.each<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>, RegExp]>([
    ['a price that moved from the one shown', (f) => pressPickV2(f.source, f.view, f.book, A, ITEM, E18, f.io, hooks().h), /The pick price changed. Refresh and try again./],
    ['the last item', (f) => pressPickV2(f.source, { ...f.view, m2: { history: f.view.m2?.history ?? null, money: { ...required(f.view.m2?.money), shop: { ...required(f.view.m2?.money?.shop), inside: 1n } } } }, f.book, A, ITEM, PRICE, f.io, hooks().h), /The last item stays in the shop./],
    ['more than the wallet holds', async (f) => { f.io.coins.mockImplementation(async () => E18); return pressPickV2(f.source, f.view, f.book, A, ITEM, PRICE, f.io, hooks().h); }, /More than this wallet holds./],
    ['an item not inside', (f) => pressPickV2(f.source, f.view, f.book, A, { collection: COLLECTION, id: 8n }, PRICE, f.io, hooks().h), /This item is no longer in the shop./],
  ])('refuses %s with today\'s words, before any approval is sent', async (_name, run, message) => {
    const f = await fixture();
    f.io.coins.mockImplementation(async (fn) => (fn === 'balanceOf' ? 10n * E18 : 0n));
    const err = await run(f).catch((e: unknown) => e);
    expect(String((err as Error).message)).toMatch(message);
    expect(sends()).toEqual([]);
  });

  it('a declined approval stops the press: nothing else is sent, the ticks stop at the approval', async () => {
    const f = await fixture();
    f.io.coins.mockImplementation(async (fn) => (fn === 'balanceOf' ? 10n * E18 : 0n));
    wallet.mockImplementation(async ({ method }) => { if (method === 'eth_sendTransaction') throw Object.assign(new Error('User rejected'), { code: 4001 }); return method === 'eth_chainId' ? toHex(chainId) : [A]; });
    const { ticks, h } = hooks();
    const error = await pressPickV2(f.source, f.view, f.book, A, ITEM, PRICE, f.io, h).catch((e: unknown) => e);
    expect(shopErrorText(error, 'approval')).toBe('Declined in your wallet. Nothing was sent.');
    expect(ticks.at(-1)).toEqual({ approve: 'stopped', act: 'waiting' });
    expect(f.io.simulate).toHaveBeenCalledTimes(1);
  });
});

describe('SH-297 one press: Give', () => {
  it('the item not approved: that one item approved to this shop (never all of the wallet\'s), mined, then the give at least the shown price', async () => {
    const f = await fixture();
    let approved = false;
    f.io.item.mockImplementation(async () => ({ owner: A, approved }));
    f.io.receipt.mockImplementation(async (hash: Hex) => { approved = true; return { transactionHash: hash, blockNumber: 200n, blockHash: H(200), status: 'success' as const }; });
    const { ticks, h } = hooks();
    await pressGiveV2(f.source, f.view, f.book, A, COLLECTION, 7n, E18, f.io, h);
    const [approve, give] = sends();
    expect(sends()).toHaveLength(2);
    expect(approve?.to.toLowerCase()).toBe(COLLECTION.toLowerCase());
    expect(decodeFunctionData({ abi: ERC721_ABI, data: required(approve).data })).toMatchObject({ functionName: 'approve', args: [f.shop, 7n] });
    expect(decodeFunctionData({ abi: shopVaultV2Abi as Abi, data: required(give).data })).toMatchObject({ functionName: 'give', args: [COLLECTION, 7n, E18] });
    expect(ticks.at(-1)).toEqual({ approve: 'done', act: 'done' });
  });

  it('the item approved already: only the give; refusals read as today', async () => {
    const f = await fixture();
    const { ticks, h } = hooks();
    await pressGiveV2(f.source, f.view, f.book, A, COLLECTION, 7n, E18, f.io, h);
    expect(decodeFunctionData({ abi: shopVaultV2Abi as Abi, data: sentOnce(f.shop).data })).toMatchObject({ functionName: 'give', args: [COLLECTION, 7n, E18] });
    expect(ticks).toEqual([null]);
    wallet.mockClear();
    f.io.item.mockResolvedValue({ owner: B, approved: false });
    await expect(pressGiveV2(f.source, f.view, f.book, A, COLLECTION, 7n, E18, f.io, hooks().h)).rejects.toThrow('This item is not in your wallet.');
    await expect(pressGiveV2(f.source, f.view, f.book, A, COLLECTION, 7n, 2n * E18, f.io, hooks().h)).rejects.toThrow('The give price changed. Refresh and try again.');
    expect(sends()).toEqual([]);
  });
});

describe('SH-297 1b: the words after a mined approval are true', () => {
  it('a declined or unsent second step, a refusal, a price that moved: each says what happened to the approval only where it went through', () => {
    expect(shopErrorText(new AfterApprovalError('pick', new WalletRejectedError()), 'pick')).toBe('The approval went through; the pick was not sent. The next press sends only the pick.');
    expect(shopErrorText(new AfterApprovalError('give', new NotSendableError('x')), 'give')).toBe('The approval went through; the give was not sent. The next press sends only the give.');
    expect(shopErrorText(new AfterApprovalError('give', new BaseError('reverted', { cause: new ExecutionRevertedError() })), 'give')).toBe('The shop refused this give; your approval stays for the next press.');
    expect(shopErrorText(new AfterApprovalError('pick', new Error('The pick price changed. Refresh and try again.')), 'pick')).toBe('The pick price changed. Refresh and try again.');
    expect(shopErrorText(new AfterApprovalError('pick', new Error('Not confirmed')), 'pick')).toBe('Sent, but not confirmed. Check your wallet before trying again.');
    // Without an approval in the press, today's words.
    expect(shopErrorText(new WalletRejectedError(), 'pick')).toBe('Declined in your wallet. Nothing was sent.');
  });
});
