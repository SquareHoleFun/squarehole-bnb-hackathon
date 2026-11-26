/**
 * SH-EXISTING-NFTS-E08C: pasted ids, as the shop's starter ids read them (decimal ids and low-high ranges, comma
 * groups, spaces or new lines): every full uint256 including 0, 10 to 10,000 distinct ids, in typed order, never
 * through Number.
 */
import { describe, expect, it } from 'vitest';
import { idsProblemText, parseSetIds } from './set-ids';

const MAX = (1n << 256n) - 1n;
const ok = (text: string) => {
  const parsed = parseSetIds(text);
  if (!parsed.ok) throw new Error(idsProblemText(parsed.problem));
  return parsed.ids;
};

describe('pasted ids', () => {
  it('reads ids and ranges in typed order, one per line or in comma groups, the full uint256 width included', () => {
    expect(ok('0-9')).toEqual([0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n]);
    expect(ok('5, 1 2\n3\t4,  100 - 104 , 7')).toEqual([5n, 1n, 2n, 3n, 4n, 100n, 101n, 102n, 103n, 104n, 7n]);
    expect(ok(`${MAX} ${MAX - 9n}-${MAX - 1n}`)).toEqual([MAX, ...Array.from({ length: 9 }, (_, i) => MAX - 9n + BigInt(i))]);
    expect(ok('1-10000')).toHaveLength(10_000);
    const big = (1n << 255n) + 3n;
    expect(ok(`${big}-${big + 9n}`).at(-1)).toBe(big + 9n);
  });

  it('refuses what is not an id, a range that runs down, an empty group, too few, too many and a repeat', () => {
    const problem = (text: string) => { const parsed = parseSetIds(text); return parsed.ok ? null : idsProblemText(parsed.problem); };
    expect(problem('')).toBe('Paste the ids');
    expect(problem('  \n ')).toBe('Paste the ids');
    for (const bad of ['01 2 3 4 5 6 7 8 9 10', '0x1 2 3 4 5 6 7 8 9 10', '-1 0-8', '1e3 0-8', '1.0 0-8', `${MAX + 1n} 0-8`, '9-0', 'abc', '1--2']) {
      expect(problem(bad), bad).toMatch(/^Not an id: /);
    }
    expect(problem('0-8,')).toBe('An empty group between commas');
    expect(problem('0-4,,5-9')).toBe('An empty group between commas');
    expect(problem('0-8')).toBe('At least 10 ids · 9 now');
    expect(problem('0-10000')).toBe('At most 10,000 ids');
    expect(problem(`0-${MAX}`)).toBe('At most 10,000 ids');
    expect(problem('0-9 5')).toBe('#5 is listed twice');
    expect(problem('0-9 3-4')).toBe('#3 is listed twice');
  });
});
