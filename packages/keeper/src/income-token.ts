import type { Address, PublicClient } from 'viem';
import { readEthParityPrice } from './income-parity';
import type { ReceiptLog } from './income-read';
import { readIncomePrice, type IncomeBlock, type IncomePrice } from './income-price';
import type { BoxState } from './world';

const same = (a: unknown, b: Address) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const distinct = (list: readonly Address[]) => list.filter((a, i) => list.findIndex(b => same(b, a)) === i);
const key = (l: ReceiptLog) => `${l.transactionHash}:${l.logIndex}`;
const zero: Address = '0x0000000000000000000000000000000000000000';
const MAX_PART = (1n << 127n) - 1n;
/** Payment completion events bound each call, including zero or uncredited ones; HolderBatchFunded/ItemFunded do not. */
const collectionEnds = new Set(['Collected', 'PlatformPaid', 'FitPaid', 'CreatorClaimed', 'BoughtBack', 'RewardsBought']);

/**
 * Token transfers need the box's own PoolManager claim burn, not merely an unrelated Safe deposit. SH-190: both are
 * read from the paying transaction's own receipt (the box event's anchor), never from an open range of the coin's or
 * the PoolManager's logs: P's ERC-20 `Transfer` from the box's PoolManager to its Safe or this keeper (`take`), right
 * after the PoolManager's ERC-6909 `Transfer` burning P's claim id to zero from the emitting part, the three parts that
 * pay out P (BoxReceiverV2Extension `_payClaims`, BoxCoordinatorV2 and BoxHookV2 `unlockCallback`).
 */
export async function tokenIncomeValuer(pub: PublicClient, box: Pick<BoxState, 'receiver' | 'coordinator' | 'hook'>,
  q: Address, pm: Address, safe: Address, keeper: Address, final: IncomeBlock, now: bigint,
  header: (number: bigint) => Promise<IncomeBlock>, consumed: Set<string>,
  receipt: (anchor: ReceiptLog) => Promise<readonly ReceiptLog[]>) {
  // F164 D3: a reviewed Sepolia parity pin replaces only the pricing step; the receipt proof below is the same.
  const parity = await readEthParityPrice(pub, q, final);
  const current = parity ?? await readIncomePrice(pub, box.coordinator, q, final, now);
  const prices = new Map<bigint, IncomePrice>([[final.number, current]]);
  const recipients = distinct([safe, keeper]);
  let total = 0n;
  return {
    async value(l: ReceiptLog, amount: bigint, recipient: Address, shape: 'payout' | 'collection' = 'payout'): Promise<bigint> {
      // Only these recipients can contribute to keeper room.
      if (!recipients.some(r => same(recipient, r))) throw new Error('token income recipient not read');
      if (amount === 0n) return 0n;
      if (amount < 0n || amount > MAX_PART * 4n) throw new Error('token income amount out of range');
      const rows = await receipt(l);
      const transfers = rows.filter(r => same(r.address, q) && r.eventName === 'Transfer');
      const burns = rows.filter(r => same(r.address, pm) && r.eventName === 'Transfer');
      const proofs: ReceiptLog[] = [];
      const start = shape === 'collection' ? rows.reduce((start, e) => same(e.address, l.address)
        && collectionEnds.has(e.eventName ?? '') && e.logIndex < l.logIndex ? Math.max(start, e.logIndex) : start, -1) : -1;
      const matches = (b: ReceiptLog, part: bigint) => b.transactionHash === l.transactionHash && b.blockHash === l.blockHash
          && b.logIndex > start && b.logIndex < l.logIndex && !consumed.has(key(b)) && !proofs.includes(b)
          && same(b.args.caller, l.address) && same(b.args.from, l.address) && same(b.args.to, zero)
          && b.args.id === BigInt(q) && b.args.amount === part
          && transfers.some(t => t.transactionHash === l.transactionHash && t.blockHash === l.blockHash
            && t.logIndex === b.logIndex + 1 && t.logIndex < l.logIndex && !consumed.has(key(t))
            && same(t.args.from, pm) && same(t.args.to, recipient) && t.args.value === part);
      if (shape === 'collection') {
        // ReceiverBooksV21 pays each buyer source separately, then emits their total.
        // Each source can itself need int128 chunks; do not re-chunk the combined tip.
        // Two buyer sources and the uint128 total tip cap fit within four parts.
        proofs.push(...burns.filter(b => typeof b.args.amount === 'bigint' && b.args.amount > 0n
          && b.args.amount <= MAX_PART && matches(b, b.args.amount)));
        if (proofs.length > 4 || proofs.reduce((sum, b) => sum + (b.args.amount as bigint), 0n) !== amount) return 0n;
      } else {
        // Platform payouts retain their exact four-int128-part contract shape.
        for (let left = amount; left > 0n;) {
          const part = left > MAX_PART ? MAX_PART : left;
          const burn = burns.find(b => matches(b, part));
          if (!burn) return 0n;
          proofs.push(burn);
          left -= part;
        }
      }
      for (const burn of proofs) {
        consumed.add(key(burn));
        consumed.add(`${burn.transactionHash}:${burn.logIndex + 1}`);
      }
      let price = parity ?? prices.get(l.blockNumber);
      if (!price) {
        const b = await header(l.blockNumber);
        price = await readIncomePrice(pub, box.coordinator, q, b, b.timestamp);
        prices.set(l.blockNumber, price);
      }
      if (price.route !== current.route) throw new Error('token income route changed');
      total += amount;
      const then = price.quote(amount), latest = current.quote(amount);
      return then < latest ? then : latest;
    },
    checkTotal() { current.quote(total); },
  };
}
