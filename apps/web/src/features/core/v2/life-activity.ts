/**
 * SH-BOX-LIFE-VIEW: a v2 box's history from the indexer's activity route (`/v2/boxes/<chain>/<token>/activity`,
 * core-gateway.ts; every swap as a `trade`, every other decoded event of the box as a `v2_event`, newest first, paged by
 * `(block, logIndex)`), and what the page makes of it:
 * - the rows of its story: trades (who, buy or sell, both amounts, when, the transaction) and the box's own events
 *   (created, raise full, graduated, buy-backs, the pool deepened, fees, closed, claims);
 * - the holders, from the box token's transfers of its whole history, only when that history is complete and agrees with
 *   the snapshot's holder count and supply.
 * Amounts are bigint from decimal strings; a malformed answer is refused whole. Pure functions: the live controller
 * (useLifeActivity.ts) owns the reads.
 */
import { getAddress, type Address, type Hex } from 'viem';
import { rolesOfV2, type BoxRecordV2 } from '../../../../../../packages/chain/src/core/v2';
import { address as addressOf, hash, object, raw } from './indexer-v2';

type Wire = Readonly<Record<string, unknown>>;
export type TradeRouteV2 = 'hook' | 'executor' | 'buy_back' | 'launch_router' | 'other';
const ROUTES: readonly TradeRouteV2[] = ['hook', 'executor', 'buy_back', 'launch_router', 'other'];

interface ItemBase {
  /** `<block>-<logIndex>`: the indexer's own key, unique in its sequence. */
  readonly id: string;
  readonly block: bigint;
  readonly logIndex: number;
  readonly blockHash: Hex;
  readonly txHash: Hex;
  /** Block time, unix seconds. */
  readonly at: bigint;
}
export interface ActivityTradeV2 extends ItemBase {
  readonly kind: 'trade';
  readonly side: 'buy' | 'sell';
  readonly route: TradeRouteV2;
  /** P into the pool on a buy (launch tax apart), P out on a sale. */
  readonly p: bigint;
  /** T out of the pool on a buy, T in on a sale. */
  readonly t: bigint;
  readonly taxP: bigint;
  /** The indexer's trader (today only a taxed launch-router buy's buyer), else null. */
  readonly trader: Address | null;
  readonly sqrtPriceX96After: bigint;
}
export interface ActivityEventV2 extends ItemBase {
  readonly kind: 'v2_event';
  /** The emitting part ("coordinator", "hook", "receiver", "token", "poolManager", …). */
  readonly source: string;
  readonly event: string;
  readonly data: Wire;
}
export type ActivityItemV2 = ActivityTradeV2 | ActivityEventV2;

export interface ActivityPageV2 {
  readonly asOfBlock: bigint | null;
  readonly items: readonly ActivityItemV2[];
  /** The cursor for the next (older) page; null at the start of the box's history. */
  readonly next: string | null;
}

const CURSOR = /^\d{1,20}-\d{1,5}$/;
const int = (v: unknown, max: number): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max) throw new Error('Invalid activity index');
  return v;
};

function baseOf(item: Wire): ItemBase {
  const block = raw(item.block); const logIndex = int(item.logIndex, 0xffffffff);
  const id = `${block}-${logIndex}`;
  if (typeof item.id !== 'string' || item.id !== id) throw new Error('Activity id does not match its block and log index');
  return { id, block, logIndex, blockHash: hash(item.blockHash), txHash: hash(item.txHash), at: raw(item.timestamp) };
}

/**
 * One answer of the activity route; items of kinds a v2 box has not (none today) are left out. A trade's route the page
 * does not know (a later indexer's) is `other`: the swap is shown as a trade, never the whole answer refused.
 */
export function parseActivityPageV2(input: unknown): ActivityPageV2 {
  const body = object(input);
  if (!Array.isArray(body.items)) throw new Error('Activity items missing');
  if (body.next !== null && (typeof body.next !== 'string' || !CURSOR.test(body.next))) throw new Error('Invalid activity cursor');
  const asOf = body.asOf === null || body.asOf === undefined ? null : object(body.asOf);
  const items = body.items.flatMap((input): ActivityItemV2[] => {
    const item = object(input);
    if (item.kind === 'trade') {
      if (item.side !== 'buy' && item.side !== 'sell') throw new Error('Invalid trade side');
      if (typeof item.route !== 'string') throw new Error('Invalid trade route');
      const route = ROUTES.includes(item.route as TradeRouteV2) ? (item.route as TradeRouteV2) : 'other';
      return [{ ...baseOf(item), kind: 'trade', side: item.side, route, p: raw(item.qRaw), t: raw(item.tRaw), taxP: raw(item.taxQ),
        trader: item.trader === null ? null : addressOf(item.trader), sqrtPriceX96After: raw(item.sqrtPriceX96After) }];
    }
    if (item.kind === 'v2_event') {
      const data = object(item.data);
      if (typeof data.source !== 'string' || typeof data.event !== 'string') throw new Error('Invalid activity event');
      return [{ ...baseOf(item), kind: 'v2_event', source: data.source, event: data.event, data }];
    }
    return [];
  });
  return { asOfBlock: asOf ? raw(asOf.block) : null, items, next: body.next as string | null };
}

/** Newest first: a later block, or the same block and a later log. */
export const newerFirst = (a: Pick<ItemBase, 'block' | 'logIndex'>, b: Pick<ItemBase, 'block' | 'logIndex'>): number =>
  a.block === b.block ? b.logIndex - a.logIndex : a.block > b.block ? -1 : 1;
/** Whether `a` comes strictly before (is older than) `b` in the indexer's sequence. */
const olderThan = (a: Pick<ItemBase, 'block' | 'logIndex'>, b: Pick<ItemBase, 'block' | 'logIndex'>): boolean => a.block < b.block || (a.block === b.block && a.logIndex < b.logIndex);

function unique(items: readonly ActivityItemV2[]): ActivityItemV2[] {
  const seen = new Set<string>();
  return [...items].sort(newerFirst).filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

/**
 * What the page holds of the history: a contiguous run of the indexer's sequence, newest first (never a hole), and the
 * cursor to the older part (null once the run reaches the box's first event).
 */
export interface ActivityStoreV2 {
  readonly loaded: boolean;
  readonly items: readonly ActivityItemV2[];
  readonly next: string | null;
  readonly asOfBlock: bigint | null;
}
export const EMPTY_ACTIVITY_V2: ActivityStoreV2 = Object.freeze({ loaded: false, items: Object.freeze([]) as readonly ActivityItemV2[], next: null, asOfBlock: null });

/**
 * Whether the held items continue a fresh read's run on the same chain where the two meet: the block of the fresh
 * read's oldest item. Every held item of that block carries the hash the fresh read gives it, and there is at least
 * one. A block's hash commits to every block before it, so the held items older than the meeting point lie on the
 * fresh read's chain too. A held run with another hash for that block, or none of its items, was read from a branch a
 * reorg has replaced there (fix round 3: a reorged block of more items than one read, the read ending inside it).
 */
function joinsAt(held: readonly ActivityItemV2[], oldestFresh: ActivityItemV2): boolean {
  const canonical = oldestFresh.blockHash.toLowerCase();
  let met = false;
  for (const item of held) {
    if (item.block !== oldestFresh.block) continue;
    if (item.blockHash.toLowerCase() !== canonical) return false;
    met = true;
  }
  return met;
}

/**
 * Merges a fresh read of the newest items (one page or several consecutive ones, newest first). Inside the range the
 * fresh read covers it is the truth (an item seen again replaces the old one; one the indexer no longer serves there, a
 * reorg, goes); older held items stay only where the two runs meet on the same block hash (`joinsAt`). `reached` is
 * false when the fresh read does not reach back to the newest held item (more new items than it carried), or when the
 * held items of the block where it ends carry another hash (a reorg across its boundary): then the caller reads further
 * back and merges again, or replaces the held run with the fresh one and its own cursor.
 */
export function mergeNewestV2(store: ActivityStoreV2, fresh: ActivityPageV2): { readonly store: ActivityStoreV2; readonly reached: boolean } {
  const asOfBlock = fresh.asOfBlock ?? store.asOfBlock;
  if (!store.loaded || store.items.length === 0) return { store: { loaded: true, items: unique(fresh.items), next: fresh.next, asOfBlock }, reached: true };
  const oldestFresh = fresh.items.at(-1);
  // An empty newest read beside held items (a history being rebuilt, the gateway says a short page may be): keep them.
  if (!oldestFresh) return { store: { ...store, asOfBlock }, reached: true };
  const newestHeld = store.items[0] as ActivityItemV2;
  // A read that ends at the box's first item always reaches; one that ends later must reach the newest held item.
  if (fresh.next !== null && olderThan(newestHeld, oldestFresh)) return { store, reached: false };
  const kept = store.items.filter((item) => olderThan(item, oldestFresh));
  // Older held items are kept only on the fresh read's chain: a reorg can replace a block across the read's boundary.
  if (kept.length > 0 && !joinsAt(store.items, oldestFresh)) return { store, reached: false };
  // Nothing held is older: the run ends where the fresh read ends, at its cursor.
  const next = fresh.next === null ? null : kept.length > 0 ? store.next : fresh.next;
  return { store: { loaded: true, items: unique([...fresh.items, ...kept]), next, asOfBlock }, reached: true };
}

/**
 * A fresh run that could not be joined to the held one (too many new items, or a reorg across the boundary that the
 * reads back did not get past): it replaces it, with its own cursor (older items can be read again).
 */
export const replaceNewestV2 = (fresh: ActivityPageV2): ActivityStoreV2 => ({ loaded: true, items: unique(fresh.items), next: fresh.next, asOfBlock: fresh.asOfBlock });

/**
 * An older page read with `before`: joined when `before` is still the held run's cursor and, given `tail` (the run's
 * last item when the page was asked for), that last item is still the same one with the same block hash; else dropped
 * (it is stale). A reorg can keep an id: a page asked for below the old branch's last item, joined below the new
 * branch's, would hold the old branch's rows for good (fix round 3).
 */
export function appendOlderV2(store: ActivityStoreV2, before: string, page: ActivityPageV2, tail?: Pick<ItemBase, 'id' | 'blockHash'>): ActivityStoreV2 {
  if (store.next !== before) return store;
  const oldest = store.items.at(-1);
  if (tail && (!oldest || oldest.id !== tail.id || oldest.blockHash.toLowerCase() !== tail.blockHash.toLowerCase())) return store;
  const older = oldest ? page.items.filter((item) => olderThan(item, oldest)) : page.items;
  return { ...store, items: unique([...store.items, ...older]), next: page.next };
}

// ------------------------------------------------------------------------------------------------ who

export type HolderRoleV2 = 'pool' | 'box' | 'creator';

/** The addresses a box's own page names: the pool (the PoolManager), the box's own contracts and the creator. */
export interface RolesBookV2 {
  readonly roleOf: (address: string) => HolderRoleV2 | null;
  /** The role's own name for a box contract ("coordinator", "receiver", …). */
  readonly partOf: (address: string) => string | null;
}
export function rolesBookV2(record: BoxRecordV2): RolesBookV2 {
  const parts = new Map<string, string>();
  for (const [role, address] of Object.entries(rolesOfV2(record).contracts)) if (address) parts.set(address.toLowerCase(), role);
  const pool = record.poolManager.toLowerCase();
  const creator = record.creator.toLowerCase();
  return {
    roleOf: (address) => {
      const a = address.toLowerCase();
      return a === pool ? 'pool' : parts.has(a) ? 'box' : a === creator ? 'creator' : null;
    },
    partOf: (address) => parts.get(address.toLowerCase()) ?? null,
  };
}

const ZERO = /^0x0{40}$/i;
const isTokenTransfer = (item: ActivityItemV2): item is ActivityEventV2 => item.kind === 'v2_event' && item.source === 'token' && item.event === 'Transfer';
const dataRaw = (item: ActivityEventV2, key: string): bigint | null => {
  const v = item.data[key];
  return typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) ? BigInt(v) : null;
};
const dataAddress = (item: ActivityEventV2, key: string): Address | null => {
  const v = item.data[key];
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? (getAddress(v) as Address) : null;
};

/**
 * Who a trade was for, from the box token's transfers of the same transaction: the account whose T moved the most in
 * the trade's direction (a buy: the largest net gain; a sale: the largest net loss), leaving out the zero address, the
 * pool and the box's own contracts, so a router's hand-off is followed to the account at its end. Null when none.
 */
export function traderOfV2(trade: Pick<ActivityTradeV2, 'side'>, transfers: readonly ActivityEventV2[], book: RolesBookV2): Address | null {
  const net = new Map<string, bigint>();
  for (const t of transfers) {
    const from = dataAddress(t, 'from'); const to = dataAddress(t, 'to'); const amount = dataRaw(t, 'amount');
    if (!from || !to || amount === null) continue;
    net.set(from.toLowerCase(), (net.get(from.toLowerCase()) ?? 0n) - amount);
    net.set(to.toLowerCase(), (net.get(to.toLowerCase()) ?? 0n) + amount);
  }
  let best: string | null = null;
  let bestAmount = 0n;
  for (const [account, change] of net) {
    if (ZERO.test(account) || book.roleOf(account) === 'pool' || book.roleOf(account) === 'box') continue;
    const moved = trade.side === 'buy' ? change : -change;
    if (moved > bestAmount) { best = account; bestAmount = moved; }
  }
  return best ? (getAddress(best) as Address) : null;
}

// ------------------------------------------------------------------------------------------------ the story

export type LifeEventKindV2 = 'created' | 'full' | 'graduated' | 'closed' | 'claim' | 'buyBack' | 'deepened' | 'fees' | 'swap';

interface RowBase { readonly id: string; readonly at: bigint; readonly block: bigint; readonly txHash: Hex }
export interface LifeTradeRowV2 extends RowBase {
  readonly kind: 'trade';
  readonly side: 'buy' | 'sell';
  readonly p: bigint;
  readonly t: bigint;
  readonly taxP: bigint;
  readonly who: Address | null;
  readonly role: HolderRoleV2 | null;
}
export interface LifeEventRowV2 extends RowBase {
  readonly kind: 'event';
  readonly event: LifeEventKindV2;
  /** The event's P and T amounts where it has them (a tip, a buy-back's P and its burned T, …). */
  readonly p: bigint | null;
  readonly t: bigint | null;
  /** Who did it, where the event names someone (the graduation's caller, a claim's holder). */
  readonly who: Address | null;
  readonly role: HolderRoleV2 | null;
  /** A failure's cause ("Deadline", …). */
  readonly cause: string | null;
}
export type LifeRowV2 = LifeTradeRowV2 | LifeEventRowV2;

const eventIn = (items: readonly ActivityItemV2[], source: string, name: string): ActivityEventV2 | undefined =>
  items.find((i): i is ActivityEventV2 => i.kind === 'v2_event' && i.source === source && i.event === name);

/**
 * The rows of the box's story, newest first, from held items: each trade a row (its bootstrap, buy-back and deepening
 * swaps folded into the box's own event rows), and one row per box event the page tells: Created, Raise full,
 * Graduated, Closed, a claim, a buy-back, the pool deepened, fees collected. Transfers, liquidity moves and the like are
 * not rows; they name who traded.
 */
export function lifeRowsV2(items: readonly ActivityItemV2[], book: RolesBookV2): LifeRowV2[] {
  const byTx = new Map<string, ActivityItemV2[]>();
  for (const item of items) {
    const key = `${item.block}:${item.txHash.toLowerCase()}`;
    const list = byTx.get(key);
    if (list) list.push(item);
    else byTx.set(key, [item]);
  }
  const rows: LifeRowV2[] = [];
  for (const group of byTx.values()) {
    const transfers = group.filter(isTokenTransfer);
    const ev = (item: ActivityEventV2, event: LifeEventKindV2, p: bigint | null, t: bigint | null, who: Address | null = null, cause: string | null = null): LifeEventRowV2 =>
      ({ kind: 'event', id: item.id, at: item.at, block: item.block, txHash: item.txHash, event, p, t, who, role: who ? book.roleOf(who) : null, cause });
    const bootstrap = eventIn(group, 'launchRouter', 'Bootstrapped');
    const boughtBack = eventIn(group, 'receiver', 'BoughtBack');
    const deepened = eventIn(group, 'hook', 'Deepened');
    let bootstrapFolded = false;
    for (const item of group) {
      if (item.kind === 'trade') {
        if (item.route === 'launch_router' && bootstrap && !bootstrapFolded && item.p === dataRaw(bootstrap, 'qIn')) { bootstrapFolded = true; continue; }
        if (item.route === 'buy_back' && boughtBack) continue;
        if (item.route === 'hook' && deepened) continue;
        if (item.route === 'buy_back') { rows.push({ kind: 'event', id: item.id, at: item.at, block: item.block, txHash: item.txHash, event: 'buyBack', p: item.p, t: item.t, who: null, role: null, cause: null }); continue; }
        if (item.route === 'hook' || item.route === 'executor') { rows.push({ kind: 'event', id: item.id, at: item.at, block: item.block, txHash: item.txHash, event: 'swap', p: item.p, t: item.t, who: null, role: null, cause: null }); continue; }
        const who = item.trader ?? traderOfV2(item, transfers, book);
        rows.push({ kind: 'trade', id: item.id, at: item.at, block: item.block, txHash: item.txHash, side: item.side, p: item.p, t: item.t, taxP: item.taxP, who, role: who ? book.roleOf(who) : null });
        continue;
      }
      const key = `${item.source}.${item.event}`;
      if (key === 'coordinator.BoxLaunched') rows.push(ev(item, 'created', bootstrap ? dataRaw(bootstrap, 'qIn') : null, dataRaw(item, 'bootstrapTokensBurned')));
      else if (key === 'hook.CurveClosed') rows.push(ev(item, 'full', null, null));
      else if (key === 'coordinator.Graduated') rows.push(ev(item, 'graduated', dataRaw(item, 'reward'), null, dataAddress(item, 'caller')));
      else if (key === 'coordinator.BoxFailed') rows.push(ev(item, 'closed', null, null, dataAddress(item, 'caller'), typeof item.data.cause === 'number' ? (['Deadline', 'ClosedPastCap', 'GraduationTimedOut'][item.data.cause - 1] ?? null) : null));
      else if (key === 'coordinator.Claimed') rows.push(ev(item, 'claim', dataRaw(item, 'p'), dataRaw(item, 't'), dataAddress(item, 'holder')));
      else if (key === 'receiver.BoughtBack') rows.push(ev(item, 'buyBack', dataRaw(item, 'pSpent'), dataRaw(item, 'tBurned') ?? dataRaw(item, 'tBought')));
      else if (key === 'hook.Deepened') rows.push(ev(item, 'deepened', dataRaw(item, 'qUsed'), dataRaw(item, 'tUsed')));
      else if (key === 'receiver.Collected') {
        const buyers = dataRaw(item, 'buyersP') ?? 0n; const sellers = dataRaw(item, 'sellersP') ?? 0n;
        if (buyers + sellers > 0n) rows.push(ev(item, 'fees', buyers + sellers, null));
      }
    }
  }
  return rows.sort((a, b) => (a.block === b.block ? idLog(b.id) - idLog(a.id) : a.block > b.block ? -1 : 1));
}
const idLog = (id: string): number => Number(id.split('-')[1] ?? '0');

// ------------------------------------------------------------------------------------------------ holders

export interface HolderV2 {
  readonly address: Address;
  readonly balance: bigint;
  /** Share of the supply in basis points, truncated. */
  readonly shareBps: number;
  readonly role: HolderRoleV2 | null;
}
export type HoldersV2 =
  | { readonly status: 'ready'; readonly holders: readonly HolderV2[]; readonly atBlock: bigint }
  /**
   * `behind`: the history's newest read is older than the snapshot's figures (they moved since); `incomplete`: the
   * history is not all held.
   */
  | { readonly status: 'unavailable'; readonly reason: 'incomplete' | 'behind' | 'mismatch' | 'unread' };

/**
 * Every T balance at `atBlock` (the snapshot's block) from the box token's transfers, when `store` holds the box's whole
 * history, read no earlier than `since`: the block of the first snapshot that showed its figures as they are (by default
 * `atBlock`). The snapshot's block is the indexer's head, which moves every block whatever the box does, so a history
 * read after the figures last moved shows the same box, however many heads later. Shown only when the count of positive
 * balances and their sum equal the snapshot's `holderCount` and `totalSupplyT` (the indexer's own figures). Largest
 * first, then by address.
 */
export function holdersV2(store: ActivityStoreV2, atBlock: bigint, stats: { readonly holderCount: bigint; readonly totalSupplyT: bigint } | null, book: RolesBookV2, since: bigint = atBlock): HoldersV2 {
  if (!store.loaded) return { status: 'unavailable', reason: 'unread' };
  if (store.next !== null || store.asOfBlock === null || stats === null) return { status: 'unavailable', reason: 'incomplete' };
  if (store.asOfBlock < since) return { status: 'unavailable', reason: 'behind' };
  const balances = new Map<string, bigint>();
  for (const item of [...store.items].reverse()) {
    if (!isTokenTransfer(item) || item.block > atBlock) continue;
    const from = dataAddress(item, 'from'); const to = dataAddress(item, 'to'); const amount = dataRaw(item, 'amount');
    if (!from || !to || amount === null) return { status: 'unavailable', reason: 'mismatch' };
    if (!ZERO.test(from)) balances.set(from.toLowerCase(), (balances.get(from.toLowerCase()) ?? 0n) - amount);
    if (!ZERO.test(to)) balances.set(to.toLowerCase(), (balances.get(to.toLowerCase()) ?? 0n) + amount);
  }
  const positive = [...balances].filter(([, balance]) => balance > 0n);
  const sum = positive.reduce((total, [, balance]) => total + balance, 0n);
  if (BigInt(positive.length) !== stats.holderCount || sum !== stats.totalSupplyT || [...balances.values()].some((b) => b < 0n)) return { status: 'unavailable', reason: 'mismatch' };
  const holders = positive
    .sort(([a, x], [b, y]) => (x === y ? (a < b ? -1 : 1) : x > y ? -1 : 1))
    .map(([account, balance]) => ({ address: getAddress(account) as Address, balance, shareBps: sum > 0n ? Number((balance * 10_000n) / sum) : 0, role: book.roleOf(account) }));
  return { status: 'ready', holders, atBlock };
}

// ------------------------------------------------------------------------------------------------ the graduation

/** When the box graduated (its `Graduated` event's block time), if held. */
export function graduatedAtV2(items: readonly ActivityItemV2[]): bigint | null {
  const graduated = items.find((i) => i.kind === 'v2_event' && i.source === 'coordinator' && i.event === 'Graduated');
  return graduated ? graduated.at : null;
}
