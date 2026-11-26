/**
 * Seeded, reproducible PRNG for property tests (mulberry32). Test-only: domain/provider logic never uses
 * randomness. Seeds are fixed in each test so a failure reproduces exactly.
 */
export interface Prng {
  /** Uniform integer in [0, maxExclusive). `maxExclusive` must be a small positive safe integer. */
  int(maxExclusive: number): number;
  /** Uniform-ish unsigned bigint with up to `maxDigits` decimal digits (never a leading zero). */
  bigDigits(maxDigits: number): bigint;
  pick<T>(values: readonly T[]): T;
}

export function createPrng(seed: number): Prng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (maxExclusive: number): number => Math.floor(next() * maxExclusive);
  return {
    int,
    bigDigits(maxDigits) {
      const length = 1 + int(maxDigits);
      let text = String(1 + int(9));
      for (let i = 1; i < length; i += 1) text += String(int(10));
      return int(20) === 0 ? 0n : BigInt(text);
    },
    pick<T>(values: readonly T[]): T {
      if (values.length === 0) throw new Error('pick from empty list');
      return values[int(values.length)] as T;
    },
  };
}
