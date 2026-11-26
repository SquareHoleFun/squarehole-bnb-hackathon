import { required } from '../../core/v2/test-support/required';
import { describe, expect, it } from 'vitest';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { boxSpecFile, buildSpecV2, recipeCtx, v2Issues } from './model';
import { specHashV2, encodeBoxSpecV2, emptyBranch } from './spec-types';
import { inputV2Of } from './test-support/v2-fixtures';

describe('CQ11-E Demo configurations', () => {
  it.each(CONFIGURATIONS)('$id encodes a full-range box with two current fee choices', (config) => {
    const input = inputV2Of(config);
    const spec = buildSpecV2(input);
    expect(v2Issues(input)).toEqual([]);
    expect(spec.gradLayout).toBe(3);
    expect(spec.pricing.listingId).toBe(recipeCtx(input).pricing.id);
    expect(spec.raise).toBe(recipeCtx(input).pricing.raise);
    for (const side of [spec.buyers, spec.sellers]) {
      // ShopT (BuyT / BudgetOrPile) only on a shop's sellers' side (SH-V21-FE14).
      expect([[1, 2], [2, 1], [1, 4], [1, 6], [1, 8], ...(config.shop && side === spec.sellers ? [[2, 7]] : [])]).toContainEqual([side.a.leg, side.a.dest]);
      expect(side.b).toEqual(emptyBranch()); expect(side.split).toBe(1);
    }
    expect(spec.addOns.some((a) => a.id === 10)).toBe(false);
    if (config.tokenOnly) { expect(spec.n).toBe(0); expect(spec.pickFeeBps).toBe(0); }
    expect(spec.boxType).toBe(config.shop ? 4 : config.pile ? 5 : config.tokenOnly ? 3 : 1);
  });
  it('validates creator amounts in the price coin decimals against its fixed raise', () => {
    const config = required(CONFIGURATIONS.find((c) => c.pricing === 'USDC'));
    const exact = inputV2Of(config, {}, { firstIn: '1.000001' });
    expect(buildSpecV2(exact).creatorBuy).toBe(1000001n);
    expect(v2Issues(inputV2Of(config, {}, { firstIn: '0.0000001' })).some((i) => i.control === 'create-first-in')).toBe(true);
    expect(v2Issues(inputV2Of(config, {}, { firstIn: '15986.524323' })).some((i) => i.control === 'create-first-in')).toBe(true);
  });
  it('labels exported data Demo, including copied listings, and serializes raw amounts as strings', () => {
    const input = inputV2Of(); const spec = buildSpecV2(input); const ctx = recipeCtx(input);
    const body = JSON.parse(boxSpecFile(spec, { ...ctx, listings: ctx.listings.map((l) => ({ ...l })) }).parts.join(''));
    expect(body).toMatchObject({ demo: true, specHash: specHashV2(spec), encoded: encodeBoxSpecV2(spec), spec: { raise: spec.raise.toString() } });
    const real = { pricing: { ...ctx.pricing, demo: undefined }, listings: ctx.listings.map((l) => ({ ...l, demo: undefined })) };
    expect(JSON.parse(boxSpecFile(spec, real).parts.join(''))).not.toHaveProperty('demo');
  });
});
