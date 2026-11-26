import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { required } from '../../core/v2/test-support/required';
import { FeesStep } from './FeesStep';
import { DEMO_LISTINGS } from './listings';
import { sideText } from './OverviewV2';
import { INSIDE, pickFor, type RecipeCtx } from './recipes';

afterEach(cleanup);
const pricing = { ...required(DEMO_LISTINGS[0]), symbol: 'tUSDC' };
const ctx: RecipeCtx = { pricing, listings: [pricing], ticker: 'RENT' };

describe('SH-194: fees name the coin paid and the coin used', () => {
  it('labels both sides and both buyback choices, preserving their picks', () => {
    const set = vi.fn();
    render(<FeesStep buyers={pickFor('burn')} sellers={pickFor('items', INSIDE.burn)} ctx={ctx} collection errorFor={() => null} set={set} />);
    const buyers = screen.getByRole('group', { name: 'Buyers’ fees · in tUSDC' });
    const sellers = screen.getByRole('group', { name: 'Sellers’ fees · paid in RENT, used as tUSDC' });
    expect(within(buyers).getByRole('button', { name: 'Buy back and burn RENT' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(sellers).getByRole('button', { name: 'Buy back and burn RENT' }));
    expect(set).toHaveBeenLastCalledWith({ sellers: pickFor('burn') });
    const vault = within(sellers).getByRole('button', { name: 'Buy back and burn RENT in the vault' });
    expect(vault.textContent).toBe('Buy back and burn RENT');
    fireEvent.click(vault);
    expect(set).toHaveBeenLastCalledWith({ sellers: pickFor('items', INSIDE.burn) });
  });

  it('repeats the fee source and buyback token on the Overview', () => {
    expect(sideText('sellers', pickFor('burn'), ctx)).toBe('Buy back and burn RENT · paid in RENT, used as tUSDC');
    expect(sideText('sellers', pickFor('items', INSIDE.burn), ctx)).toBe('To items · Buy back and burn RENT · paid in RENT, used as tUSDC');
    expect(sideText('buyers', pickFor('burn'), ctx)).toBe('Buy back and burn RENT · in tUSDC');
    expect(sideText('sellers', pickFor('items-t', INSIDE.keep), ctx)).toBe('To items · Keep · paid in RENT, used as tUSDC · items claim RENT');
    expect(sideText('sellers', pickFor('holders-t'), ctx)).toBe('To holders · paid in RENT, used as tUSDC · holders claim RENT');
    expect(sideText('buyers', pickFor('holders-t'), ctx)).toBe('To holders · in tUSDC · holders claim RENT');
    expect(sideText('buyers', pickFor('items-t', INSIDE.keep), ctx)).toBe('To items · Keep · in tUSDC · items claim RENT');
  });

  it.each(['holders', 'items'] as const)('separates the sellers’ fee coin from the %s claim coin', choice => {
    const set = vi.fn();
    render(<FeesStep buyers={pickFor('keep')} sellers={pickFor(choice)} ctx={ctx} collection errorFor={() => null} set={set} />);
    const sellers = screen.getByRole('group', { name: 'Sellers’ fees · paid in RENT, used as tUSDC' });
    const claims = within(sellers).getByRole('group', { name: 'Claimed in' });
    expect(within(claims).getByRole('button', { name: 'Claimed in tUSDC' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(claims).getByRole('button', { name: 'Claimed in RENT' }));
    expect(set).toHaveBeenLastCalledWith({ sellers: pickFor(choice === 'items' ? 'items-t' : 'holders-t') });
    expect(within(sellers).queryByRole('group', { name: 'Paid in' })).toBeNull();
  });

  it('names the buyback choice in details, apart from burning the price coin', () => {
    const fit = { ...pricing, symbol: 'FIT', checkedBurn: true };
    render(<FeesStep buyers={pickFor('burn')} sellers={pickFor('items', INSIDE.burn)} ctx={{ ...ctx, pricing: fit }} collection errorFor={() => null} set={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: 'Burn FIT' })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'About items in the vault, sellers' }));
    expect(screen.getByText(/Keep: the share stays/).textContent).toContain('Buy back and burn RENT:');
    expect(screen.getByText(/Keep is claimable/).textContent).toContain('Buy back and burn RENT: after graduation.');
    expect(screen.getByText(/^Claimed in RENT instead:/)).toBeTruthy();
    expect(screen.queryByText(/Burn: the share|Burn buys this box/)).toBeNull();
  });

  it.each([['holders', 'tUSDC'], ['holders-t', 'RENT']] as const)('SH-194-af3: buyers’ %s says inbox money skips holders (SH-245) and distinguishes claim coins', (choice, claimCoin) => {
    render(<FeesStep buyers={pickFor(choice)} sellers={pickFor('keep')} ctx={ctx} collection={false} errorFor={() => null} set={vi.fn()} />);
    const buyers = screen.getByRole('group', { name: 'Buyers’ fees · in tUSDC' });
    expect(within(buyers).getByRole('button', { name: 'To holders' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(buyers).getByRole('button', { name: `Claimed in ${claimCoin}` }).getAttribute('aria-pressed')).toBe('true');
    const inbox = screen.getByText('In this version of the boxes, inbox money skips holders, because holders are paid from trades and inbox money has no trade behind it. Its 10/15 goes into the pool, or into the closing claim if the box fails.');
    expect(screen.queryByText('Inbox money follows the buyers’ side.')).toBeNull();
    const details = inbox.closest('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('Fee details');
    expect(inbox.previousElementSibling?.textContent).toBe('Every box also has an inbox for royalties and gifts in other coins. The box offers coins on its sale list for tUSDC on CoW. If one does not sell for 30 days, your payee can take it as it is, and any other coin at any time.');
    const priceClaims = screen.getByText('To holders, claimed in tUSDC: each holder claims its share once a batch is funded and calculated. Nothing is sent automatically. Not converted into RENT. No expiry. Holder fees claimed in tUSDC stay separate from a failed box’s closing claim.');
    expect(priceClaims.closest('details')).toBe(details);
    const boxClaims = screen.getByText('Claimed in RENT instead: after graduation the fees buy RENT in this box’s own pool, and holders or items claim that. Nothing is bought before graduation; if the box fails first, the fees join the closing claim.');
    expect(boxClaims.closest('details')).toBe(details);
  });

  it('names the box coin before a ticker is entered', () => {
    expect(sideText('sellers', pickFor('burn'), { ...ctx, ticker: '' })).toBe('Buy back and burn the box coin · paid in the box coin, used as tUSDC');
  });
});
