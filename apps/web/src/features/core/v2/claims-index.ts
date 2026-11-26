/**
 * The wallet claims index (SH-V2-CLAIMS-INDEX): `GET /v2/wallets/<chain>/<wallet>/claims`, every claim one wallet has
 * across the indexer's v2 boxes at one canonical block, with the payments it received in the last 7,200 blocks. Claim
 * all and the Claims page build their list from it (F128); the bounded direct scan (claim-reads.ts) is only the
 * fallback when it is unavailable. The chain reader validates every page and returns all of them or an error, never a
 * partial list. Amounts arrive as decimal strings and become bigint here; nothing here touches a wallet.
 *
 * Its answer is one more read for the block-number rule (holder-claims.ts, item-claims.ts, claim-all.ts): every row is a
 * read at the index block A, and a claim the index no longer lists has nothing left at A. Its payments are mined claims
 * at their own blocks, so "Claimed" survives a page reload.
 */
import type { Address, Hex } from 'viem';
import { readAllWalletClaimsV2, type WalletClaimV2, type WalletClaimsPageV2 } from '../../../../../../packages/chain/src/core/v2/claims-reader';
import type { BatchCredit } from './holder-claims';
import type { V2Snapshot, V2Source } from './indexer-v2';
import type { ItemCredit } from './item-claims';
import { batchInT, itemsInT } from './payouts-t';

/** The index traversal, behind one seam so tests can answer it; production reads the box feed's own indexer. */
export const claimsIndexIO = {
  read: (source: V2Source, wallet: Address, signal?: AbortSignal): Promise<WalletClaimsPageV2> =>
    readAllWalletClaimsV2({ baseUrl: source.origin, chainId: source.manifest.chainId, wallet, limit: 100, ...(signal ? { signal } : {}) }),
};

/** A traversal the endpoint asks to restart (409, or a snapshot that moved between pages); anything else means "use the scan". */
export const restartable = (error: unknown): boolean => error instanceof Error && /409|snapshot changed|restart/i.test(error.message);

/** The single claims the index lists by role, in this site's words. */
export type IndexedKind = 'holder' | 'item' | 'creator' | 'remainder' | 'hand-in';
const KIND: Readonly<Record<WalletClaimV2['kind'], IndexedKind>> = { holder: 'holder', item: 'item', creator: 'creator', no_buyer: 'remainder', failure: 'hand-in' };

/** One payment this wallet received (a mined claim), newest per claim: its role, batch or item, block and amounts. */
export interface IndexedReceipt {
  readonly kind: IndexedKind;
  /** The holder ledger, item ledger, receiver or coordinator that paid. */
  readonly role: Address;
  readonly id: bigint | null;
  readonly tx: Hex; readonly block: bigint; readonly logIndex: number;
  /** In the claim's own coin: P, or the box token T for a T holder batch or an item's T credit (`inT`, v2.1 step 2). */
  readonly paidP: bigint;
  readonly inT: boolean;
  /** The hand-in only: the coins handed in. */
  readonly coinsT: bigint | null;
}

/** One box as the index read it for this wallet at block `at`. A claim it does not list has nothing left at `at`. */
export interface IndexedBoxV2 {
  readonly at: { readonly block: bigint; readonly hash: Hex };
  readonly holder: ReadonlyMap<string, BatchCredit>;
  readonly items: ReadonlyMap<string, ItemCredit>;
  /** v2.1 step 2: items' credit in the box token (claimT), apart from their P credit. */
  readonly itemsT: ReadonlyMap<string, ItemCredit>;
  /** What the payee can claim now (a payout the payee itself would refuse counts as nothing here). */
  readonly creator: bigint;
  /** The index lists a creator payment the receiver would refuse to pay out: unavailable, never "nothing" (FINAL-OC01). */
  readonly creatorRefused: boolean;
  readonly remainder: bigint;
  /** RC6-RR-INBOX: the inbox P the creator's remainder quote includes, which its claim first moves into the pot; null: none. */
  readonly remainderInboxP: bigint | null;
  /**
   * The hand-in: coins, their P out of the pot and the approval. RC6-RR-INBOX: a final share quoted with the inbox's P
   * names it (`collectFirstP`) beside its price; null otherwise. A row without a price is no hand-in (SH-RC7 item 29).
   */
  readonly handIn: { readonly coins: bigint; readonly pOut: bigint; readonly approved: bigint; readonly collectFirstP: bigint | null } | null;
  readonly receipts: readonly IndexedReceipt[];
}

/** A batch the index no longer lists: settled, nothing left. */
export const NOTHING_LEFT_BATCH: BatchCredit = Object.freeze({ status: 'settled', claimableP: 0n, payout: 'empty' });
/** An item the index no longer lists for this wallet: nothing left for it to claim. */
export const nothingLeftItem = (owner: Address): ItemCredit => ({ owner, status: 'synced', claimableP: 0n, outsideP: 0n, stashP: 0n, graduated: true, failed: false, payout: 'empty' });

const low = (value: string) => value.toLowerCase();
const big = (value: string | null): bigint | null => (value === null ? null : BigInt(value));
const payoutOf = (row: WalletClaimV2): 'available' | 'unavailable' | 'unverified' => (row.payout === 'available' || row.payout === 'unavailable' ? row.payout : 'unverified');

/** The payments in a page, newest per claim (role, kind, batch or item). */
export function receiptsOf(page: WalletClaimsPageV2): IndexedReceipt[] {
  const newest = new Map<string, IndexedReceipt>();
  for (const row of page.items) {
    if (row.status !== 'claimed' || !row.payment || row.amountP === null) continue;
    const id = row.kind === 'holder' ? BigInt(row.batchId) : row.kind === 'item' ? BigInt(row.itemId) : null;
    const receipt: IndexedReceipt = { kind: KIND[row.kind], role: row.roleAddress, id, tx: row.payment.txHash, block: BigInt(row.payment.block), logIndex: row.payment.logIndex,
      paidP: BigInt(row.amountP), inT: row.asset === row.box.token, coinsT: row.kind === 'failure' ? BigInt(row.coinsT) : null };
    const key = `${receipt.role}:${receipt.kind}:${id ?? ''}:${receipt.inT ? 't' : ''}`;
    const before = newest.get(key);
    if (!before || before.block < receipt.block || (before.block === receipt.block && before.logIndex < receipt.logIndex)) newest.set(key, receipt);
  }
  return [...newest.values()];
}

/** Whether a row is this box's: the same registry, box id and coin. */
const ofBox = (row: WalletClaimV2, view: V2Snapshot) =>
  row.box.token === low(view.token) && row.box.registry === low(view.release.registry.address) && row.box.boxId === view.record.boxId.toString();

/**
 * One box's claims from the index page, for the claim-state rule. Rows of other boxes are left out, and so is any row
 * in another coin than the box's price coin P or, for a holder batch or item paid in the box token (v2.1 step 2), the box
 * token T: a T holder row only for a batch its side pays in T, a T item row apart from that item's P row.
 */
export function indexedBoxOf(page: WalletClaimsPageV2, view: V2Snapshot): IndexedBoxV2 {
  const p = low(view.record.q); const t = low(view.token);
  const rows = page.items.filter((row) => ofBox(row, view) && (row.asset === p || (row.asset === t && (row.kind === 'item' ? itemsInT(view.spec) : row.kind === 'holder' && batchInT(view.spec, BigInt(row.batchId))))));
  const unpaid = rows.filter((row) => row.status !== 'claimed');
  const holder = new Map<string, BatchCredit>(); const items = new Map<string, ItemCredit>(); const itemsT = new Map<string, ItemCredit>();
  let creator = 0n; let creatorRefused = false; let remainder = 0n; let remainderInboxP: bigint | null = null; let handIn: IndexedBoxV2['handIn'] = null;
  for (const row of unpaid) {
    const amount = big(row.amountP); const pending = row.status === 'pending' || amount === null;
    switch (row.kind) {
      case 'holder': {
        // A T batch's credit can grow after a claim (holder-claims.ts `grows`).
        const grows = row.asset === t ? { grows: true as const } : {};
        holder.set(BigInt(row.batchId).toString(), pending ? { status: 'settling', claimableP: null, payout: 'not_ready', ...grows } : { status: 'settled', claimableP: amount, payout: payoutOf(row), ...grows });
        break;
      }
      case 'item':
        (row.asset === t ? itemsT : items).set(BigInt(row.itemId).toString(), pending
          ? { owner: row.wallet, status: 'sync_pending', claimableP: null, outsideP: null, stashP: null, graduated: view.graduated, failed: view.failed !== null, payout: 'not_ready' }
          : { owner: row.wallet, status: 'synced', claimableP: amount, outsideP: big(row.outsideP), stashP: big(row.stashP), graduated: view.graduated, failed: view.failed !== null, payout: payoutOf(row) });
        break;
      case 'creator': if (!pending && row.payout === 'available') creator = amount; else if (!pending && amount > 0n) creatorRefused = true; break;
      case 'no_buyer':
        if (!pending) { remainder = amount; remainderInboxP = row.collectFirst ? BigInt(row.collectFirst.pendingP) : null; }
        break;
      case 'failure':
        // SH-RC7 item 29: a pending row, the index's unpriced collect-first one included, is nothing to claim at its
        // block: the merged coordinator quotes the final share with the inbox's readable P (RC6 R1-3's reading is gone).
        if (!pending) handIn = { coins: BigInt(row.coinsT), pOut: amount, approved: big(row.allowanceT) ?? 0n, collectFirstP: row.collectFirst ? BigInt(row.collectFirst.pendingP) : null };
        break;
    }
  }
  const box = new Set(rows.map((row) => row.roleAddress));
  return { at: { block: BigInt(page.asOf.block), hash: page.asOf.hash }, holder, items, itemsT, creator, creatorRefused, remainder, remainderInboxP, handIn, receipts: receiptsOf(page).filter((r) => box.has(r.role)) };
}

/** The snapshot as the index read it: the same box, with the index's block and hash, so each send re-checks there. */
export const viewAt = (view: V2Snapshot, at: IndexedBoxV2['at']): V2Snapshot => ({ ...view, block: at.block, blockHash: at.hash });
