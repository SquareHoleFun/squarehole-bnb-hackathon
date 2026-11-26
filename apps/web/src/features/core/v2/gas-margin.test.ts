/**
 * SH-258 fix round: a shop's checked sends get the create flow's margin (a fifth or 150,000,
 * whichever is more). Measured by the shop lane on chain 97: a sell-back used 382,847 gas on a limit of 371,383 (its
 * estimate plus a fifth) when the next block fell into a later second.
 */
import { describe, expect, it } from 'vitest';
import { actionGasLimit, coordinatorGasLimit, gasLimitFor } from './actions-v2';

const SHOP = '0x0000000000000000000000000000000000000a01';
const COORDINATOR = '0x0000000000000000000000000000000000000c01';

describe('the gas margin of a checked send', () => {
  it('covers the measured sell-back: the estimate behind 371,383 plus 150,000 is above 382,847', () => {
    const estimate = (371_383n * 5n) / 6n;
    expect(estimate + estimate / 5n).toBeLessThan(382_847n);
    expect(actionGasLimit(estimate)).toBeGreaterThan(382_847n);
    expect(gasLimitFor(SHOP, COORDINATOR, estimate, SHOP)).toBe(actionGasLimit(estimate));
    // Other sends keep their fifth (rr2-claim-gas.test.ts).
    expect(gasLimitFor(SHOP, COORDINATOR, 400_000n)).toBe(480_000n);
  });

  it('a fifth where a fifth is more; the coordinator keeps its own margin', () => {
    expect(actionGasLimit(100_000n)).toBe(250_000n);
    expect(actionGasLimit(1_000_000n)).toBe(1_200_000n);
    expect(gasLimitFor(COORDINATOR, COORDINATOR, 1_000_000n)).toBe(coordinatorGasLimit(1_000_000n));
  });

  it('round 3: never clipped: a coordinator claim estimated at 14,000,000 asks its full 16,800,000 (the guard then refuses it)', () => {
    expect(coordinatorGasLimit(14_000_000n)).toBe(16_800_000n);
    expect(coordinatorGasLimit(17_000_000n)).toBe(20_400_000n);
  });
});
