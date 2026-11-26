import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { payeeNames, PAYEE_NAME, type ViewRead } from '../src/lib/payee-names';

// SH-281 step 3: a payee is named "Card shop" or "Holders" only when every check passes; one failing check (or a
// stranger's contract that reverts) leaves it unnamed, so the page shows "Paid to <address>".
const A = (n: string) => `0x${n.repeat(40).slice(0, 40)}` as Address;
const SHOPS = A('5');
const STAKES = A('6');
const TOKEN = A('7');
const CREATOR = A('8');
const SHOP = A('a');
const STAKE = A('b');
const STRANGER = A('c');

/** A chain in which SHOP and STAKE are ours for TOKEN; `over` changes one answer (or makes it revert with 'revert'). */
function chain(over: Partial<Record<string, unknown>> = {}): ViewRead {
  const answers: Record<string, unknown> = {
    [`${SHOPS}.isShop.${SHOP}`]: true,
    [`${SHOP}.shopToken`]: TOKEN,
    [`${STAKES}.stakeOf.${CREATOR},${TOKEN}`]: STAKE,
    [`${STAKES}.isStake.${STAKE}`]: true,
    [`${STAKE}.stakeToken`]: TOKEN,
    [`${STAKE}.stakeFactory`]: STAKES,
    ...over,
  };
  return async (address, fn, args = []) => {
    const key = `${address}.${fn}${args.length ? '.' + args.join(',') : ''}`;
    const v = key in answers ? answers[key] : fn === 'isShop' || fn === 'isStake' ? false : 'revert';
    if (v === 'revert') throw new Error('execution reverted');
    return v;
  };
}
const names = (read: ViewRead, f: { shops?: Address; stakes?: Address } = { shops: SHOPS, stakes: STAKES }, payees: Address[] = [SHOP, STAKE, STRANGER]) =>
  payeeNames(read, f, { token: TOKEN, creator: CREATOR }, payees);

describe('the payee names, proven on chain', () => {
  it('all checks pass: "Card shop" and "Holders"; a stranger stays unnamed', async () => {
    expect(await names(chain())).toEqual({ [SHOP.toLowerCase()]: PAYEE_NAME.shop, [STAKE.toLowerCase()]: PAYEE_NAME.holders });
    expect(PAYEE_NAME).toEqual({ shop: 'Card shop', holders: 'Holders' });
  });
  it('without the factories in the deployment file: no names', async () => {
    expect(await names(chain(), {})).toEqual({});
    expect(await names(chain(), { shops: SHOPS })).toEqual({ [SHOP.toLowerCase()]: 'Card shop' });
    expect(await names(chain(), { stakes: STAKES })).toEqual({ [STAKE.toLowerCase()]: 'Holders' });
  });
  it('the shop: each check failing alone leaves it unnamed', async () => {
    const shopName = async (over: Record<string, unknown>) => (await names(chain(over)))[SHOP.toLowerCase()];
    expect(await shopName({ [`${SHOPS}.isShop.${SHOP}`]: false })).toBe(undefined); // not made by our factory
    expect(await shopName({ [`${SHOPS}.isShop.${SHOP}`]: 'revert' })).toBe(undefined);
    expect(await shopName({ [`${SHOP}.shopToken`]: A('9') })).toBe(undefined); // another token's shop
    expect(await shopName({ [`${SHOP}.shopToken`]: 'revert' })).toBe(undefined); // no token() at all
  });
  it('the stake: each check failing alone leaves it unnamed', async () => {
    const stakeName = async (over: Record<string, unknown>) => (await names(chain(over)))[STAKE.toLowerCase()];
    expect(await stakeName({ [`${STAKES}.stakeOf.${CREATOR},${TOKEN}`]: A('d') })).toBe(undefined); // not the creator's stake
    expect(await stakeName({ [`${STAKES}.stakeOf.${CREATOR},${TOKEN}`]: 'revert' })).toBe(undefined);
    expect(await stakeName({ [`${STAKES}.isStake.${STAKE}`]: false })).toBe(undefined);
    expect(await stakeName({ [`${STAKE}.stakeToken`]: A('9') })).toBe(undefined); // another token's stake
    expect(await stakeName({ [`${STAKE}.stakeFactory`]: A('9') })).toBe(undefined); // another factory's
    expect(await stakeName({ [`${STAKE}.stakeFactory`]: 'revert' })).toBe(undefined);
  });
  it("a stranger's contract that copies the answers it can (its own token() is this token) stays unnamed", async () => {
    const r = await names(chain({ [`${STRANGER}.shopToken`]: TOKEN, [`${STRANGER}.stakeToken`]: TOKEN, [`${STRANGER}.stakeFactory`]: STAKES }));
    expect(r[STRANGER.toLowerCase()]).toBe(undefined);
  });
});
