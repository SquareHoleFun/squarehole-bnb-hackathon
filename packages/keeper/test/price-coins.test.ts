import { afterEach, describe, expect, it, vi } from 'vitest';
import { keccak256, type Address, type PublicClient } from 'viem';
import { ethParityManifest, type EthParityPin } from '../src/income-parity-manifest';
import { ethParityPin, readEthParityPrice } from '../src/income-parity';
import { IncomeValuationError, valuationFailureCode } from '../src/income-failure';

const mocked = vi.hoisted(() => ({ entries: undefined as Record<string, EthParityPin> | undefined }));
vi.mock('../src/income-parity-manifest', async original => {
  const real = await original<typeof import('../src/income-parity-manifest')>();
  return { ...real, get ethParityManifest() { return mocked.entries ?? real.ethParityManifest; } };
});
const committed = Object.values(ethParityManifest);
const code = '0x60006000', block = { number: 100n, timestamp: 1200n };
// Independent literals and arithmetic: changing the proposed rates requires reviewing these seven rows too.
const cases = [
  ['tETH', '0x7156c3e4DD23F5776c26b3F6140BC03fFb7c4D5E', 18n, 1_000_000_000_000_000_000n],
  ['tUSDC', '0x5B397F65571deF193Ba5DBE8b2a353C3963c65F6', 6n, 10_000_000_000_000_000_000n],
  ['tNVDA', '0x2cbBAD2607fCCFEe778d959d386997862099f33B', 18n, 10_000_000_000_000_000_000n],
  ['tLINK', '0xb1b5CDdB6Be298e9188984e53513B0db38eEa6D7', 18n, 10_000_000_000_000_000_000n],
  ['tGOLD', '0x25f276Ce776f5C9b0686250e78EA34bF7aB4C17A', 18n, 1_000_000_000_000_000_000_000n],
  ['tPEPE', '0x1C5231c8BDde9ED7AA80Fe13EDb634db9Bd3E1c7', 18n, 10_000_000_000_000_000n],
  ['tFROG', '0x86d5c2533A78077c125630d4D1D1B2321A07Eb35', 18n, 10_000_000_000_000_000n],
] as const;
function fixture(token: Address = cases[1][1], over: Partial<EthParityPin> = {}) {
  const found = committed.find(p => p.token === token);
  if (!found) throw new Error('fixture pin missing');
  const pin = { ...found, codeHash: keccak256(code), ...over };
  mocked.entries = { [`${pin.chainId}:${token.toLowerCase()}`]: pin };
  const pub = { getChainId: vi.fn(async () => 11155111), getBytecode: vi.fn(async () => code),
    readContract: vi.fn(async () => BigInt(pin.decimals)) };
  return { pin, pub, read: () => readEthParityPrice(pub as unknown as PublicClient, token, block) };
}
afterEach(() => { mocked.entries = undefined; });

describe('SH-236 checked fixed quotes', () => {
  it.each(cases)('%s values raw units and whole coins by independent rate arithmetic', async (_, token, decimals, rate) => {
    const f = fixture(token), price = await f.read();
    expect(f.pin.weiPerCoin).toBe(rate.toString());
    expect(price?.quote(1n)).toBe(rate / (10n ** decimals));
    expect(price?.quote(10n ** decimals)).toBe(rate);
    expect(price?.quote(11_886n)).toBe(11_886n * rate / (10n ** decimals));
    expect(f.pub.getBytecode).toHaveBeenCalledWith({ address: token, blockNumber: 100n });
    expect(f.pub.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: token, functionName: 'decimals', blockNumber: 100n }));
    expect(price?.route).toBe(['eth-parity', '11155111', token, decimals.toString(), f.pin.codeHash, rate.toString()].join(':').toLowerCase());
  });
  it('rounds fractional wei down, including dust', async () => {
    const f = fixture(cases[5][1]), p = await f.read();
    expect(p?.quote(99n)).toBe(0n);
    expect(p?.quote(101n)).toBe(1n);
    expect(p?.quote(199n)).toBe(1n);
  });
  it('rejects negative, malformed and overflowing amounts and overflowing values', async () => {
    const p = await fixture().read();
    for (const amount of [-1n, 1n << 256n, '1' as unknown as bigint]) expect(() => p?.quote(amount)).toThrow(IncomeValuationError);
    expect(p?.quote(0n)).toBe(0n);
    expect(() => p?.quote((1n << 256n) - 1n)).toThrow(/value out of range/);
    const exact = await fixture(cases[0][1]).read();
    expect(exact?.quote((1n << 256n) - 1n)).toBe((1n << 256n) - 1n);
  });
  it('rejects a null hash, a wrong runtime hash and wrong runtime decimals', async () => {
    await expect(fixture(undefined, { codeHash: null }).read()).rejects.toMatchObject({ code: 'PIN_INVALID' });
    const wrongCode = fixture(); wrongCode.pub.getBytecode.mockResolvedValue('0x6001');
    await expect(wrongCode.read()).rejects.toMatchObject({ code: 'PIN_INVALID' });
    const wrongDecimals = fixture(); wrongDecimals.pub.readContract.mockResolvedValue(18n);
    await expect(wrongDecimals.read()).rejects.toMatchObject({ code: 'PIN_INVALID' });
  });
  it('leaves unknown coins to the existing route and rejects duplicate pin identities', async () => {
    const f = fixture();
    expect(await readEthParityPrice(f.pub as unknown as PublicClient, '0x1111111111111111111111111111111111111111', block)).toBeNull();
    expect(f.pub.getBytecode).not.toHaveBeenCalled();
    mocked.entries = { ...mocked.entries, duplicate: f.pin };
    expect(() => ethParityPin(11155111n, f.pin.token)).toThrow(/ambiguous/);
  });
  it.each(['1', '10', '8453', '31337'])('rejects an injected fixed pin for chain %s', async chainId => {
    const f = fixture(undefined, { chainId });
    expect(() => ethParityPin(BigInt(chainId), f.pin.token)).toThrow(/Sepolia only/);
  });
  it('maps known failures to codes and unknown or hostile failures to OTHER', () => {
    expect(valuationFailureCode(new Error('token income route unavailable'))).toBe('VALUATION_UNAVAILABLE');
    expect(valuationFailureCode(new Error('income tick log capacity'))).toBe('INCOME_CAPACITY');
    for (const error of [new Error('https://rpc.invalid/key 0x1234'), 'PIN_INVALID', { message: 'token income route unavailable' }]) {
      expect(valuationFailureCode(error)).toBe('OTHER');
    }
  });
});
