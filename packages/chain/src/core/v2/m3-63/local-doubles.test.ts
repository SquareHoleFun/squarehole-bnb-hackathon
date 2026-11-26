import { expect, it } from 'vitest';
import { itemPage, nextItemPayment, seedStep } from './local-doubles';
import { A, B, H } from '../../../../../indexer/src/core/v2/m3-fixture.test-support';
import type { ItemSession } from '../../../../../../apps/web/src/features/core/v2/item-claims';

it('M363-OC01 double: selected and pending items keep priority and every item has a bounded page', () => {
  const ids = Array.from({ length: 26 }, (_, i) => BigInt(i + 1)), owners = new Map(ids.map(id => [String(id), A]));
  const session: ItemSession = { '25': { claim: { tx: H(9), block: 101n, paidP: 1n } } };
  const pages = [0, 1, 2].map(page => itemPage(ids, owners, session, A, 26n, page));
  expect(pages[0]).toContain(26n); expect(pages[0]).toContain(25n);
  expect(pages.every(page => page.length <= 12)).toBe(true);
  expect(new Set(pages.flat())).toEqual(new Set(ids));
});

it('M363-OC02 double: capped payments conserve remaining credit down to a one-unit tail, with no tip or minimum', () => {
  const cap = (1n << 127n) - 1n;
  let remaining = cap * 3n + 1n, paid = 0n;
  for (const payment of [cap, cap, cap, 1n]) {
    expect(nextItemPayment(remaining, 0n, payment)).toBe(payment);
    remaining -= payment; paid += payment;
    expect(paid + remaining).toBe(cap * 3n + 1n);
  }
  expect(remaining).toBe(0n);
  for (const amount of [0n, cap - 1n, cap + 1n]) expect(() => nextItemPayment(cap, 7n, amount)).toThrow();
  expect(nextItemPayment(1n, 3n, 4n)).toBe(4n);
});

it('M363-OC03 double: Claim all adds only a backed seed owed to this wallet, as a distinct asset', () => {
  const pile = { seeder: A, asset: B, failed: true, seedReturnDue: 2n ** 100n + 1n, seedReturnBacked: true };
  expect(seedStep(A, pile)).toEqual({ kind: 'seed-return', asset: B, amount: pile.seedReturnDue, to: A });
  expect(seedStep(B, pile)).toBeNull();
  for (const patch of [{ failed: false }, { seedReturnBacked: false }, { seedReturnBacked: null }, { seedReturnDue: 0n }]) {
    expect(seedStep(A, { ...pile, ...patch })).toBeNull();
  }
});
