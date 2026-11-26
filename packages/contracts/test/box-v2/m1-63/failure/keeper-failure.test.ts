import { describe, expect, it } from 'vitest';
import { emptyMemory, plan } from '../../../../../keeper/src/plan';
import { box, options, v2, world } from '../../../../../keeper/test/support/v2';

describe('M1-63 failure keeper handoff', () => {
  it('RC5 does not schedule a FIT exit even when only the failed hook holds P', () => {
    // A completed claim leaves pot = tLeft = 0. A subsequent 7 P claim gift sits at the hook.
    // ViemChain reads depthBudget only for graduated boxes, so the actual failed-box snapshot
    // below cannot distinguish that gift from an empty hook. There is no FIT sweep job.
    const failed = box({ graduated: false, failed: true, v2: { ...v2, pot: 0n, tLeft: 0n, depthBudget: 0n } });
    const result = plan(world(failed), emptyMemory(), options());
    expect(result.candidates).not.toContainEqual(expect.objectContaining({
      job: 'sweepAfterLastClaim', to: failed.coordinator,
    }));
  });

  it('keeps the sweep unavailable while holders remain', () => {
    const failed = box({ graduated: false, failed: true, v2: { ...v2, pot: 7n, tLeft: 1n } });
    expect(plan(world(failed), emptyMemory(), options()).candidates.map((c) => c.job))
      .not.toContain('sweepAfterLastClaim');
  });
});
