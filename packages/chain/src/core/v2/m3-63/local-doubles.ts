/** Review-only reference for the two owner handoffs. Never imported by production. */
import type { Address } from 'viem';
import type { ItemSession } from '../../../../../../apps/web/src/features/core/v2/item-claims';

export function itemPage(ids: readonly bigint[], owners: ReadonlyMap<string, Address | null>, session: ItemSession,
  account: Address, selected: bigint | null, page = 0, limit = 12): bigint[] {
  const mine = [...new Set(ids.map(String))].map(BigInt).filter(id =>
    owners.get(String(id))?.toLowerCase() === account.toLowerCase() || session[String(id)]?.claim !== undefined);
  const pending = (id: bigint) => {
    const known = session[String(id)];
    return known?.claim !== undefined && (!known.read || known.read.block < known.claim.block);
  };
  const empty = (id: bigint) => session[String(id)]?.read?.credit.claimableP === 0n;
  const pinned = selected !== null && mine.includes(selected) ? [selected] : [];
  // Pending receipts first; empty decided claims still rotate, so future earnings remain discoverable.
  const rest = mine.filter(id => !pinned.includes(id)).sort((a, b) =>
    (pending(a) === pending(b) ? (empty(a) === empty(b) ? (a < b ? -1 : a > b ? 1 : 0) : empty(a) ? 1 : -1) : pending(a) ? -1 : 1));
  const slots = limit - pinned.length;
  return [...pinned, ...rest.slice(page * slots, (page + 1) * slots)];
}

/** Keep total liability separate from the amount the next successful claim actually pays. */
export function nextItemPayment(outside: bigint, stash: bigint, simulated: bigint): bigint {
  if (outside < 0n || stash < 0n) throw new Error('invalid credit');
  const total = outside + stash, cap = (1n << 127n) - 1n;
  const expected = total > cap ? cap : total;
  if (expected === 0n || simulated !== expected) throw new Error('unverified payment');
  return expected;
}

/** An owed seed is a separate asset, never included in a P total or redirected to the caller. */
export function seedStep(account: Address, pile: { seeder: Address; asset: Address; failed: boolean;
  seedReturnDue: bigint; seedReturnBacked: boolean | null }) {
  if (!pile.failed || !pile.seedReturnBacked || pile.seedReturnDue <= 0n || account.toLowerCase() !== pile.seeder.toLowerCase()) return null;
  return { kind: 'seed-return' as const, asset: pile.asset, amount: pile.seedReturnDue, to: pile.seeder };
}
