import { expect, it } from 'vitest';
import { oursList } from '../src/jobs';
import { m3Fixture, YEAR } from './support/m3';

it('keeps failed router upkeep forever, leaving collection and royalty forwarding to public callers', async () => {
  const f = m3Fixture();
  Object.assign(f.s, { failed: true, graduated: false });
  for (const elapsed of [YEAR - 1n, YEAR, 100n * YEAR]) {
    f.s.now = f.s.failedAt + elapsed;
    for (const left of [0n, 1n, 100n]) {
      f.s.left = left;
      const jobs = await f.candidates();
      expect(jobs.some(c => c.fn === 'sweepAfterLastClaim')).toBe(false);
      expect(jobs.some(c => c.fn === 'collect' || c.fn === 'forwardRoyalty')).toBe(false);
      expect(jobs.some(c => c.fn === 'sweep')).toBe(true);
    }
  }
  expect(oursList().map(c => c.job)).not.toContain('sweepAfterLastClaim');
});
