/**
 * SH-RC7-SITE-INBOX (rc7 open item 11, P2.10 item 2): the create page's read-only preview of the sale list a box created
 * now copies, with each coin's lot in its own units; the box's price coin left out (it goes to the box, never on sale);
 * details on demand on the Fees step; none in the Demo.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { required } from '../../core/v2/test-support/required';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import { FeesStep } from './FeesStep';
import { DEMO_LISTINGS, NATIVE_TOKEN } from './listings';
import { DEFAULT_V2, recipeCtx } from './model';
import { SALE_LIST_OFF, saleListRows, type SaleListAnswer } from './sale-list';
import { inputV2Of } from './test-support/v2-fixtures';

afterEach(cleanup);
const WETH = '0x00000000000000000000000000000000000e7e00' as Address;
const OTHER = '0x0000000000000000000000000000000000000123' as Address;
const listing = (symbol: string) => required(DEMO_LISTINGS.find((l) => l.symbol === symbol));
const USDC = listing('USDC'); const LINK = listing('LINK'); const ETH = listing('ETH');
const LIST = { version: 9n, complete: true, coins: [{ coin: WETH, lot: 5n * 10n ** 16n }, { coin: USDC.token, lot: 100_000_000n }, { coin: LINK.token, lot: 25n * 10n ** 17n }, { coin: OTHER, lot: 7n }] };

describe('saleListRows', () => {
  it('names each coin by the listing book with its lot in the coin’s own units; WETH by name; an unknown coin by its short address and raw units', () => {
    expect(saleListRows(LIST, LINK, DEMO_LISTINGS, WETH)).toEqual([
      { coin: WETH, name: 'WETH', lot: '0.05 WETH' }, { coin: USDC.token, name: 'USDC', lot: '100 USDC' }, { coin: OTHER, name: '0x0000…0123', lot: '7 raw units' }]);
  });
  it('leaves out the box’s price coin, and WETH for a box priced in ETH; exact beyond 2^53', () => {
    expect(saleListRows(LIST, USDC, DEMO_LISTINGS, WETH).map((row) => row.name)).toEqual(['WETH', 'LINK', '0x0000…0123']);
    expect(saleListRows(LIST, ETH, DEMO_LISTINGS, WETH).map((row) => row.name)).toEqual(['USDC', 'LINK', '0x0000…0123']);
    expect(saleListRows({ ...LIST, coins: [{ coin: OTHER, lot: 2n ** 200n + 1n }] }, ETH, DEMO_LISTINGS, WETH)[0]?.lot).toBe(`${2n ** 200n + 1n} raw units`);
    expect(NATIVE_TOKEN).toBe(ETH.token);
  });
});

describe('the Fees step’s sale list', () => {
  const fees = (saleList: SaleListAnswer | undefined, pricing = LINK) => render(<FeesStep buyers={DEFAULT_V2.buyers} sellers={DEFAULT_V2.sellers}
    ctx={recipeCtx(inputV2Of(undefined, { pricing: pricing.token }, { contents: 'token' }))} collection={false} saleList={saleList} errorFor={() => null} set={() => {}} />);

  it('lists the coins and lots on demand, read-only, with no control or field', () => {
    fees({ state: 'ready', list: LIST, weth: WETH });
    const details = required(document.querySelector<HTMLDetailsElement>('details[data-sale-list]'));
    const summary = within(details).getByText('Sale list · 3 coins', { selector: 'summary' });
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    const lot = (name: string) => within(details).getByText(name, { selector: 'dt' }).nextElementSibling?.textContent;
    expect([lot('WETH'), lot('USDC'), lot('0x0000…0123')]).toEqual(['0.05 WETH', '100 USDC', '7 raw units']);
    // SH-SITE-FIXES-10: the price coin by its own name (this box is priced in LINK), never "P".
    expect(within(details).getByText('Offered for LINK on CoW in whole lots of')).toBeTruthy();
    expect(within(details).getByText('As listed now. Your box keeps the list it is created with.')).toBeTruthy();
    expect(within(details).queryAllByRole('button')).toEqual([]);
    expect(within(details).queryAllByRole('textbox')).toEqual([]);
    expect(within(details).queryByText('Some coins could not be read.')).toBeNull();
    expect(appCopyFraming(renderedCopy(details))).toEqual([]);
  });

  it('says so while reading, when the read failed, when the list is empty or incomplete; nothing in the Demo or without the prop', () => {
    fees({ state: 'checking' });
    expect(screen.getByText('Reading the sale list…')).toBeTruthy();
    cleanup();
    fees({ state: 'failed' });
    expect(screen.getByText('Sale list unavailable.')).toBeTruthy();
    cleanup();
    fees({ state: 'ready', list: { version: 1n, complete: false, coins: [{ coin: LINK.token, lot: 1n }] }, weth: WETH });
    expect(screen.getByText('Sale list · 0 coins', { selector: 'summary' })).toBeTruthy();
    expect(screen.getByText('No coins on the sale list.')).toBeTruthy();
    expect(screen.getByText('Some coins could not be read.')).toBeTruthy();
    cleanup();
    for (const answer of [SALE_LIST_OFF, undefined]) {
      fees(answer);
      expect(document.querySelector('details[data-sale-list]')).toBeNull();
      cleanup();
    }
  });
});
