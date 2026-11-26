/**
 * SH-TA-33: the items in a v2 box's vault (BoxVaultV2), taken out for box tokens and put back for box tokens. Take one
 * out: withdraw(id, max, deadline), which pulls quoteWithdraw(1) plus the pick fee in T (an exact T approval to the
 * vault first, when the wallet's allowance is short). Put one back: returnItem(id, min, deadline), which pays
 * quoteReturn(1) less the return fee (approve(vault, id) on the collection first, when the vault may not take it yet).
 *
 * Every call comes from the shared builders (packages/chain collection-calls-v2.ts), which check it against the box's
 * prepared roles, the caller and the exact approval, and the shared sender checks it again before the wallet
 * (`submitWrite`). Each transaction is one wallet confirmation, asked only on a press; nothing is read from or sent to
 * the wallet on navigation. Amounts stay bigint; anything unread is null and shows as unavailable, never zero.
 */
import { BaseError, ContractFunctionRevertedError, createPublicClient, erc20Abi, http, type Abi, type Address, type Hex } from 'viem';
import { rawCidV1 } from '@squarehole/artwork';
import { checkRequestPrice, InsufficientGasFundsError, NotSendableError, preSendRefusalText, RpcRequestError, WalletContextChangedError, WalletRejectedError, submitWrite } from '@squarehole/chain/write';
import { gasFundsLine } from '../../tx/gas-words';
import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import { boxCollectionAbi } from '@squarehole/chain/abi';
import {
  collectionItemApprovalCallV2, collectionTargetV2, collectionTokenApprovalCallV2, returnItemCallV2, rolesOfV2, vaultV2Abi, withdrawCallV2,
  type CollectionApprovalV2, type WriteCallV2, type WriteTargetV2,
} from '../../../../../../packages/chain/src/core/v2';
import { actionIO, identity, type HolderReceiptV2 } from './actions-v2';
import { m3Target, sendCheckedV2, type SendIO } from './m3-actions';
import type { ItemsHistory } from './m3-data';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { waitVaultOperation, vaultOperationError, pendingVaultMoveLine, pendingVaultMoves, rememberVaultMove, type PendingVaultMoveV2, type VaultOperationV2, type VaultReceiptReaderV2 } from './vault-operations';
import { ITEM_NOT_REVEALED, REASON_FALLBACK, reasonText } from './reveal-words';
import { pageClient } from '../../create/v2/view-client';

/** Items shown at once in each list (in the vault, and Yours); More items reads the next ones. */
export const VAULT_PAGE = 12;
/**
 * SH-235: reads of the wallet's coins that must not be older than a block (this card's last confirmed transaction, or
 * an approval just confirmed): how often the chain's head is asked, and how long apart, before the send stops with the
 * refresh line instead of using an older answer.
 */
export const FLOOR_READS = 10;
export const FLOOR_WAIT_MS = 1_000;
/** The line a send stops with when the chain's answers stay older than a transaction this card saw confirmed. */
export const REFRESH_LINE = 'Refresh before sending: this read is not current and verified.';
export const EARLIER_LINE = 'An earlier transaction is still under way.';
export const WALLET_ERROR_LINE = 'Your wallet returned an error. Check it before trying again.';
export const READ_LIMIT_MS = 120_000;
/** The price limit around the shown price: a take pays at most 1% more, a put-back takes at least 1% less. */
export const LIMIT_BPS = 100n;
/** Seconds a sent take or put-back stays valid, from the chain's latest block. */
export const DEADLINE_SECONDS = 1200n;

/** The vault roles of a box whose vault holds collection items: not a shop or a pile (their vaults hold other things). */
export interface VaultRolesV2 {
  readonly vault: Address;
  readonly collection: Address;
  /** The draw add-on's placeholder tickets (role 7), or null: with tickets only items that came back sit on the shelf. */
  readonly tickets: Address | null;
  readonly firstId: bigint;
  readonly n: number;
}

export function vaultRolesOf(view: Pick<V2Snapshot, 'record' | 'spec'>): VaultRolesV2 | null {
  if (view.spec.boxType === 4 || view.spec.boxType === 5 || !Number.isSafeInteger(view.spec.n) || view.spec.n <= 0) return null;
  const { vault, collection, tickets } = rolesOfV2(view.record).contracts;
  if (!vault || !collection) return null;
  return { vault, collection, tickets: tickets ?? null, firstId: view.spec.firstId, n: view.spec.n };
}

/** ceil(principal × bps / 10,000), as VaultViews.fee rounds. */
export function feeOf(principal: bigint, bps: bigint): bigint {
  return bps === 0n ? 0n : (principal * bps + 9_999n) / 10_000n;
}
/** The most a take may pull: the shown price plus LIMIT_BPS (rounded down). */
export const takeLimit = (shownT: bigint): bigint => shownT + (shownT * LIMIT_BPS) / 10_000n;
/** The least a put-back may pay: the shown amount less LIMIT_BPS (rounded up). */
export const returnLimit = (shownT: bigint): bigint => shownT - (shownT * LIMIT_BPS) / 10_000n;

/** What the vault quotes now. Null fields could not be read (unavailable, never zero). */
export interface VaultQuoteV2 {
  /** T to take one item out (quoteWithdraw(1) plus the pick fee); null when none can leave (the last item stays). */
  readonly takeT: bigint | null;
  /**
   * T one item brings back (quoteReturn(1) less the return fee; while none is out, the vault's share activeSupply / inside
   * less the fee); null when it cannot be read, or when quoteReturn(1) failed any other way.
   */
  readonly returnT: bigint | null;
  readonly inside: bigint | null;
  readonly pickFeeBps: bigint | null;
  readonly returnFeeBps: bigint | null;
  /** The last item always stays in the vault. */
  readonly lastItem: boolean;
}

/** One item now, from the vault and the collection. */
export interface VaultItemV2 {
  readonly id: bigint;
  readonly owner: Address | null;
  /** In the vault and free to take out (BoxVaultV2.isOnShelf). */
  readonly onShelf: boolean;
  /** Out of the vault (BoxVaultV2.isOutside): its owner may put it back. */
  readonly outside: boolean;
  readonly revealed: boolean;
  /** The picture's SHA-256, committed at reveal; null before reveal. */
  readonly imageHash: Hex | null;
  /**
   * T06: the 3D model's SHA-256 (the GLB's bytes), committed at reveal; null before reveal and for an item without a model
   * (a zero hash: a 2D collection's). Only a revealed item's nonzero hash is ever asked for (View 3D, on a press).
   */
  readonly modelHash: Hex | null;
}

/** One list's item reads: the items that answered, and how many reads failed (unknown, never an absent item). */
export interface ItemReadsV2 {
  readonly items: readonly VaultItemV2[];
  readonly failed: number;
}

/**
 * T06: where a revealed item's 3D model is asked for: the source's first gateway (box-pictures.ts: the pictures' own
 * origins, so no new one), by the raw CIDv1 of the committed hash, as BoxCollectionV2's `animation_url` names it. Only
 * the first (XR-ITEM-3D-V2 F3): a model that fails there is not asked of another gateway, and its picture stays. No hash
 * (unrevealed, or a 2D item) or no gateway: nowhere (null), and no model view is offered.
 */
export function modelUrlV2(modelHash: Hex | null, gateways: readonly string[]): string | null {
  const gateway = gateways[0];
  return modelHash === null || gateway === undefined ? null : `${gateway}/ipfs/${rawCidV1(modelHash)}`;
}

/** Reads each id on chain (VaultItemsIO.item); a failed read is counted apart from the items, never dropped as absent. */
export async function readItemsV2(io: Pick<VaultItemsIO, 'item'>, ids: readonly bigint[], block?: bigint): Promise<ItemReadsV2> {
  const reads = await Promise.all(ids.map((id) => io.item(id, block).catch(() => null)));
  const items = reads.filter((item): item is VaultItemV2 => item !== null);
  return { items, failed: reads.length - items.length };
}

/** This wallet's T and what it lets the vault take, both read at `block`. */
export interface VaultCoinsV2 { readonly balance: bigint; readonly allowance: bigint; readonly block: bigint }

export interface VaultItemsIO extends SendIO {
  receipt: VaultReceiptReaderV2;
  receiptOnce(hash: Hex): Promise<HolderReceiptV2 | null>;
  head(floor?: bigint): Promise<bigint>;
  counts(account: Address, block: bigint): Promise<{ mined: bigint; latest: bigint; pending: bigint; latestAfter: bigint }>;
  balanceOf(account: Address, block: bigint): Promise<bigint>;
  quote(block?: bigint): Promise<VaultQuoteV2>;
  item(id: bigint, block?: bigint): Promise<VaultItemV2>;
  coins(account: Address, atLeast?: bigint, block?: bigint): Promise<VaultCoinsV2>;
  itemApproved(id: bigint, owner: Address, block?: bigint): Promise<boolean>;
  now(block?: bigint): Promise<bigint>;
}

const ZERO_HASH = /^0x0{64}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const same = (a: string | null | undefined, b: string | null | undefined) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** The vault, collection and wallet reads over the source's RPC, and the shared send path. View calls only, except `submit`. */
export function vaultItemsIO(source: V2Source, view: V2Snapshot, request: Eip1193Request,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((done) => { setTimeout(done, ms); })): VaultItemsIO {
  const roles = vaultRolesOf(view);
  const client = pageClient(source.rpc, source.manifest.chainId, () => createPublicClient({ transport: http(source.rpc, { retryCount: 0 }), ccipRead: false }));
  let checked: Promise<void> | null = null;
  const sameChain = () => {
    checked ??= client.getChainId().then((id) => { if (id !== source.manifest.chainId) throw new Error('Wrong network'); });
    checked.catch(() => { checked = null; });
    return checked;
  };
  const read = async (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint) => {
    await sameChain();
    return client.readContract({ address, abi, functionName, args, ...(blockNumber !== undefined ? { blockNumber } : {}) } as never) as Promise<unknown>;
  };
  /**
   * SH-235: reads named by a block number, asked again a bounded number of times: while the chain's head (never from
   * viem's block-number cache) is older than `floor`, and when a read fails without a refusal (a node behind the block,
   * on a load-balanced RPC, does not know it yet). A refusal is never asked again. In the end: the last read's own error,
   * or REFRESH_LINE when the head never reached the floor.
   */
  const atBlock = async <T>(floor: bigint, run: (block: bigint) => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      let failure: unknown = null;
      try {
        const head = await client.getBlockNumber({ cacheTime: 0 });
        if (head >= floor) return await run(head);
      } catch (error) {
        if (refused(error)) throw error;
        failure = error;
      }
      if (attempt >= FLOOR_READS) throw failure ?? new Error(REFRESH_LINE);
      await pause(FLOOR_WAIT_MS);
    }
  };
  const repeated = async <T>(run: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try { return await run(); } catch (error) { if (refused(error) || attempt >= FLOOR_READS) throw error; }
      await pause(FLOOR_WAIT_MS);
    }
  };
  const action = actionIO(source.rpc, request);
  const need = () => { if (!roles) throw new Error('Vault unavailable'); return roles; };
  const vault = (functionName: string, args: readonly unknown[] = [], block?: bigint) => read(need().vault, vaultV2Abi as Abi, functionName, args, block);
  const collection = (functionName: string, args: readonly unknown[] = [], block?: bigint) => read(need().collection, boxCollectionAbi as Abi, functionName, args, block);
  return { ...action, submit: submitWrite,
    // At a named block (after an approval), a simulation or an estimate a node could not answer is asked again; a revert is the vault's answer.
    simulate: (to, data, account, block) => (block === undefined ? action.simulate(to, data, account) : repeated(() => action.simulate(to, data, account, block))),
    estimate: (to, data, account, block) => (block === undefined ? action.estimate(to, data, account) : repeated(() => action.estimate(to, data, account, block))),
    receipt: (hash, onReplaced) => client.waitForTransactionReceipt({ hash, onReplaced, timeout: 180_000 }),
    receiptOnce: (hash) => client.getTransactionReceipt({ hash }),
    head: async (floor = 0n) => { await sameChain(); return atBlock(floor, async (block) => block); },
    counts: async (account, block) => {
      await sameChain();
      const mined = await client.request({ method: 'eth_getTransactionCount', params: [account, `0x${block.toString(16)}`] });
      const latest = await client.request({ method: 'eth_getTransactionCount', params: [account, 'latest'] });
      const pending = await client.request({ method: 'eth_getTransactionCount', params: [account, 'pending'] });
      const latestAfter = await client.request({ method: 'eth_getTransactionCount', params: [account, 'latest'] });
      return { mined: BigInt(mined), latest: BigInt(latest), pending: BigInt(pending), latestAfter: BigInt(latestAfter) };
    },
    balanceOf: async (account, block) => await collection('balanceOf', [account], block) as bigint,
    quote: async (block) => {
      const optional = (p: Promise<unknown>): Promise<bigint | null> => p.then((v) => (typeof v === 'bigint' ? v : null)).catch(() => null);
      const [inside, pickFeeBps, returnFeeBps] = await Promise.all([optional(vault('inside', [], block)), optional(vault('pickFeeBps', [], block)), optional(vault('returnFeeBps', [], block))]);
      let lastItem: boolean = false;
      const withdrawn = await vault('quoteWithdraw', [1n], block).then((v) => v as bigint).catch((error: unknown) => { lastItem = revertName(error) === 'LastItem'; return null; });
      // While no item is out, quoteReturn(1) refuses with InvalidQuantity(1, 0). Then, and only then, once the vault also
      // counts none outside, one item would bring back the share VaultViews.quoteReturn computes: activeSupply / inside,
      // at least one unit (below it the vault refuses too). Any other failure (a timeout, another refusal) stays unread.
      const returned = await vault('quoteReturn', [1n], block).then((v) => (typeof v === 'bigint' ? v : null)).catch(async (error: unknown) => {
        if (view.failed || inside === null || inside <= 0n || !noneOutsideRefusal(error)) return null;
        const [outside, active] = await Promise.all([vault('outside', [], block), vault('activeSupply', [], block)]);
        if (outside !== 0n || typeof active !== 'bigint') return null;
        const share = active / inside;
        return share >= 1n ? share : null;
      }).catch(() => null);
      return { takeT: withdrawn !== null && pickFeeBps !== null ? withdrawn + feeOf(withdrawn, pickFeeBps) : null,
        returnT: returned !== null && returnFeeBps !== null ? returned - feeOf(returned, returnFeeBps) : null, inside, pickFeeBps, returnFeeBps, lastItem };
    },
    item: async (id, block) => {
      try {
        const [owned, onShelf, outside, traits] = await Promise.all([
          collection('ownerOf', [id], block).then((value) => ({ value }), (error: unknown) => ({ error })),
          vault('isOnShelf', [id], block), vault('isOutside', [id], block), collection('traitsOf', [id], block),
        ]);
        const owner = 'value' in owned && typeof owned.value === 'string' ? owned.value as Address : null;
        // An item outside the vault has an owner that Yours and Put back need: an unread owner fails this read (a list counts
        // it unavailable), never null, which would read as another wallet's item. No owner is expected only inside the vault
        // (the vault's own) or for a token the collection does not hold (ERC721NonexistentToken).
        if (owner === null && outside === true && !('error' in owned && nonexistentToken(owned.error, id))) {
          throw new Error(`Item #${id} unavailable. Refresh and try again.`, { cause: 'error' in owned ? owned.error : owned.value });
        }
        const [revealed, , imageHash, modelHash] = traits as readonly [boolean, bigint, Hex, Hex];
        return { id, owner, onShelf: onShelf === true, outside: outside === true, revealed: revealed === true,
          imageHash: revealed === true && typeof imageHash === 'string' && !ZERO_HASH.test(imageHash) ? imageHash : null,
          modelHash: revealed === true && typeof modelHash === 'string' && HASH.test(modelHash) && !ZERO_HASH.test(modelHash) ? modelHash : null };
      } catch (cause) { throw new Error(`Item #${id} unavailable. Refresh and try again.`, { cause }); }
    },
    coins: async (account, atLeast = 0n, block) => {
      await sameChain();
      // Both at one block, named by number: a node behind it cannot answer for it with older state.
      const at = async (block: bigint) => {
        const [balance, allowance] = await Promise.all([read(view.token, erc20Abi as Abi, 'balanceOf', [account], block), read(view.token, erc20Abi as Abi, 'allowance', [account, need().vault], block)]);
        return { balance: balance as bigint, allowance: allowance as bigint, block };
      };
      return block === undefined ? atBlock(atLeast, at) : at(block);
    },
    itemApproved: async (id, owner, block) => {
      const [one, all] = await Promise.all([collection('getApproved', [id], block), collection('isApprovedForAll', [owner, need().vault], block)]);
      return same(one as string | null, need().vault) || all === true;
    },
    now: async (blockNumber) => { await sameChain(); return (await client.getBlock(blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber })).timestamp; },
  };
}

/** The vault's named refusal and its arguments, when a read reverted with an error the vault ABI decodes; else null. */
function revertOf(error: unknown): { readonly name: string; readonly args: readonly unknown[] } | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  const data = reverted instanceof ContractFunctionRevertedError ? reverted.data : undefined;
  return data ? { name: data.errorName, args: data.args ?? [] } : null;
}
function revertName(error: unknown): string | null {
  return revertOf(error)?.name ?? null;
}

/** The collection's refusal of an id it does not hold: ERC721NonexistentToken(id), from its decoded error. */
function nonexistentToken(error: unknown, id: bigint): boolean {
  const refusal = revertOf(error);
  return refusal?.name === 'ERC721NonexistentToken' && refusal.args[0] === id;
}

/** quoteReturn(1)'s refusal while no item is outside: VaultViews.quoteReturn's InvalidQuantity(count 1, available 0). */
function noneOutsideRefusal(error: unknown): boolean {
  const refusal = revertOf(error);
  return refusal?.name === 'InvalidQuantity' && refusal.args.length === 2 && refusal.args[0] === 1n && refusal.args[1] === 0n;
}

/**
 * The shared sender's target for one wallet's vault action: the box's roles (m3-actions.ts) with its vault, collection
 * and optional tickets bound to the caller (collection-calls-v2.ts), and the one exact approval being prepared.
 */
export function vaultTargetV2(source: V2Source, view: V2Snapshot, account: Address, approval?: CollectionApprovalV2): WriteTargetV2 {
  if (!vaultRolesOf(view)) throw new NotSendableError('box has no item vault');
  return { ...m3Target(source, view), ...collectionTargetV2(source.manifest.chainId, view.record, account), ...(approval ? { collectionApproval: approval } : {}) };
}

/** Checking covers reads and preflight; the three action steps cover only the wallet request. */
type WalletStep = 'approve' | 'withdraw' | 'return';
export type VaultStepV2 = 'checking' | WalletStep | 'confirming';
export interface VaultSendResultV2 { readonly approval: HolderReceiptV2 | null; readonly receipt: HolderReceiptV2 }
export interface VaultSendOptionsV2 {
  readonly floor?: bigint;
  readonly onReceipt?: (block: bigint) => void;
  readonly onCount?: (mined: bigint, block: bigint) => void;
}
/** Bounds a read, not a wallet send. Late answers cannot resume its caller. */
export async function readForSend<T>(read: Promise<T>, line = REFRESH_LINE, ms = READ_LIMIT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(line)), ms); })]);
  } catch (cause) { throw new Error(line, { cause }); }
  finally { clearTimeout(timer); }
}
const fresh = (view: V2Snapshot) => {
  if (view.stale || !view.verified) throw new Error(REFRESH_LINE);
  if (view.failed) throw new Error('This box is closed.');
  if (!view.gate.open) throw new Error('The vault opens with the box.');
};
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** Each look is pinned; an unproved move is held until its deadline or its own transaction ends. */
async function move(kind: 'take' | 'return', source: V2Source, view: V2Snapshot, account: Address, id: bigint, shownT: bigint, io: VaultItemsIO,
  onStep: (step: VaultStepV2) => void = () => undefined, options: VaultSendOptionsV2 = {}): Promise<VaultSendResultV2> {
  fresh(view);
  const base = vaultTargetV2(source, view, account); const take = kind === 'take';
  if (shownT <= 0n) throw new Error(take ? 'Price unavailable. Refresh and try again.' : 'Amount unavailable. Refresh and try again.');
  let floor = options.floor ?? 0n; let block = floor; let now = 0n; let confirmed = false; let asked = false;
  const limit = take ? takeLimit(shownT) : returnLimit(shownT);
  const counts = async () => {
    const read = await readForSend(io.counts(account, block));
    options.onCount?.(read.mined, block);
    return read;
  };
  const checkCounts = ({ mined, latest, pending, latestAfter }: Awaited<ReturnType<VaultItemsIO['counts']>>) => {
    if (latest !== latestAfter || latest !== mined) throw new Error(REFRESH_LINE);
    if (pending > latest) throw new Error(EARLIER_LINE);
  };
  const roles = vaultRolesOf(view);
  if (!roles) throw new NotSendableError('box has no item vault');
  const vault = roles.vault;
  const pendingCheck = () => {
    const line = pendingVaultMoveLine(source.manifest.chainId, vault, account, kind, id, now);
    if (line) throw new Error(line);
  };
  const look = async () => {
    onStep('checking');
    block = await readForSend(io.head(floor));
    if (block < floor) throw new Error(REFRESH_LINE);
    floor = block;
    const count = await counts();
    const [quote, item, coins, approved, time] = await Promise.all([
      readForSend(io.quote(block), 'Price unavailable. Refresh and try again.'),
      readForSend(io.item(id, block), `Item #${id} unavailable. Refresh and try again.`),
      take ? readForSend(io.coins(account, block, block)) : null,
      take ? false : readForSend(io.itemApproved(id, account, block)),
      readForSend(io.now(block)),
    ]);
    now = time;
    if (take && !item.onShelf) throw new Error(item.outside ? `Item #${id} is no longer in the vault.` : `Item #${id} unavailable. Refresh and try again.`);
    if (!take && (!item.outside || !same(item.owner, account))) throw new Error(`Item #${id} is not in your wallet.`);
    const held = pendingVaultMoves(source.manifest.chainId, vault, account, kind, id, now).find((r) => r.hash);
    if (held?.hash) {
      const receipt = await readForSend(io.receiptOnce(held.hash)).catch(() => null);
      if (receipt && same(receipt.transactionHash, held.hash)) rememberVaultMove(held, now, true);
    }
    pendingCheck();
    checkCounts(count);
    if (take) {
      if (quote.lastItem) throw new Error('The last item stays in the vault.');
      if (quote.takeT === null) throw new Error('Price unavailable. Refresh and try again.');
      if (quote.takeT > limit) throw new Error('The price changed. Refresh and try again.');
      if (!item.revealed) throw new Error(ITEM_NOT_REVEALED);
      if (!coins || coins.block !== block) throw new Error(REFRESH_LINE);
      if (coins.balance < quote.takeT) throw new Error('More than this wallet holds.');
      return coins.allowance >= limit;
    }
    if (!item.revealed) throw new Error(`Item #${id} comes back once it is revealed.`);
    if (quote.returnT === null) throw new Error('Price unavailable. Refresh and try again.');
    if (quote.returnT < limit) throw new Error('The amount changed. Refresh and try again.');
    return approved;
  };
  const send = async (target: WriteTargetV2, call: WriteCallV2, step: WalletStep, pending?: PendingVaultMoveV2) => {
    let operation: VaultOperationV2 | undefined; let stopped: unknown; let requested = false; let outcome: HolderReceiptV2 | undefined;
    // core-v2 submitWrite omits the hooks. Forward its checked request once, unchanged, after our last check.
    const guardedWallet: Eip1193Request = async (request) => {
      if (request.method !== 'eth_sendTransaction') return readForSend(io.request(request));
      // SH-258 round 4: the price read (round 3b) comes before the last pending check, and that check and the move's
      // record stay together with nothing awaited between them, so a second tab finds this move recorded.
      try {
        const count = await counts(); checkCounts(count);
        await checkRequestPrice(io.feeReader, target.chainId, (request.params as readonly unknown[] | undefined)?.[0]);
        pendingCheck();
      } catch (error) { stopped = error; throw error; }
      if (pending) rememberVaultMove(pending, now);
      asked = true; requested = true; onStep(step);
      try { return await io.request(request); } finally { onStep('checking'); }
    };
    const checked: SendIO = { ...io, chainId: () => readForSend(io.chainId()), request: guardedWallet,
      simulate: async (...args) => { try { await readForSend(io.simulate(...args)); } catch (cause) { throw new Error(refused(cause instanceof Error ? cause.cause : cause) ? 'The vault refused it. Refresh and try again.' : REFRESH_LINE, { cause }); } },
      estimate: async (...args) => { try { return await readForSend(io.estimate(...args)); } catch (cause) { throw new Error(refused(cause instanceof Error ? cause.cause : cause) ? 'The vault refused it. Refresh and try again.' : REFRESH_LINE, { cause }); } },
      submit: async (request) => {
        const hash = await io.submit(request);
        if (pending) { pending = { ...pending, hash }; rememberVaultMove(pending, now); }
        operation = { account, to: call.to, data: call.data, hash, outcome: 'unknown' };
        onStep('confirming'); return hash;
      },
      receipt: async () => {
        if (!operation) throw new Error('Not confirmed');
        await waitVaultOperation(operation, (hash, replaced) => readForSend(io.receipt(hash, replaced), 'Not confirmed', 180_000));
        if (pending && operation.outcome !== 'unknown') rememberVaultMove(pending, now, true);
        if (operation.receipt) {
          outcome = operation.receipt; confirmed = true; floor = max(floor, outcome.blockNumber);
          options.onReceipt?.(outcome.blockNumber);
        }
        const error = vaultOperationError(operation);
        if (error) throw new Error(error);
        if (!outcome) throw new Error('Not confirmed'); return { ...outcome, transactionHash: operation.hash };
      },
    };
    try { await sendCheckedV2(target, account, call.to, call.data, checked, block); }
    catch (error) {
      if (stopped) throw stopped;
      if (pending && requested && error instanceof WalletRejectedError) rememberVaultMove(pending, now, true);
      if (!operation && requested && !(error instanceof WalletRejectedError)) throw new Error(WALLET_ERROR_LINE, { cause: error });
      throw error;
    }
    onStep('checking'); if (!outcome) throw new Error('Not confirmed'); return outcome;
  };
  let approval: HolderReceiptV2 | null = null;
  try {
    let approved = await look();
    await identity(base, account, { chainId: () => readForSend(io.chainId()), request: (request) => readForSend(io.request(request)) });
    const approve = async () => {
      const target = vaultTargetV2(source, view, account, take ? { kind: 'token', spender: 'vault', amount: limit } : { kind: 'item', id });
      approval = await send(target, take ? collectionTokenApprovalCallV2(target, account) : collectionItemApprovalCallV2(target, account), 'approve');
    };
    if (!approved) await approve();
    approved = await look();
    if (!approved && approval === null) { await approve(); approved = await look(); }
    if (!take && !approved) throw new Error(REFRESH_LINE);
    const deadline = now + DEADLINE_SECONDS;
    const pending: PendingVaultMoveV2 = { chain: String(source.manifest.chainId), vault: vault.toLowerCase() as Address, account: account.toLowerCase() as Address, kind, id: id.toString(), deadline: deadline.toString() };
    const receipt = await send(base, take ? withdrawCallV2(base, id, limit, deadline, account) : returnItemCallV2(base, id, limit, deadline, account), take ? 'withdraw' : 'return', pending);
    return { approval, receipt };
  } catch (error) {
    // SH-258 round 4: an approval confirmed, then the move refused before the wallet: the line says both facts.
    const refusal = approval !== null ? preSendRefusalText(error) : null;
    if (refusal) throw new Error(approvalThenRefusal(take, refusal), { cause: error });
    if (asked && vaultErrorText(error) === 'Nothing confirmed. Try again.') throw new Error(confirmed ? REASON_FALLBACK : WALLET_ERROR_LINE, { cause: error });
    throw error;
  }
}
export const sendTakeOutV2 = (...args: Parameters<typeof move> extends [unknown, ...infer Rest] ? Rest : never) => move('take', ...args);
export const sendPutBackV2: typeof sendTakeOutV2 = (...args) => move('return', ...args);

/**
 * SH-235: what the card knows of the items' places: the items history of a box whose fees pay its items (as before),
 * otherwise the vault inventory every box with a collection vault has (`vaultItems`); null from a server that publishes
 * neither. Both only narrow which items are read; each item is checked on chain before it shows.
 */
export type VaultInventory = Pick<ItemsHistory, 'known' | 'owners'>;
export const inventoryOf = (view: Pick<V2Snapshot, 'm3' | 'vaultItems'>): VaultInventory | null => view.m3?.items ?? view.vaultItems ?? null;

/** One item's place proved by a receipt or an accepted read; no hash and no send lock. */
export interface VaultMoveV2 { readonly id: bigint; readonly inside: boolean; readonly account: Address; readonly block: bigint }

/**
 * The moves the feed has not caught up with: those after its block (`feedBlock`, the card's asOf, which the inventory
 * belongs to). Without an inventory nothing ever catches up, so every move of this visit stays (as before SH-235).
 */
export function pendingMoves(moves: readonly VaultMoveV2[], inventory: VaultInventory | null, feedBlock: bigint): readonly VaultMoveV2[] {
  return inventory === null ? moves : moves.filter((move) => move.block > feedBlock);
}

/** Each item's latest place from the moves (newest first), by decimal id. */
function latest(moves: readonly VaultMoveV2[]): ReadonlyMap<string, VaultMoveV2> {
  const places = new Map<string, VaultMoveV2>();
  for (const move of moves) if (!places.has(move.id.toString())) places.set(move.id.toString(), move);
  return places;
}

/**
 * The vault's items to read for one page: every collection id the inventory does not place outside (without tickets every
 * revealed item inside is free to take), or, with the draw add-on's tickets, only the items that left and came back (the
 * rest stay hidden for draws). The moves this card saw confirmed are laid over it, so a take leaves this list at once
 * and a put-back comes back. Filtered before the page is cut: page one is the first `size` items still inside. Without
 * an inventory, the whole id range. Each id is checked on chain before it shows.
 */
export function insideCandidates(roles: VaultRolesV2, history: VaultInventory | null | undefined, page: number, size = VAULT_PAGE,
  moves: readonly VaultMoveV2[] = []): { readonly ids: readonly bigint[]; readonly pages: number } {
  const startAt = (count: number) => Math.min(Math.max(0, page), Math.max(0, Math.ceil(count / size) - 1)) * size;
  const placed = latest(moves);
  if (roles.tickets && history) {
    const shelf = new Set(history.known.filter((k) => k.inside).map((k) => k.id.toString()));
    for (const [id, move] of placed) { if (move.inside) shelf.add(id); else shelf.delete(id); }
    const sorted = [...shelf].map(BigInt).sort(ascending);
    const start = startAt(sorted.length);
    return { ids: sorted.slice(start, start + size), pages: Math.max(1, Math.ceil(sorted.length / size)) };
  }
  const out = new Set((history?.known ?? []).filter((k) => !k.inside).map((k) => k.id.toString()));
  for (const [id, move] of placed) { if (move.inside) out.delete(id); else out.add(id); }
  const count = roles.n - [...out].filter((id) => BigInt(id) >= roles.firstId && BigInt(id) < roles.firstId + BigInt(roles.n)).length;
  const start = startAt(count);
  const ids: bigint[] = [];
  let seen = 0;
  for (let i = 0n; i < BigInt(roles.n) && ids.length < size; i += 1n) {
    const id = roles.firstId + i;
    if (out.has(id.toString())) continue;
    if (seen >= start) ids.push(id);
    seen += 1;
  }
  return { ids, pages: Math.max(1, Math.ceil(count / size)) };
}

/**
 * The wallet's items to read, all of them (the card shows VAULT_PAGE at a time): first those this card took out for this
 * account and the feed has not published yet (newest first), then those the inventory places outside with this owner
 * (every outside item when it names no owners), newest movement first; an item this card put back is left out. Each
 * is checked on chain before it shows.
 */
export function mineCandidates(history: VaultInventory | null | undefined, account: Address, moves: readonly VaultMoveV2[] = []): readonly bigint[] {
  const placed = latest(moves);
  const taken = [...placed.values()].filter((move) => !move.inside && same(move.account, account)).map((move) => move.id);
  const owners = history?.owners;
  const outside = (history?.known ?? []).filter((k) => !k.inside && (owners === undefined || same(owners[k.id.toString()] ?? null, account))).map((k) => k.id)
    .filter((id) => placed.get(id.toString())?.inside !== true);
  return [...new Set([...taken, ...outside].map(String))].map(BigInt);
}

const ascending = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * SH-235: a refusal the chain really gave: a revert with data. viem's readContract wraps any failed call,
 * a node's own error too (an upstream timeout, -32603, no data), in ContractFunctionRevertedError; such a read is asked
 * again, a refusal never.
 */
function refused(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return error.walk((cause) => {
    const data = (cause as { data?: unknown }).data;
    return (cause instanceof ContractFunctionRevertedError && (cause.data !== undefined || (cause.raw !== undefined && cause.raw !== '0x')))
      || (typeof data === 'string' && /^0x[0-9a-f]+$/i.test(data));
  }) !== null;
}

const sendLines = new Set([
  REFRESH_LINE, EARLIER_LINE, WALLET_ERROR_LINE, ITEM_NOT_REVEALED, REASON_FALLBACK, reasonText('unknown-send'),
  'Price unavailable. Refresh and try again.', 'The price changed. Refresh and try again.',
  'The vault refused it. Refresh and try again.', 'Sent, but not confirmed. Check your wallet before trying again.',
  'Cancelled in the wallet: an empty transaction took its place.', 'Replaced or cancelled in your wallet.',
  'The last item stays in the vault.', 'More than this wallet holds.', 'This box is closed.',
  'The vault opens with the box.', 'Amount unavailable. Refresh and try again.', 'The amount changed. Refresh and try again.',
  'Wrong network', 'Wallet changed; confirm again',
]);
/** "Approval confirmed. The withdrawal was not sent: the network gave no usable gas price. Try again." (round 4) */
export function approvalThenRefusal(take: boolean, refusal: string): string {
  const reason = refusal.replace(/; nothing was sent\.?/, '.').replace(/^./, (first) => first.toLowerCase());
  return `Approval confirmed. The ${take ? 'withdrawal' : 'return'} was not sent: ${reason}`;
}
const APPROVAL_THEN_REFUSAL = /^Approval confirmed\. The (?:withdrawal|return) was not sent: /;

/** One plain line for a failed send: nothing sent, declined, refused by the vault, not confirmed, or the check that stopped it. */
export function vaultErrorText(error: unknown): string {
  if (error instanceof RpcRequestError) return REFRESH_LINE;
  if (error instanceof WalletContextChangedError) return error.change === 'chain' ? 'Wrong network' : 'Wallet changed; confirm again';
  if (error instanceof NotSendableError) return 'Not sent. Nothing reached your wallet.';
  if (error instanceof WalletRejectedError) return 'Declined in your wallet.';
  if (error instanceof InsufficientGasFundsError) return gasFundsLine(error.chainId);
  // SH-258 round 3b: a price or gas-limit refusal never reached the wallet: its own line.
  const refusal = preSendRefusalText(error);
  if (refusal) return refusal;
  if (refused(error)) return 'The vault refused it. Refresh and try again.';
  if (error instanceof Error && error.message === 'Not confirmed') return 'Sent, but not confirmed. Check your wallet before trying again.';
  if (error instanceof Error && (sendLines.has(error.message) || APPROVAL_THEN_REFUSAL.test(error.message) || /^Item #\d+ (?:unavailable\. Refresh and try again\.|is no longer in the vault\.|is not in your wallet\.|comes back once it is revealed\.)$/.test(error.message))) return error.message;
  return 'Nothing confirmed. Try again.';
}
