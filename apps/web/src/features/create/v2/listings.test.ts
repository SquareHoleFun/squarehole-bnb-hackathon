import { required } from '../../core/v2/test-support/required';
import { describe, expect, it } from 'vitest';
import { DEMO_LISTINGS, amountText, bootstrapFor, offeredListings, raiseOf, raiseText, parentPath, RAISE_ETH, type SiteListing } from './listings';
import { BOOTSTRAP_ETH } from '@squarehole/box-spec';
const coin = (symbol: string) => required(DEMO_LISTINGS.find((l) => l.symbol === symbol));
describe('CQ11-E permanent price coins', () => {
  it('uses the published raise without a band or a price conversion', () => {
    for (const row of DEMO_LISTINGS) expect(raiseOf(row)).toBe(row.raise);
    expect(raiseText(coin('FIT'), coin('FIT').raise)).toBe('21034900.425 FIT');
    expect(raiseText(coin('USDC'), coin('USDC').raise)).toBe('15986.524323 USDC');
  });
  it('filters invalid raises; a repeated identity is an invalid answer, never a listing to choose', () => {
    const row = coin('LINK');
    expect(offeredListings([{ ...row, raise: 999999n }])).toEqual([]);
    expect(offeredListings([{ ...row, raise: 2n ** 128n }])).toEqual([]);
    expect(offeredListings([row, { ...row, id: row.id + 1 }])).toEqual([]);
  });
  it('offers every listed coin, in id order: no flag hides one (F151 R68-HIDE)', () => {
    const book = [...DEMO_LISTINGS].reverse();
    expect(offeredListings(book).map((l) => l.id)).toEqual(DEMO_LISTINGS.map((l) => l.id).sort((a, b) => a - b));
    expect(offeredListings(book)).toHaveLength(DEMO_LISTINGS.length);
    // The removed flag (F122 R36H's `hidden`), were a row ever to carry it, hides nothing.
    const stray = { ...coin('LINK'), hidden: true } as unknown as SiteListing;
    expect(offeredListings([stray])).toEqual([stray]);
    expect(offeredListings(book.map((l) => ({ ...l, hidden: true }) as unknown as SiteListing))).toHaveLength(DEMO_LISTINGS.length);
  });
  it('keeps large amounts and 6, 8, 18 decimal dust exact', () => {
    expect(amountText(15986524323n, coin('USDC'))).toBe('15986.524323 USDC');
    expect(amountText(1n, coin('WBTC'))).toBe('0.00000001 WBTC');
    expect(amountText(9007199254740993000000000000000001n, coin('LINK'))).toBe('9007199254740993.000000000000000001 LINK');
  });
  it('uses the listing bootstrap and rounds a derived box-coin bootstrap up', () => {
    expect(bootstrapFor(coin('ETH'), RAISE_ETH)).toBe(BOOTSTRAP_ETH);
    expect(bootstrapFor(coin('USDC'), coin('USDC').raise)).toBe(coin('USDC').bootstrap);
    const fit = coin('FIT');
    expect(bootstrapFor(fit, fit.raise)).toBe((fit.raise * BOOTSTRAP_ETH + RAISE_ETH - 1n) / RAISE_ETH);
    expect(bootstrapFor(fit, fit.raise + 1n)).toBeNull();
    expect(parentPath(fit)).toContain('/box/31337/');
  });
});
