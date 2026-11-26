import type { Hex } from 'viem';
import { itemPoliciesV2, pileConfigV2, type BoxSpecV2 } from './chain-v2';
import type { CoreEventV2 } from './events-v2';

export interface ItemFundingViewV2 {
  readonly batchId: bigint; readonly side: number; readonly source: number;
  readonly choiceP: bigint; readonly ledgerP: bigint;
}
export interface ItemOperationViewV2 {
  readonly ticketKey: Hex; readonly itemId: bigint; readonly fundingCursor: bigint; readonly at: bigint; readonly kind: number;
}
export interface ItemTicketViewV2 {
  readonly fundingStart: bigint; readonly start: bigint; readonly requestedAt: bigint;
  readonly state: 'open' | 'delivered' | 'cancelled'; readonly itemId: bigint | null;
}
export interface ItemsViewV2 {
  readonly policies: { readonly buyers: number; readonly sellers: number };
  readonly choiceP: bigint; readonly fundedP: bigint; readonly retainedBurnP: bigint; readonly depthP?: bigint; readonly flushedP: bigint;
  readonly fundingCursor: bigint; readonly lifecycleCursor: bigint; readonly outsideIndex: bigint;
  readonly funding: Readonly<Record<string, ItemFundingViewV2>>;
  readonly operations: Readonly<Record<string, ItemOperationViewV2>>;
  readonly tickets: Readonly<Record<string, ItemTicketViewV2>>;
  /** Lifecycle facts only; wallet transfers do not change these journal records. */
  readonly items: Readonly<Record<string, { readonly inside: boolean; readonly sequence: bigint }>>;
  /** Current collection owners at the feed hash; null means burned, an absent id is unknown. */
  readonly owners: Readonly<Record<string, string | null>>;
  /** Actual owner-claim payments, including repeated tranches; never current claimable credit. */
  readonly paidByItem: Readonly<Record<string, bigint>>;
  readonly paidP: bigint;
  readonly noticesFailed: bigint;
}
export interface PileViewV2 {
  readonly leaveBehindBps?: bigint;
  readonly asset: string; readonly seeder: string; readonly seedAmount: bigint;
  readonly seedLoaded: boolean; readonly loadedAmount: bigint; readonly seedReturned: boolean; readonly returnedAmount: bigint;
  readonly graduated: boolean; readonly failed: boolean; readonly redeemedT: bigint; readonly redeemedAsset: bigint;
}
export interface M3ViewV2 { readonly items: ItemsViewV2 | null; readonly pile: PileViewV2 | null }
function ensure(ok: unknown, why: string): asserts ok { if (!ok) throw new Error(`M3 history: ${why}`); }
const lower = (a: unknown) => String(a).toLowerCase();
const zeroKey = /^0x0{64}$/i;
const zeroAddress = /^0x0{40}$/i;

/** Canonically ordered, deduplicated logs from applyV2Block. No event total is a current claim or balance. */
export function m3ViewV2(events: readonly CoreEventV2[], boxId: bigint, spec: BoxSpecV2, creator: string, previous?: M3ViewV2): M3ViewV2 {
  const policies = itemPoliciesV2(spec);
  let items: ItemsViewV2 | null = previous?.items ?? (policies.buyers || policies.sellers ? {
    policies, choiceP: 0n, fundedP: 0n, retainedBurnP: 0n, flushedP: 0n, fundingCursor: 0n, lifecycleCursor: 0n,
    outsideIndex: 0n, funding: {}, operations: {}, tickets: {}, items: {}, owners: {}, paidByItem: {}, paidP: 0n, noticesFailed: 0n,
  } : null);
  const validItem = (id: bigint) => ensure(id >= spec.firstId && id < spec.firstId + BigInt(spec.n), 'item outside collection');
  const config = spec.boxType === 5 ? pileConfigV2(spec.contentsParams) : null;
  let pile: PileViewV2 | null = previous?.pile ?? (config ? { ...config, asset: lower(config.asset), seeder: lower(creator),
    seedLoaded: config.seedAmount === 0n, loadedAmount: 0n, seedReturned: false, returnedAmount: 0n,
    graduated: false, failed: false, redeemedT: 0n, redeemedAsset: 0n } : null);
  for (const e of events) {
    if (e.boxId !== boxId) continue;
    const a = e.args; const key = `${e.source}.${e.name}`;
    if (items && (key === 'collection.Transfer' || key === 'collection.ConsecutiveTransfer')) {
      const range = e.name === 'ConsecutiveTransfer';
      const first = (range ? a.fromTokenId : a.tokenId) as bigint;
      const last = range ? a.toTokenId as bigint : first;
      validItem(first); validItem(last);
      ensure(last >= first, 'reversed collection range');
      const to = lower(range ? a.toAddress : a.to);
      // Copy once for a bounded collection range; never mutate the parent snapshot.
      const owners = { ...items.owners };
      for (let id = first; id <= last; id++) owners[String(id)] = zeroAddress.test(to) ? null : to;
      items = { ...items, owners };
    } else if (items && key === 'itemLedger.ItemPaid') {
      const id = a.id as bigint; const p = a.grossP as bigint;
      validItem(id);
      ensure(a.tipP === 0n && p > 0n && !zeroAddress.test(lower(a.owner)) && !zeroAddress.test(lower(a.to)), 'invalid claim-only payment');
      ensure(items.paidP + items.flushedP + p <= items.fundedP, 'payment exceeds transferred funding');
      // A payout callback may transfer the NFT before this event. Neither owner nor to sets current ownership.
      items = { ...items, paidP: items.paidP + p,
        paidByItem: { ...items.paidByItem, [String(id)]: (items.paidByItem[String(id)] ?? 0n) + p } };
    } else if (items && key === 'receiver.ItemFunded') {
      const receipt = { batchId: a.batchId as bigint, side: a.side as number, source: a.source as number, choiceP: a.choiceP as bigint, ledgerP: a.ledgerP as bigint };
      const id = a.receiptId as bigint; const policy = receipt.side === 1 ? policies.buyers : receipt.side === 2 ? policies.sellers : 0;
      ensure(id === items.fundingCursor + 1n, 'item receipt is not consecutive');
      ensure(policy !== 0 && receipt.source >= 1 && receipt.source <= 3 && (receipt.source === 1 ? receipt.batchId > 0n : receipt.batchId === 0n), 'invalid funding source/side');
      ensure(receipt.ledgerP <= receipt.choiceP && (policy !== 1 || receipt.ledgerP === receipt.choiceP)
        && (receipt.source !== 3 || policy === 1 || receipt.ledgerP === 0n), 'funding exceeds its source or disagrees with policy');
      items = { ...items, choiceP: items.choiceP + receipt.choiceP, fundedP: items.fundedP + receipt.ledgerP,
        retainedBurnP: items.retainedBurnP + (policy === 2 ? receipt.choiceP - receipt.ledgerP : 0n),
        ...(policy === 3 ? { depthP: (items.depthP ?? 0n) + receipt.choiceP - receipt.ledgerP } : {}), fundingCursor: id,
        outsideIndex: items.outsideIndex + (receipt.source === 3 ? 0n : receipt.choiceP / BigInt(spec.n)),
        funding: { ...items.funding, [String(id)]: receipt } };
    } else if (items && key === 'vault.ItemLifecycleRecorded') {
      const seq = a.sequence as bigint; const op = a as unknown as ItemOperationViewV2;
      ensure(seq === items.lifecycleCursor + 1n, 'lifecycle sequence is not consecutive');
      ensure(op.fundingCursor === items.fundingCursor, 'lifecycle funding cursor disagrees with receipts');
      ensure(op.kind >= 1 && op.kind <= 6, 'unknown lifecycle kind');
      let tickets = items.tickets; let known = items.items;
      if (op.kind <= 3) {
        ensure(!zeroKey.test(op.ticketKey), 'missing ticket key');
        const k = lower(op.ticketKey); const ticket = tickets[k];
        if (op.kind === 1) {
          ensure(!ticket && op.itemId === 0n, 'ticket key reused or request names an item');
          tickets = { ...tickets, [k]: { fundingStart: op.fundingCursor, start: items.outsideIndex, requestedAt: op.at, state: 'open', itemId: null } };
        } else {
          ensure(ticket?.state === 'open', 'ticket is not open');
          ensure(op.kind !== 3 || op.itemId === 0n, 'cancel names an item');
          tickets = { ...tickets, [k]: { ...ticket, state: op.kind === 2 ? 'delivered' : 'cancelled', itemId: op.kind === 2 ? op.itemId : null } };
        }
      } else ensure(zeroKey.test(op.ticketKey), 'named item has ticket key');
      if (op.kind === 2 || op.kind >= 4) {
        validItem(op.itemId);
        known = { ...known, [String(op.itemId)]: { inside: op.kind === 5, sequence: seq } };
      }
      items = { ...items, tickets, items: known, lifecycleCursor: seq, operations: { ...items.operations, [String(seq)]: {
        ticketKey: op.ticketKey, itemId: op.itemId, fundingCursor: op.fundingCursor, at: op.at, kind: op.kind,
      } } };
    } else if (items && key === 'itemLedger.ResidueFlushed') {
      const p = a.p as bigint;
      ensure(items.paidP + items.flushedP + p <= items.fundedP, 'residue exceeds transferred funding');
      items = { ...items, flushedP: items.flushedP + p };
    } else if (items && key === 'vault.ItemLedgerCallFailed') items = { ...items, noticesFailed: items.noticesFailed + 1n };
    if (!pile || e.source !== 'vault') continue;
    if (e.name === 'SeedLoaded') {
      ensure(!pile.seedLoaded && !pile.failed && !pile.graduated && lower(a.seeder) === pile.seeder && lower(a.asset) === pile.asset && a.amount === pile.seedAmount, 'seed loading differs from commitment');
      pile = { ...pile, seedLoaded: true, loadedAmount: a.amount as bigint };
    } else if (e.name === 'GateOpened') {
      ensure(pile.seedLoaded && !pile.failed && !pile.graduated, 'pile graduation before seed or after failure');
      pile = { ...pile, graduated: true };
    } else if (e.name === 'FailureEntered') {
      ensure(!pile.graduated && !pile.failed, 'pile failure after graduation or repeated');
      pile = { ...pile, failed: true };
    } else if (e.name === 'Redeemed') {
      ensure(pile.graduated && !pile.failed && (a.tIn as bigint) > 0n, 'redemption before graduation');
      // Gifts of the fixed asset join redemptions, so output may exceed the original seed.
      pile = { ...pile, redeemedT: pile.redeemedT + (a.tIn as bigint), redeemedAsset: pile.redeemedAsset + (a.assetOut as bigint) };
    } else if (e.name === 'SeedReturned') {
      ensure(pile.failed && !pile.seedReturned && lower(a.seeder) === pile.seeder && a.amount === pile.loadedAmount, 'seed return is not owed to this seeder');
      pile = { ...pile, seedReturned: true, returnedAmount: a.amount as bigint };
    }
  }
  return { items, pile };
}
