/**
 * The TypeScript mirror of `PlaceholderShuffle.sol` (F36 a; docs/design/draw-and-reveal.md § 4): the site and the salt
 * holder use it to work out which Misfit number every placeholder gets once the graduation word is known, and which
 * position a draw picks. It must agree with Solidity bit for bit: the vectors below are written from this module and
 * checked by `packages/contracts/test/v2/PlaceholderShuffle.t.sol`. `SH_WRITE_VECTORS=1` rewrites the file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keccak256, stringToHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import {
  invertPlaceholderShuffle,
  permutePlaceholderShuffle,
  pickIndex,
  placeholderMisfitId,
  shuffleHalves,
  SHUFFLE_ROUNDS,
} from './placeholder-shuffle';

const VECTORS = fileURLToPath(new URL('../../contracts/test/vectors/placeholder-shuffle.json', import.meta.url));
const word = (label: string): Hex => keccak256(stringToHex(`squarehole.vectors.shuffle.${label}`));

function bijection(key: Hex, n: bigint): void {
  const seen = new Set<bigint>();
  for (let x = 0n; x < n; x += 1n) {
    const y = permutePlaceholderShuffle(key, x, n);
    expect(y >= 0n && y < n).toBe(true);
    expect(seen.has(y)).toBe(false);
    seen.add(y);
    expect(invertPlaceholderShuffle(key, y, n)).toBe(x);
  }
}

describe('placeholder shuffle (TypeScript mirror)', () => {
  it('splits b = max(2, ⌈log₂ N⌉) into ⌊b/2⌋ and ⌈b/2⌉ bits', () => {
    const cases: [bigint, bigint][] = [
      [1n, 2n],
      [2n, 2n],
      [4n, 2n],
      [5n, 3n],
      [9n, 4n],
      [4_200n, 13n],
      [8_192n, 13n],
      [8_193n, 14n],
      [10_000n, 14n],
      [20_000n, 15n],
    ];
    for (const [n, b] of cases) {
      const { u, v } = shuffleHalves(n);
      expect([u + v, u]).toEqual([b, b / 2n]);
    }
    expect(() => shuffleHalves(0n)).toThrow();
    expect(SHUFFLE_ROUNDS).toBe(8);
  });

  // About 450,000 keccak evaluations in pure TypeScript: seconds alone, longer under the parallel verify run.
  it('is a bijection that inverts, for N in {1, 2, 3, 7, 64, 4,200, 10,000}', { timeout: shLimit(120_000) }, () => {
    for (const n of [1n, 2n, 3n, 7n, 64n]) for (const i of [0, 1, 2]) bijection(word(`${n}-${i}`), n);
    bijection(word('4200'), 4_200n);
    bijection(word('10000'), 10_000n);
  });

  it('numbers placeholders firstId + π(slot) and rejects slots outside [0, N)', () => {
    const w = word('ids');
    expect(placeholderMisfitId(w, 0n, 4_200n, 1n)).toBe(1n + permutePlaceholderShuffle(w, 0n, 4_200n));
    expect(() => permutePlaceholderShuffle(w, 4_200n, 4_200n)).toThrow();
    expect(() => pickIndex(w, 1n, 0n)).toThrow();
  });

  it('writes (SH_WRITE_VECTORS=1) or matches the shared vectors that Solidity checks', () => {
    const cases: { n: bigint; w: Hex; slots: bigint[] }[] = [];
    const all = (n: bigint): bigint[] => Array.from({ length: Number(n) }, (_, i) => BigInt(i));
    for (const n of [1n, 2n, 3n, 7n, 64n]) cases.push({ n, w: word(`vec-${n}`), slots: all(n) });
    const sample = (n: bigint): bigint[] => [...all(160n), ...Array.from({ length: 40 }, (_, i) => n - 40n + BigInt(i))];
    cases.push({ n: 4_200n, w: word('vec-4200'), slots: sample(4_200n) });
    cases.push({ n: 10_000n, w: word('vec-10000'), slots: sample(10_000n) });
    cases.push({ n: 10_000n, w: `0x${'00'.repeat(32)}`, slots: sample(10_000n) });
    cases.push({ n: 4_200n, w: `0x${'ff'.repeat(32)}`, slots: sample(4_200n) });
    cases.push({ n: 20_000n, w: word('vec-20000'), slots: sample(20_000n) });
    const columns = { caseN: [] as number[], caseWord: [] as Hex[], caseU: [] as number[], caseV: [] as number[], caseStart: [] as number[], caseCount: [] as number[], slot: [] as number[], number: [] as number[] };
    for (const c of cases) {
      const { u, v } = shuffleHalves(c.n);
      columns.caseN.push(Number(c.n));
      columns.caseWord.push(c.w);
      columns.caseU.push(Number(u));
      columns.caseV.push(Number(v));
      columns.caseStart.push(columns.slot.length);
      columns.caseCount.push(c.slots.length);
      for (const x of c.slots) {
        columns.slot.push(Number(x));
        columns.number.push(Number(permutePlaceholderShuffle(c.w, x, c.n)));
      }
    }
    const picks = { pickWord: [] as Hex[], pickTicket: [] as number[], pickRemaining: [] as number[], pickIndex: [] as number[] };
    for (let i = 0; i < 40; i += 1) {
      const w = word(`pick-${i}`);
      const remaining = BigInt([1, 2, 37, 4_199, 9_999, 10_000, 4_200, 123][i % 8] as number);
      const ticket = BigInt(1 + i * 7);
      picks.pickWord.push(w);
      picks.pickTicket.push(Number(ticket));
      picks.pickRemaining.push(Number(remaining));
      picks.pickIndex.push(Number(pickIndex(w, ticket, remaining)));
    }
    const doc = { schema: 'squarehole.placeholder-shuffle/v1', rounds: SHUFFLE_ROUNDS, generator: 'packages/chain/src/placeholder-shuffle.ts', ...columns, ...picks };
    const text = `${JSON.stringify(doc, null, 1)}\n`;
    if (process.env.SH_WRITE_VECTORS === '1') writeFileSync(VECTORS, text);
    expect(readFileSync(VECTORS, 'utf8') === text, 'placeholder-shuffle.json differs; run with SH_WRITE_VECTORS=1').toBe(true);
    expect(columns.slot.length).toBeGreaterThan(1_000);
  });
});
