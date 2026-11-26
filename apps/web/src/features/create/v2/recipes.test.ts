import { describe, expect, it } from 'vitest';
import { CHOICES, choiceOf, pickFor, recipeIssues, sideOf } from './recipes';
import { emptyBranch } from './spec-types';
import { recipeCtx } from './model';
import { inputV2Of } from './test-support/v2-fixtures';

describe('CQ11-E fee choices', () => {
  it('encodes the frozen menu on either side with no split or parameters', () => {
    for (const [choice, leg, dest] of [['keep', 1, 2], ['burn', 2, 1], ['grow', 1, 4]] as const) {
      const pick = pickFor(choice);
      expect(choiceOf(pick)).toBe(choice);
      expect(sideOf(pick)).toEqual({ a: { leg, dest, legParams: '0x', destParams: '0x' }, b: emptyBranch(), split: 1, splitParams: '0x' });
    }
  });
  it('all nine pairs work even when the pricing coin itself cannot burn', () => {
    for (const a of CHOICES) for (const b of CHOICES) expect(recipeIssues(pickFor(a), pickFor(b))).toEqual([]);
  });
  it('refuses persisted splits and foreign destinations instead of silently offering them', () => {
    const ctx = recipeCtx(inputV2Of());
    const burn = pickFor('burn');
    for (const split of [{ kind: 'share', bps: 2500 }, { kind: 'cap', preset: 1 }, { kind: 'rule', plugIn: 'old' }] as const) {
      expect(recipeIssues({ ...burn, split }, burn)).toHaveLength(1);
    }
    expect(recipeIssues({ ...burn, a: { ...burn.a, to: ctx.pricing.token } }, burn)).toHaveLength(1);
  });
});
