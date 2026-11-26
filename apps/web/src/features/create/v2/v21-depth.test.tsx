/**
 * SH-V21-05 (v2.1 step 5) in the creation flow: the third in-vault rule, Grow the pool (ItemsInsidePolicy.Depth = 3), for
 * items paid in the price coin or in the box token. The wire is the one canonical uint8 the factory, the generated
 * validator and the chain package read; Keep stays the explicit default; a switch between P and T keeps the rule.
 */
import { RECIPE_CHOICES } from '../../../../e2e/trading-controls';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { encodeAbiParameters } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateBoxSpecV2 } from '../../../../../../packages/box-spec/src/generated/box-spec.v2';
import { itemPolicyV2 } from '../../../../../../packages/chain/src/core/v2';
import { feeChoiceV2 } from '../../../../../../packages/indexer/src/core/v2/views-v2';
import { required } from '../../core/v2/test-support/required';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import { FeesStep } from './FeesStep';
import { DEMO_LISTINGS, type SiteListing } from './listings';
import { buildSpecV2, recipeCtx, v2Issues } from './model';
import { sideText } from './OverviewV2';
import { DEFAULT_INSIDE, INSIDE, INSIDE_LABEL, choiceOf, insideOf, pickFor, sideOf, type SidePick } from './recipes';
import { Dest, Leg } from './spec-types';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { inputV2Of } from './test-support/v2-fixtures';

afterEach(cleanup);
const config = (id: string) => required(CONFIGURATIONS.find((entry) => entry.id === id));
const coin = (symbol: string) => required(DEMO_LISTINGS.find((l) => l.symbol === symbol));
const uint8 = (n: number) => encodeAbiParameters([{ type: 'uint8' }], [n]);
const depthP = pickFor('items', INSIDE.depth);
const depthT = pickFor('items-t', INSIDE.depth);

describe('Grow the pool on the wire', () => {
  it('encodes Depth as the canonical uint8 3 in P and in T; the chain and indexer readers name it back', () => {
    expect(INSIDE.depth).toBe(3);
    expect(INSIDE_LABEL[INSIDE.depth]).toBe('Grow the pool');
    expect(DEFAULT_INSIDE).toBe(INSIDE.keep);
    expect(pickFor('items')).toEqual(pickFor('items', INSIDE.keep));
    for (const [pick, leg, choice] of [[depthP, Leg.AsPaid, 'items'], [depthT, Leg.BuyT, 'items-t']] as const) {
      const side = sideOf(pick);
      expect(side.a).toEqual({ leg, dest: Dest.Items, legParams: '0x', destParams: uint8(3) });
      expect(feeChoiceV2(side)).toBe(choice);
      expect(itemPolicyV2(side)).toBe(3);
      expect(choiceOf(pick)).toBe(choice);
      expect(insideOf(pick)).toBe(3);
    }
    // An unknown rule is still no choice, never read as one of the three.
    expect(choiceOf({ ...depthP, a: { ...depthP.a, inside: 4 as unknown as 3 } })).toBeNull();
  });

  it.each(['ETH', 'USDC', 'LINK', 'NVDAon'])('the generated validator accepts Depth on either side, beside Keep and Burn, priced in %s', (symbol) => {
    const listing = coin(symbol);
    const picks = [[depthP, 3], [depthT, 3], [pickFor('items', INSIDE.keep), 1], [pickFor('items-t', INSIDE.burn), 2]] as const;
    for (const [buyers, buyersPolicy] of picks) for (const [sellers, sellersPolicy] of picks) {
      const input = inputV2Of(config('bag-holders'), { pricing: listing.token, buyers, sellers });
      expect(v2Issues(input), symbol).toEqual([]);
      const spec = buildSpecV2(input);
      expect([spec.buyers.a.destParams, spec.sellers.a.destParams], symbol).toEqual([uint8(buyersPolicy), uint8(sellersPolicy)]);
      expect(validateBoxSpecV2(spec, { listing }), symbol).toEqual({ reason: 0, field: 0 });
    }
  });
});

describe('Grow the pool on the Fees step', () => {
  const step = (buyers: SidePick, listing: SiteListing = coin('ETH')) => {
    const set = vi.fn();
    const input = inputV2Of(config('rug-rugs'), { pricing: listing.token }, { contents: 'collection', ticker: 'RUGS' });
    render(<FeesStep buyers={buyers} sellers={pickFor('burn')} ctx={recipeCtx(input)} collection errorFor={() => null} set={set} />);
    const group = screen.getByRole('group', { name: `Buyers’ fees · in ${listing.symbol}` });
    return { set, group, vault: within(group).getByRole('group', { name: /In the vault/ }) };
  };
  const pressed = (vault: HTMLElement) => within(vault).getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('aria-label'));

  it('offers it as the third in-vault rule; Keep stays the default; a press writes Depth', () => {
    const { set, vault } = step(pickFor('items'));
    expect(within(vault).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['About items in the vault, buyers', 'Keep in the vault', 'Buy back and burn RUGS in the vault', 'Grow the pool in the vault']);
    expect(pressed(vault)).toEqual(['Keep in the vault']);
    fireEvent.click(within(vault).getByRole('button', { name: 'Grow the pool in the vault' }));
    expect(set).toHaveBeenLastCalledWith({ buyers: depthP });
  });

  it('keeps Depth when the payout switches between the price coin and the box token, and when To items is pressed again', () => {
    const p = step(depthP);
    expect(pressed(p.vault)).toEqual(['Grow the pool in the vault']);
    fireEvent.click(within(p.group).getByRole('button', { name: 'Claimed in RUGS' }));
    expect(p.set).toHaveBeenLastCalledWith({ buyers: depthT });
    cleanup();
    const t = step(depthT);
    expect(pressed(t.vault)).toEqual(['Grow the pool in the vault']);
    fireEvent.click(within(t.group).getByRole('button', { name: 'Claimed in ETH' }));
    expect(t.set).toHaveBeenLastCalledWith({ buyers: depthP });
    fireEvent.click(within(t.group).getByRole('button', { name: 'To items' }));
    expect(t.set).toHaveBeenLastCalledWith({ buyers: depthT });
  });

  it.each([[depthP, 'Grow the pool: the share goes into this box’s own pool for good, in ETH.'],
    [depthT, 'Grow the pool: the share goes into this box’s own pool for good, in ETH; only items out of the vault claim RUGS.']] as const)(
    'explains it behind the (i), in the copy rule (%#)', (pick, line) => {
      const { vault } = step(pick);
      fireEvent.click(within(vault).getByRole('button', { name: /About items in the vault/ }));
      expect(within(vault).getByText(line)).toBeTruthy();
      expect(within(vault).getByText(/the Misfits’ way/)).toBeTruthy();
      // "Grow the pool" is the founder's fixed label (the app's wording audit allows exactly that phrase).
      expect(appCopyFraming(renderedCopy(document.body).map((text) => text.replace(/\bGrow the pool\b/g, 'Add to the pool')))).toEqual([]);
      const labels = Array.from(document.querySelectorAll('[aria-label], legend'))
        .filter((element) => !element.matches(RECIPE_CHOICES))
        .map((element) => `${element.getAttribute('aria-label') ?? ''} ${element.textContent ?? ''}`);
      expect(labels.filter((label) => /\b(buy|sell|swap)\b/i.test(label))).toEqual([]);
    });

  it('the overview names it by its label, in either coin', () => {
    const ctx = recipeCtx(inputV2Of(config('rug-rugs'), { pricing: coin('LINK').token }, { ticker: 'MARINE' }));
    expect(sideText('buyers', depthP, ctx)).toBe('To items · Grow the pool · in LINK');
    expect(sideText('sellers', depthT, ctx)).toBe('To items · Grow the pool · paid in MARINE, used as LINK · items claim MARINE');
  });
});
