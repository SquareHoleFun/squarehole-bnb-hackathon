import { afterEach, describe, expect, it, vi } from 'vitest';
import { keccak256, type Address, type PublicClient } from 'viem';
import { readFileSync } from 'node:fs';
import { ethParityManifest, testCoinRates, type EthParityPin } from '../src/income-parity-manifest';
import { checkedEthParity, ETH_PARITY_CHAIN_IDS, ethParityPin, readEthParityPrice } from '../src/income-parity';

// SH-259: a box on BNB Chain testnet (97) priced in a test coin counts its income for keeper room exactly as on Sepolia
// (F164 D3): only through a reviewed literal pin per coin, at the same rate literal per symbol, checked on chain at the
// finalized block. The pins in the first tests are fixtures (obviously fake addresses); the last test checks the
// committed 97 pins against the real deployment's record (packages/contracts/deployments/bnb-testnet/97-extras.json).
const mocked = vi.hoisted(() => ({ entries: undefined as Record<string, EthParityPin> | undefined }));
vi.mock('../src/income-parity-manifest', async original => {
  const real = await original<typeof import('../src/income-parity-manifest')>();
  return { ...real, get ethParityManifest() { return mocked.entries ?? real.ethParityManifest; } };
});
afterEach(() => { mocked.entries = undefined; });

const code = '0x6000600060006000';
const tNVDA: Address = '0x9797979797979797979797979797979797970001';
const tUSDC: Address = '0x9797979797979797979797979797979797970002';
const pin = (token: Address, decimals: string, weiPerCoin: string, chainId = '97'): EthParityPin =>
  ({ chainId, token, decimals, codeHash: keccak256(code), weiPerCoin });
const key = (p: EthParityPin) => `${p.chainId}:${p.token.toLowerCase()}`;
function client(chainId: number, decimals: bigint) {
  return { getChainId: vi.fn(async () => chainId), getBytecode: vi.fn(async () => code), readContract: vi.fn(async () => decimals) };
}
const block = { number: 5_000_000n, timestamp: 1_800_000_000n };

describe('SH-259: keeper room for test coins on BNB Chain testnet (97)', () => {
  it('admits chain 97 beside Sepolia, and no other chain', () => {
    expect(ETH_PARITY_CHAIN_IDS).toEqual(['11155111', '97']);
    const nvda = pin(tNVDA, '18', testCoinRates.tNVDA);
    expect(checkedEthParity(key(nvda), nvda)).toBe(nvda);
    for (const chainId of ['56', '204', '5611', '1', '31337']) {
      const other = pin(tNVDA, '18', testCoinRates.tNVDA, chainId);
      expect(() => checkedEthParity(key(other), other), chainId).toThrow(/refused/);
    }
  });

  it('finds a 97 pin on chain 97 only: the same address on Sepolia has no pin', () => {
    const nvda = pin(tNVDA, '18', testCoinRates.tNVDA);
    mocked.entries = { [key(nvda)]: nvda };
    expect(ethParityPin(97n, tNVDA)).toBe(nvda);
    expect(ethParityPin(11155111n, tNVDA)).toBeUndefined();
    expect(ethParityPin(56n, tNVDA)).toBeUndefined();
  });

  it.each([
    ['tNVDA', tNVDA, 18n, testCoinRates.tNVDA],
    ['tUSDC', tUSDC, 6n, testCoinRates.tUSDC],
  ] as const)('values %s in tBNB wei at the reviewed rate literal', async (_, token, decimals, rate) => {
    const p = pin(token, decimals.toString(), rate);
    mocked.entries = { [key(p)]: p };
    const pub = client(97, decimals);
    const price = await readEthParityPrice(pub as unknown as PublicClient, token, block);
    expect(price?.quote(10n ** decimals)).toBe(BigInt(rate));
    expect(price?.quote(3n * 10n ** decimals / 2n)).toBe(3n * BigInt(rate) / 2n);
    expect(price?.route).toBe(['eth-parity', '97', token, decimals.toString(), p.codeHash, rate].join(':').toLowerCase());
    expect(pub.getBytecode).toHaveBeenCalledWith({ address: token, blockNumber: block.number });
  });

  it('counts nothing for a 97 coin whose code or decimals differ on chain', async () => {
    const p = pin(tNVDA, '18', testCoinRates.tNVDA);
    mocked.entries = { [key(p)]: p };
    const wrongCode = client(97, 18n);
    wrongCode.getBytecode.mockResolvedValue('0x6001');
    await expect(readEthParityPrice(wrongCode as unknown as PublicClient, tNVDA, block)).rejects.toMatchObject({ code: 'PIN_INVALID' });
    await expect(readEthParityPrice(client(97, 6n) as unknown as PublicClient, tNVDA, block)).rejects.toMatchObject({ code: 'PIN_INVALID' });
    mocked.entries = { [key(p)]: { ...p, codeHash: null } };
    await expect(readEthParityPrice(client(97, 18n) as unknown as PublicClient, tNVDA, block)).rejects.toMatchObject({ code: 'PIN_INVALID' });
  });
});

describe('SH-259: the committed pins of chain 97 are the release deployment\'s test coins', () => {
  const extras = JSON.parse(readFileSync(new URL('../../contracts/deployments/bnb-testnet/97-extras.json', import.meta.url), 'utf8')) as {
    chainId: number; coins: Record<string, { address: string; codeHash: string }>;
    listings: { token: string; decimals: number }[];
  };
  const committed = Object.entries(ethParityManifest).filter(([k]) => k.startsWith('97:'));

  it('pins exactly the five coins of the deployment, each at its symbol\'s rate, decimals and runtime code hash', () => {
    expect(extras.chainId).toBe(97);
    expect(committed).toHaveLength(5);
    for (const [symbol, coin] of Object.entries(extras.coins)) {
      const entry = ethParityManifest[`97:${coin.address.toLowerCase()}`];
      const listing = extras.listings.find((l) => l.token.toLowerCase() === coin.address.toLowerCase());
      expect(entry, symbol).toBeDefined();
      expect(entry?.token.toLowerCase(), symbol).toBe(coin.address.toLowerCase());
      expect(entry?.codeHash, symbol).toBe(coin.codeHash);
      expect(entry?.decimals, symbol).toBe(String(listing?.decimals));
      expect(entry?.weiPerCoin, symbol).toBe(testCoinRates[symbol as keyof typeof testCoinRates]);
    }
  });

  it('every committed 97 pin passes the parity checks and is found on chain 97 only', () => {
    for (const [key, entry] of committed) {
      expect(checkedEthParity(key, entry), key).toBe(entry);
      expect(ethParityPin(97n, entry.token), key).toBe(entry);
      expect(ethParityPin(11155111n, entry.token), key).toBeUndefined();
    }
  });
});
