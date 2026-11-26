/**
 * M3-52 JSON boundary (every-item payouts and coin piles). Money is parsed only from decimal strings into bigint.
 * History (`view.m3`) is never a wallet credit: per-item credit comes from the ledger read at the displayed hash
 * (`readItemClaimV2`), and pile custody from `money.m3`, read at that same hash.
 */
import type { Address, Hex } from 'viem';
import { pileConfigV2 } from '../../../../../../packages/chain/src/core/v2/m3-spec-v2';
import { address, hash, object, raw } from './indexer-v2';

/** S1 inside policy per side: 0 is a side that does not pay items, 1 Keep, 2 Burn (BuyBackBurn), 3 Grow the pool (Depth, v2.1 step 5). */
export type SidePolicy = 0 | 1 | 2 | 3;
export interface ItemsHistory {
  readonly policies: { readonly buyers: SidePolicy; readonly sellers: SidePolicy };
  /** The cumulative live share of one item (sum of floor(A / N) over live receipts), from history. */
  readonly outsideIndex: bigint;
  /** What every item's slot was paid so far: the live index plus the graduation base stash of a Keep side. */
  readonly paidPerItem: bigint;
  readonly fundedP: bigint;
  readonly retainedBurnP: bigint;
  /** P a Depth side sent to the box's own pool instead of the ledger (`choiceP - ledgerP` of its receipts); absent until one is published. */
  readonly depthP?: bigint;
  readonly flushedP: bigint;
  readonly fundingCursor: bigint;
  readonly lifecycleCursor: bigint;
  /** Items that left the vault at least once, newest movement first; `inside` is their last recorded place. */
  readonly known: readonly { readonly id: bigint; readonly inside: boolean; readonly sequence: bigint }[];
  /**
   * The indexer's current owner of each item at the feed hash (M3-52b, from the collection's transfers; null: burned).
   * Absent from older publications. It only narrows which items to read; the owner itself is read at the hash.
   */
  readonly owners?: Readonly<Record<string, Address | null>>;
  readonly openDraws: number;
  readonly noticesFailed: bigint;
}
export interface PileHistory {
  readonly asset: Address; readonly seeder: Address; readonly seedAmount: bigint;
  readonly seedLoaded: boolean; readonly loadedAmount: bigint; readonly seedReturned: boolean; readonly returnedAmount: bigint;
  readonly graduated: boolean; readonly failed: boolean; readonly redeemedT: bigint; readonly redeemedAsset: bigint;
}
/** Pile custody read at the displayed hash. `balance` is null at zero supply (the read never inspected custody). */
export interface PileMoney {
  readonly asset: Address; readonly seedAmount: bigint; readonly balance: bigint | null; readonly supply: bigint;
  readonly graduated: boolean; readonly failed: boolean; readonly seedReceived: boolean; readonly seedReturnDue: bigint; readonly redemptionOpen: boolean;
}
export interface M3Snapshot {
  readonly items: ItemsHistory | null;
  readonly pile: PileHistory | null;
  readonly itemBalanceP: bigint | null;
  readonly pileMoney: PileMoney | null;
}

const bool = (v: unknown): boolean => { if (typeof v !== 'boolean') throw new Error('Invalid M3 flag'); return v; };
const small = (v: unknown, max: number): number => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max) throw new Error('Invalid M3 number'); return v; };
const policy = (v: unknown): SidePolicy => small(v, 3) as SidePolicy;
const optional = (v: unknown) => (v === null ? null : raw(v));

type KnownItem = ItemsHistory['known'][number];
/** One item's last recorded place: the id, whether it is inside, its order key (all decimal strings on the wire). */
const knownOf = (id: unknown, value: unknown): KnownItem => { const i = object(value); return { id: raw(id), inside: bool(i.inside), sequence: raw(i.sequence) }; };
const newestFirst = (a: KnownItem, b: KnownItem) => (a.sequence < b.sequence ? 1 : a.sequence > b.sequence ? -1 : 0);
/** The current owner of each item outside the vault, by decimal id (null: burned), as the indexer publishes it. */
const ownersOf = (input: unknown): Readonly<Record<string, Address | null>> =>
  Object.fromEntries(Object.entries(object(input)).map(([id, owner]) => [raw(id).toString(), owner === null ? null : address(owner)]));

function parseItems(input: unknown, n: number): ItemsHistory {
  const h = object(input); const p = object(h.policies);
  const policies = { buyers: policy(p.buyers), sellers: policy(p.sellers) };
  if (policies.buyers === 0 && policies.sellers === 0) throw new Error('Items history without an items side');
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Items history without a collection');
  let keepBase = 0n;
  for (const [id, value] of Object.entries(object(h.funding))) {
    const f = object(value); raw(id);
    const side = small(f.side, 2); const source = small(f.source, 3); const choiceP = raw(f.choiceP); const ledgerP = raw(f.ledgerP);
    if (ledgerP > choiceP) throw new Error('Item funding exceeds its source');
    const rule = side === 1 ? policies.buyers : side === 2 ? policies.sellers : 0;
    // The once-only graduation receipt gives every item an equal base stash on a Keep side, none on a Burn or Depth side.
    if (source === 3 && rule === 1) keepBase += choiceP / BigInt(n);
  }
  const known = Object.entries(object(h.items)).map(([id, value]) => knownOf(id, value)).sort(newestFirst);
  const openDraws = Object.values(object(h.tickets)).filter((t) => object(t).state === 'open').length;
  const outsideIndex = raw(h.outsideIndex);
  const owners = h.owners === undefined ? undefined : ownersOf(h.owners);
  // The indexer publishes depthP only for a box with a Depth side; it stays a decimal string, never a JS number.
  const depth = h.depthP === undefined ? {} : { depthP: raw(h.depthP) };
  return { policies, outsideIndex, paidPerItem: outsideIndex + keepBase, fundedP: raw(h.fundedP), retainedBurnP: raw(h.retainedBurnP), ...depth, flushedP: raw(h.flushedP),
    fundingCursor: raw(h.fundingCursor), lifecycleCursor: raw(h.lifecycleCursor), known, ...(owners ? { owners } : {}), openDraws, noticesFailed: raw(h.noticesFailed) };
}

/**
 * SH-235: the collection vault's inventory (`vaultItems`, packages/indexer/API.md), published for every box whose vault
 * holds collection items, whatever its fees pay. The same `known` and `owners` shapes as the items history (`ItemsHistory`),
 * and the same parsing rules; no payout fields. It only narrows which items the Items card reads: each is checked on chain.
 */
export interface VaultInventoryV2 {
  readonly firstId: bigint;
  readonly n: bigint;
  /** Items that left the vault at least once, newest movement first; `inside` is their last recorded place. */
  readonly known: ItemsHistory['known'];
  /** The current owner of every item outside the vault now (null: burned). */
  readonly owners: NonNullable<ItemsHistory['owners']>;
}

/**
 * The published inventory, or null when it is not well formed or names another range than the spec (firstId, n). Like the
 * page's other hints (links, position), a bad record never refuses the box: the card then works as without one.
 */
export function parseVaultItems(input: unknown, spec: { readonly firstId: bigint; readonly n: number }): VaultInventoryV2 | null {
  try {
    const v = object(input);
    const firstId = raw(v.firstId); const n = raw(v.n);
    if (firstId !== spec.firstId || n !== BigInt(spec.n)) return null;
    if (!Array.isArray(v.known) || BigInt(v.known.length) > n) return null;
    const known = v.known.map((entry) => { const k = object(entry); return knownOf(k.id, k); }).sort(newestFirst);
    const listed = new Set(known.map((k) => k.id.toString()));
    const outside = new Set(known.filter((k) => !k.inside).map((k) => k.id.toString()));
    const owners = ownersOf(v.owners);
    if (listed.size !== known.length || known.some((k) => k.id < firstId || k.id >= firstId + n) || Object.keys(owners).length !== outside.size || Object.keys(owners).some((id) => !outside.has(id))) return null;
    return { firstId, n, known, owners };
  } catch { return null; }
}

function parsePile(input: unknown): PileHistory {
  const p = object(input);
  return { asset: address(p.asset), seeder: address(p.seeder), seedAmount: raw(p.seedAmount), seedLoaded: bool(p.seedLoaded), loadedAmount: raw(p.loadedAmount),
    seedReturned: bool(p.seedReturned), returnedAmount: raw(p.returnedAmount), graduated: bool(p.graduated), failed: bool(p.failed), redeemedT: raw(p.redeemedT), redeemedAsset: raw(p.redeemedAsset) };
}

function parsePileMoney(input: unknown): PileMoney {
  const m = object(input);
  const balance = optional(m.balance);
  if ((balance === null) !== (m.balanceStatus === 'unavailable_zero_supply') || (balance !== null && m.balanceStatus !== 'verified')) throw new Error('Invalid pile balance status');
  return { asset: address(m.asset), seedAmount: raw(m.seedAmount), balance, supply: raw(m.supply), graduated: bool(m.graduated), failed: bool(m.failed),
    seedReceived: bool(m.seedReceived), seedReturnDue: raw(m.seedReturnDue), redemptionOpen: bool(m.redemptionOpen) };
}

/**
 * The published M3 history and the same-hash M3 money; any other block's money is refused, and so is a pile whose
 * published leave-behind (v2.1 step 3) is not the one its spec fixes.
 */
export function parseM3(historyInput: unknown, moneyInput: unknown, blockHash: string, spec: { readonly boxType: number; readonly n: number; readonly contentsParams?: string }): M3Snapshot {
  const history = historyInput == null ? null : object(historyInput);
  const items = history && history.items != null ? parseItems(history.items, spec.n) : null;
  const pile = history && history.pile != null ? parsePile(history.pile) : null;
  if ((pile !== null) !== (spec.boxType === 5 && history !== null)) throw new Error('Pile history disagrees with the box type');
  let itemBalanceP: bigint | null = null; let pileMoney: PileMoney | null = null;
  if (moneyInput != null) {
    const m = object(moneyInput);
    if (hash(m.hash).toLowerCase() !== blockHash.toLowerCase()) throw new Error('M3 money from a different block');
    itemBalanceP = optional(m.itemBalanceP);
    pileMoney = m.pile == null ? null : parsePileMoney(m.pile);
    if (pileMoney && pile && (pileMoney.asset.toLowerCase() !== pile.asset.toLowerCase() || pileMoney.seedAmount !== pile.seedAmount)) throw new Error('Pile reads disagree with its commitment');
    const published = m.pile == null ? undefined : object(m.pile).leaveBehindBps;
    if (published !== undefined && spec.contentsParams !== undefined && raw(published) !== leaveBehindOf({ boxType: spec.boxType, contentsParams: spec.contentsParams })) throw new Error('Pile leave-behind disagrees with its commitment');
  }
  return { items, pile, itemBalanceP, pileMoney };
}

/** v2.1 step 3's fixed leave-behind of a pile, in basis points: 0 for the 64-byte PileParams, else its preset (0 or 500). */
export function leaveBehindOf(spec: { readonly boxType: number; readonly contentsParams: string }): bigint | null {
  if (spec.boxType !== 5) return null;
  try { return pileConfigV2(spec.contentsParams as Hex).leaveBehindBps; } catch { return null; }
}

/**
 * Raw asset units one whole T (18 decimals) gets from the pile now, as `quoteRedeem` pays a holder who is not the last:
 * floor(floor(balance × 10^18 / supply) × (10,000 − leave-behind) / 10,000). Null without a read.
 */
export function perCoin(money: Pick<PileMoney, 'balance' | 'supply'>, leaveBehindBps = 0n): bigint | null {
  return money.balance === null || money.supply <= 0n ? null : ((money.balance * 10n ** 18n) / money.supply) * (10_000n - leaveBehindBps) / 10_000n;
}

/**
 * `quoteRedeem(tIn)` from the same-hash reads (PileVaultV2, v2.1 step 3): the whole balance when tIn is the whole
 * supply (the last holder takes what is left), else floor(floor(balance × tIn / supply) × (10,000 − leave-behind) /
 * 10,000). With no leave-behind this is floor(balance × tIn / supply). Null when it cannot be computed.
 */
export function quoteOf(money: Pick<PileMoney, 'balance' | 'supply'>, tIn: bigint, leaveBehindBps = 0n): bigint | null {
  if (money.balance === null || money.supply <= 0n || tIn <= 0n || tIn > money.supply) return null;
  if (tIn === money.supply) return money.balance;
  return ((money.balance * tIn) / money.supply) * (10_000n - leaveBehindBps) / 10_000n;
}
