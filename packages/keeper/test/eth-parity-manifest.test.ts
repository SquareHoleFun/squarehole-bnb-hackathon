import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { listingRouteManifest } from '../../burn-bot/src/listing-route-manifest';
import { ethParityManifest, testCoinRates, type EthParityPin } from '../src/income-parity-manifest';
import { checkedEthParity, ethParityPin } from '../src/income-parity';

// F164 D3. No vi.mock here: these are the committed pins themselves (token-income.test.ts replaces them in one test).
// tETH and the test coins as the reviewed Sepolia records name them: tETH in the trade folder's deployment record
// (status deployed, with tETH's runtime code hash since sh-177), the coins in SH-SEPOLIA-EXAMPLES-INFRA step 3a. F156
// keeps that trade folder out of other packages' imports (apps/web/src/no-trade-source.test.ts), so the address and the
// hash are repeated here; the record itself is checked against this pin from inside the trade folder
// (packages/chain/src/trade-sepolia/coin.test.ts).
const teth: Address = '0x7156c3e4DD23F5776c26b3F6140BC03fFb7c4D5E';
const tethCodeHash: Hex = '0xd505c35f935774b06c15d563b72fc31ddab453a4c83c3e4297e2e1ba76a3ee6c';
const coins = { tUSDC: '0x5B397F65571deF193Ba5DBE8b2a353C3963c65F6', tNVDA: '0x2cbBAD2607fCCFEe778d959d386997862099f33B',
  tGOLD: '0x25f276Ce776f5C9b0686250e78EA34bF7aB4C17A', tPEPE: '0x1C5231c8BDde9ED7AA80Fe13EDb634db9Bd3E1c7',
  tLINK: '0xb1b5CDdB6Be298e9188984e53513B0db38eEa6D7', tFROG: '0x86d5c2533A78077c125630d4D1D1B2321A07Eb35' } as const;
const pin = (chainId: string, token: Address = teth): EthParityPin => ({ chainId, token, decimals: '18', codeHash: null, weiPerCoin: '1000000000000000000' });

describe('F164 D3 committed ETH parity pins', () => {
  it('every committed entry passes the parity checks', () => {
    expect(Object.isFrozen(ethParityManifest)).toBe(true);
    for (const [key, entry] of Object.entries(ethParityManifest)) {
      expect(Object.isFrozen(entry), key).toBe(true);
      expect(checkedEthParity(key, entry), key).toBe(entry);
      expect(ethParityPin(BigInt(entry.chainId), entry.token), key).toBe(entry);
    }
  });

  it('pins exactly the seven reviewed Sepolia coins and their proposed rate literals', () => {
    expect(testCoinRates).toEqual({ tETH: '1000000000000000000', tUSDC: '10000000000000000000',
      tNVDA: '10000000000000000000', tLINK: '10000000000000000000', tGOLD: '1000000000000000000000',
      tPEPE: '10000000000000000', tFROG: '10000000000000000' });
    // SH-259 widened the table by chain 97's pins (bnb-testnet-parity.test.ts); Sepolia's stay exactly these seven.
    expect(Object.keys(ethParityManifest).filter(key => key.startsWith('11155111:'))).toHaveLength(7);
    expect(ethParityPin(11155111n, teth)).toEqual({ ...pin('11155111'), codeHash: tethCodeHash });
    expect(ethParityPin(11155111n, teth.toLowerCase() as Address)).toBeDefined();
    expect(ethParityPin(1n, teth)).toBeUndefined();
    const hashes = {
      tUSDC: '0x5837487a0e4a1474c40c1e21e37f318dc24c716f1cc70fca32fb00d125ded928',
      tGOLD: '0x92b27e4de58da269118de73a7445a685069b10e13eb23355cdd5639d24c5481a',
      tFROG: '0xe61b0e2559814a1a64ca184e8ed3d9fa4455e499dc64731c3a408ba371b4d37d',
    };
    for (const [symbol, coin] of Object.entries(coins)) {
      expect(ethParityPin(11155111n, coin), symbol).toEqual({ chainId: '11155111', token: coin,
        decimals: symbol === 'tUSDC' ? '6' : '18', weiPerCoin: testCoinRates[symbol as keyof typeof coins],
        codeHash: hashes[symbol as keyof typeof hashes] ?? '0xcd10e4a3585ed7988888c647416aa7dc2d03416bef9a4f1c1a7b775e2379d650' });
    }
  });

  it.each(['0', '-1', '1.5', '1e18', '', ' 1', '01', (1n << 256n).toString(), '9'.repeat(100)])('refuses rate %s', weiPerCoin => {
    expect(() => checkedEthParity(`11155111:${teth.toLowerCase()}`, { ...pin('11155111'), weiPerCoin })).toThrow();
  });
  it.each(['0', '5', '19', '-1', '6.0', '06'])('refuses decimals %s', decimals => {
    expect(() => checkedEthParity(`11155111:${teth.toLowerCase()}`, { ...pin('11155111'), decimals })).toThrow();
  });

  it.each(['1', '10', '8453', '31337', '17000', '0'])('refuses an entry for chain %s', chainId => {
    expect(() => checkedEthParity(`${chainId}:${teth.toLowerCase()}`, pin(chainId))).toThrow(/refused/);
  });

  it.each([
    ['a non-canonical chain id', '011155111:0x7156c3e4dd23f5776c26b3f6140bc03ffb7c4d5e', pin('011155111')],
    ['a key of another token', `11155111:${'0x'.padEnd(42, '1')}`, pin('11155111')],
    ['a checksummed key', `11155111:${teth}`, pin('11155111')],
    ['the zero address', `11155111:${'0x'.padEnd(42, '0')}`, pin('11155111', `0x${'0'.repeat(40)}`)],
    ['another decimals', `11155111:${teth.toLowerCase()}`, { ...pin('11155111'), decimals: '5' }],
    ['a malformed code hash', `11155111:${teth.toLowerCase()}`, { ...pin('11155111'), codeHash: '0x1234' as Hex }],
  ] as const)('refuses %s', (_, key, entry) => {
    expect(() => checkedEthParity(key, entry)).toThrow();
  });

  it('takes a 32-byte code hash once the deploy is recorded', () => {
    const recorded = { ...pin('11155111'), codeHash: `0x${'ab'.repeat(32)}` as Hex };
    expect(checkedEthParity(`11155111:${teth.toLowerCase()}`, recorded)).toBe(recorded);
  });

  it('is keeper room only: the shared sale pins (the FIT bot\'s) hold no route for tETH', () => {
    expect(Object.values(listingRouteManifest).some(e => e.p.toLowerCase() === teth.toLowerCase())).toBe(false);
  });
});
