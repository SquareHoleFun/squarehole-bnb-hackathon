import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { M2_GAS } from '../../../../../keeper/src/m2-gas';

describe('FINAL-ACCESS-G01: failed starter assets retain an executable keeper exit', () => {
  it('the configured return floor activates the production optional call', () => {
    const source = readFileSync(new URL('../../../../src/box-v2/interfaces/IShopVaultV2.sol', import.meta.url), 'utf8');
    const cap = source.match(/NFT_RETURN_GAS\s*=\s*([\d_]+)/)?.[1];
    if (!cap) throw new Error('Missing production NFT_RETURN_GAS');
    const stipend = BigInt(cap.replaceAll('_', ''));
    // ShopVaultV2._optional: cap + cap/63 + NFT_RETURN_RESERVE_GAS + 20000.
    const reserve = source.match(/NFT_RETURN_RESERVE_GAS\s*=\s*([\d_]+)/)?.[1];
    if (!reserve) throw new Error('Missing production NFT_RETURN_RESERVE_GAS');
    const minimum = stipend + stipend / 63n + BigInt(reserve.replaceAll('_', '')) + 20_000n;
    expect(M2_GAS.shopReturn, 'transaction floor must exceed the inner admission floor before outer work').toBeGreaterThan(minimum);
    expect(M2_GAS.shopReturn, 'Recovery.t.sol proves the measured outer envelope').toBe(2_000_000n);
  });
});
