import { describe, expect, it } from 'vitest';
import { interpret } from '../../../../../keeper/src/chain';
import { emptyMemory, plan } from '../../../../../keeper/src/plan';
import { addr, box, options, v2, world } from '../../../../../keeper/test/support/v2';
import type { Candidate } from '../../../../../keeper/src/types';

describe('FINAL2-ACCESS-K01: F130 fixed-Safe maintenance survives F127 owner-only claims', () => {
  for (const phase of ['curve', 'graduated', 'failed'] as const) {
    it(`schedules both funded fixed-Safe exits during ${phase}, independently of box 0`, () => {
      const state = box({
        graduated: phase === 'graduated', failed: phase === 'failed', curveClosed: false,
        fitOwed: 10n ** 22n, platformOwed: 10n ** 21n,
        v2: { ...v2, depthBudget: 0n, buyBackP: 0n },
      });
      const calls = plan(world(state), emptyMemory(), options()).candidates;
      expect(calls.filter((c) => c.fn === 'payFit' || c.fn === 'payPlatform').map((c) => [c.to, c.fn, c.args]))
        .toEqual([[state.receiver, 'payFit', []], [state.receiver, 'payPlatform', []]]);
    });
  }

  it.each(['receiverPayFit', 'receiverPayPlatform'] as const)('recognizes real positive %s progress', (job) => {
    const c: Candidate = { job, key: `${job}:2:fixture`, to: addr(3),
      fn: job === 'receiverPayFit' ? 'payFit' : 'payPlatform', args: [], version: 2 };
    expect(interpret(c, 0n, null).ok).toBe(false);
    expect(interpret(c, 1n, null)).toEqual({ ok: true, tipWei: null, estimate: 0n });
  });

  it('never schedules user claim pushes and leaves empty Safe debts idle', () => {
    const state = box({ v2: { ...v2, depthBudget: 0n, buyBackP: 0n } });
    const calls = plan(world(state), emptyMemory(), options()).candidates;
    expect(calls.some((c) => ['payFit', 'payPlatform', 'claim', 'claimCreator', 'claimFor'].includes(c.fn)))
      .toBe(false);
  });

  it('preserves the box-0 payout planner and interpretation', () => {
    const calls = plan(world(box({ version: 1, fitOwed: 2n, platformOwed: 1n })), emptyMemory(), options())
      .candidates.filter((c) => c.fn === 'payFit' || c.fn === 'payPlatform');
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(interpret(c, 1n, null).ok).toBe(true);
  });
});
