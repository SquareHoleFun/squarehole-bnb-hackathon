/**
 * V21-MONEY-01 in the creation flow (SH-V21-FIX-MONEY-01): the factory refuses Eat on a box coin whose listing records
 * no checked burn (`BoxTokenNeedsCheckedBurn(P)`). The page offers Eat only when the release's factory, asked through its
 * refusal() view about a probe priced in the coin, allows it; the rule itself is never repeated here.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { encodeErrorResult, encodeFunctionData, encodeFunctionResult, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateBoxSpecV2 } from '../../../../../../packages/box-spec/src/generated/box-spec.v2';
import { factoryV2Abi } from '../../../../../../packages/chain/src/core/v2/abi-v2';
import { required } from '../../core/v2/test-support/required';
import { PROBE_OWNER } from '../create-checks';
import { EAT_REFUSALS_ABI, eatAnswerV21, eatProbeSpec } from './eat-check';
import { FeesStep } from './FeesStep';
import { withEat } from './indexer-listings';
import type { TokenReader } from './issuer-powers';
import { DEMO_LISTINGS, type SiteListing } from './listings';
import { EAT_REFUSED, EAT_UNCHECKED, recipeCtx, v2Issues, V2_CONTROL } from './model';
import { eatOffered, pickFor } from './recipes';
import { BoxTypeV2, Dest, Leg, ListingClass, ListingKind } from './spec-types';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { inputV2Of } from './test-support/v2-fixtures';

afterEach(cleanup);
const FACTORY = '0x00000000000000000000000000000000000fac70' as Address;
const coin = (symbol: string) => required(DEMO_LISTINGS.find((l) => l.symbol === symbol));
const config = (id: string) => required(CONFIGURATIONS.find((entry) => entry.id === id));
/**
 * A box coin listed without a checked burn: a ledger T admitted by plain add, so its listing kind is LISTED (the
 * reviewer's case). Only the factory can tell it is a box coin; the page never reads that from the listing.
 */
const UNCHECKED: SiteListing = { ...coin('LINK'), token: '0x00000000000000000000000000000000000b0c01' as Address, id: 9, class: ListingClass.OTHER, kind: ListingKind.LISTED, symbol: 'B52', name: 'B52', checkedBurn: false, eat: undefined };
const refusalOf = (bytes: Hex): Hex => encodeFunctionResult({ abi: factoryV2Abi, functionName: 'refusal', result: bytes });
const needsCheckedBurn = (token: Address): Hex => encodeErrorResult({ abi: EAT_REFUSALS_ABI, errorName: 'BoxTokenNeedsCheckedBurn', args: [token] });
/** A chain that answers one refusal() call to the factory, and checks it was asked exactly that. */
function factoryAnswering(listing: SiteListing, reply: Hex | null): TokenReader & { readonly asked: ReturnType<typeof vi.fn> } {
  const asked = vi.fn(async (to: Address, data: Hex) => {
    expect(to).toBe(FACTORY);
    expect(data).toBe(encodeFunctionData({ abi: factoryV2Abi, functionName: 'refusal', args: [eatProbeSpec(listing), PROBE_OWNER] }));
    return reply;
  });
  return { call: asked, hasCode: async () => true, asked };
}

describe('the probe put to the factory', () => {
  it.each(DEMO_LISTINGS.map((l) => l.symbol))('priced in %s, it is a valid token box eating on both sides, so the factory reaches its Eat rule', (symbol) => {
    const listing = coin(symbol);
    const spec = eatProbeSpec(listing);
    expect(validateBoxSpecV2(spec, { listing })).toEqual({ reason: 0, field: 0 });
    expect(spec.boxType).toBe(BoxTypeV2.TOKEN_ONLY);
    expect(spec.pricing).toEqual({ listingId: listing.id, token: listing.token });
    for (const side of [spec.buyers, spec.sellers]) expect([side.a.leg, side.a.dest]).toEqual([Leg.AsPaid, Dest.Eat]);
  });
});

describe('the factory’s answer', () => {
  it('BoxTokenNeedsCheckedBurn naming this coin refuses Eat; an empty answer allows it', async () => {
    const refused = factoryAnswering(UNCHECKED, refusalOf(needsCheckedBurn(UNCHECKED.token)));
    expect(await eatAnswerV21(refused, FACTORY, UNCHECKED)).toBe('refused');
    expect(refused.asked).toHaveBeenCalledOnce();
    expect(await eatAnswerV21(factoryAnswering(coin('LINK'), refusalOf('0x')), FACTORY, coin('LINK'))).toBe('allowed');
  });

  it('any other answer concludes nothing: another coin named, another refusal, a revert; a failed read stays a failure', async () => {
    expect(await eatAnswerV21(factoryAnswering(UNCHECKED, refusalOf(needsCheckedBurn(coin('FIT').token))), FACTORY, UNCHECKED)).toBeNull();
    const invalid = encodeErrorResult({ abi: factoryV2Abi, errorName: 'InvalidSpec', args: [17, 3] });
    expect(await eatAnswerV21(factoryAnswering(UNCHECKED, refusalOf(invalid)), FACTORY, UNCHECKED)).toBeNull();
    expect(await eatAnswerV21(factoryAnswering(UNCHECKED, null), FACTORY, UNCHECKED)).toBeNull();
    const down: TokenReader = { call: async () => { throw new Error('RPC down'); }, hasCode: async () => true };
    await expect(eatAnswerV21(down, FACTORY, UNCHECKED)).rejects.toThrow('RPC down');
  });

  it('each listing carries its own answer; one not answered stays unknown', () => {
    const [eth, link] = [coin('ETH'), coin('LINK')].map((l) => ({ ...l, eat: undefined }));
    expect(withEat([required(eth), required(link), UNCHECKED], ['allowed', null, 'refused']).map((l) => l.eat)).toEqual(['allowed', undefined, 'refused']);
  });
});

describe('the Fees step and its checks', () => {
  const inputFor = (listing: SiteListing, buyers = pickFor('burn')) => ({
    ...inputV2Of(config('rug-rugs'), { pricing: listing.token, buyers }, { contents: 'token', ticker: 'RUGS' }),
    listings: [...DEMO_LISTINGS.filter((l) => l.id !== listing.id), listing],
  });
  const menu = (listing: SiteListing, buyers = pickFor('burn')) => {
    render(<FeesStep buyers={buyers} sellers={pickFor('burn')} ctx={recipeCtx(inputFor(listing, buyers))} collection={false} errorFor={() => null} set={vi.fn()} />);
    const group = screen.getByRole('group', { name: `Buyers’ fees · in ${listing.symbol}` });
    return within(group).getAllByRole('button').map((b) => b.textContent);
  };

  it('a box coin the factory refuses to eat: no Burn or Lock on the menu, and a pick made before is named at Fees', () => {
    const refused = { ...UNCHECKED, eat: 'refused' as const };
    expect(eatOffered(refused)).toBe(false);
    expect(menu(refused)).toEqual(['Keep', 'Buy back and burn RUGS', 'Grow the pool', 'To holders']);
    cleanup();
    expect(menu(refused, pickFor('eat'))).toContain('Lock B52');
    expect(v2Issues(inputFor(refused, pickFor('eat')))).toContainEqual({ step: 'v2-fees', control: V2_CONTROL.buyers, message: EAT_REFUSED('B52') });
    expect(EAT_REFUSED('B52')).toBe('B52 is a box coin with no checked burn, so it cannot be eaten.');
  });

  it('until the factory answers, Eat is not offered; once it allows, Burn or Lock is', () => {
    expect(menu(UNCHECKED)).not.toContain('Lock B52');
    expect(v2Issues(inputFor(UNCHECKED, pickFor('eat')))).toContainEqual({ step: 'v2-fees', control: V2_CONTROL.buyers, message: EAT_UNCHECKED('B52') });
    cleanup();
    expect(menu({ ...coin('FIT'), eat: 'allowed' })).toContain('Burn FIT');
    cleanup();
    expect(menu({ ...coin('LINK'), eat: 'allowed' })).toContain('Lock LINK');
    expect(v2Issues(inputFor({ ...coin('LINK'), eat: 'allowed' }, pickFor('eat')))).toEqual([]);
  });
});
