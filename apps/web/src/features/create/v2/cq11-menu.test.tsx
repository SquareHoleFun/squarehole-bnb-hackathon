import { required } from '../../core/v2/test-support/required';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FeesStep } from './FeesStep';
import { DEMO_LISTINGS, offeredListings, raiseOf } from './listings';
import { buildSpecV2, DEFAULT_V2, recipeCtx } from './model';
import { branch, recipeIssues, sideOf, type SidePick } from './recipes';
import { Dest, Leg } from './spec-types';
import { encodeAbiParameters } from 'viem';
import { inputV2Of } from './test-support/v2-fixtures';
import { validateBoxSpecV2 } from '../../../../../../packages/box-spec/src/generated/box-spec.v2';

const only = (leg: number, dest: number): SidePick => ({ a: branch(leg, dest), b: branch(0, 0), split: { kind: 'none' } });
const menu = [only(Leg.AsPaid, Dest.Creator), only(Leg.BuyT, Dest.Eat), only(Leg.AsPaid, Dest.Depth), only(Leg.AsPaid, Dest.Holders)];

describe('CQ11-E4 / F119-F123 creation menu', () => {
  it('M253-CREATE: accepts all sixteen combinations with canonical P-only holder parameters', () => {
    for (const buyers of menu) for (const sellers of menu) {
      expect(recipeIssues(buyers, sellers)).toEqual([]);
      expect(sideOf(sellers).b).toEqual({ leg: 0, dest: 0, legParams: '0x', destParams: '0x' });
      if (sellers.a.dest === Dest.Holders) expect(sideOf(sellers).a.destParams).toBe(encodeAbiParameters([{ type: 'uint8' }], [1]));
    }
    // v2.1 step 1 made AsPaid/Eat the "eat the price coin" choice (recipes.test.ts); the reserved members stay refused.
    for (const old of [only(Leg.RESERVED_3, Dest.Creator), only(Leg.RESERVED_4, Dest.Eat), only(Leg.AsPaid, Dest.RESERVED_3), only(Leg.BuyT, Dest.Creator), only(Leg.AsPaid, Dest.Module)]) {
      expect(recipeIssues(required(menu[0]), old).length).toBeGreaterThan(0);
    }
  });
  it('builds full range and defaults to buying and burning T on BOTH sides', () => {
    const spec = buildSpecV2({ ...inputV2Of(), v2: DEFAULT_V2 });
    expect(spec.gradLayout).toBe(3);
    expect(spec.buyers).toEqual(spec.sellers);
    expect(spec.addOns.some((addon) => addon.id === 10)).toBe(false);
  });
  it('M253-CREATE: generated M2 validation accepts each complete fee pairing in 6/8/18-decimal and stock P', () => {
    for (const symbol of ['ETH', 'USDC', 'WBTC', 'NVDAon']) {
      const listing = required(DEMO_LISTINGS.find(l => l.symbol === symbol));
      for (const buyers of menu) for (const sellers of menu) {
        const input = inputV2Of(undefined, { pricing: listing.token, buyers, sellers }, { contents: 'token' });
        const spec = buildSpecV2(input);
        expect(validateBoxSpecV2(spec, { listing }), `${symbol}/${buyers.a.dest}/${sellers.a.dest}`).toEqual({ reason: 0, field: 0 });
      }
    }
  });
  it('M253-CREATE: offers holders on each side and names the price coin for both', () => {
    const input = inputV2Of();
    const set = vi.fn();
    render(<FeesStep buyers={DEFAULT_V2.buyers} sellers={DEFAULT_V2.sellers} ctx={recipeCtx(input)} collection errorFor={() => null} set={set} />);
    // SH-SITE-FIXES-10: the price coin by its own name (LINK), never "P", and no "P =" key.
    expect(screen.getByText(/^1% of every trade: in LINK on buys, in .+ on sales$/)).toBeTruthy();
    expect(screen.getByText('You choose where 10/15 goes')).toBeTruthy();
    expect(screen.queryByText(/\bP = |in P on buys/)).toBeNull();
    for (const side of ['Buyers’', 'Sellers’']) {
      const group = screen.getByRole('group', { name: side === 'Buyers’' ? 'Buyers’ fees · in LINK' : 'Sellers’ fees · paid in MARINE, used as LINK' });
      expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Keep', 'Buy back and burn MARINE', 'Grow the pool', 'To holders', 'To items', 'Lock LINK']);
      fireEvent.click(within(group).getByRole('button', { name: 'To holders' }));
    }
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenLastCalledWith({ sellers: only(Leg.AsPaid, Dest.Holders) });
    expect(screen.queryByText(/Cap what you take/)).toBeNull();
  });
  it('M253-CREATE: refuses a hidden second branch instead of discarding it', () => {
    const holders = only(Leg.AsPaid, Dest.Holders);
    expect(recipeIssues({ ...holders, b: branch(Leg.AsPaid, Dest.Creator) }, holders)).toHaveLength(1);
  });
  it('offers only permanent listings and uses the lister’s exact raise for box coins too', () => {
    expect(DEMO_LISTINGS.some((l) => l.symbol === 'sUSDS')).toBe(false);
    const fit = required(DEMO_LISTINGS.find((l) => l.symbol === 'FIT'));
    expect(raiseOf(fit)).toBe(21_034_900_425_000_000_000_000_000n);
    expect(offeredListings([fit, { ...fit, id: fit.id + 1 }])).toEqual([]);
  });
});
