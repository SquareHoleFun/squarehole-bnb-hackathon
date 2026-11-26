/**
 * SH-BOX-LIFE-VIEW § 0 and § 2: the box's history from the indexer's activity route, on GPU Poor's real answer
 * (api.squarehole.fun, 2026-10-27) and its earlier moments: parsing, the merge that never loses or doubles a row (a
 * newer page, a gap read further back, a reorg, a stale older page), who traded (the indexer leaves `trader` null for
 * plain pool trades; the same transaction's T transfer names the account), the rows of the story, the holders (only
 * from a complete history that matches the snapshot), and the pool's price after graduation.
 */
import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { parseSnapshotV2 } from './indexer-v2';
import {
  appendOlderV2, EMPTY_ACTIVITY_V2, holdersV2, lifeRowsV2, mergeNewestV2, parseActivityPageV2, replaceNewestV2, rolesBookV2, traderOfV2,
  type ActivityEventV2, type ActivityItemV2, type ActivityPageV2, type ActivityStoreV2,
} from './life-activity';
import { gpuPoorLifeV2, LIFE_BUYER, LIFE_CREATOR, LIFE_SNIPER, recordedLifeV2, sepoliaLifeSourceV2 } from './test-support/life-v2';

const source = sepoliaLifeSourceV2();
const DEPLOYER = getAddress('0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE');
const POOL = getAddress('0xE03A1074c86CFeDd5C142C4F04F1a1536e203543');
const recorded = () => parseActivityPageV2(recordedLifeV2.gpuPoor.activity);
const viewOf = (body: unknown) => parseSnapshotV2(body, source);
const book = () => rolesBookV2(viewOf(recordedLifeV2.gpuPoor.body).record);
const pageOf = (items: readonly ActivityItemV2[], next: string | null, asOfBlock: bigint | null = 12_003_391n): ActivityPageV2 => ({ items, next, asOfBlock });
const ids = (store: ActivityStoreV2) => store.items.map((item) => item.id);

describe('the activity route’s answer', () => {
  it('parses GPU Poor’s whole history: 37 items newest first, five swaps, block times and transaction hashes; refuses a malformed one', () => {
    const page = recorded();
    expect(page.items).toHaveLength(37);
    expect(page.next).toBeNull();
    expect(page.asOfBlock).toBe(12_003_391n);
    const trades = page.items.filter((item) => item.kind === 'trade');
    expect(trades.map((t) => [t.id, t.side, t.route])).toEqual([['12003365-51', 'buy', 'hook'], ['12003364-100', 'buy', 'buy_back'], ['12003363-135', 'buy', 'buy_back'], ['12003353-119', 'buy', 'other'], ['12003304-71', 'buy', 'launch_router']]);
    const fill = trades.find((t) => t.id === '12003353-119');
    expect(fill && [fill.p, fill.t, fill.at, fill.txHash, fill.trader]).toEqual([100_974_445_980_372_006_763n, 797_524_090_994_133_535_912_801_006n, 1_793_082_816n, '0x2c14a15762315c0867621dd5f76b956185d248e29fa2dcb57936130dbcbfb9f8', null]);
    const wire = recordedLifeV2.gpuPoor.activity as { items: Record<string, unknown>[] };
    const fillWire = wire.items.find((item) => item.id === '12003353-119');
    const broken = (patch: Record<string, unknown>) => ({ ...wire, items: [{ ...fillWire, ...patch }] });
    expect(() => parseActivityPageV2(broken({ qRaw: 12 }))).toThrow();
    expect(() => parseActivityPageV2(broken({ id: '12003353-120' }))).toThrow(/id/);
    expect(() => parseActivityPageV2(broken({ side: 'swap' }))).toThrow(/side/);
    expect(() => parseActivityPageV2(broken({ route: 7 }))).toThrow(/route/);
    expect(() => parseActivityPageV2({ ...wire, next: 'yesterday' })).toThrow(/cursor/);
    // A route a later indexer adds is a trade the page shows as such (`other`), never the whole answer refused.
    const hookTrade = wire.items.find((item) => item.id === '12003365-51');
    const later = parseActivityPageV2({ ...wire, items: [hookTrade, { ...fillWire, route: 'aggregator_v9' }] });
    expect(later.items.map((item) => [item.id, item.kind === 'trade' ? item.route : item.kind])).toEqual([['12003365-51', 'hook'], ['12003353-119', 'other']]);
    // A kind a v2 box does not have is left out, never guessed.
    expect(parseActivityPageV2({ ...wire, items: [{ ...wire.items[0], kind: 'v1_batch' }] }).items).toEqual([]);
  });
});

describe('the merge: never a lost or doubled row', () => {
  const all = recorded().items;
  const newest = (n: number) => all.slice(0, n);

  it('a first read is the run; a newer read that reaches the held rows adds what is new on top, each id once', () => {
    let store = mergeNewestV2(EMPTY_ACTIVITY_V2, pageOf(all.slice(10, 30), '12003304-74')).store;
    expect(store.items).toHaveLength(20);
    expect(store.next).toBe('12003304-74');
    // The newest 15 overlap the held run's newest 5: 10 new rows, the overlap once.
    const merged = mergeNewestV2(store, pageOf(newest(15), '12003359-78'));
    expect(merged.reached).toBe(true);
    store = merged.store;
    expect(ids(store)).toEqual(all.slice(0, 30).map((item) => item.id));
    expect(new Set(ids(store)).size).toBe(30);
    // The same read again changes nothing; the cursor to the older part stays the held run's.
    expect(ids(mergeNewestV2(store, pageOf(newest(15), '12003359-78')).store)).toEqual(ids(store));
    expect(store.next).toBe('12003304-74');
  });

  it('a read that does not reach the held rows says so, so the reader reads further back; failing that it replaces them', () => {
    const store = mergeNewestV2(EMPTY_ACTIVITY_V2, pageOf(all.slice(30), null)).store;
    expect(store.next).toBeNull();
    // The newest 5 end at 12003364-100: rows 5 … 29 lie between, unread.
    const gap = mergeNewestV2(store, pageOf(newest(5), '12003364-100'));
    expect(gap.reached).toBe(false);
    expect(gap.store).toBe(store);
    // Read further back until the run joins: the whole history, once each.
    const joined = mergeNewestV2(store, pageOf(all.slice(0, 31), '12003304-73'));
    expect(joined.reached).toBe(true);
    expect(ids(joined.store)).toEqual(all.map((item) => item.id));
    // Out of budget: the fresh run replaces the held one, with its own cursor (no hole between them).
    const replaced = replaceNewestV2(pageOf(newest(5), '12003364-100'));
    expect([replaced.items.length, replaced.next]).toEqual([5, '12003364-100']);
  });

  it('inside the range a read covers it is the truth: a row the indexer no longer serves there (a reorg) goes, one seen again replaces the old', () => {
    const store = mergeNewestV2(EMPTY_ACTIVITY_V2, pageOf(newest(20), '12003353-120')).store;
    const reorged = all[2] as ActivityItemV2;
    const replaced = { ...(all[1] as ActivityEventV2), blockHash: `0x${'ab'.repeat(32)}` as const };
    const fresh = pageOf([all[0] as ActivityItemV2, replaced, ...newest(12).slice(3)], '12003359-75');
    const merged = mergeNewestV2(store, fresh).store;
    expect(ids(merged)).not.toContain(reorged.id);
    expect(merged.items.find((item) => item.id === replaced.id)?.blockHash).toBe(replaced.blockHash);
    // Older held rows outside the fresh range stay.
    expect(ids(merged).slice(-8)).toEqual(ids(store).slice(-8));
    expect(new Set(ids(merged)).size).toBe(merged.items.length);
  });

  it('an item an answer carries twice is held once: a first read, a newer read, a fresh run, an older page', () => {
    const [a, b, c, d] = all as [ActivityItemV2, ActivityItemV2, ActivityItemV2, ActivityItemV2];
    expect(ids(mergeNewestV2(EMPTY_ACTIVITY_V2, pageOf([a, b, b, c], c.id)).store)).toEqual([a.id, b.id, c.id]);
    const held = mergeNewestV2(EMPTY_ACTIVITY_V2, pageOf([c, d], d.id)).store;
    expect(ids(mergeNewestV2(held, pageOf([a, a, b, c, c], c.id)).store)).toEqual([a.id, b.id, c.id, d.id]);
    expect(ids(replaceNewestV2(pageOf([a, a, b], b.id)))).toEqual([a.id, b.id]);
    const run = mergeNewestV2(EMPTY_ACTIVITY_V2, pageOf([a, b], b.id)).store;
    expect(ids(appendOlderV2(run, b.id, pageOf([c, c, d], d.id)))).toEqual([a.id, b.id, c.id, d.id]);
  });

  it('an older page joins only while its cursor is still the run’s; an empty newest read keeps the held rows', () => {
    const store = mergeNewestV2(EMPTY_ACTIVITY_V2, pageOf(newest(10), '12003359-79')).store;
    const older = pageOf(all.slice(10, 20), '12003353-120');
    const joined = appendOlderV2(store, '12003359-79', older);
    expect(ids(joined)).toEqual(all.slice(0, 20).map((item) => item.id));
    expect(joined.next).toBe('12003353-120');
    // Stale: the run moved on (another page joined first); the same page again changes nothing.
    expect(appendOlderV2(joined, '12003359-79', older)).toBe(joined);
    // An empty newest read (a history being rebuilt) never empties the list.
    expect(mergeNewestV2(joined, pageOf([], null)).store.items).toHaveLength(20);
    expect(mergeNewestV2(joined, pageOf([], '12003391-1')).store.items).toHaveLength(20);
    // A read that reaches the box's first item ends the run there: nothing older is left to read.
    expect(mergeNewestV2(joined, pageOf(all, null)).store).toMatchObject({ next: null, items: all });
  });
});

describe('a reorg across the fresh read’s boundary (fix round 3)', () => {
  /** A swap at `block`, log `logIndex`, on the chain's branch `branch` (its block hash says which), in the route's shape. */
  const swapOn = (block: number, logIndex: number, branch = 1) => ({
    kind: 'trade', id: `${block}-${logIndex}`, block: String(block), blockHash: `0x${(block * 10 + branch).toString(16).padStart(64, '0')}`, timestamp: String(1_793_083_300 + block),
    txHash: `0x${(block * 1_000 + logIndex + branch * 100_000).toString(16).padStart(64, '0')}`, logIndex, side: 'buy', route: 'other', qRaw: '1000', tRaw: '2000', taxQ: '0', trader: null,
    sqrtPriceX96After: '113506849788177122193529205755893',
  });
  const read = (wire: readonly Record<string, unknown>[], next: string | null) => parseActivityPageV2({ asOf: { block: '1000' }, items: wire, next });
  /** Block 100 with 60 swaps from log `top` down on `branch`, then blocks 99 and 98 with one swap each (never reorged). */
  const chain = (top: number, branch: number) => [...Array.from({ length: 60 }, (_, i) => swapOn(100, top - i, branch)), swapOn(99, 1), swapOn(98, 1)];
  const pairs = (items: readonly ActivityItemV2[]) => items.map((item) => [item.id, item.blockHash]);
  const BRANCH_1 = `0x${(1001).toString(16).padStart(64, '0')}`;

  it('the held rows of the block a newest read ends in carry another hash: it reads further back, never keeping the old branch; then only rows both hold alike stay, also with the whole history held', () => {
    const before = chain(159, 1);
    const held = mergeNewestV2(EMPTY_ACTIVITY_V2, read(before, null)).store;
    expect([held.items.length, held.next]).toEqual([62, null]);
    // The reorg replaced block 100 (its logs five later, another hash). The newest 50 end inside it, at 100-115.
    const after = chain(164, 2);
    const newest = mergeNewestV2(held, read(after.slice(0, 50), '100-115'));
    expect(newest.reached).toBe(false);
    expect(newest.store).toBe(held);
    // Read back to the box's first item: the whole history as the indexer serves it now, no row of the old branch.
    const whole = mergeNewestV2(held, read(after, null));
    expect(whole.reached).toBe(true);
    expect(pairs(whole.store.items)).toEqual(pairs(read(after, null).items));
    expect(whole.store.next).toBeNull();
    expect(whole.store.items.filter((item) => item.blockHash === BRANCH_1)).toEqual([]);
    // Read back to block 99, which both hold alike: the held rows older than it (block 98) stay, the cursor the held one's.
    const joined = mergeNewestV2(held, read(after.slice(0, 61), '99-1'));
    expect(joined.reached).toBe(true);
    expect(pairs(joined.store.items)).toEqual(pairs(read(after, null).items));
    expect(joined.store.next).toBeNull();
  });

  it('every held item of the meeting block must carry the read’s hash: a block held with two hashes reads further back; the same hash in capitals joins', () => {
    // The held block 100 mixes the new branch (its newest 30) with the old one (its oldest 30): one matching item is not
    // enough, the old rows below the meeting point would stay.
    const mixed = [...chain(159, 2).slice(0, 30), ...chain(159, 1).slice(30)];
    const held = mergeNewestV2(EMPTY_ACTIVITY_V2, read(mixed, null)).store;
    const now = chain(159, 2);
    expect(mergeNewestV2(held, read(now.slice(0, 50), '100-110'))).toEqual({ store: held, reached: false });
    expect(pairs(mergeNewestV2(held, read(now, null)).store.items)).toEqual(pairs(read(now, null).items));
    // A hash is compared without regard to case: the same block in capitals joins, the held rows below it kept.
    const whole = mergeNewestV2(EMPTY_ACTIVITY_V2, read(now, null)).store;
    const capitals = now.slice(0, 50).map((item) => ({ ...item, blockHash: `0x${item.blockHash.slice(2).toUpperCase()}` }));
    const joined = mergeNewestV2(whole, read(capitals, '100-110'));
    expect([joined.reached, joined.store.items.length, joined.store.next]).toEqual([true, 62, null]);
  });

  it('a held run that holds none of the block a newest read ends in (a reorg put a new block there) reads further back too', () => {
    const held = mergeNewestV2(EMPTY_ACTIVITY_V2, read([swapOn(101, 1), swapOn(99, 1), swapOn(98, 1)], null)).store;
    const now = [swapOn(101, 3, 2), swapOn(100, 1, 2), swapOn(99, 1), swapOn(98, 1)];
    expect(mergeNewestV2(held, read(now.slice(0, 2), '100-1'))).toEqual({ store: held, reached: false });
    // One older page: block 99 is the same on both, so block 98 stays as held.
    const joined = mergeNewestV2(held, read(now.slice(0, 3), '99-1'));
    expect([joined.reached, pairs(joined.store.items), joined.store.next]).toEqual([true, pairs(read(now, null).items), null]);
  });

  it('an older page asked for below the old branch’s last row is stale once the run’s last row is the new branch’s, the same id', () => {
    /** Block 101 with 50 swaps and block 100 with 10, on `branch`, then block 99 (never reorged). */
    const branch = (b: number) => [...Array.from({ length: 50 }, (_, i) => swapOn(101, 159 - i, b)), ...Array.from({ length: 10 }, (_, i) => swapOn(100, 9 - i, b)), swapOn(99, 1)];
    const held = mergeNewestV2(EMPTY_ACTIVITY_V2, read(branch(1).slice(0, 50), '101-110')).store;
    const tail = held.items.at(-1);
    // The reorg replaced blocks 100 and 101, the same logs: the newest read takes block 101's new branch, the same cursor.
    const repaired = mergeNewestV2(held, read(branch(2).slice(0, 50), '101-110'));
    expect([repaired.reached, repaired.store.next]).toEqual([true, '101-110']);
    // The page asked for before (the old branch's blocks 100 and 99) is dropped; the same page asked for now joins.
    expect(appendOlderV2(repaired.store, '101-110', read(branch(1).slice(50), null), tail)).toBe(repaired.store);
    const now = appendOlderV2(repaired.store, '101-110', read(branch(2).slice(50), null), repaired.store.items.at(-1));
    expect([pairs(now.items), now.next]).toEqual([pairs(read(branch(2), null).items), null]);
  });

  it('a fresh run that reaches past every held row ends at its own cursor, never the held run’s', () => {
    const all = recorded().items;
    const held = mergeNewestV2(EMPTY_ACTIVITY_V2, pageOf(all.slice(0, 5), all[4]?.id ?? null)).store;
    const merged = mergeNewestV2(held, pageOf(all.slice(0, 20), all[19]?.id ?? null));
    expect([merged.reached, merged.store.items.length, merged.store.next]).toEqual([true, 20, all[19]?.id]);
  });
});

describe('who traded', () => {
  it('the filling buy’s VRAM went from the pool to the founder’s deployer in the same transaction: that is who bought', () => {
    const page = recorded();
    const fill = page.items.find((item) => item.id === '12003353-119');
    const transfers = page.items.filter((item): item is ActivityEventV2 => item.kind === 'v2_event' && item.txHash === fill?.txHash && item.source === 'token');
    expect(traderOfV2({ side: 'buy' }, transfers, book())).toBe(DEPLOYER);
    // A router's hand-off is followed to the account at its end; the pool and the box's own contracts never trade.
    const hop = (from: string, to: string, amount: string) => ({ ...(transfers[0] as ActivityEventV2), data: { source: 'token', event: 'Transfer', from, to, amount } });
    const router = '0x00000000000000000000000000000000000000a1';
    expect(traderOfV2({ side: 'buy' }, [hop(POOL, router, '5'), hop(router, LIFE_BUYER, '5')], book())).toBe(LIFE_BUYER);
    expect(traderOfV2({ side: 'sell' }, [hop(LIFE_BUYER, POOL, '7')], book())).toBe(LIFE_BUYER);
    expect(traderOfV2({ side: 'buy' }, [hop(POOL, '0x3c5924a06cE9Bb1A5864cc896e58bCD3C2a003f8', '9')], book())).toBeNull();
    expect(traderOfV2({ side: 'buy' }, [], book())).toBeNull();
  });
});

describe('the story', () => {
  it('GPU Poor, newest first: the deepening, two buy-backs, fees, Graduated (the tip to its caller), Raise full, the buy and Created', () => {
    const rows = lifeRowsV2(recorded().items, book());
    expect(rows.map((row) => (row.kind === 'trade' ? `${row.side}` : row.event))).toEqual(['deepened', 'buyBack', 'buyBack', 'fees', 'graduated', 'full', 'buy', 'created']);
    const buy = rows[6];
    expect(buy?.kind === 'trade' && [buy.who, buy.role, buy.p, buy.t, buy.txHash]).toEqual([DEPLOYER, null, 100_974_445_980_372_006_763n, 797_524_090_994_133_535_912_801_006n, '0x2c14a15762315c0867621dd5f76b956185d248e29fa2dcb57936130dbcbfb9f8']);
    const graduated = rows[4];
    expect(graduated?.kind === 'event' && [graduated.who, graduated.p, graduated.at]).toEqual([DEPLOYER, 10n ** 17n, 1_793_082_888n]);
    const created = rows[7];
    // The bootstrap buy is the creation's own (its VRAM burned), not a trade row; BoxLaunched is the creation, not the opening.
    expect(created?.kind === 'event' && [created.event, created.p, created.t, created.at]).toEqual(['created', 35_655_029_729_003_341n, 1_079_731_410_673_673_875_460_333n, 1_793_082_228n]);
    const buyBack = rows[1];
    expect(buyBack?.kind === 'event' && [buyBack.p, buyBack.t]).toEqual([240_152_812_443_455_724n, 491_586_276_538_164_949_653_449n]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  it('the launch window: a taxed buy names its buyer (the indexer’s own trader) and its tax apart', () => {
    const { activity } = gpuPoorLifeV2('window');
    const rows = lifeRowsV2(parseActivityPageV2(activity).items, book());
    const buy = rows[0];
    expect(buy?.kind === 'trade' && [buy.side, buy.who, buy.taxP > 0n]).toEqual(['buy', LIFE_SNIPER, true]);
  });

  it('a closed box: Closed (the deadline) and a claim with its holder, its coins handed in and its P', () => {
    const { activity } = gpuPoorLifeV2('failed');
    const rows = lifeRowsV2(parseActivityPageV2(activity).items, book());
    expect(rows.slice(0, 3).map((row) => (row.kind === 'event' ? [row.event, row.cause, row.who] : row.kind))).toEqual([['claim', null, LIFE_BUYER], ['closed', 'Deadline', DEPLOYER], 'trade']);
  });
});

describe('the creator, named', () => {
  it('a buy by the box’s creator is labelled Creator, in the story and among the holders; the pool and the box’s contracts stay apart', () => {
    const roles = book();
    expect([roles.roleOf(LIFE_CREATOR), roles.roleOf(LIFE_CREATOR.toLowerCase()), roles.roleOf(POOL), roles.roleOf('0x3c5924a06cE9Bb1A5864cc896e58bCD3C2a003f8'), roles.roleOf(LIFE_BUYER)]).toEqual(['creator', 'creator', 'pool', 'box', null]);
    expect(roles.partOf('0x3c5924a06cE9Bb1A5864cc896e58bCD3C2a003f8')).toBe('coordinator');
    const { body, activity } = gpuPoorLifeV2('raising', { buyer: LIFE_CREATOR });
    const view = viewOf(body);
    const store = mergeNewestV2(EMPTY_ACTIVITY_V2, parseActivityPageV2(activity)).store;
    const buy = lifeRowsV2(store.items, roles)[0];
    expect(buy?.kind === 'trade' && [buy.side, buy.who, buy.role]).toEqual(['buy', LIFE_CREATOR, 'creator']);
    const holders = holdersV2(store, view.block, view.statistics ?? null, roles);
    expect(holders.status === 'ready' && holders.holders.map((h) => [h.address, h.role])).toEqual([[LIFE_CREATOR, 'creator'], [POOL, 'pool'], [getAddress('0x3c5924a06cE9Bb1A5864cc896e58bCD3C2a003f8'), 'box']]);
    // A closed box's claim by its creator names the creator too.
    const closed = lifeRowsV2(parseActivityPageV2(gpuPoorLifeV2('failed', { buyer: LIFE_CREATOR }).activity).items, roles)[0];
    expect(closed?.kind === 'event' && [closed.event, closed.who, closed.role]).toEqual(['claim', LIFE_CREATOR, 'creator']);
  });
});

describe('the holders', () => {
  const full = (activity: unknown) => mergeNewestV2(EMPTY_ACTIVITY_V2, parseActivityPageV2(activity)).store;

  it('graduated GPU Poor: the pool and the founder’s deployer, their shares of the supply, exactly the snapshot’s count and supply', () => {
    const view = viewOf(recordedLifeV2.gpuPoor.body);
    const stats = view.statistics;
    const holders = holdersV2(full(recordedLifeV2.gpuPoor.activity), view.block, stats ?? null, book());
    expect(holders.status).toBe('ready');
    if (holders.status !== 'ready') return;
    expect(holders.holders.map((h) => [h.address, h.role, h.shareBps])).toEqual([[DEPLOYER, null, 7991], [POOL, 'pool', 2008]]);
    expect(holders.holders.reduce((sum, h) => sum + h.balance, 0n)).toBe(stats?.totalSupplyT);
  });

  it('raise full, graduating: three holders, the box’s coordinator labelled, as the founder’s screenshot counted', () => {
    const { body, activity } = gpuPoorLifeV2('graduating');
    const view = viewOf(body);
    const holders = holdersV2(full(activity), view.block, view.statistics ?? null, book());
    expect(holders.status === 'ready' && holders.holders.map((h) => h.role)).toEqual([null, 'box', 'pool']);
    expect(view.statistics?.holderCount).toBe(3n);
  });

  it('unavailable, never guessed: an incomplete history, a count or supply that does not match, an activity older than the snapshot', () => {
    const view = viewOf(recordedLifeV2.gpuPoor.body);
    const stats = view.statistics ?? null;
    const store = full(recordedLifeV2.gpuPoor.activity);
    expect(holdersV2(EMPTY_ACTIVITY_V2, view.block, stats, book())).toEqual({ status: 'unavailable', reason: 'unread' });
    expect(holdersV2({ ...store, next: '12003304-60' }, view.block, stats, book())).toEqual({ status: 'unavailable', reason: 'incomplete' });
    expect(holdersV2({ ...store, asOfBlock: view.block - 1n }, view.block, stats, book())).toEqual({ status: 'unavailable', reason: 'behind' });
    expect(holdersV2(store, view.block, stats && { ...stats, holderCount: 3n }, book())).toEqual({ status: 'unavailable', reason: 'mismatch' });
    expect(holdersV2(store, view.block, stats && { ...stats, totalSupplyT: stats.totalSupplyT + 1n }, book())).toEqual({ status: 'unavailable', reason: 'mismatch' });
  });

  it('a history read before the snapshot’s head but after its figures last moved answers for it; one read before they moved is behind', () => {
    const view = viewOf(recordedLifeV2.gpuPoor.body);
    const stats = view.statistics ?? null;
    // Read 20 heads ago; the figures stand as they are since 25 heads ago: the same box, every holder at once.
    const store = { ...full(recordedLifeV2.gpuPoor.activity), asOfBlock: view.block - 20n };
    const ready = holdersV2(store, view.block, stats, book(), view.block - 25n);
    expect(ready.status === 'ready' && [ready.atBlock, ready.holders.map((h) => [h.address, h.shareBps])]).toEqual([view.block, [[DEPLOYER, 7991], [POOL, 2008]]]);
    expect(holdersV2(store, view.block, stats, book(), view.block - 20n).status).toBe('ready');
    // The figures moved 19 heads ago, after that read: behind until a newer read.
    expect(holdersV2(store, view.block, stats, book(), view.block - 19n)).toEqual({ status: 'unavailable', reason: 'behind' });
    // Without the block of the last move, the snapshot's own block is the bound (as before).
    expect(holdersV2(store, view.block, stats, book())).toEqual({ status: 'unavailable', reason: 'behind' });
  });
});
