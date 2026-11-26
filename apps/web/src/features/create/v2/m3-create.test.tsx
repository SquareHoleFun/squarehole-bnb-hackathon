/**
 * M3-53 in the creation flow: "To items" with its in-vault rule (Keep or Burn, R43-M3A) and a token-only box's coin
 * pile (seed coin and exact seed, R43-M3D/M3E). The generated M3-10 twin decides canonical bytes; the site's builder
 * must produce exactly what it accepts, and refuse what it refuses, before any wallet is involved.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { decodeAbiParameters } from 'viem';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../../app-providers';
import { Shell } from '../../../shell/Shell';
import { createDemoWalletAdapter } from '../../wallet';
import { CreatePage } from '../CreatePage';
import { resetDraftForTests } from '../draft';
import { validateBoxSpecV2 } from '../../../../../../packages/box-spec/src/generated/box-spec.v2';
import { required } from '../../core/v2/test-support/required';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { creationPlan, demoCreateGas } from './creation-plan';
import { FeesStep } from './FeesStep';
import { DEMO_LISTINGS } from './listings';
import { buildSpecV2, pileSeedOf, recipeCtx, v2Issues, type V2Choices } from './model';
import { INSIDE, choiceOf, insideOf, pickFor, sideOf } from './recipes';
import { BoxTypeV2, Dest, Leg } from './spec-types';
import { inputV2Of, seedV2 } from './test-support/v2-fixtures';
import { resetV2ForTests, updateV2 } from './v2-draft';

const config = (id: string) => required(CONFIGURATIONS.find((entry) => entry.id === id));
const coin = (symbol: string) => required(DEMO_LISTINGS.find((l) => l.symbol === symbol));
const keep = pickFor('items', INSIDE.keep);
const burn = pickFor('items', INSIDE.burn);

beforeEach(() => { resetDraftForTests(); resetV2ForTests(); });
afterEach(cleanup);

describe('M3-53 every-item payouts in the spec', () => {
  it('encodes Keep and Burn as the exact 32-byte ItemsDestParams, never a missing byte', () => {
    expect(sideOf(keep).a).toMatchObject({ leg: Leg.AsPaid, dest: Dest.Items, destParams: `0x${'0'.repeat(63)}1` });
    expect(sideOf(burn).a.destParams).toBe(`0x${'0'.repeat(63)}2`);
    expect(choiceOf(keep)).toBe('items'); expect(insideOf(burn)).toBe(2);
    // An items pick without its rule is not a menu button.
    expect(choiceOf({ ...keep, a: { ...keep.a, inside: undefined } })).toBeNull();
  });
  it.each(['ETH', 'USDC', 'WBTC', 'NVDAon'])('the generated validator accepts items on either side, mixed rules, in %s', (symbol) => {
    const listing = coin(symbol);
    for (const [buyers, sellers] of [[keep, keep], [keep, burn], [burn, pickFor('holders')], [pickFor('burn'), burn]] as const) {
      const input = inputV2Of(config('bag-holders'), { pricing: listing.token, buyers, sellers });
      expect(v2Issues(input)).toEqual([]);
      const spec = buildSpecV2(input);
      expect(spec.boxType).toBe(BoxTypeV2.NEW_COLLECTION);
      expect(validateBoxSpecV2(spec, { listing })).toEqual({ reason: 0, field: 0 });
    }
  });
  it('refuses items on a token-only box or a pile, at Fees, as the validator does', () => {
    for (const pile of [null, { asset: coin('USDC').token, seed: '5' }]) {
      const input = inputV2Of(config('rug-rugs'), { buyers: keep, pile }, { contents: 'token' });
      expect(v2Issues(input)).toContainEqual({ step: 'v2-fees', control: 'create-v2-buyers', message: 'To items needs a new collection.' });
      expect(validateBoxSpecV2(buildSpecV2(input), { listing: recipeCtx(input).pricing }).reason).not.toBe(0);
    }
  });
});

describe('M3-53 the coin pile in the spec and the plan', () => {
  it.each([
    ['USDC', '1000', 1_000_000_000n],
    ['WBTC', '0.00000001', 1n],
    ['ETH', '2.5', 2_500_000_000_000_000_000n],
    ['USDC', '0', 0n],
    ['LINK', '123456789012345678901234567890.123456789012345678', 123456789012345678901234567890123456789012345678n],
  ])('a %s seed of %s is exact raw units in a canonical 64-byte PileParams', (symbol, seed, raw) => {
    const asset = coin(symbol).token;
    const input = inputV2Of(config('dragons-hoard'), { pile: { asset, seed } });
    expect(v2Issues(input)).toEqual([]);
    const spec = buildSpecV2(input);
    expect(spec).toMatchObject({ boxType: BoxTypeV2.PILE, n: 0, firstId: 0n, pickFeeBps: 0, collectionName: '' });
    expect((spec.contentsParams.length - 2) / 2).toBe(64);
    const [decodedAsset, decodedSeed] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], spec.contentsParams);
    expect([decodedAsset.toLowerCase(), decodedSeed]).toEqual([asset.toLowerCase(), raw]);
    expect(validateBoxSpecV2(spec, { listing: recipeCtx(input).pricing })).toEqual({ reason: 0, field: 0 });
    expect(pileSeedOf(input)?.amount).toBe(raw);
  });
  it.each([['1.0000001', 'USDC'], ['-1', 'USDC'], ['1e6', 'USDC'], ['abc', 'ETH']])('refuses the seed text %s for %s, at Contents', (seed, symbol) => {
    const input = inputV2Of(config('dragons-hoard'), { pile: { asset: coin(symbol).token, seed } });
    expect(v2Issues(input).map((i) => [i.step, i.control])).toContainEqual(['v2-contents', 'create-v2-pile-seed']);
  });
  it('refuses a seed coin that is off the menu and ignores a pile once the box has a collection', () => {
    expect(v2Issues(inputV2Of(config('dragons-hoard'), { pile: { asset: '0x00000000000000000000000000000000000000aa', seed: '1' } })).map((i) => i.control)).toContain('create-v2-pile-coin');
    const collection = buildSpecV2(inputV2Of(config('bag-holders'), { pile: { asset: coin('USDC').token, seed: '1' } }));
    expect(collection).toMatchObject({ boxType: BoxTypeV2.NEW_COLLECTION, contentsParams: '0x' });
  });
  it('the plan loads the seed after createBox: an exact ERC-20 approval and pull, or the exact native value; never in the creation payment', () => {
    const plan = (seedCoin: string, seed: string) => {
      const input = inputV2Of(config('dragons-hoard'), { pile: { asset: coin(seedCoin).token, seed } });
      const spec = buildSpecV2(input);
      return creationPlan(spec, recipeCtx(input).pricing, { estimate: demoCreateGas, seed: pileSeedOf(input) });
    };
    const usdc = plan('USDC', '1000');
    expect(usdc.steps.map((s) => s.call)).toEqual(['createBox', 'approveSeed', 'loadSeed']);
    expect(usdc.steps[1]).toMatchObject({ amount: 1_000_000_000n });
    expect(usdc.steps[2]).toMatchObject({ value: 0n, amount: 1_000_000_000n });
    const eth = plan('ETH', '0.5');
    expect(eth.steps.map((s) => s.call)).toEqual(['createBox', 'loadSeed']);
    expect(eth.steps[1]).toMatchObject({ value: 500_000_000_000_000_000n });
    expect(eth.steps[0]?.value).toBe(plan('ETH', '0').steps[0]?.value);
    expect(plan('USDC', '0').steps.map((s) => s.call)).toEqual(['createBox']);
  });
});

function renderStep(step: string) {
  render(<AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}><MemoryRouter initialEntries={[`/create/${step}`]}><Routes>
    <Route element={<Shell />}><Route path="create/:step" element={<CreatePage demoStepMs={0} v2Listings={DEMO_LISTINGS} />} /></Route>
  </Routes></MemoryRouter></AppProviders>);
}
/** The v2 store's current choices, read through its one writer (it returns them unchanged). */
function current(): V2Choices | null {
  let seen: V2Choices | null = null;
  updateV2((choices) => { seen = choices; return choices; });
  return seen;
}

describe('M3-53 the Fees and Contents steps', () => {
  it('offers To items only with a collection, and its in-vault rule starts at Keep', () => {
    const set = vi.fn();
    const input = inputV2Of(config('bag-holders'));
    const { rerender } = render(<FeesStep buyers={pickFor('burn')} sellers={keep} ctx={recipeCtx(input)} collection={false} errorFor={() => null} set={set} />);
    const buyers = () => screen.getByRole('group', { name: 'Buyers’ fees · in ETH' });
    expect(within(buyers()).queryByRole('button', { name: 'To items' })).toBeNull();
    // A stale items pick stays visible so its message has a place.
    expect(within(screen.getByRole('group', { name: 'Sellers’ fees · paid in TOTE, used as ETH' })).getByRole('button', { name: 'To items' }).getAttribute('aria-pressed')).toBe('true');
    rerender(<FeesStep buyers={pickFor('burn')} sellers={keep} ctx={recipeCtx(input)} collection errorFor={() => null} set={set} />);
    fireEvent.click(within(buyers()).getByRole('button', { name: 'To items' }));
    expect(set).toHaveBeenLastCalledWith({ buyers: keep });
    const vault = within(screen.getByRole('group', { name: 'Sellers’ fees · paid in TOTE, used as ETH' })).getByRole('group', { name: /In the vault/ });
    expect(within(vault).getByRole('button', { name: 'Keep in the vault' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(vault).getByRole('button', { name: 'Buy back and burn TOTE in the vault' }));
    expect(set).toHaveBeenLastCalledWith({ sellers: burn });
    fireEvent.click(within(vault).getByRole('button', { name: /About items in the vault/ }));
    expect(screen.getByText(/Undrawn items share one hidden pool/)).toBeTruthy();
    expect(screen.getByText(/the Misfits’ way/)).toBeTruthy();
  });
  it('a token-only box adds a coin pile on Contents: seed coin, exact seed and the one no-rescue line', async () => {
    seedV2(config('rug-rugs'));
    renderStep('v2-contents');
    const pile = screen.getByRole('group', { name: /Coin pile/ });
    await act(async () => fireEvent.click(within(pile).getByRole('radio', { name: /Coin pile/ })));
    await act(async () => fireEvent.click(within(screen.getByRole('group', { name: 'Seed coin' })).getByRole('radio', { name: 'USDC' })));
    const seed = screen.getByRole('textbox', { name: /Seed · USDC/ });
    await act(async () => fireEvent.change(seed, { target: { value: '1000' } }));
    expect(screen.getByText('Coins sent to the pile by mistake cannot be recovered.')).toBeTruthy();
    expect(current()?.pile).toEqual({ asset: coin('USDC').token, seed: '1000', leaveBehindBps: 0 });
    await act(async () => fireEvent.click(within(pile).getByRole('radio', { name: 'None' })));
    expect(current()?.pile).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Seed/ })).toBeNull();
  });
  it('the coin pile follows the tiles directly, and a collection’s pick fee its fields, both before Coming later (FE3)', async () => {
    const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    seedV2(config('dragons-hoard'));
    renderStep('v2-contents');
    const later = screen.getByRole('region', { name: 'Coming later' });
    const tiles = required(screen.getByRole('radio', { name: /^Token/ }).closest('fieldset'));
    const pile = screen.getByRole('group', { name: /Coin pile/ });
    // Tiles, then the pile and its fields, then Coming later: nothing else in between.
    expect(tiles.nextElementSibling).toBe(pile);
    for (const part of [pile, screen.getByRole('group', { name: 'Seed coin' }), screen.getByRole('textbox', { name: /Seed · USDC/ }), screen.getByText('Coins sent to the pile by mistake cannot be recovered.')]) {
      expect(before(part, later)).toBe(true);
    }
    cleanup(); resetDraftForTests(); resetV2ForTests();
    seedV2(config('bag-holders'));
    renderStep('v2-contents');
    expect(before(screen.getByRole('group', { name: /Pick fee/ }), screen.getByRole('region', { name: 'Coming later' }))).toBe(true);
  });
  it('the Overview names the pile and its seed, and lists the seed steps', async () => {
    seedV2(config('dragons-hoard'));
    renderStep('v2-overview');
    expect(screen.getByText('Token and coin pile')).toBeTruthy();
    expect(screen.getAllByText('1000 USDC').length).toBeGreaterThan(0);
    expect(screen.getByText('approve seed · 1000 USDC')).toBeTruthy();
    expect(screen.getByText('loadSeed · 1000 USDC')).toBeTruthy();
  });
  it('the Overview names the in-vault rule of each items side', () => {
    seedV2(config('bag-holders'));
    updateV2((choices) => ({ ...choices, sellers: burn }));
    renderStep('v2-overview');
    expect(screen.getByText('To items · Keep · in ETH')).toBeTruthy();
    expect(screen.getByText('To items · Buy back and burn TOTE · paid in TOTE, used as ETH')).toBeTruthy();
  });
  it('a Demo Create of a seeded pile waits for its seed, then opens', async () => {
    seedV2(config('dragons-hoard'));
    renderStep('v2-overview');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect to create' })));
    const dialog = await screen.findByRole('dialog');
    await act(async () => fireEvent.click(within(dialog).getAllByRole('radio')[0] as HTMLElement));
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: /sample wallet$/ })));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    vi.useFakeTimers();
    try {
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create' })));
      const status = () => document.querySelector('[data-create-status]')?.textContent ?? '';
      expect(status()).toMatch(/^Sending/);
      await act(async () => vi.advanceTimersByTime(1_000));
      expect(status()).toBe('Open');
    } finally {
      vi.useRealTimers();
    }
  });
});
