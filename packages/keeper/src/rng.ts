import { randomInt } from 'node:crypto';

/** A source of numbers in [0, 1). The keeper runs on `cryptoRng`; tests seed theirs. */
export type Rng = () => number;

/** mulberry32: a small deterministic generator for tests and the random-walk histories. Not for secrets. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The keeper's own: the v2 snapshots' times must not be predictable from outside (change queue 4). */
export const cryptoRng: Rng = () => randomInt(0, 2 ** 32) / 2 ** 32;
