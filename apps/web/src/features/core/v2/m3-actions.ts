/**
 * M3-53 actions: item claims, the item ledger's sync, pile redemption (approve, then redeem with an exact minimum) and
 * the seed return after failure. Each reads the displayed hash first, simulates, re-checks the wallet, and goes
 * through the shared sender (`submitWrite`), the site's only wallet send. The wallet is asked only on a press.
 */
import { createPublicClient, decodeFunctionResult, encodeFunctionData, erc20Abi, http, type Abi, type Address, type Hex } from 'viem';
import { boxCollectionAbi } from '@squarehole/chain/abi';
import { itemLedgerV2Abi, pileVaultV2Abi, rolesOfV2 } from '../../../../../../packages/chain/src/core/v2';
import type { WriteTargetV2 } from '../../../../../../packages/chain/src/core/v2/write-calls-v2';
import { m2RpcReaderV2 } from '../../../../../../packages/indexer/src/core/v2/m2-reads-v2';
import { readItemClaimV2, readPileQuoteV2 } from '../../../../../../packages/indexer/src/core/v2/m3-reads-v2';
import { submitWrite } from '@squarehole/chain/write';
import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import { actionIO, gasLimitFor, identity, type ActionIO, type HolderReceiptV2 } from './actions-v2';
import type { V2Snapshot, V2Source } from './indexer-v2';
import type { ItemClaimV2 } from './item-claims';
import { pageClient } from '../../create/v2/view-client';

/** The most records one sync processes from each journal (ItemLedgerV2: 1 <= k <= 32). */
export const SYNC_PAGE = 32n;

/**
 * The prepared roles of an M3 box. The shared sender's guard admits item claims and sync only to `itemLedger` (role
 * 16) and the pile's approval, redemption and seed return only to `pile` (role 3 of a PILE box); anything else it
 * refuses before the wallet with NotSendableError.
 */
export type M3TargetV2 = WriteTargetV2;
export type PileQuoteV2 = Awaited<ReturnType<typeof readPileQuoteV2>>;

export interface M3ActionIO extends Pick<ActionIO, 'chainId' | 'request' | 'simulate' | 'estimate' | 'feeReader'> {
  /** Each item's current owner at the displayed hash (one ownerOf each); null where the read failed. */
  owners(ids: readonly bigint[]): Promise<ReadonlyMap<string, Address | null>>;
  /** One item's backed credit at the displayed hash, with the owner-only claim simulated (M3-52). */
  item(id: bigint): Promise<ItemClaimV2>;
  /** The pile's quote for `tIn` at the displayed hash (M3-52). */
  quote(tIn: bigint): Promise<PileQuoteV2>;
  /** A current read of T: the wallet's balance, or what it lets the pile take. */
  coins(fn: 'balanceOf' | 'allowance', args: readonly Address[]): Promise<bigint>;
  receipt(hash: Hex): Promise<HolderReceiptV2>;
  submit: typeof submitWrite;
}

const fresh = (view: V2Snapshot) => { if (view.stale || !view.verified || !view.claimRow) throw new Error('Refresh before sending: this read is not current and verified'); return view.claimRow; };

export function m3ActionIO(source: V2Source, view: V2Snapshot, request: Eip1193Request): M3ActionIO {
  const client = pageClient(source.rpc, source.manifest.chainId, () => createPublicClient({ transport: http(source.rpc, { retryCount: 0 }) }));
  const reader = m2RpcReaderV2(client);
  const checked = async () => { const row = fresh(view); if (await client.getChainId() !== source.manifest.chainId) throw new Error('Wrong network'); return row; };
  return { ...actionIO(source.rpc, request), submit: submitWrite,
    receipt: (hash) => client.waitForTransactionReceipt({ hash }),
    owners: async (ids) => {
      const row = await checked(); const collection = row.contracts.collection;
      if (!collection) throw new Error('Collection unavailable');
      const owners = await Promise.all(ids.map(async (id) => {
        try {
          const data = await reader.callAt(collection, encodeFunctionData({ abi: boxCollectionAbi, functionName: 'ownerOf', args: [id] }), view.blockHash);
          return [id.toString(), decodeFunctionResult({ abi: boxCollectionAbi, functionName: 'ownerOf', data }) as Address] as const;
        } catch { return [id.toString(), null] as const; }
      }));
      return new Map(owners);
    },
    item: async (id) => readItemClaimV2(reader, await checked(), { id }, view.blockHash),
    quote: async (tIn) => readPileQuoteV2(reader, await checked(), tIn, view.blockHash),
    coins: async (fn, args) => client.readContract({ address: view.token, abi: erc20Abi, functionName: fn, args: args as never }) as Promise<bigint>,
  };
}

/** The shared sender's target for this box, with the M3 roles it has. */
export function m3Target(source: V2Source, view: V2Snapshot): M3TargetV2 {
  const roles = rolesOfV2(view.record).contracts;
  if (!roles.coordinator || !roles.receiver) throw new Error('Box roles unavailable');
  return { chainId: source.manifest.chainId, coordinator: roles.coordinator, receiver: roles.receiver, token: view.token, p: view.record.q,
    ...(roles.holderLedger ? { holderLedger: roles.holderLedger } : {}), ...(roles.itemLedger ? { itemLedger: roles.itemLedger } : {}),
    ...(view.spec.boxType === 5 && roles.vault ? { pile: roles.vault } : {}) };
}

/** What one checked send needs: the simulation, the estimate, the wallet re-check, the shared sender and the receipt. */
export type SendIO = Pick<M3ActionIO, 'chainId' | 'request' | 'simulate' | 'estimate' | 'submit' | 'receipt' | 'feeReader'>;

/**
 * Simulate, estimate, re-check the wallet, send through the shared sender, and require this transaction's success. SH-235:
 * with `block`, the simulation and the estimate read that block (one not older than an approval just confirmed).
 */
export async function sendCheckedV2(target: M3TargetV2, account: Address, to: Address, data: Hex, io: SendIO, block?: bigint): Promise<HolderReceiptV2> {
  // Without a block, the calls stay exactly as every other card makes them (the latest block).
  await (block === undefined ? io.simulate(to, data, account) : io.simulate(to, data, account, block));
  const estimate = await (block === undefined ? io.estimate(to, data, account) : io.estimate(to, data, account, block));
  await identity(target, account, io);
  // RR2-LIM-2: a coordinator claim (Claim all's remainder and hand-in) carries the inbox sweep's margin.
  const sent = await io.submit({ protocol: 'core-v2', target, call: { to, data, value: 0n }, wallet: io.request, from: account,
    // SH-258: the shop's wider margin on BNB Chain testnet only (measured there); Sepolia keeps its fifth.
    gasLimit: gasLimitFor(to, target.coordinator, estimate, target.chainId === 97 ? (target as { readonly shop?: Address }).shop ?? null : null), feeReader: io.feeReader });
  const receipt = await io.receipt(sent);
  if (receipt.status !== 'success' || receipt.transactionHash !== sent) throw new Error('Not confirmed');
  return receipt;
}

const encode = (abi: Abi, functionName: string, args: readonly unknown[] = []) => encodeFunctionData({ abi, functionName, args } as never) as Hex;

/** The current owner claims one item's whole credit (outside share and stash) to itself: claim([id], owner). */
export async function sendItemClaimV2(source: V2Source, view: V2Snapshot, account: Address, id: bigint, expectedP: bigint, io: M3ActionIO): Promise<HolderReceiptV2> {
  const target = m3Target(source, view); const ledger = target.itemLedger;
  fresh(view);
  if (!ledger || id <= 0n || expectedP <= 0n) throw new Error('Refresh your item payouts before claiming');
  await identity(target, account, io);
  const credit = await io.item(id);
  if (credit.hash !== view.blockHash || credit.id !== id || credit.owner.toLowerCase() !== account.toLowerCase() || credit.status !== 'synced' || credit.payout !== 'available' || credit.claimableP !== expectedP) {
    throw new Error('Item payout changed or unavailable. Refresh and try again.');
  }
  return sendCheckedV2(target, account, ledger, encode(itemLedgerV2Abi, 'claim', [[id], account]), io);
}

/**
 * v2.1 step 2: the current owner claims one item's credit in the box token to itself: claimT([id], owner). The same
 * checks as the P claim, against the read's `t` quote at the displayed hash; the shared sender admits only this call.
 */
export async function sendItemClaimTV2(source: V2Source, view: V2Snapshot, account: Address, id: bigint, expectedT: bigint, io: M3ActionIO): Promise<HolderReceiptV2> {
  const target = m3Target(source, view); const ledger = target.itemLedger;
  fresh(view);
  if (!ledger || id <= 0n || expectedT <= 0n) throw new Error('Refresh your item payouts before claiming');
  await identity(target, account, io);
  const credit = await io.item(id);
  const t = credit.t;
  if (!t || credit.hash !== view.blockHash || credit.id !== id || credit.owner.toLowerCase() !== account.toLowerCase() || credit.status !== 'synced' || t.payout !== 'available' || t.claimableT !== expectedT) {
    throw new Error('Item payout changed or unavailable. Refresh and try again.');
  }
  return sendCheckedV2(target, account, ledger, encode(itemLedgerV2Abi, 'claimT', [[id], account]), io);
}

/** Anyone advances the item ledger through its funding and vault records, one page: sync(32). No money moves. */
export async function sendItemSyncV2(source: V2Source, view: V2Snapshot, account: Address, io: M3ActionIO): Promise<HolderReceiptV2> {
  const target = m3Target(source, view); fresh(view);
  if (!target.itemLedger) throw new Error('Item ledger unavailable');
  await identity(target, account, io);
  return sendCheckedV2(target, account, target.itemLedger, encode(itemLedgerV2Abi, 'sync', [SYNC_PAGE]), io);
}

function pileOf(source: V2Source, view: V2Snapshot) {
  const target = m3Target(source, view); fresh(view);
  if (!target.pile || !view.m3?.pileMoney) throw new Error('Coin pile unavailable');
  return { target, pile: target.pile, money: view.m3.pileMoney };
}

/** Let the pile take exactly `tIn` of this wallet's coins: approve(pile, tIn) on T. */
export async function sendPileApproveV2(source: V2Source, view: V2Snapshot, account: Address, tIn: bigint, io: M3ActionIO): Promise<HolderReceiptV2> {
  const { target, pile, money } = pileOf(source, view);
  if (!money.redemptionOpen || tIn <= 0n) throw new Error('Redemption opens after graduation');
  await identity(target, account, io);
  if (tIn > await io.coins('balanceOf', [account])) throw new Error('More coins than this wallet holds');
  return sendCheckedV2(target, account, view.token, encode(erc20Abi as Abi, 'approve', [pile, tIn]), io);
}

/** Hand in `tIn` coins for exactly the quoted share: redeem(tIn, minOut, wallet), minOut = the displayed quote. */
export async function sendPileRedeemV2(source: V2Source, view: V2Snapshot, account: Address, tIn: bigint, minOut: bigint, io: M3ActionIO): Promise<HolderReceiptV2> {
  const { target, pile, money } = pileOf(source, view);
  if (!money.redemptionOpen || tIn <= 0n || minOut <= 0n) throw new Error('Redemption opens after graduation');
  await identity(target, account, io);
  const quote = await io.quote(tIn);
  if (quote.hash !== view.blockHash || quote.tIn !== tIn || !quote.graduated || quote.failed || quote.assetOut !== minOut) throw new Error('Pile quote changed. Refresh and try again.');
  const [balance, allowance] = await Promise.all([io.coins('balanceOf', [account]), io.coins('allowance', [account, pile])]);
  if (tIn > balance) throw new Error('More coins than this wallet holds');
  if (allowance < tIn) throw new Error('Approve these coins first');
  return sendCheckedV2(target, account, pile, encode(pileVaultV2Abi, 'redeem', [tIn, minOut, account]), io);
}

/** After failure, anyone sends the recorded seed back to its seeder (the creator): returnSeed(). */
export async function sendSeedReturnV2(source: V2Source, view: V2Snapshot, account: Address, io: M3ActionIO): Promise<HolderReceiptV2> {
  const { target, pile, money } = pileOf(source, view);
  if (!money.failed || money.seedReturnDue <= 0n) throw new Error('No seed return is due');
  await identity(target, account, io);
  return sendCheckedV2(target, account, pile, encode(pileVaultV2Abi, 'returnSeed'), io);
}
