import { describe, expect, it } from 'vitest';
import { itemCandidates, itemsToRead, MAX_ITEMS_READ, type ItemSession } from '../../../../../../apps/web/src/features/core/v2/item-claims';
import type { ItemsHistory } from '../../../../../../apps/web/src/features/core/v2/m3-data';
import { A, H } from '../../../../../indexer/src/core/v2/m3-fixture.test-support';

export function history(count = MAX_ITEMS_READ + 1): ItemsHistory {
  return { policies: { buyers: 1, sellers: 0 }, outsideIndex: 1n, paidPerItem: 1n, fundedP: BigInt(count),
    retainedBurnP: 0n, flushedP: 0n, fundingCursor: 1n, lifecycleCursor: BigInt(count), openDraws: 0, noticesFailed: 0n,
    known: Array.from({ length: count }, (_, i) => ({ id: BigInt(i + 1), inside: false, sequence: BigInt(i + 1) })).reverse() };
}
export const owners = (ids: readonly bigint[]) => new Map(ids.map(id => [String(id), A]));

describe('M363-OC01: every owned item has a reachable deciding read (ordinary open regressions)', () => {
  it('the item explicitly selected in Details survives the full-credit cap', () => {
    const selected = BigInt(MAX_ITEMS_READ + 1);
    const candidates = itemCandidates(history(), {}, selected);
    const read = itemsToRead(candidates, owners(candidates), {}, A);
    expect(read.length).toBeLessThanOrEqual(MAX_ITEMS_READ);
    expect(read).toContain(selected);
  });

  it('an item with a pending mined receipt gets its deciding read ahead of unrelated owned items', () => {
    const id = BigInt(MAX_ITEMS_READ + 1);
    const session: ItemSession = { [String(id)]: { claim: { tx: H(9), block: 101n, paidP: 1n } } };
    const candidates = itemCandidates(history(), session, null);
    expect(itemsToRead(candidates, owners(candidates), session, A)).toContain(id);
  });

  it('decided empty claims free capacity so Claim all can reach the thirteenth item', () => {
    const session: ItemSession = Object.fromEntries(Array.from({ length: MAX_ITEMS_READ }, (_, i) => {
      const id = BigInt(i + 1);
      return [String(id), { claim: { tx: H(i + 1), block: 100n, paidP: 1n }, read: { block: 101n, credit: {
        hash: H(101), id, owner: A, fundingCursor: 1n, lifecycleCursor: 13n, fundingCount: 1n, lifecycleCount: 13n,
        balanceP: 1n, status: 'synced', outsideP: 0n, stashP: 0n, claimableP: 0n, failed: false, graduated: true, payout: 'empty',
      } } }];
    }));
    const candidates = itemCandidates(history(), session, null);
    expect(itemsToRead(candidates, owners(candidates), session, A)).toContain(13n);
  });
});
