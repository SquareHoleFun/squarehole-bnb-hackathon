/**
 * SH-V21-RC6-INT part 2 (F138, R53 G-J): a v2 collection's royalties reach its inbox and follow the fee setup, so the
 * royalty add-on always carries destination 1 and names the owner as payee, whatever a v1 draft said; the page offers
 * no destination and says what the inbox does.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { decodeAbiParameters, type Hex } from 'viem';
import { required } from '../../core/v2/test-support/required';
import { ContentsStep } from '../ContentsStep';
import { EMPTY_PAGE } from '../create-model';
import { formOf } from '../test-support/fixtures';
import { FeesStep } from './FeesStep';
import { DEMO_LISTINGS, isBoxToken } from './listings';
import { buildSpecV2, DEFAULT_V2, recipeCtx } from './model';
import { branch, type SidePick } from './recipes';
import { Dest, Leg } from './spec-types';
import { inputV2Of } from './test-support/v2-fixtures';
import { validateBoxSpecV2 } from '../../../../../../packages/box-spec/src/generated/box-spec.v2';

afterEach(cleanup);
const depth: SidePick = { a: branch(Leg.AsPaid, Dest.Depth), b: branch(0, 0), split: { kind: 'none' } };

it.each(['fees', 'creator', 'pool'] as const)('encodes destination 1 and the owner as payee for a royalty draft set to %s', (royaltyTo) => {
  const listing = required(DEMO_LISTINGS.find(l => l.symbol === 'ETH'));
  const input = inputV2Of(undefined, { pricing: listing.token, buyers: depth, sellers: depth }, { contents: 'collection', royaltyBps: 250, royaltyTo });
  const spec = buildSpecV2(input);
  const royalty = required(spec.addOns.find(a => a.id === 4));
  expect(decodeAbiParameters([{ type: 'uint16' }, { type: 'uint8' }], royalty.params as Hex)).toEqual([250, 1]);
  expect(spec.creatorFeeRecipient.toLowerCase()).toBe(required(input.owner).toLowerCase());
  expect(validateBoxSpecV2(spec, { listing })).toEqual({ reason: 0, field: 0 });
  // Royalties off: no add-on, so no payee unless a side pays the creator.
  const off = buildSpecV2({ ...input, form: { ...input.form, royaltyBps: 0 } });
  expect(off.addOns.some(a => a.id === 4)).toBe(false);
  expect(validateBoxSpecV2(off, { listing })).toEqual({ reason: 0, field: 0 });
});

it('the fee details say what the inbox does, and a box priced in another box coin hears about the 30 days', () => {
  for (const symbol of ['ETH', 'FIT']) {
    const listing = required(DEMO_LISTINGS.find(l => l.symbol === symbol));
    const input = inputV2Of(undefined, { pricing: listing.token }, { contents: 'collection' });
    render(<FeesStep buyers={DEFAULT_V2.buyers} sellers={DEFAULT_V2.sellers} ctx={recipeCtx(input)} collection errorFor={() => null} set={() => {}} />);
    // Part 3: the box offers its sale-list coins on CoW; no sale is promised.
    // SH-SITE-FIXES-10: the price coin by its own name in the details too.
    expect(screen.getByText(new RegExp(`^Every box also has an inbox for royalties and gifts in other coins\\. The box offers coins on its sale list for ${symbol} on CoW\\. If one does not sell`))).toBeTruthy();
    // Part 2 fix round (review low 4b): the payee takes in-kind coins itself; nothing is sent by itself.
    expect(screen.getByText(/If one does not sell for 30 days, your payee can take it as it is, and any other coin at any time\.$/)).toBeTruthy();
    expect(screen.queryAllByText(/^CoW cannot price box coins, so in this box such sales seldom happen and your payee can take those coins after 30 days\.$/)).toHaveLength(isBoxToken(listing) ? 1 : 0);
    expect(screen.queryByText(/sell for P through CoW|reach your payee/)).toBeNull();
    cleanup();
  }
});

it.each([['tUSDC', 'tUSDC'], [undefined, 'the price coin']] as const)('the royalty’s (i) in the v2 flow names the price coin (%s), the To holders exception, the failed box and the CoW offer (SH-245)', (priceCoin, named) => {
  const noop = () => undefined;
  render(<ContentsStep form={formOf({ royaltyBps: 250 })} set={noop} errorFor={() => null} touch={noop} art={null} commitment={null}
    collectionCover={null} page={EMPTY_PAGE} progress={null} onArt={noop} onCollectionCover={noop} onBanner={noop} onTeasers={noop}
    onPage={noop} inbox {...(priceCoin ? { priceCoin } : {})}
    pictures={{ collection: { busy: false, problem: null }, banner: { busy: false, problem: null }, teaser: { busy: false, problem: null } }} />);
  const button = screen.getByRole('button', { name: 'About the royalty' });
  fireEvent.click(button);
  expect(document.getElementById(button.getAttribute('aria-controls') ?? '')?.textContent).toBe(`Asked of marketplaces each time an item is resold; they may skip it. Royalties reach this box’s inbox. Once in ${named} they follow the buyers’ side, except To holders: that 10/15 goes into the pool. If the box fails first, they join the closing claim. The box offers coins on its sale list for ${named} on CoW; your payee can take one that does not sell for 30 days.`);
  expect(document.getElementById(button.getAttribute('aria-controls') ?? '')?.textContent).not.toMatch(/\bP\b/);
});
