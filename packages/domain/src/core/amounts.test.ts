import { describe, expect, it } from 'vitest';
import { AmountError } from '../errors';
import { createPrng } from '../test-support/prng';
import {
  MAX_UINT256,
  addAmounts,
  amountOf,
  assetRef,
  compareAmounts,
  compareRatio,
  decodeAmount,
  decodeRatio,
  encodeAmount,
  encodeRatio,
  erc20AssetId,
  formatAmount,
  formatRatio,
  mockAssetId,
  mulDiv,
  nativeAssetId,
  ratio,
  ratioCeil,
  ratioFloor,
  sameAsset,
  subAmounts,
  toChainId,
  type AssetRef,
} from './index';

const SEPOLIA = toChainId(11_155_111);
const MAINNET = toChainId(1);
const FIT_ADDRESS = '0x00000000000000000000000000000000000000f1';
const FIT: AssetRef = assetRef({ id: erc20AssetId(SEPOLIA, FIT_ADDRESS), decimals: 18, symbol: 'FIT' });
const ETH: AssetRef = assetRef({ id: nativeAssetId(SEPOLIA), decimals: 18, symbol: 'ETH' });
const MAINNET_FIT: AssetRef = assetRef({ id: erc20AssetId(MAINNET, FIT_ADDRESS), decimals: 18, symbol: 'FIT' });
const MOCK_Q: AssetRef = assetRef({ id: mockAssetId('Q'), decimals: 18, symbol: 'Q' });

function amountCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof AmountError ? error.code : `unexpected ${String(error)}`;
  }
  return undefined;
}

describe('asset refs', () => {
  it('derives chain and address from the id; the symbol is presentation only', () => {
    expect(FIT).toEqual({ id: `eip155:11155111/erc20:${FIT_ADDRESS}`, standard: 'erc20', chainId: 11_155_111, address: FIT_ADDRESS, decimals: 18, symbol: 'FIT' });
    expect(ETH).toMatchObject({ standard: 'native', chainId: 11_155_111, address: null });
    expect(MOCK_Q).toMatchObject({ standard: 'mock', chainId: null, address: null });
    expect(Object.isFrozen(FIT)).toBe(true);
  });

  it('identity is id plus decimals, never the symbol', () => {
    expect(sameAsset(FIT, { ...FIT, symbol: 'OTHER' })).toBe(true);
    expect(sameAsset(FIT, MAINNET_FIT)).toBe(false);
    expect(sameAsset(FIT, ETH)).toBe(false);
  });

  it('rejects bad decimals and a same id with other decimals', () => {
    expect(amountCode(() => assetRef({ id: nativeAssetId(SEPOLIA), decimals: 37, symbol: 'ETH' }))).toBe('invalid_decimals');
    expect(amountCode(() => assetRef({ id: nativeAssetId(SEPOLIA), decimals: 1.5, symbol: 'ETH' }))).toBe('invalid_decimals');
    expect(amountCode(() => sameAsset(FIT, { ...FIT, decimals: 6 }))).toBe('asset_mismatch');
  });
});

describe('amounts (bigint in logic, bound to one asset)', () => {
  it('holds 0 to 2^256 - 1 raw units', () => {
    expect(amountOf(FIT, 0n).raw).toBe(0n);
    expect(amountOf(FIT, MAX_UINT256).raw).toBe(MAX_UINT256);
    expect(amountOf(FIT, '1000').raw).toBe(1000n);
    expect(amountCode(() => amountOf(FIT, -1n))).toBe('negative_amount');
    expect(amountCode(() => amountOf(FIT, MAX_UINT256 + 1n))).toBe('amount_out_of_range');
    expect(amountCode(() => amountOf(FIT, '1e27'))).toBe('malformed_raw_amount');
  });

  it('adds and subtracts only within one asset', () => {
    const a = amountOf(FIT, 5n);
    expect(addAmounts(a, amountOf(FIT, 7n)).raw).toBe(12n);
    expect(subAmounts(amountOf(FIT, 7n), a).raw).toBe(2n);
    expect(amountCode(() => addAmounts(a, amountOf(ETH, 1n)))).toBe('asset_mismatch');
    expect(amountCode(() => addAmounts(a, amountOf(MAINNET_FIT, 1n)))).toBe('asset_mismatch');
    expect(amountCode(() => subAmounts(a, amountOf(FIT, 6n)))).toBe('underflow');
    expect(amountCode(() => addAmounts(amountOf(FIT, MAX_UINT256), amountOf(FIT, 1n)))).toBe('amount_out_of_range');
    expect(compareAmounts(a, amountOf(FIT, 5n))).toBe(0);
    expect(compareAmounts(a, amountOf(FIT, 6n))).toBe(-1);
    expect(amountCode(() => compareAmounts(a, amountOf(ETH, 5n)))).toBe('asset_mismatch');
  });

  it('mulDiv rounds exactly as asked', () => {
    expect(mulDiv(10n, 1n, 3n, 'floor')).toBe(3n);
    expect(mulDiv(10n, 1n, 3n, 'ceil')).toBe(4n);
    expect(mulDiv(9n, 1n, 3n, 'ceil')).toBe(3n);
    expect(mulDiv(MAX_UINT256, MAX_UINT256, MAX_UINT256, 'floor')).toBe(MAX_UINT256);
    expect(amountCode(() => mulDiv(1n, 1n, 0n, 'floor'))).toBe('division_by_zero');
    expect(amountCode(() => mulDiv(-1n, 1n, 1n, 'floor'))).toBe('negative_amount');
  });
});

describe('decimal string codec', () => {
  it('encodes as { assetId, raw } and decodes only against the same asset', () => {
    const data = encodeAmount(amountOf(FIT, 123n));
    expect(data).toEqual({ assetId: FIT.id, raw: '123' });
    expect(decodeAmount(data, FIT).raw).toBe(123n);
    expect(amountCode(() => decodeAmount(data, MAINNET_FIT))).toBe('asset_mismatch');
    expect(amountCode(() => decodeAmount(data, ETH))).toBe('asset_mismatch');
  });

  it('rejects non-string and non-canonical raw values', () => {
    for (const raw of [123, 1e27, '0123', '-1', '1.0', ' 1', '0x10', '', null]) {
      expect(amountCode(() => decodeAmount({ assetId: FIT.id, raw }, FIT)), String(raw)).toBe('malformed_raw_amount');
    }
    expect(amountCode(() => decodeAmount({ raw: '1' }, FIT))).toBe('asset_mismatch');
    expect(amountCode(() => decodeAmount(null, FIT))).toBe('malformed_raw_amount');
  });

  it('round-trips exactly (seed 20260928, 2000 runs, up to 77 digits)', () => {
    const prng = createPrng(20_260_928);
    for (let run = 0; run < 2000; run += 1) {
      const raw = prng.bigDigits(77) % (MAX_UINT256 + 1n);
      const asset = prng.pick([FIT, ETH, MOCK_Q]);
      const decoded = decodeAmount(JSON.parse(JSON.stringify(encodeAmount(amountOf(asset, raw)))) as unknown, asset);
      expect(decoded.raw).toBe(raw);
      expect(decoded.asset).toBe(asset);
    }
  });

  it('formats with the asset symbol and never overstates', () => {
    expect(formatAmount(amountOf(FIT, 1_500_000_000_000_000_000n))).toBe('1.5 FIT');
    expect(formatAmount(amountOf(FIT, 1n))).toBe('<0.0001 FIT');
    expect(formatAmount(amountOf(ETH, 4_206_980_085_000_000_000n), { maxFractionDigits: 9 })).toBe('4.206980085 ETH');
  });
});

describe('exact ratios (for r and K, never rounded into a payable amount)', () => {
  it('reduces, compares and rounds', () => {
    expect(ratio(10n, 4n)).toEqual({ num: 5n, den: 2n });
    expect(ratio(0n, 7n)).toEqual({ num: 0n, den: 1n });
    expect(ratioFloor(ratio(10n, 4n))).toBe(2n);
    expect(ratioCeil(ratio(10n, 4n))).toBe(3n);
    expect(ratioCeil(ratio(8n, 4n))).toBe(2n);
    expect(compareRatio(ratio(1n, 3n), ratio(2n, 6n))).toBe(0);
    expect(compareRatio(ratio(1n, 3n), ratio(1n, 2n))).toBe(-1);
    expect(amountCode(() => ratio(1n, 0n))).toBe('division_by_zero');
    expect(amountCode(() => ratio(-1n, 2n))).toBe('negative_amount');
  });

  it('encodes as decimal strings like the v2 reference results', () => {
    expect(encodeRatio(ratio(10n, 4n))).toEqual({ num: '5', den: '2' });
    expect(decodeRatio({ num: '100000000000000000000000', den: '1' })).toEqual({ num: 10n ** 23n, den: 1n });
    expect(amountCode(() => decodeRatio({ num: '1', den: '0' }))).toBe('division_by_zero');
    expect(amountCode(() => decodeRatio({ num: 1, den: '1' }))).toBe('malformed_raw_amount');
  });

  it('formats a ratio of raw units in whole units, truncated, marked when inexact', () => {
    expect(formatRatio(ratio(10n ** 23n, 1n), FIT)).toBe('100,000 FIT');
    expect(formatRatio(ratio(10n ** 18n, 3n), FIT)).toBe('≈0.3333 FIT');
  });
});
