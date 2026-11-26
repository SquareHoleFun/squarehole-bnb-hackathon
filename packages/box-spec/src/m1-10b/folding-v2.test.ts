/**
 * M1-10-b: the boolean folding both twins' predicates go through (scripts/lib/checks-v2.mjs AND, OR, NOT). A bug here is
 * in both twins at once, so the twins still agree and only the hand-declared verdicts would catch it (one did: NOT once
 * dropped the parentheses of a negated group). This checks the folding itself: seeded random predicate trees, folded to
 * text, evaluated for every assignment of their atoms and compared with the tree evaluated directly.
 */
import { describe, expect, it } from 'vitest';
import { AND, NOT, OR, type Folded } from '../../scripts/lib/checks-v2.mjs';

type Tree = { atom: number } | { all: Tree[] } | { any: Tree[] } | { not: Tree } | { constant: boolean };

// The atoms' text takes each form the folding treats differently: plain comparisons, a call, a group, a negated call.
const ATOMS = ['a === 1', 'b !== 0', 'id(c)', '(d === 1)', '!id(a)'];
const direct = [(v: number[]) => v[0] === 1, (v: number[]) => v[1] !== 0, (v: number[]) => v[2] === 1, (v: number[]) => v[3] === 1, (v: number[]) => v[0] !== 1];

function lcg(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

function tree(rand: () => number, depth: number): Tree {
  const r = rand();
  if (depth === 0 || r < 0.3) return rand() < 0.15 ? { constant: rand() < 0.5 } : { atom: Math.floor(rand() * ATOMS.length) };
  const kids = () => Array.from({ length: 1 + Math.floor(rand() * 3) }, () => tree(rand, depth - 1));
  if (r < 0.55) return { all: kids() };
  if (r < 0.8) return { any: kids() };
  return { not: tree(rand, depth - 1) };
}

function fold(t: Tree): Folded {
  if ('atom' in t) return ATOMS[t.atom] as string;
  if ('constant' in t) return t.constant;
  if ('all' in t) return AND(t.all.map(fold));
  if ('any' in t) return OR(t.any.map(fold));
  return NOT(fold(t.not));
}

function evaluate(t: Tree, v: number[]): boolean {
  if ('atom' in t) return (direct[t.atom] as (v: number[]) => boolean)(v);
  if ('constant' in t) return t.constant;
  if ('all' in t) return t.all.every((x) => evaluate(x, v));
  if ('any' in t) return t.any.some((x) => evaluate(x, v));
  return !evaluate(t.not, v);
}

describe('M1-10-b: boolean folding of the twins` predicates', () => {
  it('keeps every folded predicate equal to its tree, for every assignment (2,000 seeded trees)', () => {
    const rand = lcg(0x4d3130);
    for (let n = 0; n < 2000; n++) {
      const t = tree(rand, 5);
      const folded = fold(t);
      const run = typeof folded === 'boolean' ? () => folded : (new Function('a', 'b', 'c', 'd', 'id', `return ${folded};`) as (...x: unknown[]) => boolean);
      for (let bits = 0; bits < 16; bits++) {
        const v = [bits & 1, (bits >> 1) & 1, (bits >> 2) & 1, (bits >> 3) & 1];
        expect(run(...v, (x: number) => x === 1), `${JSON.stringify(t)} as ${String(folded)}`).toBe(evaluate(t, v));
      }
    }
  });

  it('folds constants away and never leaves a double negation', () => {
    expect(AND([true, 'a === 1'])).toBe('a === 1');
    expect(OR([false, false])).toBe(false);
    expect(NOT(NOT('id(c)'))).toBe('id(c)');
    expect(NOT(NOT('(a === 1 || b !== 0)'))).toBe('(a === 1 || b !== 0)');
    expect(AND(['x', NOT(NOT(OR(['a', 'b'])))])).toBe('(x && (a || b))');
  });
});
