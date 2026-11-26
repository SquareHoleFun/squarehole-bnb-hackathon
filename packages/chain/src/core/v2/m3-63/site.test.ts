import { describe, expect, it } from 'vitest';
import { A, B, H } from '../../../../../indexer/src/core/v2/m3-fixture.test-support';
import { itemState, claimableItem, withItemClaim, withItemRead, type ItemClaimV2 } from '../../../../../../apps/web/src/features/core/v2/item-claims';
import { boxSteps, claimList, claimCount, listSignature, stepP } from '../../../../../../apps/web/src/features/core/v2/claim-all';
import { claimInOrder } from '../../../../../../apps/web/src/features/core/v2/holder-claims';
import { parseM3, perCoin, quoteOf } from '../../../../../../apps/web/src/features/core/v2/m3-data';
import { publishedItems, publishedPile } from '../../../../../../apps/web/src/features/core/v2/test-support/m3-published';

const amount = (1n << 100n) + 3n;
const credit: ItemClaimV2 = { hash: H(101), id: 1n, owner: A, fundingCursor: 2n, lifecycleCursor: 3n, fundingCount: 2n,
  lifecycleCount: 3n, balanceP: amount, status: 'synced', outsideP: amount - 7n, stashP: 7n, claimableP: amount,
  failed: false, graduated: true, payout: 'available' };

describe('M363-SITE: claims, states and serialized money agree with canonical reads', () => {
  it('only current owners see ready payouts; failed reads cannot erase a mined claim; later credit returns', () => {
    let s = withItemRead({}, 1n, { block: 90n, credit });
    expect(itemState(s['1'], B).kind).toBe('other');
    expect(claimableItem(itemState(s['1'], A))).toBe(amount);
    s = withItemClaim(s, 1n, { block: 100n, tx: H(77), paidP: amount });
    expect(itemState(s['1'], A)).toMatchObject({ kind: 'claimed', checked: false });
    s = withItemRead(s, 1n, { block: 101n, credit: { ...credit, outsideP: 0n, stashP: 0n, claimableP: 0n, payout: 'empty' } });
    expect(itemState(s['1'], A)).toMatchObject({ kind: 'claimed', checked: true });
    expect(withItemRead(s, 1n, { block: 99n, credit })).toBe(s);
    s = withItemRead(s, 1n, { block: 102n, credit: { ...credit, claimableP: 1n, outsideP: 1n, stashP: 0n } });
    expect(claimableItem(itemState(s['1'], A))).toBe(1n);
  });
  it.each([
    [{ status: 'sync_pending', claimableP: null }, 'syncing'], [{ payout: 'unavailable' }, 'paused'],
    [{ payout: 'unverified' }, 'unchecked'], [{ graduated: false, claimableP: 0n }, 'waiting'],
  ] as const)('unready state %s is never a Claim button', (patch, kind) => {
    const state = itemState({ read: { block: 101n, credit: { ...credit, ...patch } } }, A);
    expect(state.kind).toBe(kind); expect(claimableItem(state)).toBeNull();
  });
  it('F128 includes every implemented claim kind in deterministic order without summing unlike assets', async () => {
    const steps = boxSteps({ holder: [{ batch: 3n, amount }, { batch: 1n, amount: 1n }], items: [{ id: 2n, amount }, { id: 1n, amount: 3n }],
      creator: { kind: 'ready', read: { block: 1n, amount: 1n } }, remainder: { kind: 'ready', read: { block: 1n, amount: 2n } },
      handIn: { kind: 'ready', read: { block: 1n, amount: 4n, pOut: 5n, approved: 3n } } });
    expect(steps.map(s => s.kind)).toEqual(['holder', 'holder', 'item', 'item', 'creator', 'remainder', 'approve', 'hand-in']);
    expect(claimCount(steps)).toBe(7); expect(steps.map(stepP)).toEqual([1n, amount, 3n, amount, 1n, 2n, 0n, 5n]);
    const list = claimList([{ key: 'P', box: 'one', steps }, { key: 'Q', box: 'two', steps }]);
    expect(list).toHaveLength(16); expect(list.slice(8).every(e => e.key === 'Q')).toBe(true);
    expect(listSignature(list)).not.toBe(listSignature(list.slice(1)));
    const sent: string[] = []; let finish: () => void = () => undefined;
    const mined = new Promise<void>(resolve => { finish = resolve; });
    const run = claimInOrder(list, async entry => { sent.push(entry.step.kind); if (sent.length === 1) await mined; else throw new Error('rejected'); });
    expect(sent).toEqual(['holder']); finish();
    expect(await run).toMatchObject({ done: 1, stoppedAt: list[1] }); expect(sent).toHaveLength(2);
  });
  it('item history and pile money parse decimal strings exactly and reject numeric or wrong-hash money', async () => {
    const items = await publishedItems();
    const input = { ...items.body.m3, items: { ...items.body.m3.items, fundedP: String(amount) } };
    expect(parseM3(input, items.body.money.m3, items.body.asOf.hash, items.row.spec).items?.fundedP).toBe(amount);
    expect(() => parseM3({ ...input, items: { ...input.items, fundedP: 123 } }, items.body.money.m3, items.body.asOf.hash, items.row.spec)).toThrow();
    expect(() => parseM3(input, items.body.money.m3, H(999), items.row.spec)).toThrow();
    const pile = await publishedPile({ balance: amount, supply: 11n });
    const m = parseM3(pile.body.m3, pile.body.money.m3, pile.body.asOf.hash, pile.row.spec).pileMoney;
    if (!m) throw new Error('missing pile');
    expect(perCoin(m)).toBe(amount * 10n ** 18n / 11n); expect(quoteOf(m, 3n)).toBe(amount * 3n / 11n);
    expect(quoteOf({ ...m, balance: null }, 3n)).toBeNull(); expect(quoteOf(m, 12n)).toBeNull();
  });
});
