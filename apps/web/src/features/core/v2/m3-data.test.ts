/** M3-53: the published M3-52 history and same-hash money as the page reads them; bigint only, no float. */
import { describe, expect, it } from 'vitest';
import { parseSnapshotV2 } from './indexer-v2';
import { parseM3, perCoin, quoteOf } from './m3-data';
import { A, ETH, KEEP_BASE, LIVE_INDEX, H, publishedItems, publishedPile } from './test-support/m3-published';
import { required } from './test-support/required';

describe('M3-53 items history', () => {
  it('reads both in-vault rules, the per-item figure (live index plus the Keep base) and the items that left the vault', async () => {
    const { body, source } = await publishedItems();
    const view = parseSnapshotV2(body, source);
    const items = required(view.m3?.items);
    expect(view.choices).toEqual({ buyers: 'items', sellers: 'items' });
    expect(items.policies).toEqual({ buyers: 1, sellers: 2 });
    expect(items.paidPerItem).toBe(LIVE_INDEX + KEEP_BASE / 4n);
    expect(items.known.map((k) => [k.id, k.inside])).toEqual([[3n, true], [2n, false], [1n, false]]);
    expect(items.openDraws).toBe(1);
    expect(view.m3?.itemBalanceP).toBe(KEEP_BASE + ETH + ETH / 2n);
    expect(view.claimRow?.contracts.itemLedger).toBeTruthy();
  });
  it('reads the indexer’s current owners when published (M3-52b); older publications have none', async () => {
    const { body, source } = await publishedItems();
    const m3 = body.m3 as { items: Record<string, unknown> };
    const withOwners = { ...m3, items: { ...m3.items, owners: { '1': A.toLowerCase(), '2': null } } };
    expect(parseM3(withOwners, null, body.asOf.hash, { boxType: 1, n: 4 }).items?.owners).toEqual({ '1': A, '2': null });
    expect(parseSnapshotV2(body, source).m3?.items?.owners).toBeUndefined();
    expect(() => parseM3({ ...m3, items: { ...m3.items, owners: { x: A } } }, null, body.asOf.hash, { boxType: 1, n: 4 })).toThrow();
  });
  it('a Burn side adds no base stash; only a Keep side does', async () => {
    const { body } = await publishedItems();
    const m3 = body.m3 as { items: { policies: { buyers: number } } };
    const burnBoth = { ...m3, items: { ...m3.items, policies: { buyers: 2, sellers: 2 } } };
    expect(parseM3(burnBoth, null, body.asOf.hash, { boxType: 1, n: 4 }).items?.paidPerItem).toBe(LIVE_INDEX);
  });
  it('refuses money from another block, a non-decimal amount and funding above its source', async () => {
    const { body } = await publishedItems();
    const m3 = body.m3 as { items: Record<string, unknown> & { funding: Record<string, Record<string, unknown>> } };
    expect(() => parseM3(m3, { hash: H(9), itemBalanceP: '1', pile: null }, body.asOf.hash, { boxType: 1, n: 4 })).toThrow(/different block/);
    expect(() => parseM3({ ...m3, items: { ...m3.items, outsideIndex: 1.5 } }, null, body.asOf.hash, { boxType: 1, n: 4 })).toThrow();
    expect(() => parseM3({ ...m3, items: { ...m3.items, funding: { '1': { ...m3.items.funding['1'], ledgerP: `${KEEP_BASE + 1n}` } } } }, null, body.asOf.hash, { boxType: 1, n: 4 })).toThrow(/exceeds/);
  });
});

describe('M3-53 pile history and custody', () => {
  it('keeps the commitment, the received seed and the live balance apart', async () => {
    const { body, source, seed } = await publishedPile({ loaded: false, graduated: false });
    const view = parseSnapshotV2(body, source);
    expect(view.spec.boxType).toBe(5);
    expect(view.m3?.pile).toMatchObject({ seedAmount: seed, seedLoaded: false, loadedAmount: 0n });
    expect(view.m3?.pileMoney).toMatchObject({ seedAmount: seed, seedReceived: false, redemptionOpen: false });
  });
  it('refuses pile reads that disagree with the commitment', async () => {
    const { body } = await publishedPile();
    const money = (body.money as { m3: { pile: Record<string, unknown> } }).m3;
    expect(() => parseM3(body.m3, { ...money, pile: { ...money.pile, seedAmount: '1' } }, body.asOf.hash, { boxType: 5, n: 0 })).toThrow(/commitment/);
  });
  it.each([[6, 1_000_000_000n], [8, 100_000_000_000n], [18, 1000n * ETH]])('per coin and the redemption quote are exact floor divisions at %i decimals', (_decimals, balance) => {
    const supply = 3n * ETH;
    expect(perCoin({ balance, supply })).toBe((balance * ETH) / supply);
    expect(quoteOf({ balance, supply }, ETH)).toBe(balance / 3n);
    expect(quoteOf({ balance, supply }, 1n)).toBe((balance * 1n) / supply);
    expect(quoteOf({ balance, supply }, supply + 1n)).toBeNull();
  });
  it('a zero-supply read has no balance, so no per-coin figure and no quote', () => {
    expect(perCoin({ balance: null, supply: 0n })).toBeNull();
    expect(quoteOf({ balance: null, supply: 0n }, 1n)).toBeNull();
    expect(quoteOf({ balance: 2n ** 200n, supply: 2n ** 100n }, 2n ** 99n)).toBe(2n ** 199n);
  });
});
