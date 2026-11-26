import { describe, expect, it } from 'vitest';
import { checkRoyaltyLot, proposeRoyaltyLot } from '../royalty-lots.mjs';
import { H } from './rpc.mjs';

const price = (tokenAmount: string, wethAmount: string) => ({ tokenAmount, wethAmount,
  source: 'synthetic fixture only', blockNumber: '1000', blockHash: H(1000), timestamp: '2008000' });

describe('LL-06: exact CW2 valuation and readable lots', () => {
  it.each([
    ['USDC', 6n, 'STABLE', '1000000', '500000000000000', 100000000n],
    ['WBTC', 8n, 'OTHER', '100000000', '32000000000000000000', 160000n],
    ['stock', 18n, 'STOCK', '1000000000000000000', '100000000000000000', 2500000000000000000n],
    ['cheap coin', 18n, 'OTHER', '1000000000000000000', '1000000000', 50000000000000000000000000n],
    ['round half up', 6n, 'STABLE', '125000000', '50000000000000000', 130000000n],
    ['fair whole coin', 6n, 'OTHER', '1000000', '50000000000000000', 1100000n],
    ['one raw unit', 6n, 'OTHER', '1', '100000000000000000', 1n],
  ])('%s gets a readable, non-default lot without losing precision', (_name, decimals, coinClass, tokens, weth, expected) => {
    const recorded = price(tokens, weth);
    expect(proposeRoyaltyLot(decimals, coinClass, recorded)).toBe(expected);
    expect(() => checkRoyaltyLot(expected, decimals, coinClass, recorded)).not.toThrow();
  });

  it('rejects the whole-coin default even when its price meets the target', () => {
    expect(() => checkRoyaltyLot(1000000n, 6n, 'OTHER', price('1000000', '50000000000000000')))
      .toThrow(/default whole-coin/);
  });

  it('refuses a price with no representable raw lot and the contract hourly-overflow boundary', () => {
    expect(() => proposeRoyaltyLot(6n, 'OTHER', price('1', '100000000000000001'))).toThrow(/lot outside/);
    const max = ((1n << 256n) - 1n) / 20n;
    expect(() => checkRoyaltyLot(max, 18n, 'OTHER', price(max.toString(), '50000000000000000'))).not.toThrow();
    expect(() => checkRoyaltyLot(max + 1n, 18n, 'OTHER', price(max.toString(), '50000000000000000'))).toThrow(/contract bounds/);
    expect(() => proposeRoyaltyLot(18n, 'OTHER', price(((1n << 256n) - 1n).toString(), '1'))).toThrow(/contract bounds/);
  });

  it.each([
    { tokenAmount: '0' }, { wethAmount: '0' }, { wethAmount: 1 }, { wethAmount: '1.0' },
    { wethAmount: '-1' }, { tokenAmount: (1n << 256n).toString() }, { source: ' ' },
    { blockHash: H(0) }, { timestamp: '0' }, { blockNumber: 1000 },
  ])('refuses malformed recorded prices: %j', change => {
    expect(() => proposeRoyaltyLot(6n, 'STABLE', { ...price('1000000', '500000000000000'), ...change })).toThrow();
  });
});
