/** M3-53's claim-state rule for items: M2's block-number rule, with an item's later credit simply claimable again. */
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { claimableItem, itemCandidates, itemPages, itemState, itemsToRead, MAX_ITEMS_READ, MAX_OWNER_SCAN, withItemClaim, withItemRead, type ItemClaimV2, type ItemSession } from './item-claims';
import type { ItemsHistory } from './m3-data';
import { A, B, H } from './test-support/m3-published';

const credit = (patch: Partial<ItemClaimV2> = {}): ItemClaimV2 => ({
  hash: H(101), id: 1n, owner: A, fundingCursor: 3n, lifecycleCursor: 4n, fundingCount: 3n, lifecycleCount: 4n, balanceP: 10n ** 30n, status: 'synced',
  outsideP: 7n, stashP: 5n, claimableP: 12n, failed: false, graduated: true, payout: 'available', ...patch,
} as ItemClaimV2);
const read = (block: bigint, patch: Partial<ItemClaimV2> = {}) => ({ block, credit: credit(patch) });
const claim = (block: bigint) => ({ tx: H(70), block, paidP: 12n });
const at = (session: ItemSession, id = 1n) => itemState(session[id.toString()], A);

describe('M3-53 item claim state', () => {
  it('reads: ready with its stash, paused, not checked, needs sync, after graduation, none', () => {
    expect(at(withItemRead({}, 1n, read(10n)))).toEqual({ kind: 'ready', amount: 12n, stash: 5n });
    expect(at(withItemRead({}, 1n, read(10n, { payout: 'unavailable' })))).toMatchObject({ kind: 'paused', amount: 12n });
    expect(at(withItemRead({}, 1n, read(10n, { payout: 'unverified' })))).toMatchObject({ kind: 'unchecked' });
    expect(at(withItemRead({}, 1n, read(10n, { status: 'sync_pending', claimableP: null, outsideP: null, stashP: null, payout: 'not_ready' })))).toEqual({ kind: 'syncing' });
    expect(at(withItemRead({}, 1n, read(10n, { graduated: false, claimableP: 0n, payout: 'not_owner_claimable' })))).toEqual({ kind: 'waiting' });
    expect(at(withItemRead({}, 1n, read(10n, { claimableP: 0n, payout: 'empty' })))).toEqual({ kind: 'none' });
    expect(at({})).toEqual({ kind: 'unknown' });
  });
  it('only the current owner sees an item; a transfer moves it to the new owner', () => {
    const session = withItemRead({}, 1n, read(10n, { owner: B }));
    expect(itemState(session['1'], A)).toEqual({ kind: 'other' });
    expect(itemState(session['1'], B)).toMatchObject({ kind: 'ready' });
  });
  it('a mined claim shows Claimed with no Claim button until a read at its block or later', () => {
    let session = withItemClaim(withItemRead({}, 1n, read(10n)), 1n, claim(20n));
    expect(at(session)).toEqual({ kind: 'claimed', amount: 12n, checked: false });
    expect(claimableItem(at(session))).toBeNull();
    // An older read, arriving late, decides nothing.
    session = withItemRead(session, 1n, read(19n));
    expect(at(session)).toMatchObject({ kind: 'claimed', checked: false });
  });
  it('a read at or after the receipt decides: credit gone keeps Claimed; any credit is simply claimable again', () => {
    const claimed = withItemClaim({}, 1n, claim(20n));
    expect(at(withItemRead(claimed, 1n, read(20n, { claimableP: 0n, outsideP: 0n, stashP: 0n, payout: 'empty' })))).toEqual({ kind: 'claimed', amount: 12n, checked: true });
    const again = withItemRead(claimed, 1n, read(21n, { claimableP: 3n, outsideP: 3n, stashP: 0n }));
    expect(at(again)).toEqual({ kind: 'ready', amount: 3n, stash: 0n });
    expect(claimableItem(at(again))).toBe(3n);
  });
  it('keeps the newest read: a stale read never replaces a newer one', () => {
    const newer = withItemRead({}, 1n, read(30n, { claimableP: 0n, payout: 'empty' }));
    expect(withItemRead(newer, 1n, read(29n))).toBe(newer);
    expect(at(withItemRead(newer, 1n, read(30n)))).toMatchObject({ kind: 'ready' });
  });
});

describe('M3-53 which items to read', () => {
  const history = (ids: readonly [bigint, boolean][]): ItemsHistory => ({ policies: { buyers: 1, sellers: 2 }, outsideIndex: 0n, paidPerItem: 0n, fundedP: 0n, retainedBurnP: 0n, flushedP: 0n,
    fundingCursor: 0n, lifecycleCursor: 0n, known: ids.map(([id, inside], i) => ({ id, inside, sequence: BigInt(ids.length - i) })), openDraws: 0, noticesFailed: 0n });
  it('items out of the vault, newest movement first, plus every claimed item and one typed id; never an item in the vault', () => {
    const session = withItemClaim({}, 9n, claim(5n));
    // Priority order (M363-OC01): the typed item, the receipt waiting for its read, then the newest movements.
    expect(itemCandidates(history([[3n, true], [2n, false], [1n, false]]), session, 7n)).toEqual([7n, 9n, 2n, 1n]);
    // The cap keeps the typed and claimed items, then the newest movements.
    const crowded = history(Array.from({ length: 80 }, (_, i) => [BigInt(80 - i), false] as [bigint, boolean]));
    const capped = itemCandidates(crowded, withItemClaim({}, 1n, claim(5n)), 2n);
    expect(capped).toContain(1n); expect(capped).toContain(2n); expect(capped).toContain(80n); expect(capped).not.toContain(3n);
    expect(itemCandidates(null, {}, null)).toEqual([]);
  });
  it(`scans at most ${MAX_OWNER_SCAN} owners and reads at most ${MAX_ITEMS_READ} of this wallet's items in full`, () => {
    const many = history(Array.from({ length: 100 }, (_, i) => [BigInt(i + 1), false] as [bigint, boolean]));
    const candidates = itemCandidates(many, {}, null);
    expect(candidates).toHaveLength(MAX_OWNER_SCAN);
    const owners = new Map<string, Address | null>(candidates.map((id) => [id.toString(), id % 2n === 0n ? A : B]));
    const mine = itemsToRead(candidates, owners, {}, A);
    expect(mine).toHaveLength(MAX_ITEMS_READ);
    expect(mine.every((id) => id % 2n === 0n)).toBe(true);
    expect([...mine].sort((a, b) => (a < b ? -1 : 1))).toEqual(mine);
  });
  it('keeps a claimed item in the reads even after it moved, so its deciding read still comes', () => {
    const owners = new Map<string, Address | null>([['1', B], ['2', null]]);
    expect(itemsToRead([1n, 2n], owners, withItemClaim({}, 1n, claim(5n)), A)).toEqual([1n]);
  });
});

describe('M363-OC01: every owned item has a reachable deciding read', () => {
  /** `count` items out of the vault, newest movement first (the highest id moved last), optionally with the indexer's owners. */
  const outside = (count: number, owners?: (id: bigint) => Address | null): ItemsHistory => ({ policies: { buyers: 1, sellers: 0 }, outsideIndex: 1n, paidPerItem: 1n, fundedP: 1n, retainedBurnP: 0n,
    flushedP: 0n, fundingCursor: 1n, lifecycleCursor: 1n, openDraws: 0, noticesFailed: 0n,
    known: Array.from({ length: count }, (_, i) => ({ id: BigInt(count - i), inside: false, sequence: BigInt(count - i) })),
    ...(owners ? { owners: Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i + 1), owners(BigInt(i + 1))])) } : {}) });
  const mineAll = (ids: readonly bigint[]) => new Map<string, Address | null>(ids.map((id) => [id.toString(), A]));
  /** What one page reads in full, as the item reads do: owners of the candidates, then this wallet's, up to the bound. */
  const page = (history: ItemsHistory, session: ItemSession, extra: bigint | null, at: number, account: Address | null = null) => {
    const candidates = itemCandidates(history, session, extra, at, account);
    return itemsToRead(candidates, mineAll(candidates), session, A);
  };
  const emptyRead = (block: bigint) => read(block, { claimableP: 0n, outsideP: 0n, stashP: 0n, payout: 'empty' });

  it('the reviewer’s three cases: a typed item, a pending receipt and twelve decided claims never crowd out the thirteenth item', () => {
    expect(page(outside(13), {}, 1n, 0)).toContain(1n);
    const pending: ItemSession = { '1': { claim: claim(101n) } };
    expect(page(outside(13), pending, null, 0)).toContain(1n);
    const decided: ItemSession = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 2), { claim: claim(100n), read: emptyRead(101n) }]));
    expect(page(outside(13), decided, null, 0)).toContain(1n);
    for (const session of [{}, pending, decided]) expect(page(outside(13), session, null, 0).length).toBeLessThanOrEqual(MAX_ITEMS_READ);
  });

  it('with the indexer’s owners: only this wallet’s items, every one on some page, twelve per page, typed and pending on every page', () => {
    const history = outside(40, (id) => (id <= 26n ? A : B));
    const session: ItemSession = { '25': { claim: claim(101n) } };
    const pages = itemPages(history, session, 26n, A);
    expect(pages).toBe(3);
    const read = Array.from({ length: pages }, (_, at) => itemCandidates(history, session, 26n, at, A));
    for (const ids of read) { expect(ids.length).toBeLessThanOrEqual(MAX_ITEMS_READ); expect(ids).toContain(26n); expect(ids).toContain(25n); }
    expect(new Set(read.flat().map(String))).toEqual(new Set(Array.from({ length: 26 }, (_, i) => String(i + 1))));
    // Another wallet's items are never asked for; pages wrap around.
    expect(read.flat().some((id) => id > 26n)).toBe(false);
    expect(itemCandidates(history, session, 26n, pages, A)).toEqual(read[0]);
  });

  it('without the owner list: every item recorded outside the vault on some page, at most 64 owner reads a page', () => {
    const history = outside(80);
    expect(itemPages(history, {}, null)).toBe(2);
    const read = [0, 1].map((at) => itemCandidates(history, {}, null, at));
    expect(read.map((ids) => ids.length)).toEqual([MAX_OWNER_SCAN, 80 - MAX_OWNER_SCAN]);
    expect(new Set(read.flat().map(String)).size).toBe(80);
  });

  it('a decided claim rotates to the end: completing a page brings the next items in, and it is still read again for new earnings', () => {
    const history = outside(13, () => A);
    const session: ItemSession = { '13': { claim: claim(100n), read: emptyRead(101n) } };
    expect(itemCandidates(history, session, null, 0, A)).not.toContain(13n);
    expect(itemCandidates(history, session, null, 1, A)).toEqual([13n]);
    // A receipt still waiting for its read is reserved on every page instead.
    const waiting: ItemSession = { '13': { claim: claim(102n), read: emptyRead(101n) } };
    expect(itemPages(history, waiting, null, A)).toBe(2);
    for (const at of [0, 1]) expect(itemCandidates(history, waiting, null, at, A)).toContain(13n);
  });

  it('more pending receipts than one page: they page fairly, the typed item on every page', () => {
    const session: ItemSession = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [String(i + 1), { claim: claim(100n) }]));
    expect(itemPages(outside(20), session, 20n)).toBe(2);
    const read = [0, 1].map((at) => itemCandidates(outside(20), session, 20n, at));
    for (const ids of read) { expect(ids[0]).toBe(20n); expect(ids.length).toBeLessThanOrEqual(MAX_ITEMS_READ); }
    expect(new Set(read.flat().map(String))).toEqual(new Set([...Array.from({ length: 15 }, (_, i) => String(i + 1)), '20']));
  });
});
