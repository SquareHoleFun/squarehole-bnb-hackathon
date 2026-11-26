/**
 * A shop's actions on its box page (SH-V21-FE13; ShopVaultV2): give one of your items from a listed collection for its
 * tier's fixed T (an item approval first), pick an item inside for its fixed pick price (a T approval first), and, for
 * the curator, add a collection at a tier. Each checks what the page showed against a current read, then goes through
 * the site's one v2 send path (m3-actions.ts `sendCheckedV2`, the one Claim all uses): a simulation, an estimate, the
 * wallet re-checked, the shared sender's guard (`submitWrite`, which admits these calls only to this box's shop and
 * its listed collections) and this transaction's mined success. The wallet is asked only on a press.
 */
import { BaseError, ExecutionRevertedError, createPublicClient, encodeFunctionData, erc20Abi, http, parseAbi, type Abi, type Address, type Hex } from 'viem';
import { InsufficientGasFundsError, NotSendableError, WalletRejectedError, submitWrite } from '@squarehole/chain/write';
import { gasFundsLine } from '../../tx/gas-words';
import { rolesOfV2, shopVaultV2Abi } from '../../../../../../packages/chain/src/core/v2';
import type { WriteTargetV2 } from '../../../../../../packages/chain/src/core/v2/write-calls-v2';
import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import { rpcTokenReader } from '../../create/v2/indexer-listings';
import { collectionCheckV2 } from '../../create/v2/shop-checks';
import { pickPriceOf, type CollectionCheck } from '../../create/v2/shop';
import { actionIO, identity, type HolderReceiptV2 } from './actions-v2';
import { m3Target, sendCheckedV2, type SendIO } from './m3-actions';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { allowanceV2, giveBlockV2, type ShopBookV2, type ShopItemV2 } from './shop-book';
import { pageClient } from '../../create/v2/view-client';

export const ERC721_ABI = parseAbi([
  'function ownerOf(uint256 id) view returns (address)',
  'function getApproved(uint256 id) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function approve(address to, uint256 id)',
  'function name() view returns (string)',
  'function supportsInterface(bytes4 id) view returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
]);

export interface ShopActionIO extends SendIO {
  /** Now: an item's owner (null when it has none or the read fails) and whether the shop may take it from that owner. */
  item(collection: Address, id: bigint, shop: Address): Promise<{ readonly owner: Address | null; readonly approved: boolean }>;
  /** Now: this wallet's T, or what it lets the shop take. */
  coins(fn: 'balanceOf' | 'allowance', args: readonly Address[]): Promise<bigint>;
  /** Whether a contract says it is an ERC-721 (shop-checks.ts). */
  collection(address: Address): Promise<CollectionCheck>;
}

export function shopActionIO(source: V2Source, view: V2Snapshot, request: Eip1193Request): ShopActionIO {
  const client = pageClient(source.rpc, source.manifest.chainId, () => createPublicClient({ transport: http(source.rpc, { retryCount: 0 }), ccipRead: false }));
  const reader = rpcTokenReader(source.rpc, source.manifest.chainId);
  const read = (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => client.readContract({ address, abi, functionName, args } as never) as Promise<unknown>;
  return { ...actionIO(source.rpc, request), receipt: (hash) => client.waitForTransactionReceipt({ hash }), submit: submitWrite,
    item: async (collection, id, shop) => {
      let owner: Address;
      try { owner = await read(collection, ERC721_ABI, 'ownerOf', [id]) as Address; } catch { return { owner: null, approved: false }; }
      const [one, all] = await Promise.all([
        read(collection, ERC721_ABI, 'getApproved', [id]).catch(() => null),
        read(collection, ERC721_ABI, 'isApprovedForAll', [owner, shop]).catch(() => false),
      ]);
      return { owner, approved: (typeof one === 'string' && one.toLowerCase() === shop.toLowerCase()) || all === true };
    },
    coins: async (fn, args) => read(view.token, erc20Abi as Abi, fn, args) as Promise<bigint>,
    collection: (address) => collectionCheckV2(reader, address),
  };
}

/** The box's shop, its config (prices and presets) and every listed collection; null for any other box. */
export function shopOf(view: V2Snapshot, book: ShopBookV2 | null) {
  const shop = view.spec.boxType === 4 ? rolesOfV2(view.record).contracts.vault : undefined;
  if (!shop) return null;
  const config = view.shopConfig;
  if (!config) return null;
  const listed = new Map<string, Address>(config.collections.map((collection) => [collection.toLowerCase(), collection]));
  for (const entry of book?.entries.values() ?? []) listed.set(entry.collection.toLowerCase(), entry.collection);
  return { shop, config, collections: [...listed.values()] };
}

/** The shared sender's target: this box's roles, its shop (role 3 of a SHOP box) and the collections the shop lists. */
export function shopTargetV2(source: V2Source, view: V2Snapshot, book: ShopBookV2 | null): WriteTargetV2 {
  const found = shopOf(view, book);
  if (!found) throw new Error('Shop unavailable');
  return { ...m3Target(source, view), shop: found.shop, shopCollections: found.collections };
}

const fresh = (view: V2Snapshot) => { if (view.stale || !view.verified) throw new Error('Refresh before sending: this read is not current and verified.'); };
const live = (view: V2Snapshot, book: ShopBookV2) => { if (!view.graduated || view.failed || book.openedAt === null) throw new Error('Gives and picks open after graduation.'); };
const same = (a: string | null | undefined, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const encode = (abi: Abi, functionName: string, args: readonly unknown[]) => encodeFunctionData({ abi, functionName, args } as never) as Hex;

/** Your item, for the shop to take in your give: approve(shop, id) on its collection. */
export async function sendItemApproveV2(source: V2Source, view: V2Snapshot, book: ShopBookV2, account: Address, collection: Address, id: bigint, io: ShopActionIO): Promise<HolderReceiptV2> {
  fresh(view); live(view, book);
  const target = shopTargetV2(source, view, book); const shop = target.shop as Address;
  if (!book.entries.has(collection.toLowerCase())) throw new Error('This collection is not listed.');
  await identity(target, account, io);
  const item = await io.item(collection, id, shop);
  if (!same(item.owner, account)) throw new Error('This item is not in your wallet.');
  if (item.approved) throw new Error('The shop may already take this item. Give it.');
  return sendCheckedV2(target, account, collection, encode(ERC721_ABI, 'approve', [shop, id]), io);
}

/**
 * Everything a give is refused for before anything is sent, today's words each: the price the page showed, the week's
 * limits and the budget, the wallet's own item. Returns the target, the price and whether the shop may take the item.
 */
async function giveCheckV2(source: V2Source, view: V2Snapshot, book: ShopBookV2, account: Address, collection: Address, id: bigint, expectedT: bigint, io: ShopActionIO) {
  fresh(view); live(view, book);
  const found = shopOf(view, book); const target = shopTargetV2(source, view, book);
  const entry = book.entries.get(collection.toLowerCase());
  const priceT = entry && found ? found.config.givePricesT[entry.tier] : undefined;
  if (!found || !entry || priceT === undefined || priceT !== expectedT || expectedT <= 0n) throw new Error('The give price changed. Refresh and try again.');
  const block = giveBlockV2(book, allowanceV2(book, found.config, view.timestamp), collection, priceT, view.timestamp);
  if (block !== null) throw new Error(GIVE_BLOCK_TEXT[block]);
  await identity(target, account, io);
  const item = await io.item(collection, id, target.shop as Address);
  if (!same(item.owner, account)) throw new Error('This item is not in your wallet.');
  return { target, priceT, approved: item.approved };
}

/** Give your item for exactly its tier's T: give(collection, id, price), the minimum being the price the page showed. */
export async function sendGiveV2(source: V2Source, view: V2Snapshot, book: ShopBookV2, account: Address, collection: Address, id: bigint, expectedT: bigint, io: ShopActionIO): Promise<HolderReceiptV2> {
  const { target, priceT, approved } = await giveCheckV2(source, view, book, account, collection, id, expectedT, io);
  if (!approved) throw new Error(notReady('give'));
  return sendCheckedV2(target, account, target.shop as Address, encode(shopVaultV2Abi as Abi, 'give', [collection, id, priceT]), io);
}

/** Let the shop take exactly a pick's price of your T: approve(shop, amount) on T. */
export async function sendShopApproveV2(source: V2Source, view: V2Snapshot, book: ShopBookV2, account: Address, amountT: bigint, io: ShopActionIO): Promise<HolderReceiptV2> {
  fresh(view); live(view, book);
  const target = shopTargetV2(source, view, book);
  if (amountT <= 0n) throw new Error('Choose an item first.');
  await identity(target, account, io);
  if (amountT > await io.coins('balanceOf', [account])) throw new Error('More than this wallet holds.');
  return sendCheckedV2(target, account, view.token, encode(erc20Abi as Abi, 'approve', [target.shop, amountT]), io);
}

/**
 * Everything a pick is refused for before anything is sent, today's words each: the price the page showed, the item
 * still inside, the last item, the wallet's balance. Returns the target, the price and what the shop may take now.
 */
async function pickCheckV2(source: V2Source, view: V2Snapshot, book: ShopBookV2, account: Address, item: ShopItemV2, expectedT: bigint, io: ShopActionIO) {
  fresh(view); live(view, book);
  const found = shopOf(view, book); const target = shopTargetV2(source, view, book);
  const entry = book.entries.get(item.collection.toLowerCase());
  const giveT = entry && found ? found.config.givePricesT[entry.tier] : undefined;
  const priceT = giveT !== undefined && found ? pickPriceOf(giveT, found.config.pickBps) : undefined;
  if (priceT === undefined || priceT !== expectedT) throw new Error('The pick price changed. Refresh and try again.');
  if (!book.items.some((held) => same(held.collection, item.collection) && held.id === item.id)) throw new Error('This item is no longer in the shop.');
  if (book.items.length <= 1 || (view.m2?.money?.shop?.inside ?? 0n) <= 1n) throw new Error('The last item stays in the shop.');
  await identity(target, account, io);
  const [balance, allowance] = await Promise.all([io.coins('balanceOf', [account]), io.coins('allowance', [account, target.shop as Address])]);
  if (priceT > balance) throw new Error('More than this wallet holds.');
  return { target, priceT, allowance };
}

/** Pick an item for exactly its pick price, to your wallet: pick(collection, id, price, you). The last item stays. */
export async function sendPickV2(source: V2Source, view: V2Snapshot, book: ShopBookV2, account: Address, item: ShopItemV2, expectedT: bigint, io: ShopActionIO): Promise<HolderReceiptV2> {
  const { target, priceT, allowance } = await pickCheckV2(source, view, book, account, item, expectedT, io);
  if (allowance < priceT) throw new Error(notReady('pick'));
  return sendCheckedV2(target, account, target.shop as Address, encode(shopVaultV2Abi as Abi, 'pick', [item.collection, item.id, priceT, account]), io);
}

/**
 * SH-297: one press, as the buy and sell box's (trade-sepolia/use-sends.ts `press`): the approval a pick or a give
 * needs first, exactly that (the pick's price to this shop; for a give that one item), sent, then waited for on chain;
 * then the pick or the give itself, with the same checks again and the price the page showed as its bound (a pick's
 * maximum, a give's minimum). With the approval in place already (an earlier press stopped after it), only the second
 * send goes. Every refusal reads as before; a refusal after the approval leaves it there for the next press.
 */
export type ShopStepState = 'waiting' | 'active' | 'done' | 'stopped';
export interface ShopProgress { readonly approve: ShopStepState; readonly act: ShopStepState }
/** Where a press is, for its button: the wallet asked, the chain awaited, or the mined approval being read back. */
export type ShopPhase = 'idle' | 'confirm' | 'mining' | 'approval';
export interface ShopPressHooks {
  readonly phase: (phase: ShopPhase) => void;
  /** Null: the press needs no approval (one send only, no ticks). */
  readonly progress: (progress: ShopProgress | null) => void;
  /** Test seam: the pause between reads of the approval (a node behind the receipt's). */
  readonly wait?: (ms: number) => Promise<void>;
}
/** The approval is read again this many times after its receipt, this far apart, before the second send. */
export const APPROVAL_READS = 8;
export const APPROVAL_READ_MS = 750;
/** A guard of the send functions: the approval the press waited for still reads short (a node behind); the approval was sent. */
export const notReady = (action: 'pick' | 'give'): string => `The ${action} was not sent yet. Try again in a moment.`;

/** The second step of a press failed after its approval was mined: the approval stays for the next press. */
export class AfterApprovalError extends Error {
  constructor(readonly action: 'pick' | 'give', readonly failure: unknown) { super(failure instanceof Error ? failure.message : String(failure), { cause: failure }); }
}

/** The IO with each send's two moments told to the press (the wallet asked; the chain awaited). */
function phased(io: ShopActionIO, hooks: ShopPressHooks): ShopActionIO {
  return { ...io, submit: async (...args: Parameters<ShopActionIO['submit']>) => { hooks.phase('confirm'); const hash = await io.submit(...args); hooks.phase('mining'); return hash; } };
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(read: () => Promise<boolean>, hooks: ShopPressHooks): Promise<void> {
  for (let i = 0; i < APPROVAL_READS; i += 1) {
    if (await read().catch(() => false)) return;
    await (hooks.wait ?? pause)(APPROVAL_READ_MS);
  }
}

/** One press of Pick: the exact price approved to this shop when it is short, mined; then the pick, at most that price. */
export async function pressPickV2(source: V2Source, view: V2Snapshot, book: ShopBookV2, account: Address, item: ShopItemV2, expectedT: bigint, io: ShopActionIO, hooks: ShopPressHooks): Promise<HolderReceiptV2> {
  const live = phased(io, hooks);
  const { target, priceT, allowance } = await pickCheckV2(source, view, book, account, item, expectedT, io);
  if (allowance < priceT) {
    hooks.progress({ approve: 'active', act: 'waiting' });
    try { await sendShopApproveV2(source, view, book, account, priceT, live); } catch (error) { hooks.progress({ approve: 'stopped', act: 'waiting' }); throw error; }
    hooks.progress({ approve: 'done', act: 'active' }); hooks.phase('approval');
    await until(async () => (await io.coins('allowance', [account, target.shop as Address])) >= priceT, hooks);
    try { const receipt = await sendPickV2(source, view, book, account, item, priceT, live); hooks.progress({ approve: 'done', act: 'done' }); return receipt; }
    catch (error) { hooks.progress({ approve: 'done', act: 'stopped' }); throw new AfterApprovalError('pick', error); }
  }
  hooks.progress(null);
  return sendPickV2(source, view, book, account, item, priceT, live);
}

/** One press of Give: that one item approved to this shop when it is not, mined; then the give, at least the shown price. */
export async function pressGiveV2(source: V2Source, view: V2Snapshot, book: ShopBookV2, account: Address, collection: Address, id: bigint, expectedT: bigint, io: ShopActionIO, hooks: ShopPressHooks): Promise<HolderReceiptV2> {
  const live = phased(io, hooks);
  const { target, priceT, approved } = await giveCheckV2(source, view, book, account, collection, id, expectedT, io);
  if (!approved) {
    hooks.progress({ approve: 'active', act: 'waiting' });
    try { await sendItemApproveV2(source, view, book, account, collection, id, live); } catch (error) { hooks.progress({ approve: 'stopped', act: 'waiting' }); throw error; }
    hooks.progress({ approve: 'done', act: 'active' }); hooks.phase('approval');
    await until(async () => (await io.item(collection, id, target.shop as Address)).approved, hooks);
    try { const receipt = await sendGiveV2(source, view, book, account, collection, id, priceT, live); hooks.progress({ approve: 'done', act: 'done' }); return receipt; }
    catch (error) { hooks.progress({ approve: 'done', act: 'stopped' }); throw new AfterApprovalError('give', error); }
  }
  hooks.progress(null);
  return sendGiveV2(source, view, book, account, collection, id, priceT, live);
}

/** The curator adds a collection at a tier: addCollection(collection, tier). It takes gives after the list delay. */
export async function sendAddCollectionV2(source: V2Source, view: V2Snapshot, book: ShopBookV2 | null, account: Address, collection: Address, tier: number, io: ShopActionIO): Promise<HolderReceiptV2> {
  fresh(view);
  if (view.failed) throw new Error('The shop is closed.');
  const money = view.m2?.money?.shop;
  const target = shopTargetV2(source, view, book);
  if (!money || !same(money.curator, account)) throw new Error('Only the curator can add a collection.');
  if (view.timestamp < money.nextAdditionAt) throw new Error('The next addition is not due yet.');
  if (!Number.isInteger(tier) || tier < 0 || tier > 3) throw new Error('Choose a tier.');
  if (target.shopCollections?.some((listed) => same(listed, collection))) throw new Error('This collection is listed already.');
  await identity(target, account, io);
  const check = await io.collection(collection);
  if (check !== 'erc721') throw new Error(check === 'no-code' ? 'No contract at this address.' : 'Not an ERC-721 collection.');
  return sendCheckedV2(target, account, target.shop as Address, encode(shopVaultV2Abi as Abi, 'addCollection', [collection, tier]), io);
}

/** Why the page holds a give back (shop-book.ts `giveBlockV2`), in plain words. */
export const GIVE_BLOCK_TEXT: Readonly<Record<NonNullable<ReturnType<typeof giveBlockV2>>, string>> = Object.freeze({
  unlisted: 'This collection is not listed.',
  waiting: 'This collection does not take gives yet.',
  closed: 'Gives and picks open after graduation.',
  budget: 'The budget is short of this give.',
  weekly: 'Over this week’s limit for the shop.',
  collection: 'Over this week’s limit for this collection.',
});

const reverted = (error: unknown) => error instanceof BaseError && error.walk((cause) => cause instanceof ExecutionRevertedError) !== null;

/** One plain line for a failed action: nothing sent, declined, refused by the shop, or not confirmed. */
export function shopErrorText(error: unknown, action: 'give' | 'pick' | 'approval' | 'addition'): string {
  // SH-297: the approval of a one-press pick or give was mined, its second step was not: never "Nothing was sent".
  if (error instanceof AfterApprovalError) {
    const failure = error.failure; const act = error.action;
    if (failure instanceof WalletRejectedError || failure instanceof NotSendableError) return `The approval went through; the ${act} was not sent. The next press sends only the ${act}.`;
    if (reverted(failure)) return `The shop refused this ${act}; your approval stays for the next press.`;
    return shopErrorText(failure, act);
  }
  if (error instanceof NotSendableError) return 'Not sent. Nothing reached your wallet.';
  if (error instanceof WalletRejectedError) return 'Declined in your wallet. Nothing was sent.';
  if (error instanceof InsufficientGasFundsError) return gasFundsLine(error.chainId);
  if (reverted(error)) return `The shop refused this ${action}. Nothing was sent.`;
  if (error instanceof Error && error.message === 'Not confirmed') return 'Sent, but not confirmed. Check your wallet before trying again.';
  if (error instanceof Error && error.message && !(error instanceof BaseError)) return error.message;
  return 'Nothing confirmed. Try again.';
}
