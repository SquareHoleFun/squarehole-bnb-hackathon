/** Quote-denominated chain figures (SH-C): exact truncation (never rounds up) and the view of a chain market. */
import type { ChainPairMarket } from '@squarehole/chain';
import { describe, expect, it } from 'vitest';
import { chainMarketView, formatQuoteFigure, truncateSignificant } from './chain-markets';

describe('truncateSignificant', () => {
  it('keeps the first N significant digits and never rounds up', () => {
    expect(truncateSignificant('0.00000000146811112211814416', 6)).toBe('0.00000000146811');
    expect(truncateSignificant('0.000000001999999999', 3)).toBe('0.00000000199');
    expect(truncateSignificant('1234567.891', 6)).toBe('1234567');
    expect(truncateSignificant('12.3456789', 6)).toBe('12.3456');
    expect(truncateSignificant('0', 6)).toBe('0');
    expect(truncateSignificant('0.000', 6)).toBe('0');
    expect(truncateSignificant('5', 6)).toBe('5');
    expect(truncateSignificant('0.10000', 6)).toBe('0.1');
  });
});

describe('formatQuoteFigure (feed cells: bounded width, never rounded up)', () => {
  it('keeps at most 6 significant digits and 6 decimals, grouped; compact from one million', () => {
    expect(formatQuoteFigure('1071614541000000000000', 18)).toBe('1,071.61');
    expect(formatQuoteFigure('545789191', 6)).toBe('545.789');
    expect(formatQuoteFigure('101187000000000000', 18)).toBe('0.101187');
    expect(formatQuoteFigure('264784270796915962', 18)).toBe('0.264784');
    expect(formatQuoteFigure('999999999999', 6)).toBe('999,999');
    expect(formatQuoteFigure('1234567890000', 6)).toBe('1.2M');
    expect(formatQuoteFigure('1', 18)).toBe('<0.000001');
    expect(formatQuoteFigure('0', 18)).toBe('0');
    expect(formatQuoteFigure('1999999', 6)).toBe('1.99999');
  });

  it('never exceeds 9 characters below one trillion', () => {
    for (const raw of ['1', '123456', '99999999999999', '123456789012345678', '999999999999999999999999', '987654321987654321987']) {
      expect(formatQuoteFigure(raw, 18).length).toBeLessThanOrEqual(9);
    }
  });
});

describe('chainMarketView', () => {
  const base = {
    pairId: '31337:0x8acd',
    chainId: 31337,
    block: { number: '63', hash: '0xabc', timestamp: '2026-09-26T00:00:00Z' },
    quote: { chainId: 31337, address: '0x0000000000000000000000000000000000000001', symbol: 'WETH', decimals: 18, issuerStatus: 'mock', kind: 'local_mock', family: null },
    priceQPerT: { available: true, display: '0.00000000146811112211814416', num: '1', den: '1', basis: 'pool_mid_price_slot0' },
    marketCapQRaw: { available: true, value: '264784270796915962', basis: 'mid_price_x_ledger_eligible_supply' },
    fdvQRaw: { available: true, value: '1464497278650756084', basis: 'mid_price_x_current_supply' },
    turnover24hQ: { available: false, reason: 'the index does not cover the window' },
    provenance: { state: 'fresh', asOf: '2026-09-26T00:00:00Z', source: 'test', coverage: 'canonical_markets' },
  } as unknown as ChainPairMarket;

  it('shows price, market cap and FDV in the quote asset, truncated; unavailable stays null (never zero)', () => {
    expect(chainMarketView(base)).toEqual({
      price: '0.00000000146811 WETH',
      marketCap: '0.264784 WETH',
      fdv: '1.46449 WETH',
      turnover: null,
      quoteSymbol: 'WETH',
      block: '63',
      state: 'fresh',
    });
  });

  it('turnover in a 6-decimal quote is bounded like the other figures (the E2E Tether pair)', () => {
    const tether = {
      ...base,
      quote: { ...base.quote, symbol: 'USDT-TEST', decimals: 6 },
      turnover24hQ: { available: true, totalRaw: '1071614541', protocolRaw: '0', otherRaw: '1071614541', swaps: 3, windowStart: '', windowEnd: '', basis: 'canonical_pool_swaps_q_leg_rolling_24h' },
      provenance: { ...base.provenance, state: 'stale' },
    } as unknown as ChainPairMarket;
    expect(chainMarketView(tether)).toMatchObject({ turnover: '1,071.61 USDT-TEST', state: 'stale' });
  });
});
