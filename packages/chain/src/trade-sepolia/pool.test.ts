import { describe, expect, it } from 'vitest';
import { Q96, getAmount0Delta, getAmount1Delta } from '../../../box-spec/src/v4-math';
import { swapStep } from './pool';

describe('v4 exact-input integer swap step', () => {
  it('takes the full input and rounds the buy price up', () => {
    const result = swapStep(2n * Q96, Q96, 1_000_000n, 10_000n, 10000n);
    const expected = ((1_000_000n * Q96) * (2n * Q96) + (1_000_000n * Q96 + 9900n * 2n * Q96) - 1n) / (1_000_000n * Q96 + 9900n * 2n * Q96);
    expect(result.price).toBe(expected);
    expect(result.input).toBe(10_000n);
    expect(result.output).toBe(getAmount1Delta(expected, 2n * Q96, 1_000_000n, false));
  });
  it('caps input at the target and rounds fees upwards', () => {
    const result = swapStep(2n * Q96, Q96, 100n, 1000n, 10000n);
    expect(result).toEqual({ price: Q96, input: 51n, output: 100n });
  });
  it('rounds a sell price down', () => {
    const result = swapStep(Q96, 2n * Q96, 1_000_000n, 10_000n, 10000n);
    expect(result.price).toBe(Q96 + 9900n * Q96 / 1_000_000n);
    expect(result.input).toBe(10_000n);
    expect(result.output).toBe(getAmount0Delta(Q96, result.price, 1_000_000n, false));
  });
});
