/**
 * Names for a launch's payees that the page can prove on chain (SH-281 step 3): "Card shop" for a shop our shop
 * factory made for this token, "Holders" for the creator's stake our stake factory made for this token. Anything that
 * fails one check stays "Paid to <address>" (a stranger's contract is never named).
 *
 * - "Card shop": our factory's `isShop(payee)` is true AND the shop's `token()` is this token.
 * - "Holders": `RailStakeFactory.stakeOf(launchCreator, token) == payee`, `isStake(payee)` is true, AND the stake's
 *   `token()` and `factory()` are this token and our stake factory (as lane m's `findStake`).
 * The factories come from the deployment file (`shops.factory`, `railStake.factory`); without one, no such name.
 */
import type { Address, PublicClient } from 'viem';
import { railStakeAbi, railStakeFactoryAbi } from '../abi/railStake';
import { shopAbi, shopFactoryAbi } from '../abi/shop';

export const PAYEE_NAME = Object.freeze({ shop: 'Card shop', holders: 'Holders' });

/** One read of a view, or undefined when it reverts or the address has no such function (a stranger's contract). */
export type ViewRead = (address: Address, fn: 'isShop' | 'shopToken' | 'stakeOf' | 'isStake' | 'stakeToken' | 'stakeFactory', args?: readonly Address[]) => Promise<unknown>;

const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** The proven names by payee (lower-case address), for the payees given. */
export async function payeeNames(
  read: ViewRead,
  f: { shops?: Address; stakes?: Address },
  launch: { token: Address; creator: Address },
  payees: readonly Address[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const safe = (p: Promise<unknown>) => p.catch(() => undefined);
  const stakeOf = f.stakes ? await safe(read(f.stakes, 'stakeOf', [launch.creator, launch.token])) : undefined;
  await Promise.all(
    payees.map(async (payee) => {
      if (f.shops) {
        const [isShop, token] = await Promise.all([safe(read(f.shops, 'isShop', [payee])), safe(read(payee, 'shopToken'))]);
        if (isShop === true && same(token, launch.token)) {
          out[payee.toLowerCase()] = PAYEE_NAME.shop;
          return;
        }
      }
      if (f.stakes && same(stakeOf, payee)) {
        const [isStake, token, factory] = await Promise.all([safe(read(f.stakes, 'isStake', [payee])), safe(read(payee, 'stakeToken')), safe(read(payee, 'stakeFactory'))]);
        if (isStake === true && same(token, launch.token) && same(factory, f.stakes)) out[payee.toLowerCase()] = PAYEE_NAME.holders;
      }
    }),
  );
  return out;
}

/** The reader on a client: each name maps to its contract's view. */
export function chainViewRead(c: PublicClient): ViewRead {
  return (address, fn, args = []) => {
    switch (fn) {
      case 'isShop':
        return c.readContract({ address, abi: shopFactoryAbi, functionName: 'isShop', args: [args[0]!] });
      case 'shopToken':
        return c.readContract({ address, abi: shopAbi, functionName: 'token' });
      case 'stakeOf':
        return c.readContract({ address, abi: railStakeFactoryAbi, functionName: 'stakeOf', args: [args[0]!, args[1]!] });
      case 'isStake':
        return c.readContract({ address, abi: railStakeFactoryAbi, functionName: 'isStake', args: [args[0]!] });
      case 'stakeToken':
        return c.readContract({ address, abi: railStakeAbi, functionName: 'token' });
      case 'stakeFactory':
        return c.readContract({ address, abi: railStakeAbi, functionName: 'factory' });
    }
  };
}
