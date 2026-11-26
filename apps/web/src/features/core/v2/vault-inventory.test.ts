/**
 * SH-235 part 2: the page reads the vault inventory the server publishes for every box with a collection vault
 * (`vaultItems`, part 1), apart from M3. The card comes from the indexer's own publication (the part 1 fixture: a burn/burn
 * box of 500 items from id 1, items 1-3 taken out, 2 put back, 1 passed on to a second wallet); the lists are the pure
 * candidate functions the Items card pages through.
 */
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { publishedVaultInventory } from '../../../../../../packages/indexer/src/core/v2/vault-inventory-fixture.test-support';
import { parseSnapshotV2, type V2Source } from './indexer-v2';
import { parseVaultItems } from './m3-data';
import { A, B, publishedItems } from './test-support/m3-published';
import { required } from './test-support/required';
import { VAULT_PAGE, insideCandidates, inventoryOf, mineCandidates, pendingMoves, vaultRolesOf, type VaultInventory, type VaultMoveV2 } from './vault-items';

const C = '0x3333333333333333333333333333333333333333' as Address;

async function burnBurn() {
  const { view, manifest } = await publishedVaultInventory();
  const source: V2Source = { network: 'local', origin: 'https://indexer.invalid', rpc: 'http://127.0.0.1:8599', manifest };
  return { body: view as unknown as Record<string, unknown>, source };
}
const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => BigInt(from + i));
/** An inventory with these ids outside (newest first, in the order given), each owned as `owners` says (default A). */
const outside = (out: readonly bigint[], owners: Readonly<Record<string, Address | null>> = {}): VaultInventory => ({
  known: out.map((id, i) => ({ id, inside: false, sequence: BigInt(1000 - i) })),
  owners: Object.fromEntries(out.map((id) => [id.toString(), owners[id.toString()] === undefined ? A : owners[id.toString()] ?? null])),
});
const roles500 = { vault: A, collection: B, tickets: null, firstId: 1n, n: 500 };

describe('SH-235 the feed parses the vault inventory apart from M3', () => {
  it('rejects duplicate, contradictory, out-of-range, oversized and unlisted-owner records as a whole', async () => {
    const { body, source } = await burnBurn();
    const entry = (id: string, inside = false) => ({ id, inside, sequence: '1' });
    const invalid = [
      { known: [entry('1'), entry('1')], owners: { '1': A } },
      { known: [entry('1', true), entry('1')], owners: {} },
      { known: [entry('0')], owners: {} }, { known: [entry('501')], owners: {} },
      { known: Array.from({ length: 501 }, () => entry('1')), owners: {} },
      { known: [], owners: { '1': A } }, { known: [entry('1', true)], owners: { '1': A } },
      { known: [entry('1')], owners: {} },
    ];
    const good = parseSnapshotV2(body, source);
    for (const bad of invalid) {
      const cards = [{ ...body, vaultItems: { firstId: '1', n: '500', ...bad } }, body].map((card) => parseSnapshotV2(card, source));
      expect(cards[0]?.vaultItems).toBeUndefined();
      expect(cards[1]).toEqual(good);
      expect(insideCandidates(roles500, inventoryOf(required(cards[0])), 0).ids).toEqual(ids(1, 12));
    }
  });
  it('a card with vaultItems and no m3 parses: the record, in the items history’s shapes', async () => {
    const { body, source } = await burnBurn();
    expect(body.m3).toBeUndefined();
    const view = parseSnapshotV2(body, source);
    expect(view.m3).toBeUndefined();
    expect(view.choices).toEqual({ buyers: 'burn', sellers: 'burn' });
    const inventory = required(view.vaultItems);
    expect(inventory.firstId).toBe(1n); expect(inventory.n).toBe(500n);
    // Newest movement first: 2 came back (block 103), 1 and 3 left before; 1 was passed on to the second wallet.
    expect(inventory.known.map((k) => [k.id, k.inside])).toEqual([[2n, true], [3n, false], [1n, false]]);
    expect(inventory.known.every((k) => typeof k.sequence === 'bigint')).toBe(true);
    expect(inventory.owners).toEqual({ '1': B, '3': A });
    expect(inventoryOf(view)).toBe(inventory);
  });
  it('a card without the field parses as before: no inventory, the card keeps today’s behaviour', async () => {
    const { body, source } = await burnBurn();
    const older = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'vaultItems'));
    const view = parseSnapshotV2(older, source);
    expect(view.vaultItems).toBeUndefined();
    expect(inventoryOf(view)).toBeNull();
    expect(parseSnapshotV2(body, source)).toEqual({ ...view, vaultItems: parseSnapshotV2(body, source).vaultItems });
  });
  it('an empty record (nothing ever moved) is an inventory: every item inside, none outside', async () => {
    const { body, source } = await burnBurn();
    const view = parseSnapshotV2({ ...body, vaultItems: { firstId: '1', n: '500', known: [], owners: {} } }, source);
    expect(view.vaultItems).toEqual({ firstId: 1n, n: 500n, known: [], owners: {} });
    expect(inventoryOf(view)).not.toBeNull();
  });
  it('a malformed record, or one for another range, is not used, and never refuses the box', async () => {
    const { body, source } = await burnBurn();
    for (const bad of [
      { firstId: '1', n: '499', known: [], owners: {} },
      { firstId: '2', n: '500', known: [], owners: {} },
      { firstId: '1', n: '500', known: [{ id: 1, inside: false, sequence: '1' }], owners: {} },
      { firstId: '1', n: '500', known: {}, owners: {} },
      { firstId: '1', n: '500', known: [], owners: { '1': 'not an address' } },
      null,
    ]) {
      const view = parseSnapshotV2({ ...body, vaultItems: bad }, source);
      expect(view.vaultItems).toBeUndefined();
    }
    expect(parseVaultItems({ firstId: '1', n: '500', known: [], owners: {} }, { firstId: 1n, n: 500 })).not.toBeNull();
  });
  it('a box with an items side still uses its items history, even beside an inventory', async () => {
    const { body, source } = await publishedItems({ known: { '1': { inside: false, sequence: 2n } } });
    const view = parseSnapshotV2({ ...body, vaultItems: { firstId: '1', n: '4', known: [{ id: '4', inside: false, sequence: '9' }], owners: { '4': B } } }, source);
    expect(view.m3?.items).not.toBeNull();
    expect(view.vaultItems?.known.map((k) => k.id)).toEqual([4n]);
    expect(inventoryOf(view)).toBe(view.m3?.items);
    expect(required(inventoryOf(view)).known.map((k) => k.id)).toEqual([1n]);
  });
});

describe('SH-235 the lists from the inventory', () => {
  it.each([500, 10_000].flatMap((n) => [0, 11, 12, 13, 487].map((k) => [n, k] as const)))('pages every id exactly once: N=%s, outside=%s', (n, k) => {
    const record = outside(ids(1, k));
    const roles = { ...roles500, n };
    const pages = Math.max(1, Math.ceil((n - k) / 12));
    const all = Array.from({ length: pages }, (_, page) => insideCandidates(roles, record, page));
    expect(all.every((page) => page.pages === pages)).toBe(true);
    expect(all.flatMap((page) => page.ids)).toEqual(ids(k + 1, n));
    const mine = mineCandidates(record, A);
    expect(Array.from({ length: Math.ceil(k / 12) }, (_, p) => mine.slice(p * 12, (p + 1) * 12)).flat()).toEqual(ids(1, k));
  });
  it('clamps a shrinking shelf before choosing candidates, also for draws', () => {
    const record = outside(ids(1, 487));
    const move = [{ id: 500n, inside: false, account: A, block: 60n }];
    expect(insideCandidates(roles500, record, 1, 12, move)).toEqual({ ids: ids(488, 499), pages: 1 });
    const drawn = { known: ids(488, 500).map((id) => ({ id, inside: true, sequence: id })), owners: {} };
    expect(insideCandidates({ ...roles500, tickets: C }, drawn, 1, 12, move)).toEqual({ ids: ids(488, 499), pages: 1 });
  });
  it('no-history shelf refills after the first twelve leave: 500 items, 1-12 out, page one is 13-24', async () => {
    const { body, source } = await burnBurn();
    const view = parseSnapshotV2({ ...body, vaultItems: { firstId: '1', n: '500', known: ids(1, 12).map((id, i) => ({ id: String(id), inside: false, sequence: String(100 - i) })),
      owners: Object.fromEntries(ids(1, 12).map((id) => [String(id), A])) } }, source);
    const roles = required(vaultRolesOf(view));
    const page0 = insideCandidates(roles, inventoryOf(view), 0);
    expect(page0.ids).toEqual(ids(13, 24));
    expect(page0.pages).toBe(Math.ceil(488 / VAULT_PAGE));
    // Later pages have no holes either.
    expect(insideCandidates(roles, inventoryOf(view), 1).ids).toEqual(ids(25, 36));
    expect(insideCandidates(roles, inventoryOf(view), page0.pages - 1).ids).toEqual(ids(493, 500));
    // Before SH-235 the card had no record here: page one stayed 1-12, each read off the shelf on chain.
    expect(insideCandidates(roles, null, 0).ids).toEqual(ids(1, 12));
  });
  it('a fresh page load finds every owned item: no session memory, only the record', async () => {
    const { body, source } = await burnBurn();
    const view = parseSnapshotV2(body, source);
    expect(mineCandidates(inventoryOf(view), A)).toEqual([3n]);
    expect(mineCandidates(inventoryOf(view), A, [])).toEqual([3n]);
  });
  it('an item received by transfer shows in Yours: item 1 is the second wallet’s, not the taker’s', async () => {
    const { body, source } = await burnBurn();
    const view = parseSnapshotV2(body, source);
    expect(mineCandidates(inventoryOf(view), B)).toEqual([1n]);
    expect(mineCandidates(inventoryOf(view), A)).not.toContain(1n);
    // The item put back (2) is no one's and is on the shelf list again.
    expect(insideCandidates(required(vaultRolesOf(view)), inventoryOf(view), 0).ids).toEqual([2n, ...ids(4, 14)]);
  });
  it('a lagging record never shows an item in both lists: this visit’s moves lie over it until the feed reaches them', () => {
    // The feed is at block 50; this visit took 13 out at block 60 and put 5 back at block 61 (5 was A's in the record).
    const record = outside(ids(1, 12));
    const moves: VaultMoveV2[] = [{ id: 5n, inside: true, account: A, block: 61n }, { id: 13n, inside: false, account: A, block: 60n }];
    const pending = pendingMoves(moves, record, 50n);
    expect(pending).toEqual(moves);
    const shelf = insideCandidates(roles500, record, 0, VAULT_PAGE, pending).ids;
    const mine = mineCandidates(record, A, pending);
    expect(shelf).toEqual([5n, ...ids(14, 24)]);
    expect(mine).toEqual([13n, ...ids(1, 12).filter((id) => id !== 5n)]);
    expect(shelf.filter((id) => mine.includes(id))).toEqual([]);
    // Once the feed has reached a receipt's block its move is dropped: the record says it now.
    expect(pendingMoves(moves, record, 60n)).toEqual([moves[0]]);
    expect(pendingMoves(moves, record, 61n)).toEqual([]);
    // Without any record (an older server) nothing ever catches up: every move of this visit stays, as before.
    expect(pendingMoves(moves, null, 1_000n)).toEqual(moves);
  });
  it('another wallet’s take in this browser is not mine, and leaves the shelf all the same', () => {
    const moves: VaultMoveV2[] = [{ id: 7n, inside: false, account: C, block: 60n }];
    expect(mineCandidates(outside([]), A, moves)).toEqual([]);
    expect(mineCandidates(outside([]), C, moves)).toEqual([7n]);
    expect(insideCandidates(roles500, outside([]), 0, VAULT_PAGE, moves).ids).not.toContain(7n);
  });
  it('Yours is never cut at 24: forty owned items are all candidates (the card pages them twelve at a time)', () => {
    const many = outside(ids(1, 40));
    expect(mineCandidates(many, A)).toHaveLength(40);
    expect(mineCandidates(outside(ids(1, 40), { '3': B, '4': null }), A)).toHaveLength(38);
  });
  it('with the draw add-on the moves lie over the shelf of items that came back', () => {
    const drawn = { ...roles500, tickets: C };
    const record: VaultInventory = { known: [{ id: 9n, inside: true, sequence: 3n }, { id: 4n, inside: true, sequence: 2n }], owners: {} };
    expect(insideCandidates(drawn, record, 0).ids).toEqual([4n, 9n]);
    expect(insideCandidates(drawn, record, 0, VAULT_PAGE, [{ id: 9n, inside: false, account: A, block: 9n }, { id: 11n, inside: true, account: A, block: 8n }]).ids).toEqual([4n, 11n]);
  });
});
