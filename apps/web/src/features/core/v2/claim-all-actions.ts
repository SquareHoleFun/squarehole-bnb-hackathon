/**
 * F128 Claim all: the claims beside holder batches (actions-v2.ts) and items (m3-actions.ts). The creator's fees
 * (`claimCreator(P, caller)` on the receiver), the creator's remainder of a box nobody bought (`claim(0, caller)`
 * on the coordinator), and on a failed box the hand-in of this wallet's coins (`approve(coordinator, coins)` on T, then
 * `claim(coins, caller)` on the coordinator). Each re-reads what it claims first, simulates, re-checks the wallet and
 * goes through the shared sender (`submitWrite`), the site's only wallet send, and requires this transaction's mined
 * success. The wallet is asked only on a press.
 *
 * FINAL-OC01: the creator's fees are always the receiver's next payment, `readCreatorClaimV2` (the chain v2 entry point,
 * shared with the wallet claims index): the payee's own simulated `claimCreator` at one canonical hash. It includes the
 * graduation settlement and royalties the receiver books lazily on the claim, and the receiver's four-part payment
 * bound. The stored `creatorOwed` decides nothing here.
 */
import { createPublicClient, decodeEventLog, decodeFunctionResult, encodeFunctionData, erc20Abi, http, type Abi, type Address, type Hex } from 'viem';
import { coordinatorV2Abi, readCreatorClaimV2, receiverV2Abi, rolesOfV2, type CreatorClaimReaderV2 } from '../../../../../../packages/chain/src/core/v2';
import { m2RpcReaderV2 } from '../../../../../../packages/indexer/src/core/v2/m2-reads-v2';
import { submitWrite } from '@squarehole/chain/write';
import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import { actionIO, identity, type ActionIO, type HolderReceiptV2 } from './actions-v2';
import type { SeedOwed, SingleRead } from './claim-all';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { m3Target, sendCheckedV2 } from './m3-actions';
import { pageClient } from '../../create/v2/view-client';

export interface ClaimAllIO extends Pick<ActionIO, 'chainId' | 'request' | 'simulate' | 'estimate' | 'feeReader'> {
  /** A read at the displayed snapshot's hash, canonical only: what the list showed. */
  at(to: Address, abi: Abi, fn: string, args?: readonly unknown[]): Promise<unknown>;
  /** The same, called from `from` (a simulation of what `from` would be paid; nothing is sent). */
  as(from: Address, to: Address, abi: Abi, fn: string, args?: readonly unknown[]): Promise<unknown>;
  /** A read at the latest block: an approval mined after the snapshot shows only here. */
  now(to: Address, abi: Abi, fn: string, args?: readonly unknown[]): Promise<unknown>;
  receipt(hash: Hex): Promise<HolderReceiptV2>;
  submit: typeof submitWrite;
}

export function claimAllIO(source: V2Source, view: V2Snapshot, request: Eip1193Request): ClaimAllIO {
  const client = pageClient(source.rpc, source.manifest.chainId, () => createPublicClient({ transport: http(source.rpc, { retryCount: 0 }) }));
  const reader = m2RpcReaderV2(client);
  const base = actionIO(source.rpc, request);
  return { chainId: base.chainId, request: base.request, simulate: base.simulate, estimate: base.estimate, feeReader: base.feeReader, submit: submitWrite,
    receipt: (hash) => client.waitForTransactionReceipt({ hash }),
    at: async (to, abi, fn, args = []) => {
      const data = await reader.callAt(to, encodeFunctionData({ abi, functionName: fn, args } as never), view.blockHash);
      return decodeFunctionResult({ abi, functionName: fn, data } as never);
    },
    as: async (from, to, abi, fn, args = []) => {
      if (!reader.callFromAt) throw new Error('Simulation unavailable');
      const data = await reader.callFromAt(from, to, encodeFunctionData({ abi, functionName: fn, args } as never), view.blockHash);
      return decodeFunctionResult({ abi, functionName: fn, data } as never);
    },
    now: (to, abi, fn, args = []) => client.readContract({ address: to, abi, functionName: fn, args } as never),
  };
}

const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const big = (value: unknown, what: string): bigint => { if (typeof value !== 'bigint') throw new Error(`${what} unavailable`); return value; };
const fresh = (view: V2Snapshot) => { if (view.stale || !view.verified) throw new Error('Refresh before claiming: this read is not current and verified'); };
const roles = (view: V2Snapshot) => {
  const { coordinator, receiver } = rolesOfV2(view.record).contracts;
  if (!coordinator || !receiver) throw new Error('Box roles unavailable');
  return { coordinator, receiver };
};

/**
 * What the snapshot alone says about this wallet's creator fees (FINAL-OC01): 0n when it has none here (the box has not
 * graduated, has failed, or another address is its payee); null when only the receiver's own quote can say how much,
 * `readCreatorFeesV2`. Never the stored creatorOwed: the receiver settles graduation and royalties lazily on the claim
 * and pays at most four int128 parts per call, so the stored figure can be zero while 1,234 is payable, or above a
 * single payment.
 */
export function creatorFeesOf(view: V2Snapshot, account: Address): bigint | null {
  // No payee (the zero address) can call claimCreator: nobody has creator fees to claim.
  if (!view.graduated || view.failed || /^0x0{40}$/i.test(account)) return 0n;
  return view.money && !same(account, view.money.creatorPayee) ? 0n : null;
}

/** The box's price coin and roles as the shared creator quote takes them (`CreatorClaimTargetV2`). */
const creatorTarget = (view: V2Snapshot) => ({ q: view.record.q, contracts: rolesOfV2(view.record).contracts });

/**
 * The creator's next payment at the displayed snapshot's hash: `readCreatorClaimV2` with this site's sender-aware RPC
 * reads (nothing is sent; the wallet is not asked). Nothing to claim reads 0; a payout the receiver would refuse, or any
 * failed read, rejects: the panel then says the read failed, never 0.
 */
export async function readCreatorFeesV2(view: V2Snapshot, account: Address, reader: CreatorClaimReaderV2): Promise<SingleRead> {
  if (creatorFeesOf(view, account) !== null) return { block: view.block, amount: 0n };
  const quote = await readCreatorClaimV2(reader, creatorTarget(view), account, view.blockHash);
  if (quote === null) return { block: view.block, amount: 0n };
  if (quote.payout !== 'available') throw new Error('Creator payout unavailable');
  return { block: view.block, amount: quote.amountP };
}

/** RPC URLs already seen answering the box's chain id (asked once per page load, not per snapshot). */
const checkedRpc = new Set<string>();

/** The sender-aware canonical reads behind `readCreatorFeesV2`, on the box's own network (checked first). */
export async function creatorReaderV2(source: V2Source): Promise<CreatorClaimReaderV2> {
  const client = pageClient(source.rpc, source.manifest.chainId, () => createPublicClient({ transport: http(source.rpc, { retryCount: 0 }) }));
  const key = `${source.rpc}|${source.manifest.chainId}`;
  if (!checkedRpc.has(key)) {
    if (await client.getChainId() !== source.manifest.chainId) throw new Error('Wrong network');
    checkedRpc.add(key);
  }
  return m2RpcReaderV2(client);
}

/** The creator's remainder of a failed box nobody bought, once no coins are left to hand in: the failure-time amount plus inbox P added later (INBOX af2). */
export function creatorRemainderOf(view: V2Snapshot, account: Address): bigint {
  const closing = view.closing;
  return view.failed && closing && closing.tLeft === 0n && same(account, view.record.creator) ? closing.creatorEntitlement : 0n;
}

/**
 * RC6-RR-INBOX: the inbox P the creator's remainder includes at the snapshot (quoteClaim(0) previews readable inbox P,
 * which the claim first moves into the pot, conditional on that intake); null when it includes none or it is unknown.
 */
export function creatorRemainderInboxPOf(view: V2Snapshot, account: Address): bigint | null {
  const remainder = creatorRemainderOf(view, account); const waiting = view.closing?.inboxP ?? null;
  return view.closing?.initialT === 0n && waiting !== null && waiting > 0n && waiting <= remainder ? waiting : null;
}

/**
 * The seed a failed coin pile owes back (M363-OC03), from the snapshot: only to its recorded seeder, only after failure,
 * only while still owed and backed by the pile's balance read at the same hash. Anyone may call returnSeed() on chain;
 * Claim all lists it only for the seeder, whose claim it is.
 */
export function seedOwedOf(view: V2Snapshot, account: Address): SeedOwed | null {
  const pile = view.m3?.pile; const money = view.m3?.pileMoney;
  if (view.spec.boxType !== 5 || !pile || !money) return null;
  const due = money.seedReturnDue;
  const backed = money.balance !== null && due <= money.balance;
  if (!money.failed || pile.seedReturned || due <= 0n || !backed || !same(account, pile.seeder)) return null;
  return { amount: due, asset: money.asset, to: pile.seeder };
}

/**
 * The hand-in at the displayed snapshot: this wallet's coins up to the coins still counted, the P they take out of
 * the pot (`quoteClaim`), and what the coordinator may already take. Nothing to hand in before failure. A refused
 * quote is a failed read, never an unpriced one. SH-RC7 item 29: the coordinator quotes the final share at its pot plus
 * the inbox's readable P, so it refuses only an inbox it cannot read, whose claim refuses too (RC6 R1-3's route is gone).
 */
export async function readHandInV2(view: V2Snapshot, account: Address, io: Pick<ClaimAllIO, 'at'>): Promise<SingleRead> {
  const tLeft = view.closing?.tLeft ?? 0n;
  if (!view.failed || tLeft === 0n) return { block: view.block, amount: 0n };
  const { coordinator } = roles(view);
  const [balance, allowance] = await Promise.all([io.at(view.token, erc20Abi, 'balanceOf', [account]), io.at(view.token, erc20Abi, 'allowance', [account, coordinator])]);
  const coins = big(balance, 'Coin balance') < tLeft ? big(balance, 'Coin balance') : tLeft;
  const approved = big(allowance, 'Allowance');
  if (coins === 0n) return { block: view.block, amount: coins, pOut: 0n, approved };
  const pOut = big(await io.at(coordinator, coordinatorV2Abi, 'quoteClaim', [coins]), 'Claim quote');
  // RC6-RR-INBOX: the final share's quote includes the inbox P its claim first moves in; the snapshot read it at this hash.
  const waiting = coins === tLeft ? view.closing?.inboxP ?? null : null;
  return { block: view.block, amount: coins, pOut, approved, ...(waiting !== null && waiting > 0n && waiting <= pOut ? { collectFirstP: waiting } : {}) };
}

/** A mined creator claim, with the P its `CreatorClaimed` event says the receiver paid (null when the receipt has none). */
export type CreatorReceiptV2 = HolderReceiptV2 & { readonly paidP: bigint | null };
/** A mined claim on a failed box's coordinator, with the P its `Claimed` event says it paid (null when the receipt has none). */
export type CoordinatorReceiptV2 = HolderReceiptV2 & { readonly paidP: bigint | null };

/**
 * The P of the coordinator's `Claimed(holder, to, t, p)` for this holder, paid to itself, for exactly `coins` (0 for the
 * creator's remainder). RC6-RR-INBOX: a claim that includes inbox P pays it only if the intake succeeds, so what was
 * paid comes from the receipt, never from the preview.
 */
export function coordinatorClaimedOf(receipt: unknown, coordinator: Address, holder: Address, coins: bigint): bigint | null {
  const logs = typeof receipt === 'object' && receipt !== null ? (receipt as { logs?: unknown }).logs : undefined;
  if (!Array.isArray(logs)) return null;
  for (const log of logs as readonly { address?: unknown; topics?: unknown; data?: unknown }[]) {
    if (typeof log.address !== 'string' || !same(log.address, coordinator) || !Array.isArray(log.topics) || typeof log.data !== 'string') continue;
    try {
      const event = decodeEventLog({ abi: coordinatorV2Abi, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
      if (event.eventName !== 'Claimed') continue;
      const args = event.args as { holder: Address; to: Address; t: bigint; p: bigint };
      if (same(args.holder, holder) && same(args.to, holder) && args.t === coins) return args.p;
    } catch { /* Another event of the coordinator. */ }
  }
  return null;
}

/** The amount of the receiver's `CreatorClaimed(payee, token, to, amount)` for this payee, coin and recipient, if any. */
export function creatorClaimedOf(receipt: unknown, receiver: Address, payee: Address, q: Address): bigint | null {
  const logs = typeof receipt === 'object' && receipt !== null ? (receipt as { logs?: unknown }).logs : undefined;
  if (!Array.isArray(logs)) return null;
  for (const log of logs as readonly { address?: unknown; topics?: unknown; data?: unknown }[]) {
    if (typeof log.address !== 'string' || !same(log.address, receiver) || !Array.isArray(log.topics) || typeof log.data !== 'string') continue;
    try {
      const event = decodeEventLog({ abi: receiverV2Abi, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
      if (event.eventName !== 'CreatorClaimed') continue;
      const args = event.args as { payee: Address; token: Address; to: Address; amount: bigint };
      if (same(args.payee, payee) && same(args.token, q) && same(args.to, payee)) return args.amount;
    } catch { /* Another event of the receiver. */ }
  }
  return null;
}

/**
 * The creator claims its fees in the box's price coin to itself: claimCreator(P, creator), exactly the amount shown.
 * That amount is always the next payment (FINAL-OC01): re-read here at the same hash as the payee's own simulated claim,
 * with the payee, graduation and failure rules of `readCreatorClaimV2`, on every route that sends it (Claim all and the
 * box page's button). The receipt's `CreatorClaimed` gives what was actually paid; what is left (a bounded payout's
 * tail, or fees that arrived since) is read again at the next snapshot.
 */
export async function sendCreatorFeesV2(source: V2Source, view: V2Snapshot, account: Address, expectedP: bigint, io: ClaimAllIO): Promise<CreatorReceiptV2> {
  fresh(view); const target = m3Target(source, view); const { coordinator, receiver } = roles(view);
  if (expectedP <= 0n) throw new Error('No creator fees to claim');
  await identity(target, account, io);
  const [payee, graduated, failed, next] = await Promise.all([io.at(receiver, receiverV2Abi, 'creatorPayee'), io.at(coordinator, coordinatorV2Abi, 'graduated'), io.at(coordinator, coordinatorV2Abi, 'failed'),
    io.as(account, receiver, receiverV2Abi, 'claimCreator', [view.record.q, account])]);
  if (!same(payee, account) || graduated !== true || failed !== false || next !== expectedP) throw new Error('Creator fees changed. Refresh and try again.');
  const receipt = await sendCheckedV2(target, account, receiver, encodeFunctionData({ abi: receiverV2Abi, functionName: 'claimCreator', args: [view.record.q, account] }), io);
  return { ...receipt, paidP: creatorClaimedOf(receipt, receiver, account, view.record.q) };
}

/**
 * The creator claims the remainder of a failed box with no coins left: claim(0, creator) on the coordinator; later inbox P
 * reopens it (RC6-RR-INBOX: quoteClaim(0) previews it). The receipt's `Claimed` gives what was paid.
 */
export async function sendCreatorRemainderV2(source: V2Source, view: V2Snapshot, account: Address, expectedP: bigint, io: ClaimAllIO): Promise<CoordinatorReceiptV2> {
  fresh(view); const target = m3Target(source, view); const { coordinator } = roles(view);
  if (expectedP <= 0n || !same(account, view.record.creator)) throw new Error('No creator remainder for this wallet');
  await identity(target, account, io);
  const [state, quote] = await Promise.all([io.at(coordinator, coordinatorV2Abi, 'claimState'), io.at(coordinator, coordinatorV2Abi, 'quoteClaim', [0n])]);
  if (!Array.isArray(state) || state[1] !== 0n || quote !== expectedP) throw new Error('Creator remainder changed. Refresh and try again.');
  const receipt = await sendCheckedV2(target, account, coordinator, encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'claim', args: [0n, account] }), io);
  return { ...receipt, paidP: coordinatorClaimedOf(receipt, coordinator, account, 0n) };
}

/** Current checks before handing in `coins`: the box failed, the wallet holds them, and they are still counted. */
async function handInChecks(view: V2Snapshot, account: Address, coins: bigint, io: ClaimAllIO, coordinator: Address): Promise<void> {
  if (coins <= 0n) throw new Error('No coins to hand in');
  const [failed, balance, state] = await Promise.all([io.now(coordinator, coordinatorV2Abi, 'failed'), io.now(view.token, erc20Abi, 'balanceOf', [account]), io.now(coordinator, coordinatorV2Abi, 'claimState')]);
  if (failed !== true || typeof balance !== 'bigint' || !Array.isArray(state) || typeof state[1] !== 'bigint' || coins > balance || coins > state[1]) throw new Error('Coins changed. Refresh and try again.');
}

/** Let the coordinator take exactly the coins handed in: approve(coordinator, coins) on T. */
export async function sendHandInApprovalV2(source: V2Source, view: V2Snapshot, account: Address, coins: bigint, io: ClaimAllIO): Promise<HolderReceiptV2> {
  fresh(view); const target = m3Target(source, view); const { coordinator } = roles(view);
  await identity(target, account, io);
  await handInChecks(view, account, coins, io, coordinator);
  return sendCheckedV2(target, account, view.token, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [coordinator, coins] }), io);
}

/**
 * Hand in `coins` for their share of the pot, paid to this wallet: claim(coins, wallet) on the coordinator. A refused
 * quote stops here (SH-RC7 item 29: the final share's quote includes the inbox's readable P; RC6 R1-3's route is gone).
 */
export async function sendHandInV2(source: V2Source, view: V2Snapshot, account: Address, coins: bigint, io: ClaimAllIO): Promise<CoordinatorReceiptV2> {
  fresh(view); const target = m3Target(source, view); const { coordinator } = roles(view);
  await identity(target, account, io);
  await handInChecks(view, account, coins, io, coordinator);
  const allowance = await io.now(view.token, erc20Abi, 'allowance', [account, coordinator]);
  if (typeof allowance !== 'bigint' || allowance < coins) throw new Error('Approve these coins first');
  await io.now(coordinator, coordinatorV2Abi, 'quoteClaim', [coins]);
  const receipt = await sendCheckedV2(target, account, coordinator, encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'claim', args: [coins, account] }), io);
  return { ...receipt, paidP: coordinatorClaimedOf(receipt, coordinator, account, coins) };
}
