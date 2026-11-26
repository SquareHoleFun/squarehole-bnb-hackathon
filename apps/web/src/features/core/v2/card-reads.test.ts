/**
 * SH-297: the wallet's cards of a shop's collections (card-reads.ts), for the shop's grid and My Box: the collections'
 * transfers to the wallet, at most ten collections a query, each card checked with ownerOf; a failed read throws (the
 * page then says so with Retry), never "no cards". SH-297 notes: older cards by each collection's count, a listing by
 * index where the collection has one, a capped walk back, and what is still not found counted.
 */
import { ContractFunctionRevertedError, getAddress, type Address } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { CARDS_MAX, COLLECTIONS_PER_QUERY, LOOKBACK, WALK_MAX, WALK_STEP, cardRangeV2, readOwnCardsV2, type CardReaderV2, type CardV2 } from './card-reads';
import { ERC721_ABI } from './shop-actions';

const ME = getAddress('0x00000000000000000000000000000000000000a1') as Address;
const OTHER = getAddress('0x00000000000000000000000000000000000000b2') as Address;
const C = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`) as Address;

/** A transfer to the wallet at a block. */
interface Seen extends CardV2 { readonly block: bigint }
interface Options {
  readonly owners?: (card: CardV2) => Address | Error;
  readonly counts?: (collection: Address) => bigint | null;
  readonly listing?: (collection: Address, count: bigint) => readonly bigint[] | null;
}
/** A reader over `transfers` (or a failure): only those inside each asked range, oldest first as the logs come. */
function reader(transfers: readonly Seen[] | (() => never), { owners = () => ME, counts = () => null, listing = () => null }: Options = {}) {
  const queries: { collections: Address[]; from: bigint; to: bigint }[] = []; const listed: Address[] = [];
  const r: CardReaderV2 = {
    transfersTo: async (collections, _to, from, to) => {
      queries.push({ collections: [...collections], from, to });
      if (typeof transfers === 'function') return transfers();
      const named = new Set(collections.map((c) => c.toLowerCase()));
      return transfers.filter((t) => named.has(t.collection.toLowerCase()) && t.block >= from && t.block <= to).map(({ collection, id }) => ({ collection, id }));
    },
    ownerOf: async (collection, id) => { const owner = owners({ collection, id }); if (owner instanceof Error) throw owner; return owner; },
    balanceOf: async (collection) => counts(collection),
    ownedByIndex: async (collection, _owner, count) => { listed.push(collection); return listing(collection, count); },
  };
  return Object.assign(r, { queries, listed });
}
const FROM = 144_000_000n; const TO = 144_200_000n;

describe('SH-297 the wallet\'s cards of a shop', () => {
  it('cards that reached the wallet any way (a pick, a mint, a transfer), newest first, each once, each still its own', async () => {
    const r = reader([{ collection: C(1), id: 3n, block: FROM }, { collection: C(1), id: 4n, block: FROM + 1n }, { collection: C(2), id: 9n, block: FROM + 2n }, { collection: C(1), id: 3n, block: FROM + 3n }],
      { owners: (card) => (card.id === 4n ? OTHER : ME) });
    const own = await readOwnCardsV2(r, [C(1), C(2)], ME, FROM, TO);
    // Card 3 came twice (it went away and came back): once, at its newest place. Card 4 was passed on: not shown.
    expect(own).toEqual({ cards: [{ collection: C(1), id: 3n }, { collection: C(2), id: 9n }], more: false, unfound: 0n });
  });

  it('at most ten collections a query (the public endpoint\'s limit); none listed, nothing read', async () => {
    const many = Array.from({ length: 23 }, (_, i) => C(i + 1));
    const r = reader([]);
    await readOwnCardsV2(r, many, ME, FROM, TO);
    expect(r.queries.map((q) => q.collections.length)).toEqual([COLLECTIONS_PER_QUERY, COLLECTIONS_PER_QUERY, 3]);
    const none = reader([]);
    expect(await readOwnCardsV2(none, [], ME, FROM, TO)).toEqual({ cards: [], more: false, unfound: 0n });
    expect(none.queries).toEqual([]);
  });

  it('a card burned since (ownerOf reverts) is not shown; a failed read throws, never "no cards"', async () => {
    const burned = new ContractFunctionRevertedError({ abi: ERC721_ABI, functionName: 'ownerOf', message: 'nonexistent token' });
    const r = reader([{ collection: C(1), id: 1n, block: FROM }, { collection: C(1), id: 2n, block: FROM }], { owners: (card) => (card.id === 1n ? burned : ME) });
    expect((await readOwnCardsV2(r, [C(1)], ME, FROM, TO)).cards).toEqual([{ collection: C(1), id: 2n }]);
    await expect(readOwnCardsV2(reader(() => { throw new Error('HTTP 503'); }), [C(1)], ME, FROM, TO)).rejects.toThrow('HTTP 503');
    await expect(readOwnCardsV2(reader([{ collection: C(1), id: 1n, block: FROM }], { owners: () => new Error('HTTP 429') }), [C(1)], ME, FROM, TO)).rejects.toThrow('HTTP 429');
  });

  it('at most CARDS_MAX checked, the rest said; the window starts LOOKBACK blocks before the shop\'s creation', async () => {
    const lots = Array.from({ length: CARDS_MAX + 5 }, (_, i) => ({ collection: C(1), id: BigInt(i), block: FROM }));
    const own = await readOwnCardsV2(reader(lots), [C(1)], ME, FROM, TO);
    expect(own.cards).toHaveLength(CARDS_MAX);
    expect(own.more).toBe(true);
    expect(cardRangeV2({ record: { creationBlock: 144_781_346n } as never, block: 144_900_000n })).toEqual([144_781_346n - LOOKBACK, 144_900_000n]);
    expect(cardRangeV2({ record: { creationBlock: 5n } as never, block: 9n })).toEqual([0n, 9n]);
  });

  it('SH-297 notes: a card received long before the window is found by walking back, only for the collections short of their count (harm: no Give group, no sentence)', async () => {
    // Collection 1: one card in the window, one received 1,200,000 blocks before it. Collection 2: its one card in the
    // window. Collection 3: none held (not searched at all).
    const old = FROM - 1_200_000n;
    const r = reader([{ collection: C(1), id: 8n, block: old }, { collection: C(1), id: 9n, block: FROM + 5n }, { collection: C(2), id: 4n, block: FROM + 6n }],
      { counts: (c) => (c === C(1) ? 2n : c === C(2) ? 1n : 0n) });
    const own = await readOwnCardsV2(r, [C(1), C(2), C(3)], ME, FROM, TO);
    expect(own).toEqual({ cards: [{ collection: C(2), id: 4n }, { collection: C(1), id: 9n }, { collection: C(1), id: 8n }], more: false, unfound: 0n });
    // The window for 1 and 2 (3 holds none); then steps of WALK_STEP back for 1 alone, stopping once its count is met.
    expect(r.queries.map((q) => [q.collections, q.from, q.to])).toEqual([
      [[C(1), C(2)], FROM, TO],
      [[C(1)], FROM - WALK_STEP, FROM - 1n],
      [[C(1)], FROM - 2n * WALK_STEP, FROM - WALK_STEP - 1n],
      [[C(1)], FROM - 3n * WALK_STEP, FROM - 2n * WALK_STEP - 1n],
    ]);
    // Every count met in the window: no walk.
    const met = reader([{ collection: C(1), id: 9n, block: FROM }], { counts: () => 1n });
    await readOwnCardsV2(met, [C(1)], ME, FROM, TO);
    expect(met.queries).toHaveLength(1);
  });

  it('SH-297 notes: the walk stops at WALK_MAX (and at block 0); what is still not found is counted, never dropped', async () => {
    const r = reader([{ collection: C(1), id: 9n, block: FROM }], { counts: () => 3n });
    const own = await readOwnCardsV2(r, [C(1)], ME, FROM, TO);
    expect(own).toEqual({ cards: [{ collection: C(1), id: 9n }], more: false, unfound: 2n });
    expect(r.queries).toHaveLength(1 + Number(WALK_MAX / WALK_STEP));
    expect(r.queries.at(-1)?.from).toBe(FROM - WALK_MAX);
    const young = reader([], { counts: () => 1n });
    expect(await readOwnCardsV2(young, [C(1)], ME, 700_000n, 800_000n)).toEqual({ cards: [], more: false, unfound: 1n });
    expect(young.queries.map((q) => [q.from, q.to])).toEqual([[700_000n, 800_000n], [200_000n, 699_999n], [0n, 199_999n]]);
  });

  it('SH-297 notes step 2: a walk step that fails ends the walk and keeps the window\'s cards (harm: "Items unavailable." where the old read showed them); the cause is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const window = [{ collection: C(1), id: 9n, block: FROM }];
    let calls = 0;
    const flaky = reader(window, { counts: () => 3n });
    const inner = flaky.transfersTo;
    flaky.transfersTo = async (collections, to, from, upTo) => { calls += 1; if (calls >= 2) throw new Error('HTTP 429'); return inner(collections, to, from, upTo); };
    expect(await readOwnCardsV2(flaky, [C(1)], ME, FROM, TO)).toEqual({ cards: [{ collection: C(1), id: 9n }], more: false, unfound: 2n });
    expect(calls).toBe(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain(`the walk back stopped at blocks ${FROM - WALK_STEP}-${FROM - 1n}`);
    expect(String(warn.mock.calls[0]?.[1])).toContain('HTTP 429');
    // The window failing still fails the read (the page says so with Retry), its cause logged too.
    warn.mockClear();
    const down = reader(() => { throw new Error('HTTP 503'); }, { counts: () => 1n });
    await expect(readOwnCardsV2(down, [C(1)], ME, FROM, TO)).rejects.toThrow('HTTP 503');
    expect(String(warn.mock.calls[0]?.[0])).toContain(`the window ${FROM}-${TO} failed`);
    warn.mockRestore();
  });

  it('SH-297 notes step 2: the count says "could not be listed", never why: a card that left after the snapshot counts too; a spent check budget is "more", not unlisted cards', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // (a) Counted 2 at the snapshot; card 4 left since (ownerOf reads now): one counted, not listed, and it is not old.
    const left = reader([{ collection: C(1), id: 3n, block: FROM }, { collection: C(1), id: 4n, block: FROM + 1n }], { counts: () => 2n, owners: (card) => (card.id === 4n ? OTHER : ME) });
    expect(await readOwnCardsV2(left, [C(1)], ME, FROM, TO)).toEqual({ cards: [{ collection: C(1), id: 3n }], more: false, unfound: 1n });
    // (b) CARDS_MAX checks spent exactly (one of them a card passed on), a count of CARDS_MAX: the walk cannot check
    // more, so the shortfall is "more than shown", nothing counted as unlisted.
    const sixty = Array.from({ length: CARDS_MAX }, (_, i) => ({ collection: C(1), id: BigInt(i), block: FROM }));
    const spent = reader(sixty, { counts: () => BigInt(CARDS_MAX), owners: (card) => (card.id === 0n ? OTHER : ME) });
    const own = await readOwnCardsV2(spent, [C(1)], ME, FROM, TO);
    expect(own.cards).toHaveLength(CARDS_MAX - 1);
    expect(own).toMatchObject({ more: true, unfound: 0n });
    expect(spent.queries).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('SH-297 notes: a collection that lists its owner\'s cards (Enumerable) is read by index, no logs; one that refuses a count is read in the window only', async () => {
    const r = reader([{ collection: C(2), id: 5n, block: FROM - 3n * WALK_STEP }], {
      counts: (c) => (c === C(1) ? 2n : null),
      listing: (c, n) => (c === C(1) ? Array.from({ length: Number(n) }, (_, i) => 100n + BigInt(i)) : null),
    });
    const own = await readOwnCardsV2(r, [C(1), C(2)], ME, FROM, TO);
    expect(own).toEqual({ cards: [{ collection: C(1), id: 100n }, { collection: C(1), id: 101n }], more: false, unfound: 0n });
    expect(r.listed).toEqual([C(1)]);
    expect(r.queries.map((q) => q.collections)).toEqual([[C(2)]]);
    // A count or a listing that cannot be read (a node behind, a refusal): that collection is read in the window, as
    // before; the read does not fail for it.
    const flaky = reader([{ collection: C(1), id: 7n, block: FROM }], { counts: () => { throw new Error('HTTP 503'); } });
    expect(await readOwnCardsV2(flaky, [C(1)], ME, FROM, TO)).toEqual({ cards: [{ collection: C(1), id: 7n }], more: false, unfound: 0n });
    const unlisted = reader([{ collection: C(1), id: 8n, block: FROM }], { counts: () => 1n, listing: () => { throw new Error('HTTP 503'); } });
    expect((await readOwnCardsV2(unlisted, [C(1)], ME, FROM, TO)).cards).toEqual([{ collection: C(1), id: 8n }]);
    // A listing longer than CARDS_MAX: the first CARDS_MAX, the rest said.
    const big = reader([], { counts: () => BigInt(CARDS_MAX + 3), listing: (_c, n) => Array.from({ length: Number(n) }, (_, i) => BigInt(i)) });
    const shown = await readOwnCardsV2(big, [C(1)], ME, FROM, TO);
    expect(shown.cards).toHaveLength(CARDS_MAX);
    expect(shown).toMatchObject({ more: true, unfound: 0n });
  });
});
