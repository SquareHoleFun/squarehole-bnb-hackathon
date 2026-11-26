/**
 * SH-V21-FE14 (item 5): the coin picker for the price coin and a pile's seed coin, ready for hundreds of listed coins:
 * one radio group named by its legend, the coins grouped by what they are and sorted by symbol, each group showing its
 * first coins until "Show all", a search by symbol, name or address, and the chosen coin always on the page.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { getAddress, toHex, type Address } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import { COIN_GROUP_LABEL, CoinPicker, SHOWN, coinGroupOf, coinLabel, coinMatches, groupCoins, sharedSymbols } from './CoinPicker';
import { DEMO_LISTINGS, offeredListings, type SiteListing } from './listings';
import { PileStep } from './PileStep';
import { PricingPicker } from './V2Steps';
import { clearV2, updateV2 } from './v2-draft';
import { ListingClass, ListingKind } from './spec-types';
import { required } from '../../core/v2/test-support/required';

afterEach(cleanup);
const CLASSES = [ListingClass.STANDARD, ListingClass.STABLE, ListingClass.STOCK, ListingClass.OTHER] as const;
/** 300 listed coins: class by turn, every seventh a box coin, symbols C001 to C300 (some sharing a name prefix). */
const BOOK: readonly SiteListing[] = Array.from({ length: 300 }, (_, i) => {
  const n = i + 1;
  return { id: n, token: getAddress(toHex(0x1000 + n, { size: 20 })) as Address, decimals: 18, class: CLASSES[i % 4] ?? ListingClass.OTHER, kind: n % 7 === 0 ? ListingKind.BOX_TOKEN : ListingKind.LISTED,
    raise: 10n ** 21n, symbol: `C${String(n).padStart(3, '0')}`, name: n % 10 === 0 ? `Gold ${n}` : `Coin ${n}`, powers: [] };
});
const picker = (value: string | null, listings: readonly SiteListing[] = BOOK) => {
  const onChange = vi.fn();
  render(<CoinPicker id="test-coins" legend="Priced in" listings={listings} value={value} onChange={onChange} hint={(l) => `Raise ${l.id}`} />);
  return { onChange, group: screen.getByRole('group', { name: 'Priced in' }) };
};
const shown = (group: HTMLElement) => within(group).getAllByRole('radio').map((r) => (r as HTMLInputElement).value);

describe('SH-V21-FE14 the coin picker’s groups', () => {
  it('puts each coin in one group: native, stablecoins, stock-linked, box coins, other coins', () => {
    const groups = groupCoins(offeredListings(DEMO_LISTINGS), '');
    expect(groups.map(([group, coins]) => [group, coins.map((c) => c.symbol)])).toEqual([
      ['native', ['ETH']], ['stable', ['USDC']], ['stock', ['NVDAon']], ['box', ['CHOO', 'FIT']], ['other', ['LINK', 'PAXG', 'WBTC']],
    ]);
    expect(coinGroupOf({ kind: ListingKind.BOX_TOKEN, class: ListingClass.STABLE })).toBe('box');
    const all = groupCoins(BOOK, '');
    expect(all.reduce((n, [, coins]) => n + coins.length, 0)).toBe(300);
    for (const [, coins] of all) expect(coins.map((c) => c.symbol)).toEqual([...coins.map((c) => c.symbol)].sort());
  });

  it('searches by symbol or name in any case, and by the start of an address', () => {
    const coin = required(BOOK[41]);
    expect(coinMatches(coin, 'c042')).toBe(true);
    expect(coinMatches(coin, 'coin 42')).toBe(true);
    expect(coinMatches(coin, coin.token.slice(0, 10).toLowerCase())).toBe(true);
    expect(coinMatches(coin, coin.token.slice(4, 12))).toBe(false);
    expect(groupCoins(BOOK, 'gold').flatMap(([, coins]) => coins).length).toBe(30);
  });
});

describe('SH-V21-FE14 the coin picker on the page', () => {
  it('300 coins: one radio group, each group shows its first coins with Show all, and the count', () => {
    const { group } = picker(required(BOOK[0]).token);
    const groups = within(group).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([COIN_GROUP_LABEL.stable, COIN_GROUP_LABEL.stock, COIN_GROUP_LABEL.box, COIN_GROUP_LABEL.other]);
    for (const g of groups) expect(within(g).getAllByRole('radio').length).toBe(SHOWN);
    expect(shown(group)).toHaveLength(4 * SHOWN);
    expect(within(group).getByText('300 coins')).toBeTruthy();
    // One radio group: every chip shares the group's name.
    expect(new Set(within(group).getAllByRole('radio').map((r) => r.getAttribute('name')))).toEqual(new Set(['test-coins']));
    const other = required(groups[3]);
    const total = groupCoins(BOOK, '').find(([g]) => g === 'other')?.[1].length ?? 0;
    fireEvent.click(within(other).getByRole('button', { name: `Show all ${total}` }));
    expect(within(other).getAllByRole('radio')).toHaveLength(total);
    expect(appCopyFraming(renderedCopy(group))).toEqual([]);
  });

  it('a search narrows every group and says how many match; no match says so', async () => {
    const { group, onChange } = picker(null);
    const search = within(group).getByRole('searchbox', { name: 'Find a coin · Priced in' });
    await act(async () => { fireEvent.change(search, { target: { value: 'C29' } }); });
    expect(shown(group).map((token) => BOOK.find((c) => c.token === token)?.symbol).sort()).toEqual(['C290', 'C291', 'C292', 'C293', 'C294', 'C295', 'C296', 'C297', 'C298', 'C299']);
    expect(within(group).getByText('10 of 300')).toBeTruthy();
    fireEvent.click(within(group).getByRole('radio', { name: /^C297/ }));
    expect(onChange).toHaveBeenLastCalledWith(required(BOOK[296]).token);
    await act(async () => { fireEvent.change(search, { target: { value: 'zzz' } }); });
    expect(within(group).getByRole('status').textContent).toBe('No listed coin matches “zzz”.');
    expect(within(group).queryAllByRole('radio')).toHaveLength(0);
  });

  it('the chosen coin stays on the page: pinned while a short group or a search hides it', async () => {
    const far = required(BOOK.find((c) => coinGroupOf(c) === 'other' && c.id > 200));
    const { group } = picker(far.token);
    const chosen = required(group.querySelector<HTMLElement>('[data-group="chosen"]'));
    expect(within(chosen).getByRole('radio', { name: new RegExp(`^${far.symbol}`) })).toHaveProperty('checked', true);
    await act(async () => { fireEvent.change(within(group).getByRole('searchbox'), { target: { value: 'C001' } }); });
    expect(group.querySelector('[data-group="chosen"]')).not.toBeNull();
    // Once its group shows it, it is no longer pinned apart.
    await act(async () => { fireEvent.change(within(group).getByRole('searchbox'), { target: { value: far.symbol } }); });
    expect(group.querySelector('[data-group="chosen"]')).toBeNull();
    expect(within(group).getByRole('radio', { name: new RegExp(`^${far.symbol}`) })).toHaveProperty('checked', true);
  });

  it('two listed coins with one symbol are told apart by their short address; every other coin keeps its symbol', () => {
    const paxg = required(DEMO_LISTINGS.find((l) => l.symbol === 'PAXG'));
    const twin = { ...paxg, id: 99, token: getAddress('0x367761085bf3c12e5da2df99ac6e1a824612b8fb') as Address, symbol: 'paxg' };
    const book = [...offeredListings(DEMO_LISTINGS), twin];
    expect([...sharedSymbols(book)]).toEqual(['paxg']);
    expect(coinLabel(paxg, sharedSymbols(book))).toBe(`PAXG · ${paxg.token.slice(0, 6)}…${paxg.token.slice(-4)}`);
    expect(coinLabel(twin, sharedSymbols(book))).toBe('paxg · 0x3677…b8fb');
    expect(coinLabel(paxg, sharedSymbols(offeredListings(DEMO_LISTINGS)))).toBe('PAXG');
    const { group, onChange } = picker(paxg.token, book);
    const radios = within(group).getAllByRole('radio', { name: /^paxg · /i });
    expect(radios).toHaveLength(2);
    fireEvent.click(within(group).getByRole('radio', { name: /^paxg · 0x3677…b8fb/ }));
    expect(onChange).toHaveBeenLastCalledWith(twin.token);
    expect(within(group).getByRole('radio', { name: /^ETH/ })).toBeTruthy();
  });

  it('SH-256 (E8): a stored price coin no longer offered: no coin shows as chosen, and a press on the one offered coin picks it', () => {
    const usdc = required(DEMO_LISTINGS.find((l) => l.symbol === 'USDC'));
    updateV2((v2) => ({ ...v2, pricing: '0xde00c00000000000000000000000000000000099' }));
    const onPick = vi.fn();
    // The page hands the picker its fallback listing (listings.ts `listingFor`: the first offered), here the only one.
    const { rerender } = render(<PricingPicker listing={usdc} listings={[usdc]} onPick={onPick} />);
    const pricing = screen.getByRole('group', { name: 'Priced in' });
    expect(within(pricing).getAllByRole('radio').map((radio) => (radio as HTMLInputElement).checked)).toEqual([false]);
    fireEvent.click(within(pricing).getByRole('radio', { name: /^USDC/ }));
    expect(onPick).toHaveBeenLastCalledWith(usdc.token);
    act(() => updateV2((v2) => ({ ...v2, pricing: usdc.token })));
    rerender(<PricingPicker listing={usdc} listings={[usdc]} onPick={onPick} />);
    expect(within(screen.getByRole('group', { name: 'Priced in' })).getByRole('radio', { name: /^USDC/ })).toHaveProperty('checked', true);
    act(() => clearV2());
  });

  it('the price coin and the seed coin both use it, with the Demo book’s coins in their groups', () => {
    const onPick = vi.fn();
    const eth = required(DEMO_LISTINGS[0]);
    render(<PricingPicker listing={eth} listings={DEMO_LISTINGS} onPick={onPick} />);
    const pricing = screen.getByRole('group', { name: 'Priced in' });
    expect(within(pricing).getByRole('radio', { name: /^ETH/ })).toHaveProperty('checked', true);
    // The Demo's eight coins fit their groups: no search box (the founder's minimal-text rule), no Show all.
    expect(within(pricing).queryByRole('searchbox')).toBeNull();
    expect(within(pricing).queryByRole('button', { name: /^Show all/ })).toBeNull();
    const symbolOf = (token: string) => DEMO_LISTINGS.find((l) => l.token === token)?.symbol;
    expect(shown(within(pricing).getByRole('group', { name: 'Box coins' })).map(symbolOf)).toEqual(['CHOO', 'FIT']);
    fireEvent.click(within(pricing).getByRole('radio', { name: /^USDC/ }));
    expect(onPick).toHaveBeenLastCalledWith(required(DEMO_LISTINGS.find((l) => l.symbol === 'USDC')).token);
    cleanup();
    const onChange = vi.fn();
    render(<PileStep pile={{ asset: eth.token, seed: '1' }} pricing={eth} listings={DEMO_LISTINGS} onChange={onChange} errorFor={() => null} touch={() => {}} />);
    const seed = screen.getByRole('group', { name: 'Seed coin' });
    fireEvent.click(within(seed).getByRole('radio', { name: 'PAXG' }));
    expect(onChange).toHaveBeenLastCalledWith({ asset: required(DEMO_LISTINGS.find((l) => l.symbol === 'PAXG')).token, seed: '1' });
  });
});
