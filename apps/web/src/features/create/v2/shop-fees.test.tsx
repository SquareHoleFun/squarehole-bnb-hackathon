/**
 * SH-V21-FE14 (step 7 request 1; founder R48A-D): Into the shop in the creation flow. It is offered on the sellers' side of
 * every shop and nowhere else; the creator fixes its ceiling at 2x, 4x or 8x the seed; the side is the canonical
 * `BuyT / BudgetOrPile` with `ShopDestParams(uint8 ceilingPreset)`, as the chain package writes and reads it; the
 * generated validator accepts every offered pairing and refuses the rest; the founder's line and the accepted warning
 * are shown word for word, at the choice and beside the fee rows the creator confirms.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { toHex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeShopDestParams, validateBoxSpecV2 } from '../../../../../../packages/box-spec/src/generated/box-spec.v2';
import { feeChoiceV2 } from '../../../../../../packages/indexer/src/core/v2/views-v2';
import { required } from '../../core/v2/test-support/required';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import { creationPlan, demoCreateGas } from './creation-plan';
import { FeesStep } from './FeesStep';
import { SHOP_FEES_LINE, SHOP_FEES_WARNING } from './fee-words';
import { DEMO_LISTINGS } from './listings';
import { SHOP_FEES_NEED_SHOP, SHOP_FEES_SELLERS_ONLY, buildSpecV2, newPile, recipeCtx, v2Issues, type BuildV2Input, type V2Choices } from './model';
import { OverviewV2, sideText } from './OverviewV2';
import { CEILING_PRESETS, DEFAULT_CEILING, ceilingOf, choiceOf, pickFor, recipeIssues, sideOf, type SidePick, type WiredChoice } from './recipes';
import { newShop, type ShopChoice } from './shop';
import { Dest, Leg, specHashV2 } from './spec-types';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { inputV2Of } from './test-support/v2-fixtures';

afterEach(cleanup);
const E18 = 10n ** 18n;
const config = (id: string) => required(CONFIGURATIONS.find((entry) => entry.id === id));
const coin = (symbol: string) => required(DEMO_LISTINGS.find((l) => l.symbol === symbol));
const SHOP: ShopChoice = { ...newShop(), seed: '1000', prices: ['1', '2', '4', '8'], collections: [{ address: '0x00000000000000000000000000000000000000a1', tier: 0 }] };
const shopInput = (v2: Partial<V2Choices> = {}, pricing = 'PAXG'): BuildV2Input =>
  inputV2Of(config('curio-corner'), { pricing: coin(pricing).token, buyers: pickFor('holders'), sellers: pickFor('shop'), pile: null, shop: SHOP, ...v2 }, { firstIn: '0.05' });
const verdict = (input: BuildV2Input) => validateBoxSpecV2(buildSpecV2(input), { listing: recipeCtx(input).pricing });

describe('SH-V21-FE14 Into the shop: the wire the chain package writes and reads', () => {
  it('is BuyT / BudgetOrPile with the canonical ShopDestParams for 2x, 4x and 8x, read back as the shop choice', () => {
    expect(CEILING_PRESETS).toEqual([2, 4, 8]);
    expect(DEFAULT_CEILING).toBe(2);
    for (const ceilingPreset of CEILING_PRESETS) {
      const pick = pickFor('shop', undefined, ceilingPreset);
      const side = sideOf(pick);
      // The generated twin's encoder and the chain package's example writer (a 32-byte uint8 word) agree byte for byte.
      expect(side).toEqual({ a: { leg: Leg.BuyT, dest: Dest.BudgetOrPile, legParams: '0x', destParams: encodeShopDestParams({ ceilingPreset }) }, b: { leg: 0, dest: 0, legParams: '0x', destParams: '0x' }, split: 1, splitParams: '0x' });
      expect(side.a.destParams).toBe(toHex(BigInt(ceilingPreset), { size: 32 }));
      expect(feeChoiceV2(side)).toBe('shop');
      expect(choiceOf(pick)).toBe('shop');
      expect(ceilingOf(pick)).toBe(ceilingPreset);
    }
    // It never reads as the coin pile's AsPaid / BudgetOrPile choice, nor that one as the shop's.
    expect(feeChoiceV2(sideOf(pickFor('pile')))).toBe('pile');
    expect(ceilingOf(pickFor('pile'))).toBeNull();
  });

  it('a shop pick without an admitted preset is no choice, never a silent default', () => {
    const shop = pickFor('shop');
    for (const ceiling of [undefined, 0, 1, 3, 16, 255]) {
      const pick: SidePick = { ...shop, a: { ...shop.a, ceiling: ceiling as never } };
      expect(choiceOf(pick), String(ceiling)).toBeNull();
      expect(recipeIssues(pickFor('holders'), pick)).toHaveLength(1);
    }
  });

  it('the preset is part of the spec: each ceiling has its own spec hash, so a quote or a salt for another one is stale', () => {
    const hashes = CEILING_PRESETS.map((preset) => specHashV2(buildSpecV2(shopInput({ sellers: pickFor('shop', undefined, preset) }))));
    expect(new Set(hashes).size).toBe(3);
  });
});

describe('SH-V21-FE14 Into the shop: only on a shop’s sellers’ side', () => {
  it.each(['ETH', 'USDC', 'PAXG'])('the generated validator accepts every offered pairing priced in %s', (symbol) => {
    const buyers: readonly WiredChoice[] = ['keep', 'burn', 'grow', 'holders', 'holders-t', 'eat'];
    for (const b of buyers) for (const preset of CEILING_PRESETS) {
      const input = shopInput({ buyers: pickFor(b), sellers: pickFor('shop', undefined, preset) }, symbol);
      expect(v2Issues(input), `${symbol} ${b}/${preset}x`).toEqual([]);
      expect(verdict(input), `${symbol} ${b}/${preset}x`).toEqual({ reason: 0, field: 0 });
    }
  });

  it('refuses at Fees what the validator refuses: the buyers’ side, a box that is no shop', () => {
    const buyers = shopInput({ buyers: pickFor('shop'), sellers: pickFor('holders') });
    expect(v2Issues(buyers)).toContainEqual({ step: 'v2-fees', control: 'create-v2-buyers', message: SHOP_FEES_SELLERS_ONLY });
    expect(verdict(buyers).reason).not.toBe(0);
    const eth = coin('ETH');
    for (const [v2, form] of [
      [{ shop: null, pile: null }, { contents: 'token' }],
      [{ shop: null, pile: { ...newPile(eth.token), seed: '1' } }, { contents: 'token' }],
      [{ shop: null, pile: null }, { contents: 'collection' }],
      // A shop chosen and then left for a collection keeps its settings in memory, but the box is no shop.
      [{ shop: SHOP }, { contents: 'collection' }],
    ] as const) {
      const input = inputV2Of(config(form.contents === 'collection' ? 'bag-holders' : 'rug-rugs'), { pricing: eth.token, buyers: pickFor('holders'), sellers: pickFor('shop'), ...v2 }, form);
      expect(v2Issues(input), JSON.stringify(form)).toContainEqual({ step: 'v2-fees', control: 'create-v2-sellers', message: SHOP_FEES_NEED_SHOP });
      expect(verdict(input).reason, JSON.stringify(form)).not.toBe(0);
    }
  });

  it('the plan is the shop’s as before: createBox, then the seed’s three steps', () => {
    const input = shopInput();
    const spec = buildSpecV2(input);
    const plan = creationPlan(spec, recipeCtx(input).pricing, { estimate: demoCreateGas, shopSeedT: 1000n * E18 });
    expect(plan.steps.map((step) => step.call)).toEqual(['approve', 'createBox', 'approveShopSeed', 'fundSeed', 'complete']);
  });
});

describe('SH-V21-FE14 Into the shop on the page', () => {
  const step = (buyers: SidePick, sellers: SidePick, shop: ShopChoice | null = SHOP) => {
    const set = vi.fn();
    const input = shopInput({ buyers, sellers, shop });
    render(<FeesStep buyers={buyers} sellers={sellers} ctx={recipeCtx(input)} collection={false} shop={shop} errorFor={() => null} set={set} />);
    const group = (side: 'Buyers’' | 'Sellers’') => screen.getByRole('group', { name: side === 'Buyers’' ? 'Buyers’ fees · in PAXG' : 'Sellers’ fees · paid in CURIO, used as PAXG' });
    return { set, buyers: group('Buyers’'), sellers: group('Sellers’') };
  };
  const names = (group: HTMLElement) => within(group).getAllByRole('button').map((b) => b.textContent);

  it('offers Into the shop on a shop’s sellers’ side only, and keeps a refused pick visible', () => {
    const page = step(pickFor('holders'), pickFor('holders'));
    expect(names(page.sellers)).toContain('Into the shop');
    expect(names(page.buyers)).not.toContain('Into the shop');
    fireEvent.click(within(page.sellers).getByRole('button', { name: 'Into the shop' }));
    expect(page.set).toHaveBeenLastCalledWith({ sellers: pickFor('shop', undefined, 2) });
    cleanup();
    expect(names(step(pickFor('holders'), pickFor('holders'), null).sellers)).not.toContain('Into the shop');
    cleanup();
    // A pick the box cannot take stays visible (v2Issues names it), as for To items and To the pile.
    expect(names(step(pickFor('shop'), pickFor('holders')).buyers)).toContain('Into the shop');
  });

  it('the ceiling: 2x, 4x and 8x the seed with their amounts, the founder’s line and the accepted warning word for word', () => {
    const page = step(pickFor('holders'), pickFor('shop', undefined, 4));
    const ceiling = within(page.sellers).getByRole('group', { name: 'Ceiling' });
    const buttons = within(ceiling).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['2x the seed2000 CURIO', '4x the seed4000 CURIO', '8x the seed8000 CURIO']);
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    expect(within(page.sellers).getByText(SHOP_FEES_LINE)).toBeTruthy();
    expect(within(page.sellers).getByText(SHOP_FEES_WARNING)).toBeTruthy();
    expect(SHOP_FEES_LINE).toBe('Fees fill the shop up to a ceiling, then go to holders.');
    expect(SHOP_FEES_WARNING).toBe('Whoever picks the collections decides who can sell into a budget the fees pay for.');
    fireEvent.click(within(ceiling).getByRole('button', { name: /^8x/ }));
    expect(page.set).toHaveBeenLastCalledWith({ sellers: pickFor('shop', undefined, 8) });
    // Pressing Into the shop again keeps the chosen ceiling.
    fireEvent.click(within(page.sellers).getByRole('button', { name: 'Into the shop' }));
    expect(page.set).toHaveBeenLastCalledWith({ sellers: pickFor('shop', undefined, 4) });
    // The details say what decides, when, and where an unwanted share goes; never as a return.
    const details = required(document.querySelector('details'));
    expect(details.textContent).toContain('The collection time decides, not the trade time');
    expect(details.textContent).toContain('the share goes to holders in PAXG');
    // "Grow the pool" is the Fees step's own choice, the one form of "grow" the rule allows (wording-v2.test.tsx).
    expect(appCopyFraming(renderedCopy(document.body).map((text) => text.replace(/\bGrow the pool\b/g, 'Add to the pool')))).toEqual([]);
    expect(document.body.textContent).not.toMatch(/profit|earn|yield|returns?\b/i);
  });

  it('before the seed is typed the ceiling shows its multiple alone', () => {
    const page = step(pickFor('holders'), pickFor('shop'), { ...SHOP, seed: '' });
    expect(within(within(page.sellers).getByRole('group', { name: 'Ceiling' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['2x the seed', '4x the seed', '8x the seed']);
  });

  it('the overview names the ceiling with its amount, and keeps the warning beside the fee rows', () => {
    const input = shopInput({ sellers: pickFor('shop', undefined, 8) });
    const ctx = recipeCtx(input);
    expect(sideText('sellers', pickFor('shop', undefined, 8), ctx, 1000n * E18)).toBe('Into the shop · ceiling 8x the seed (8000 CURIO) · paid in CURIO, used as PAXG');
    expect(sideText('sellers', pickFor('shop'), ctx)).toBe('Into the shop · ceiling 2x the seed · paid in CURIO, used as PAXG');
    const spec = buildSpecV2(input);
    const plan = creationPlan(spec, ctx.pricing, { estimate: demoCreateGas, shopSeedT: 1000n * E18 });
    render(<MemoryRouter><OverviewV2 spec={spec} hash={specHashV2(spec)} form={input.form} v2={input.v2} ctx={ctx} plan={plan} nowMs={0} fix={new Set()} run={null} owner={null} /></MemoryRouter>);
    const fees = required(screen.getByRole('heading', { name: 'Fees' }).closest('section'));
    expect(within(fees).getByText('Into the shop · ceiling 8x the seed (8000 CURIO) · paid in CURIO, used as PAXG')).toBeTruthy();
    expect(within(fees).getByText(SHOP_FEES_WARNING)).toBeTruthy();
    cleanup();
    // Another sellers' choice carries no warning.
    const holders = shopInput({ sellers: pickFor('holders') });
    const plain = buildSpecV2(holders);
    render(<MemoryRouter><OverviewV2 spec={plain} hash={specHashV2(plain)} form={holders.form} v2={holders.v2} ctx={recipeCtx(holders)} plan={plan} nowMs={0} fix={new Set()} run={null} owner={null} /></MemoryRouter>);
    expect(screen.queryByText(SHOP_FEES_WARNING)).toBeNull();
  });
});
