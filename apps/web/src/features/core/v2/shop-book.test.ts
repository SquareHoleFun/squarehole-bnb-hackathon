/**
 * SH-V21-FE13: a shop's book from its own events, and the week's give allowance exactly as ShopVaultV2 `give` checks it
 * (`_startWeek`, `_giveFloor`, `_giveLimit`; F132's floor of one cheapest active give within the week's budget).
 */
import { encodeAbiParameters, encodeEventTopics, getAddress, type AbiEvent, type Address, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { shopVaultV2Abi } from '../../../../../../packages/chain/src/core/v2';
import { LOG_SPAN, WEEK, allowanceV2, giveBlockV2, heldItemsV2, readShopBookV2, shopBookV2, shopEventOf, type ShopEventV2 } from './shop-book';

const A = getAddress('0x00000000000000000000000000000000000000a1') as Address;
const B = getAddress('0x00000000000000000000000000000000000000b2') as Address;
const E18 = 10n ** 18n;
const OPEN = 2_000_000n;
const CONFIG = { givePricesT: [1n, 2n, 4n, 8n].map((n) => n * E18), weeklyBps: 1_000, collectionBps: 250 };
const seed = (amountT: bigint, block = 1n): ShopEventV2 => ({ kind: 'seed', amountT, block });
const added = (collection: Address, tier: number, activeAt: bigint, block = 1n): ShopEventV2 => ({ kind: 'added', collection, tier, activeAt, block });
const opened = (block = 10n): ShopEventV2 => ({ kind: 'opened', timestamp: OPEN, block });
const given = (collection: Address, id: bigint, amountT: bigint, block: bigint): ShopEventV2 => ({ kind: 'given', collection, id, amountT, block });
const picked = (collection: Address, id: bigint, amountT: bigint, block: bigint): ShopEventV2 => ({ kind: 'picked', collection, id, amountT, block });

describe('SH-V21-FE13 the items inside', () => {
  it('starters and gives come in, picks and returns go out; an item given again is inside once', () => {
    const events: ShopEventV2[] = [
      { kind: 'loaded', collection: A, id: 0n, block: 2n }, { kind: 'loaded', collection: A, id: 1n, block: 2n },
      given(B, 7n, E18, 20n), picked(A, 0n, 2n * E18, 21n), given(A, 0n, E18, 22n),
      { kind: 'returned', collection: A, id: 1n, block: 23n },
    ];
    expect(heldItemsV2(events)).toEqual([{ collection: B, id: 7n }, { collection: A, id: 0n }]);
  });
});

describe('SH-V21-FE13 the week and its budget', () => {
  const base = [seed(1000n * E18), added(A, 0, OPEN - 1n), added(B, 2, OPEN - 1n), opened()];
  it('the first give or pick of a week fixes its budget before it moves; earlier weeks need no time', () => {
    // Week 1: a give of 1 and a pick of 2. Week 3 (now): a pick of 2 fixes 1001, then two gives of 1 and of 4.
    const events = [...base, given(A, 1n, E18, 20n), picked(A, 1n, 2n * E18, 21n), picked(A, 5n, 2n * E18, 40n), given(A, 2n, E18, 41n), given(B, 9n, 4n * E18, 42n)];
    const now = OPEN + 2n * WEEK + 100n;
    const times = new Map([[40n, OPEN + 2n * WEEK + 10n], [41n, OPEN + 2n * WEEK + 11n], [42n, OPEN + 2n * WEEK + 12n], [21n, OPEN + 5n]]);
    const book = shopBookV2(events, times, now, 50n);
    expect(book.week).toMatchObject({ index: 3n, startsAt: OPEN + 2n * WEEK, endsAt: OPEN + 3n * WEEK, snapshotT: 1001n * E18, fixed: true, givenT: 5n * E18 });
    expect(book.week?.givenBy.get(A.toLowerCase())).toBe(E18);
    expect(book.week?.givenBy.get(B.toLowerCase())).toBe(4n * E18);
    expect(book.budgetT).toBe((1000n - 1n + 2n + 2n - 1n - 4n) * E18);
    const allowance = allowanceV2(book, CONFIG, now);
    // 10% and 2.5% of the week's 1001, floored to raw units; the floor (tier 1's 1) is below both.
    expect(allowance).toMatchObject({ weeklyLimitT: 1001n * E18 / 10n, collectionLimitT: 1001n * E18 * 250n / 10_000n, floorT: E18 });
    expect(allowance?.weeklyLeftT).toBe(1001n * E18 / 10n - 5n * E18);
    expect(allowance?.leftFor(A)).toBe(1001n * E18 * 250n / 10_000n - E18);
    expect(allowance?.leftFor(B.toUpperCase().replace('0X', '0x'))).toBe(1001n * E18 * 250n / 10_000n - 4n * E18);
  });

  it('no give or pick yet this week: the next one fixes the budget it finds, nothing is given yet', () => {
    const events = [...base, given(A, 1n, E18, 20n)];
    const book = shopBookV2(events, new Map([[20n, OPEN + 1n]]), OPEN + WEEK + 5n, 30n);
    expect(book.week).toMatchObject({ index: 2n, snapshotT: 999n * E18, fixed: false, givenT: 0n });
    expect(allowanceV2(book, CONFIG, OPEN + WEEK + 5n)?.weeklyLeftT).toBe(999n * E18 / 10n);
  });

  it('F132: with a small budget both limits are one cheapest active give, never above the week’s budget', () => {
    const small = [seed(30n * E18), added(A, 1, OPEN - 1n), added(B, 3, OPEN - 1n), opened()];
    // The cheapest started tier is tier 2 (2). 10% of 30 is 3, above it; 2.5% is 0.75, so the floor of 2 holds.
    let allowance = allowanceV2(shopBookV2(small, new Map(), OPEN + 1n, 20n), CONFIG, OPEN + 1n);
    expect(allowance).toMatchObject({ floorT: 2n * E18, weeklyLimitT: 3n * E18, collectionLimitT: 2n * E18 });
    // A budget below the cheapest give: the floor is the budget itself.
    const tiny = [seed(3n * E18), added(B, 3, OPEN - 1n), opened()];
    allowance = allowanceV2(shopBookV2(tiny, new Map(), OPEN + 1n, 20n), CONFIG, OPEN + 1n);
    expect(allowance).toMatchObject({ floorT: 3n * E18, weeklyLimitT: 3n * E18, collectionLimitT: 3n * E18 });
  });

  it('a tier no collection has started sets no floor; the first started tier, the cheapest, does', () => {
    const events = [seed(100n * E18), added(A, 0, OPEN + 10n * 86_400n), added(B, 2, OPEN - 1n), opened()];
    expect(allowanceV2(shopBookV2(events, new Map(), OPEN + 1n, 20n), CONFIG, OPEN + 1n)?.floorT).toBe(4n * E18);
    expect(allowanceV2(shopBookV2(events, new Map(), OPEN + 11n * 86_400n, 20n), CONFIG, OPEN + 11n * 86_400n)?.floorT).toBe(E18);
  });

  it('why a give cannot go now', () => {
    const events = [seed(40n * E18), added(A, 0, OPEN - 1n), added(B, 3, OPEN + 7n * 86_400n), opened(), given(A, 1n, E18, 20n)];
    const now = OPEN + 100n;
    const book = shopBookV2(events, new Map([[20n, OPEN + 1n]]), now, 30n);
    const allowance = allowanceV2(book, CONFIG, now);
    expect(giveBlockV2(book, allowance, A, E18, now)).toBe('collection'); // 2.5% of 40 is 1, already given
    expect(giveBlockV2(book, allowance, B, 8n * E18, now)).toBe('waiting');
    expect(giveBlockV2(book, allowance, '0x00000000000000000000000000000000000000c3', E18, now)).toBe('unlisted');
    expect(giveBlockV2(shopBookV2([seed(40n * E18), added(A, 0, 1n)], new Map(), now, 30n), null, A, E18, now)).toBe('closed');
    const rich = shopBookV2([seed(1000n * E18), added(A, 0, OPEN - 1n), opened()], new Map(), now, 30n);
    expect(giveBlockV2(rich, allowanceV2(rich, CONFIG, now), A, 25n * E18, now)).toBe(null);
    expect(giveBlockV2(rich, allowanceV2(rich, CONFIG, now), A, 26n * E18, now)).toBe('collection');
    expect(giveBlockV2(rich, allowanceV2(rich, { ...CONFIG, collectionBps: 1_000 }, now), A, 101n * E18, now)).toBe('weekly');
    expect(giveBlockV2(rich, allowanceV2(rich, CONFIG, now), A, 1001n * E18, now)).toBe('budget');
  });
});

describe('SH-V21-FE13 reading the book from the chain', () => {
  const event = (name: string) => shopVaultV2Abi.find((item) => item.type === 'event' && item.name === name) as AbiEvent;
  const log = (name: string, args: Record<string, unknown>, blockNumber: bigint, logIndex = 0) => {
    const abi = event(name);
    return { topics: encodeEventTopics({ abi: [abi], eventName: name, args } as never) as Hex[],
      data: encodeAbiParameters(abi.inputs.filter((i) => !i.indexed), abi.inputs.filter((i) => !i.indexed).map((i) => args[i.name ?? ''])), blockNumber, logIndex };
  };
  it('decodes each event the book reads and skips the rest', () => {
    expect(shopEventOf(log('Given', { collection: A, id: 7n, giver: B, amountT: E18 }, 5n))).toEqual({ kind: 'given', collection: A, id: 7n, amountT: E18, block: 5n });
    expect(shopEventOf(log('CollectionAdded', { collection: A, tier: 2, activeAt: 9n }, 5n))).toEqual({ kind: 'added', collection: A, tier: 2, activeAt: 9n, block: 5n });
    expect(shopEventOf(log('CuratorProposed', { next: B }, 5n))).toBeNull();
    expect(shopEventOf({ topics: [`0x${'11'.repeat(32)}`], data: '0x', blockNumber: 5n })).toBeNull();
  });

  it(`reads ${LOG_SPAN} blocks a query, in order, and the times of this week’s moves back to the first before it`, async () => {
    const start = 100n; const end = start + 2n * LOG_SPAN + 10n; const now = OPEN + WEEK + 50n;
    const all = [
      log('SeedFunded', { amountT: 1000n * E18 }, start), log('CollectionAdded', { collection: A, tier: 0, activeAt: OPEN - 1n }, start, 1),
      log('GateOpened', { timestamp: OPEN }, start + 5n), log('Given', { collection: A, id: 1n, giver: B, amountT: E18 }, start + LOG_SPAN + 3n),
      log('Given', { collection: A, id: 2n, giver: B, amountT: E18 }, end - 1n), log('Picked', { collection: A, id: 1n, to: B, amountT: 2n * E18 }, end),
    ];
    const reader = {
      logs: vi.fn(async (_address: Address, from: bigint, to: bigint) => all.filter((l) => l.blockNumber >= from && l.blockNumber <= to).reverse()),
      timestamp: vi.fn(async (block: bigint) => (block === start + LOG_SPAN + 3n ? OPEN + 10n : OPEN + WEEK + 20n)),
    };
    const book = await readShopBookV2(reader, A, start, end, now, 1000n * E18);
    expect(reader.logs.mock.calls.map(([, from, to]) => [from, to])).toEqual([[start, start + LOG_SPAN - 1n], [start + LOG_SPAN, start + 2n * LOG_SPAN - 1n], [start + 2n * LOG_SPAN, end]]);
    expect(reader.timestamp.mock.calls.map(([block]) => block)).toEqual([end, end - 1n, start + LOG_SPAN + 3n]);
    expect(book.week).toMatchObject({ index: 2n, snapshotT: 999n * E18, fixed: true, givenT: E18 });
    expect(book.items).toEqual([{ collection: A, id: 2n }]);
    // A replay that does not add up to the budget read is refused, never shown.
    await expect(readShopBookV2(reader, A, start, end, now, 1001n * E18)).rejects.toThrow(/differs/);
  });
});
