/**
 * SH-V21-FE12 in the creation flow: the v2.1 fee choices (eat the price coin, holders and items paid in the box token,
 * fees into the coin pile) and the pile's leave-behind preset. The wire must be exactly what the factory's choice
 * decoder and the chain package's reader take (`feeChoiceV2`), and the generated validator must accept every pairing the
 * Fees step offers and refuse the ones it does not.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { decodeAbiParameters, encodeAbiParameters } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeeChoice as WIRE_IDS, validateBoxSpecV2 } from '../../../../../../packages/box-spec/src/generated/box-spec.v2';
import { pileConfigV2 } from '../../../../../../packages/chain/src/core/v2';
import { feeChoiceV2 } from '../../../../../../packages/indexer/src/core/v2/views-v2';
import { required } from '../../core/v2/test-support/required';
import { FeesStep } from './FeesStep';
import { loadListingsV2 } from './indexer-listings';
import { DEMO_LISTINGS, type SiteListing } from './listings';
import { buildSpecV2, newPile, pileInPrice, recipeCtx, v2Issues, type V2Choices } from './model';
import { sideText } from './OverviewV2';
import { PileStep, LEAVE_BEHIND_LINE } from './PileStep';
import { CHOICES, INSIDE, MENU, choiceOf, eatLabel, pickFor, sideOf, type SidePick, type WiredChoice } from './recipes';
import { BoxTypeV2, Dest, Leg } from './spec-types';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { inputV2Of } from './test-support/v2-fixtures';

afterEach(cleanup);
const config = (id: string) => required(CONFIGURATIONS.find((entry) => entry.id === id));
const coin = (symbol: string) => required(DEMO_LISTINGS.find((l) => l.symbol === symbol));
/** The generated validator's FeeChoice ids (BoxFactoryV2Parts `_choice`), by the site's names. */
const ID: Readonly<Record<WiredChoice, number>> = { keep: WIRE_IDS.Keep, burn: WIRE_IDS.Burn, grow: WIRE_IDS.Grow, holders: WIRE_IDS.Holders, items: WIRE_IDS.Items, eat: WIRE_IDS.EatPriceCoin, 'holders-t': WIRE_IDS.HoldersT, 'items-t': WIRE_IDS.ItemsT, pile: WIRE_IDS.Pile, shop: WIRE_IDS.ShopT };
const uint8 = (n: number) => encodeAbiParameters([{ type: 'uint8' }], [n]);
const pileOf = (asset: string, leaveBehindBps: 0 | 500 = 0) => ({ ...newPile(asset), seed: '1', leaveBehindBps });

describe('the v2.1 wire, as the factory and the chain package read it', () => {
  it('encodes each choice as one canonical branch; the chain reader names it back, the validator numbers it', () => {
    const expected: Readonly<Record<WiredChoice, readonly [number, number, string]>> = {
      keep: [Leg.AsPaid, Dest.Creator, '0x'], burn: [Leg.BuyT, Dest.Eat, '0x'], grow: [Leg.AsPaid, Dest.Depth, '0x'], holders: [Leg.AsPaid, Dest.Holders, uint8(1)],
      items: [Leg.AsPaid, Dest.Items, uint8(1)], eat: [Leg.AsPaid, Dest.Eat, '0x'], 'holders-t': [Leg.BuyT, Dest.Holders, uint8(2)], 'items-t': [Leg.BuyT, Dest.Items, uint8(1)],
      pile: [Leg.AsPaid, Dest.BudgetOrPile, '0x'], shop: [Leg.BuyT, Dest.BudgetOrPile, uint8(2)],
    };
    for (const choice of CHOICES) {
      const side = sideOf(pickFor(choice));
      const [leg, dest, destParams] = expected[choice];
      expect(side, choice).toEqual({ a: { leg, dest, legParams: '0x', destParams }, b: { leg: 0, dest: 0, legParams: '0x', destParams: '0x' }, split: 1, splitParams: '0x' });
      expect(feeChoiceV2(side), choice).toBe(choice);
      expect(choiceOf(pickFor(choice)), choice).toBe(choice);
      expect(ID[choice], choice).toBeGreaterThan(0);
    }
    // Every core choice but the directory's generic module (10): ShopT (11) is the shop's (SH-V21-FE14).
    expect(Object.values(ID).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 11]);
    // Items in the box token keep their explicit in-vault rule; a missing rule is no choice.
    expect(sideOf(pickFor('items-t', INSIDE.burn)).a.destParams).toBe(uint8(2));
    expect(choiceOf({ ...pickFor('items-t'), a: { ...pickFor('items-t').a, inside: undefined } })).toBeNull();
    // A directory module is no choice without the row the page resolved (only The Alchemist names one, alchemist.test.tsx).
    expect(choiceOf({ a: { leg: Leg.AsPaid, dest: Dest.Module, to: null }, b: { leg: 0, dest: 0, to: null }, split: { kind: 'none' } })).toBeNull();
    expect(MENU).not.toContain('holders-t');
  });

  it.each(['ETH', 'USDC', 'LINK', 'NVDAon', 'FIT'])('the generated validator accepts every offered pairing priced in %s', (symbol) => {
    const listing = coin(symbol);
    const check = (picks: readonly WiredChoice[], v2: Partial<V2Choices>, form: Parameters<typeof inputV2Of>[2], id: string) => {
      for (const a of picks) for (const b of picks) {
        const input = inputV2Of(config(id), { pricing: listing.token, buyers: pickFor(a), sellers: pickFor(b), ...v2 }, form);
        expect(v2Issues(input), `${symbol} ${a}/${b}`).toEqual([]);
        expect(validateBoxSpecV2(buildSpecV2(input), { listing }), `${symbol} ${a}/${b}`).toEqual({ reason: 0, field: 0 });
      }
    };
    check(['keep', 'burn', 'grow', 'holders', 'holders-t', 'eat'], { pile: null }, { contents: 'token' }, 'rug-rugs');
    check(['burn', 'holders-t', 'items', 'items-t', 'eat'], {}, { contents: 'collection' }, 'bag-holders');
    check(['pile', 'eat', 'burn', 'holders-t'], { pile: pileOf(listing.token, 500) }, { contents: 'token' }, 'dragons-hoard');
  });

  it('refuses at Fees what the validator refuses: the pile outside a pile in the price coin, items outside a collection', () => {
    const eth = coin('ETH'); const usdc = coin('USDC');
    for (const [v2, form] of [
      [{ pile: null }, { contents: 'token' }],
      [{ pile: pileOf(usdc.token) }, { contents: 'token' }],
      [{}, { contents: 'collection' }],
    ] as const) {
      const input = inputV2Of(config('dragons-hoard'), { pricing: eth.token, buyers: pickFor('pile'), ...v2 }, form);
      expect(pileInPrice(input)).toBe(false);
      expect(v2Issues(input)).toContainEqual({ step: 'v2-fees', control: 'create-v2-buyers', message: 'To the pile needs a coin pile in the price coin.' });
      expect(validateBoxSpecV2(buildSpecV2(input), { listing: eth }).reason).not.toBe(0);
    }
    const token = inputV2Of(config('rug-rugs'), { sellers: pickFor('items-t') }, { contents: 'token' });
    expect(v2Issues(token)).toContainEqual({ step: 'v2-fees', control: 'create-v2-sellers', message: 'To items needs a new collection.' });
    expect(validateBoxSpecV2(buildSpecV2(token), { listing: recipeCtx(token).pricing }).reason).not.toBe(0);
  });
});

describe('the leave-behind preset (v2.1 step 3)', () => {
  it('0% keeps the 64-byte PileParams (and a pile chosen before step 3 its hash); 5% is the 96-byte PileParamsV21', () => {
    const eth = coin('ETH');
    const base = inputV2Of(config('dragons-hoard'), { pricing: eth.token, buyers: pickFor('pile'), pile: { asset: eth.token, seed: '1' } });
    const zero = inputV2Of(config('dragons-hoard'), { pricing: eth.token, buyers: pickFor('pile'), pile: pileOf(eth.token, 0) });
    const five = inputV2Of(config('dragons-hoard'), { pricing: eth.token, buyers: pickFor('pile'), pile: pileOf(eth.token, 500) });
    expect(buildSpecV2(zero).contentsParams).toBe(buildSpecV2(base).contentsParams);
    expect((buildSpecV2(zero).contentsParams.length - 2) / 2).toBe(64);
    const spec = buildSpecV2(five);
    expect(spec.boxType).toBe(BoxTypeV2.PILE);
    expect((spec.contentsParams.length - 2) / 2).toBe(96);
    expect(pileConfigV2(spec.contentsParams)).toEqual({ asset: eth.token, seedAmount: 10n ** 18n, leaveBehindBps: 500n });
    expect(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint16' }], spec.contentsParams)[2]).toBe(500);
    for (const input of [base, zero, five]) {
      expect(v2Issues(input)).toEqual([]);
      expect(validateBoxSpecV2(buildSpecV2(input), { listing: eth })).toEqual({ reason: 0, field: 0 });
    }
  });

  it('offers 0% and 5% radios with the one help line, and keeps the coin and seed when it changes', () => {
    const onChange = vi.fn();
    const pile = { ...newPile(coin('ETH').token), seed: '1' };
    render(<PileStep pile={pile} pricing={coin('ETH')} listings={DEMO_LISTINGS} onChange={onChange} errorFor={() => null} touch={() => {}} />);
    const group = screen.getByRole('group', { name: 'Leave behind' });
    expect(within(group).getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual(['0', '500']);
    expect(within(group).getByRole('radio', { name: '0%' })).toHaveProperty('checked', true);
    expect(screen.getByText(LEAVE_BEHIND_LINE)).toBeTruthy();
    fireEvent.click(within(group).getByRole('radio', { name: '5%' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...pile, leaveBehindBps: 500 });
  });
});

describe('the Fees step', () => {
  const step = (buyers: SidePick, listing: SiteListing, options: { collection?: boolean; pileInPrice?: boolean } = {}) => {
    const set = vi.fn();
    const input = inputV2Of(config('rug-rugs'), { pricing: listing.token }, { contents: options.collection ? 'collection' : 'token', ticker: 'RUGS' });
    render(<FeesStep buyers={buyers} sellers={pickFor('burn')} ctx={recipeCtx(input)} collection={options.collection ?? false} pileInPrice={options.pileInPrice ?? false} errorFor={() => null} set={set} />);
    return { set, group: screen.getByRole('group', { name: `Buyers’ fees · in ${listing.symbol}` }) };
  };
  const names = (group: HTMLElement) => within(group).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);

  it('names eating by the listing: Lock without a checked burn, Burn with one, with one help line', () => {
    expect(eatLabel(coin('LINK'))).toBe('Lock LINK'); expect(eatLabel(coin('ETH'))).toBe('Lock ETH'); expect(eatLabel(coin('FIT'))).toBe('Burn FIT');
    const locked = step(pickFor('eat'), coin('LINK'));
    expect(names(locked.group)).toEqual(['Keep', 'Buy back and burn RUGS', 'Grow the pool', 'To holders', 'Lock LINK']);
    expect(within(locked.group).getByRole('button', { name: 'Lock LINK' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(locked.group).getByText('Locked forever at a dead address after graduation.')).toBeTruthy();
    cleanup();
    const burned = step(pickFor('eat'), coin('FIT'));
    expect(within(burned.group).getByText('Burned for good after graduation.')).toBeTruthy();
  });

  it('pays holders or items in the price coin or in the box token, keeping the in-vault rule', () => {
    const { set, group } = step(pickFor('items', INSIDE.burn), coin('ETH'), { collection: true });
    expect(names(group)).toEqual(['Keep', 'Buy back and burn RUGS', 'Grow the pool', 'To holders', 'To items', 'Lock ETH', 'Claimed in ETH', 'Claimed in RUGS', 'About items in the vault, buyers', 'Keep in the vault', 'Buy back and burn RUGS in the vault', 'Grow the pool in the vault']);
    expect(within(group).getByRole('button', { name: 'Claimed in ETH' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(group).queryByText(/Fees buy RUGS first/)).toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: 'Claimed in RUGS' }));
    expect(set).toHaveBeenLastCalledWith({ buyers: pickFor('items-t', INSIDE.burn) });
    cleanup();
    const t = step(pickFor('holders-t'), coin('ETH'));
    expect(within(t.group).getByRole('button', { name: 'To holders' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(t.group).getByRole('button', { name: 'Claimed in RUGS' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(t.group).getByText('Fees buy RUGS first, then holders claim it.')).toBeTruthy();
    // Pressing To holders again keeps the box token; another choice has no payout coin.
    fireEvent.click(within(t.group).getByRole('button', { name: 'To holders' }));
    expect(t.set).toHaveBeenLastCalledWith({ buyers: pickFor('holders-t') });
    fireEvent.click(within(t.group).getByRole('button', { name: 'Keep' }));
    expect(t.set).toHaveBeenLastCalledWith({ buyers: pickFor('keep') });
  });

  it('offers To the pile only on a pile in the price coin, and keeps a refused pick visible', () => {
    expect(names(step(pickFor('burn'), coin('ETH'), { pileInPrice: true }).group)).toContain('To the pile');
    cleanup();
    expect(names(step(pickFor('burn'), coin('ETH')).group)).not.toContain('To the pile');
    cleanup();
    expect(names(step(pickFor('pile'), coin('ETH')).group)).toContain('To the pile');
  });

  it('the overview names the coin a payout is paid in, and eating by the listing', () => {
    const ctx = recipeCtx(inputV2Of(config('rug-rugs'), { pricing: coin('LINK').token }, { ticker: 'MARINE' }));
    expect(sideText('buyers', pickFor('items-t', INSIDE.keep), ctx)).toBe('To items · Keep · in LINK · items claim MARINE');
    expect(sideText('buyers', pickFor('holders'), ctx)).toBe('To holders · in LINK');
    expect(sideText('buyers', pickFor('eat'), ctx)).toBe('Lock LINK · in LINK');
    expect(sideText('buyers', pickFor('pile'), ctx)).toBe('To the pile · in LINK');
  });
});

describe('the listing book', () => {
  it('a checked-burn admission makes the coin burn; any other row locks', async () => {
    const { publishedV2 } = await import('../../core/v2/test-support/published-v2');
    const { source, listings } = await publishedV2(false);
    const rows = listings.listings as unknown as readonly Record<string, unknown>[];
    // The synthetic listing's raise is below the offered minimum; the live book's rows are offered (indexer-v2.test.ts).
    const answer = (selector?: string) => ({ ...listings, listings: rows.map((row) => ({ ...row, raise: '1000001', detail: { ...(row.detail as Record<string, unknown>), raise: '1000001', ...(selector ? { checkedBurnSelector: selector } : {}) } })) });
    const reader = { call: async () => null, hasCode: async () => true };
    const burned = await loadListingsV2(source, async () => new Response(JSON.stringify(answer('0x42966c68'))), reader);
    const locked = await loadListingsV2(source, async () => new Response(JSON.stringify(answer())), reader);
    expect(burned.map((l) => l.checkedBurn)).toEqual([true]);
    expect(locked.map((l) => l.checkedBurn)).toEqual([false]);
    expect(eatLabel(required(locked[0]))).toMatch(/^Lock /);
  });
});
