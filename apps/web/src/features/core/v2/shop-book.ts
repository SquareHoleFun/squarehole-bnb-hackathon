/**
 * A shop's book, as its own events tell it (ShopVaultV2: SeedFunded, GateOpened, CollectionAdded, StarterLoaded,
 * StarterReturned, Given, Picked), read from the source's RPC up to the snapshot's block: the items inside, every
 * listed collection with its tier and start, and the week the shop is in with what it gave so far. From these the page
 * shows the give allowance left for the shop and for each collection exactly as `give` checks it (`_startWeek`,
 * `_giveFloor`, `_giveLimit`; F132's floor). Nothing is sent. The replayed budget must equal the snapshot's own
 * `budgetT` read, else the book is refused; every send is simulated first anyway.
 *
 * The indexer's m2 view keeps sums only (SH-V21-FE13 integrator request: publish the items and the week there).
 */
import { decodeEventLog, type Address, type Hex } from 'viem';
import { shopVaultV2Abi } from '../../../../../../packages/chain/src/core/v2';

export const WEEK = 604_800n;
/** One log query spans at most this many blocks (public RPCs cap a query's range). */
export const LOG_SPAN = 50_000n;

/** One item of a listed collection. */
export interface ShopItemV2 {
  readonly collection: Address;
  readonly id: bigint;
}

/** A listed collection: its tier (0 to 3) and when it starts taking gives. */
export interface ShopEntryV2 {
  readonly collection: Address;
  readonly tier: number;
  readonly activeAt: bigint;
}

/** A shop event the book reads, in chain order. */
export type ShopEventV2 =
  | { readonly kind: 'seed'; readonly amountT: bigint; readonly block: bigint }
  | { readonly kind: 'opened'; readonly timestamp: bigint; readonly block: bigint }
  | { readonly kind: 'added'; readonly collection: Address; readonly tier: number; readonly activeAt: bigint; readonly block: bigint }
  | { readonly kind: 'loaded' | 'returned'; readonly collection: Address; readonly id: bigint; readonly block: bigint }
  | { readonly kind: 'given' | 'picked'; readonly collection: Address; readonly id: bigint; readonly amountT: bigint; readonly block: bigint };

/** The week the shop is in (ShopVaultV2 `_startWeek`: weeks count from the opening, the first is 1). */
export interface ShopWeekV2 {
  readonly index: bigint;
  readonly startsAt: bigint;
  readonly endsAt: bigint;
  /** The week's budget: fixed by its first give or pick, else what the next one will fix (the budget now). */
  readonly snapshotT: bigint;
  readonly fixed: boolean;
  /** Given this week, in all and per collection (lower-case keys). */
  readonly givenT: bigint;
  readonly givenBy: ReadonlyMap<string, bigint>;
}

export interface ShopBookV2 {
  /** The block the book was read to (the snapshot's). */
  readonly block: bigint;
  readonly items: readonly ShopItemV2[];
  /** Every listed collection by lower-case address, in listing order. */
  readonly entries: ReadonlyMap<string, ShopEntryV2>;
  /** Each tier's first start (ShopVaultV2 `_tierActiveAt`), null for a tier no collection has. */
  readonly tiersActiveAt: readonly (bigint | null)[];
  readonly openedAt: bigint | null;
  /** The seed plus every pick, less every give: what `budgetT` reads. */
  readonly budgetT: bigint;
  /** Null before the shop opens. */
  readonly week: ShopWeekV2 | null;
}

const key = (collection: string, id?: bigint) => (id === undefined ? collection.toLowerCase() : `${collection.toLowerCase()}:${id}`);

/** The items inside: starters loaded and items given, less those picked or returned, in the order they came in. */
export function heldItemsV2(events: readonly ShopEventV2[]): ShopItemV2[] {
  const held = new Map<string, ShopItemV2>();
  for (const e of events) {
    if (e.kind === 'loaded' || e.kind === 'given') {
      held.delete(key(e.collection, e.id));
      held.set(key(e.collection, e.id), { collection: e.collection, id: e.id });
    } else if (e.kind === 'picked' || e.kind === 'returned') held.delete(key(e.collection, e.id));
  }
  return [...held.values()];
}

/**
 * The book at `now` (the snapshot's time): the week from the opening, its budget replayed from the seed, gives and
 * picks before it, and what it gave. `times` holds the block time of every give or pick in the current week and of the
 * one before it at least (readShopBookV2 reads them from the last back); earlier ones need none.
 */
export function shopBookV2(events: readonly ShopEventV2[], times: ReadonlyMap<bigint, bigint>, now: bigint, block: bigint): ShopBookV2 {
  const entries = new Map<string, ShopEntryV2>();
  const tiersActiveAt: (bigint | null)[] = [null, null, null, null];
  let openedAt: bigint | null = null;
  for (const e of events) {
    if (e.kind === 'opened') openedAt = e.timestamp;
    if (e.kind === 'added' && !entries.has(key(e.collection))) {
      entries.set(key(e.collection), { collection: e.collection, tier: e.tier, activeAt: e.activeAt });
      const first = tiersActiveAt[e.tier];
      if (e.tier >= 0 && e.tier < 4 && (first === null || first === undefined || e.activeAt < first)) tiersActiveAt[e.tier] = e.activeAt;
    }
  }
  const index = openedAt === null || now < openedAt ? null : (now - openedAt) / WEEK + 1n;
  const startsAt = openedAt === null || index === null ? null : openedAt + (index - 1n) * WEEK;
  let budget = 0n;
  let snapshot: bigint | null = null;
  let givenT = 0n;
  const givenBy = new Map<string, bigint>();
  for (const e of events) {
    if (e.kind === 'seed') budget += e.amountT;
    if (e.kind !== 'given' && e.kind !== 'picked') continue;
    const time = times.get(e.block);
    const inWeek = startsAt !== null && time !== undefined && time >= startsAt;
    // The week's first give or pick fixes the budget it starts with, before its own amount moves.
    if (inWeek && snapshot === null) snapshot = budget;
    if (e.kind === 'given') {
      budget -= e.amountT;
      if (inWeek) { givenT += e.amountT; givenBy.set(key(e.collection), (givenBy.get(key(e.collection)) ?? 0n) + e.amountT); }
    } else budget += e.amountT;
  }
  const week = index === null || startsAt === null ? null
    : { index, startsAt, endsAt: startsAt + WEEK, snapshotT: snapshot ?? budget, fixed: snapshot !== null, givenT, givenBy };
  return { block, items: heldItemsV2(events), entries, tiersActiveAt, openedAt, budgetT: budget, week };
}

/** What a give can still take this week (ShopVaultV2 `give`'s limits), for the shop and per collection. */
export interface ShopAllowanceV2 {
  /** The week's limit for all gives, and what is left of it. */
  readonly weeklyLimitT: bigint;
  readonly weeklyLeftT: bigint;
  /** The limit per collection, the same for each. */
  readonly collectionLimitT: bigint;
  /** F132: the cheapest active give (never above the week's budget), the floor of both limits. */
  readonly floorT: bigint;
  readonly leftFor: (collection: string) => bigint;
}

/** The shop's limits at `now` from its book and its fixed config (ShopConfigV2's prices and presets). */
export function allowanceV2(book: ShopBookV2, config: { readonly givePricesT: readonly bigint[]; readonly weeklyBps: number; readonly collectionBps: number }, now: bigint): ShopAllowanceV2 | null {
  const week = book.week;
  if (!week) return null;
  const snapshot = week.snapshotT;
  // `_giveFloor`: the first tier (the cheapest, prices rise by tier) any collection has started with, within the budget.
  let floorT = 0n;
  for (let tier = 0; tier < 4; tier += 1) {
    const at = book.tiersActiveAt[tier];
    if (at !== null && at !== undefined && now >= at) {
      const price = config.givePricesT[tier] ?? 0n;
      floorT = price < snapshot ? price : snapshot;
      break;
    }
  }
  const limit = (bps: number) => { const share = (snapshot * BigInt(bps)) / 10_000n; return share < floorT ? floorT : share; };
  const weeklyLimitT = limit(config.weeklyBps);
  const collectionLimitT = limit(config.collectionBps);
  const left = (cap: bigint, used: bigint) => (used >= cap ? 0n : cap - used);
  return {
    weeklyLimitT, collectionLimitT, floorT,
    weeklyLeftT: left(weeklyLimitT, week.givenT),
    leftFor: (collection) => left(collectionLimitT, week.givenBy.get(collection.toLowerCase()) ?? 0n),
  };
}

/** Why a give of `collection`'s tier price cannot go now, by the book; null when it fits every limit. */
export type GiveBlock = 'unlisted' | 'waiting' | 'closed' | 'budget' | 'weekly' | 'collection';
export function giveBlockV2(book: ShopBookV2, allowance: ShopAllowanceV2 | null, collection: string, priceT: bigint, now: bigint): GiveBlock | null {
  const entry = book.entries.get(collection.toLowerCase());
  if (!entry) return 'unlisted';
  if (book.openedAt === null || allowance === null) return 'closed';
  if (now < entry.activeAt) return 'waiting';
  if (priceT > book.budgetT) return 'budget';
  if (priceT > allowance.weeklyLeftT) return 'weekly';
  if (priceT > allowance.leftFor(collection)) return 'collection';
  return null;
}

/** A raw shop log (topics and data) as one event of the book, or null when it is none of them. */
export function shopEventOf(log: { readonly topics: readonly Hex[]; readonly data: Hex; readonly blockNumber: bigint }): ShopEventV2 | null {
  let decoded;
  try {
    decoded = decodeEventLog({ abi: shopVaultV2Abi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
  } catch {
    return null;
  }
  const a = decoded.args as Record<string, unknown>;
  const block = log.blockNumber;
  switch (decoded.eventName) {
    case 'SeedFunded': return { kind: 'seed', amountT: a.amountT as bigint, block };
    case 'GateOpened': return { kind: 'opened', timestamp: a.timestamp as bigint, block };
    case 'CollectionAdded': return { kind: 'added', collection: a.collection as Address, tier: Number(a.tier), activeAt: a.activeAt as bigint, block };
    case 'StarterLoaded': return { kind: 'loaded', collection: a.collection as Address, id: a.id as bigint, block };
    case 'StarterReturned': return { kind: 'returned', collection: a.collection as Address, id: a.id as bigint, block };
    case 'Given': return { kind: 'given', collection: a.collection as Address, id: a.id as bigint, amountT: a.amountT as bigint, block };
    case 'Picked': return { kind: 'picked', collection: a.collection as Address, id: a.id as bigint, amountT: a.amountT as bigint, block };
    default: return null;
  }
}

/** What the book needs from a chain: the shop's logs over a block range, in order, and a block's time. */
export interface ShopLogReaderV2 {
  logs(address: Address, fromBlock: bigint, toBlock: bigint): Promise<readonly { readonly topics: readonly Hex[]; readonly data: Hex; readonly blockNumber: bigint; readonly logIndex: number }[]>;
  timestamp(block: bigint): Promise<bigint>;
}

/** What the book is built from: the shop's events in chain order, the block times it needs, and the block read to. */
export interface ShopEventsV2 {
  readonly events: readonly ShopEventV2[];
  readonly times: ReadonlyMap<bigint, bigint>;
  readonly block: bigint;
}

/**
 * Reads the shop's events from its creation block to the snapshot's, `LOG_SPAN` blocks a query, then the times of its
 * last gives and picks, back to the first before the week `now` is in. A later week needs no more of them: its moves
 * are all after that one.
 */
export async function readShopEventsV2(reader: ShopLogReaderV2, shop: Address, fromBlock: bigint, toBlock: bigint, now: bigint): Promise<ShopEventsV2> {
  const logs: { topics: readonly Hex[]; data: Hex; blockNumber: bigint; logIndex: number }[] = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_SPAN) {
    const end = start + LOG_SPAN - 1n < toBlock ? start + LOG_SPAN - 1n : toBlock;
    logs.push(...await reader.logs(shop, start, end));
  }
  logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  const events = logs.flatMap((log) => { const e = shopEventOf(log); return e ? [e] : []; });
  const opened = events.find((e): e is Extract<ShopEventV2, { kind: 'opened' }> => e.kind === 'opened');
  const times = new Map<bigint, bigint>();
  if (opened && now >= opened.timestamp) {
    const startsAt = opened.timestamp + ((now - opened.timestamp) / WEEK) * WEEK;
    const moves = events.filter((e) => e.kind === 'given' || e.kind === 'picked');
    for (let i = moves.length - 1; i >= 0; i -= 1) {
      const move = moves[i];
      if (!move) break;
      const time = times.get(move.block) ?? await reader.timestamp(move.block);
      times.set(move.block, time);
      if (time < startsAt) break;
    }
  }
  return { events, times, block: toBlock };
}

/**
 * The book at `now`, read as above. `budgetT` is the snapshot's own read: a replay that differs is refused (a reorg, a
 * log the RPC dropped), never shown.
 */
export async function readShopBookV2(reader: ShopLogReaderV2, shop: Address, fromBlock: bigint, toBlock: bigint, now: bigint, budgetT: bigint | null): Promise<ShopBookV2> {
  const { events, times } = await readShopEventsV2(reader, shop, fromBlock, toBlock, now);
  const book = shopBookV2(events, times, now, toBlock);
  if (budgetT !== null && book.budgetT !== budgetT) throw new Error('Shop book differs from the budget read');
  return book;
}
