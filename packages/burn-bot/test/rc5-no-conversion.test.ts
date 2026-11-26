import { expect, it } from 'vitest';
import { roleSchema, actionSchema } from '../src/schema';
it('RC5 removes conversion custody and royalty transaction requests from the bot', () => {
  expect(roleSchema.safeParse('conversion').success).toBe(false);
  expect(actionSchema.safeParse({ kind: 'royalty', lotId: 'lot-1', amount: 1n }).success).toBe(false);
  expect(roleSchema.parse('fit')).toBe('fit');
});
