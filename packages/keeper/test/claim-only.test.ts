import { expect, it } from 'vitest';
import { emptyMemory, plan } from '../src/plan';
import { box, options, v2, world } from './support/v2';

it('F130: fixed-Safe payouts stay permissionless; F127 user claims stay owner-only', () => {
  for (const version of [1, 2] as const) {
    const b = box({ version, fitOwed: 10n ** 22n, platformOwed: 10n ** 22n, v2 });
    const jobs = plan(world(b), emptyMemory(), options()).candidates.map((c) => c.job);
    expect(jobs).toEqual(expect.arrayContaining(['receiverPayFit', 'receiverPayPlatform']));
    expect(plan(world(b), emptyMemory(), options()).candidates.some((c) =>
      ['claim', 'claimFor', 'claimCreator', 'redeem'].includes(c.fn))).toBe(false);
  }
});
