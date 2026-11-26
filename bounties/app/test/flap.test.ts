import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, keccak256, toHex } from 'viem';
import { feeRulesAbi } from '../src/abi/feeRules';
import { decodeError } from '../src/lib/errors';
import {
  candidateSalt,
  CREATE_DEFAULTS,
  curvePoints,
  mineSalt,
  predictToken,
  readCreateForm,
  reserveAt,
  type CreateForm,
} from '../src/lib/flap';

const PORTAL = '0x000042108465206185A077Edc3F3fd2b49060000';
const TOKEN_IMPL = '0x7777c57ff7dc441c1715b2e36fa581c48B782222';
const E18 = 10n ** 18n;

describe('the token address: a salt ending in 7777, as the factory predicts it', () => {
  it('mines a salt the way the entry script does, and the address ends in 7777', async () => {
    const seed = keccak256(toHex('page test'));
    const r = await mineSalt(TOKEN_IMPL, PORTAL, seed);
    expect(r.token.toLowerCase().endsWith('7777')).toBe(true);
    expect(predictToken(TOKEN_IMPL, PORTAL, r.salt)).toBe(r.token);
    expect(candidateSalt(seed, BigInt(r.tries - 1))).toBe(r.salt);
  });
});

describe('the curve, R(s) = ceil(X0 * Y0 / (Y0 - s)) - X0', () => {
  // The entry's defaults: 600,000,000 tokens to 2.35 BNB with X0 = 16 BNB; Y0 = (X0 + T) * S / T.
  const X0 = 16n * E18;
  const T = 235n * 10n ** 16n;
  const S = 600_000_000n * E18;
  const Y0 = ((X0 + T) * S) / T;
  it('starts at zero and reaches the target within a wei', () => {
    expect(reserveAt(X0, Y0, 0n)).toBe(0n);
    const r = reserveAt(X0, Y0, S);
    expect(r >= T - 1n && r <= T + 1n).toBe(true);
  });
  it('rounds up, so the Launcher always holds at least the curve', () => {
    expect(reserveAt(3n, 10n, 1n)).toBe(1n); // ceil(30 / 9) - 3 = 4 - 3
    expect(() => reserveAt(3n, 10n, 10n)).toThrow(RangeError);
  });
  it('the picture has 49 points rising to the target', () => {
    const pts = curvePoints(X0, Y0, S);
    expect(pts).toHaveLength(49);
    for (let i = 1; i < pts.length; i++) expect(pts[i]![1] > pts[i - 1]![1]).toBe(true);
  });
});

describe('the create form: the defaults create in two clicks, every refusal names its field', () => {
  it('defaults', () => {
    const r = readCreateForm(CREATE_DEFAULTS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.saleTokens).toBe(600_000_000n * E18);
      expect(r.config.targetRaise).toBe(235n * 10n ** 16n);
      expect(r.config.duration).toBe(172_800n);
      expect([r.config.tradeFeeBps, r.config.buyTaxBps, r.config.sellTaxBps, r.config.burnShareBps]).toEqual([100, 300, 500, 2000]);
      expect(r.config.taxDuration).toBe(365 * 86400);
    }
  });
  const cases: [Partial<CreateForm>, keyof CreateForm][] = [
    [{ name: ' ' }, 'name'],
    [{ symbol: '' }, 'symbol'],
    [{ saleTokens: 'x' }, 'saleTokens'],
    [{ target: '0' }, 'target'],
    [{ target: '0.0000000000000000001' }, 'target'],
    [{ virtualBnb: '' }, 'virtualBnb'],
    [{ durationHours: '1.5' }, 'durationHours'],
    [{ durationHours: '0' }, 'durationHours'],
    [{ tradeFee: '5.01' }, 'tradeFee'],
    [{ buyTax: '10.5' }, 'buyTax'],
    [{ sellTax: '11' }, 'sellTax'],
    [{ buyTax: '0.5' }, 'buyTax'],
    [{ sellTax: '0.99' }, 'sellTax'],
    [{ durationHours: '721' }, 'durationHours'],
    [{ buyTax: '0', sellTax: '0' }, 'sellTax'],
    [{ burnShare: '100' }, 'burnShare'],
    [{ taxDays: '0' }, 'taxDays'],
    [{ taxDays: '50000' }, 'taxDays'],
  ];
  for (const [over, field] of cases) {
    it(`refuses ${JSON.stringify(over)}`, () => {
      const r = readCreateForm({ ...CREATE_DEFAULTS, ...over });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.refusal.field).toBe(field);
        expect(r.refusal.text).toMatch(/\.$/);
      }
    });
  }
});

describe('a refusal with numbers shows both', () => {
  it('BelowMinimum', () => {
    const data = encodeErrorResult({ abi: feeRulesAbi, errorName: 'BelowMinimum', args: [5n * 10n ** 16n, 6n * 10n ** 16n] });
    const err = new BaseError('x', { cause: new ContractFunctionRevertedError({ abi: feeRulesAbi, data, functionName: 'redeem' }) });
    expect(decodeError(err)).toEqual({
      name: 'BelowMinimum',
      sentence: 'The payout, 0.05, fell below your minimum, 0.06, so nothing was done.',
    });
  });
  it('InvalidRecipient', () => {
    const data = encodeErrorResult({ abi: feeRulesAbi, errorName: 'InvalidRecipient' });
    const err = new BaseError('x', { cause: new ContractFunctionRevertedError({ abi: feeRulesAbi, data, functionName: 'redeem' }) });
    expect(decodeError(err).name).toBe('InvalidRecipient');
  });
});
