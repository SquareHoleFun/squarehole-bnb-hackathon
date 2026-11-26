/**
 * v2 T05 unit tests for the pure vault arithmetic: VLT-01 (current quote), the F23 last-Misfit rule, the F23
 * unsolicited-FIT rule, and the per-Misfit stream split.
 */
import { describe, expect, it } from 'vitest';
import {
  allReturnEnvelope,
  assertBurnKeepsUnit,
  assertVaultTotals,
  ceilDiv,
  conversionRate,
  escrowObligation,
  escrowSurplus,
  exactRatio,
  isEscrowSolvent,
  outsideCount,
  quoteReturnPrincipal,
  quoteWithdrawPrincipal,
  splitSlotStream,
  unsolicitedFit,
  VaultRuleError,
  type VaultTotals,
} from './index';
import { createPrng } from './test-support/prng';

const WAD = 10n ** 18n;
const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof VaultRuleError) return error.code;
    throw error;
  }
  return 'no error';
};

const half: VaultTotals = { supply: 1_000_000_000n * WAD, escrow: 500_000_000n * WAD, inside: 5000n, collectionSize: 10_000n };
/** An awkward state: A = 1,000,003 raw over n = 7, so r is not an integer. */
const odd: VaultTotals = { supply: 1_000_013n, escrow: 10n, inside: 7n, collectionSize: 10n };

describe('VLT-01 current quote: both directions use the same pre-operation (S − E)/n', () => {
  it('r = (S − E)/n in lowest terms', () => {
    expect(conversionRate(half)).toEqual({ num: 100_000n * WAD, den: 1n });
    expect(conversionRate(odd)).toEqual({ num: 1_000_003n, den: 7n });
  });

  it('withdraw rounds up, return rounds down, from the same totals', () => {
    for (const k of [1n, 2n, 3n]) {
      const exact = 1_000_003n * k;
      expect(quoteWithdrawPrincipal(odd, k)).toBe(ceilDiv(exact, 7n));
      expect(quoteReturnPrincipal(odd, k)).toBe(exact / 7n);
      expect(quoteWithdrawPrincipal(odd, k) - quoteReturnPrincipal(odd, k)).toBe(1n);
    }
    expect(quoteWithdrawPrincipal(half, 7n)).toBe(quoteReturnPrincipal(half, 7n));
  });

  it('random totals: ⌊A·k/n⌋ ≤ r·k ≤ ⌈A·k/n⌉ with a gap of at most one raw unit', () => {
    const prng = createPrng(0x7005_0101);
    for (let i = 0; i < 2000; i += 1) {
      const totalCount = 2 + prng.int(10_000);
      const insideCount = 1 + prng.int(totalCount);
      const total = BigInt(totalCount);
      const inside = BigInt(insideCount);
      const escrow = prng.bigDigits(30);
      const supply = escrow + inside + prng.bigDigits(30);
      const t: VaultTotals = { supply, escrow, inside, collectionSize: total };
      const r = conversionRate(t);
      if (insideCount > 1) {
        const k = BigInt(1 + prng.int(insideCount - 1));
        const w = quoteWithdrawPrincipal(t, k);
        expect(w * r.den >= r.num * k).toBe(true);
        expect((w - 1n) * r.den < r.num * k).toBe(true);
      }
      if (insideCount < totalCount) {
        const k = BigInt(1 + prng.int(totalCount - insideCount));
        const out = quoteReturnPrincipal(t, k);
        expect(out * r.den <= r.num * k).toBe(true);
        expect((out + 1n) * r.den > r.num * k).toBe(true);
      }
    }
  });
});

describe('F23 / v2-G04: the last Misfit cannot leave', () => {
  it('withdrawing every Misfit left is refused; one fewer is fine', () => {
    const three: VaultTotals = { supply: 3_000n, escrow: 0n, inside: 3n, collectionSize: 3n };
    expect(codeOf(() => quoteWithdrawPrincipal(three, 3n))).toBe('last_misfit');
    expect(quoteWithdrawPrincipal(three, 2n)).toBe(2_000n);
    const last: VaultTotals = { supply: 3_000n, escrow: 2_000n, inside: 1n, collectionSize: 3n };
    expect(codeOf(() => quoteWithdrawPrincipal(last, 1n))).toBe('last_misfit');
    expect(quoteReturnPrincipal(last, 2n)).toBe(2_000n);
  });

  it('counts outside 1..n (withdraw) or 1..m (return) are refused before anything else', () => {
    expect(codeOf(() => quoteWithdrawPrincipal(half, 0n))).toBe('invalid_quantity');
    expect(codeOf(() => quoteWithdrawPrincipal(half, 5001n))).toBe('invalid_quantity');
    expect(codeOf(() => quoteReturnPrincipal(half, 0n))).toBe('invalid_quantity');
    expect(codeOf(() => quoteReturnPrincipal(half, 5001n))).toBe('invalid_quantity');
  });

  it('an empty vault is not a valid state, so (S − E)/n is always defined', () => {
    expect(codeOf(() => assertVaultTotals({ ...half, inside: 0n }))).toBe('invalid_totals');
    expect(codeOf(() => assertVaultTotals({ ...half, inside: 10_001n }))).toBe('invalid_totals');
    expect(codeOf(() => assertVaultTotals({ ...half, escrow: half.supply + 1n }))).toBe('invalid_totals');
    expect(codeOf(() => assertVaultTotals({ supply: 4n, escrow: 0n, inside: 5n, collectionSize: 5n }))).toBe('invalid_totals');
  });
});

describe('escrow identities (docs/03)', () => {
  it('L, K, U and solvency at half outside after a 50m burn', () => {
    const burned = { ...half, supply: 950_000_000n * WAD };
    expect(outsideCount(burned)).toBe(5000n);
    expect(escrowObligation(burned)).toEqual({ num: 450_000_000n * WAD, den: 1n });
    expect(escrowSurplus(burned)).toEqual({ num: 50_000_000n * WAD, den: 1n });
    expect(allReturnEnvelope(burned)).toEqual({ num: 900_000_000n * WAD, den: 1n });
    expect(isEscrowSolvent(burned)).toBe(true);
    // S = K + N·r
    expect(50_000_000n * WAD + 900_000_000n * WAD).toBe(burned.supply);
  });

  it('an under-funded escrow is reported, never a negative surplus', () => {
    const short = { ...half, escrow: 400_000_000n * WAD };
    expect(isEscrowSolvent(short)).toBe(false);
    expect(codeOf(() => escrowSurplus(short))).toBe('escrow_insolvent');
  });

  it('burn dust guard: at least one raw FIT per inside Misfit must stay in A', () => {
    const tight: VaultTotals = { supply: 20n, escrow: 5n, inside: 10n, collectionSize: 12n };
    expect(() => assertBurnKeepsUnit(tight, 5n)).not.toThrow();
    expect(codeOf(() => assertBurnKeepsUnit(tight, 6n))).toBe('dust_guard');
    expect(codeOf(() => assertBurnKeepsUnit(tight, -1n))).toBe('invalid_amount');
  });

  it('exactRatio reduces and rejects bad input', () => {
    expect(exactRatio(6n, 4n)).toEqual({ num: 3n, den: 2n });
    expect(exactRatio(0n, 9n)).toEqual({ num: 0n, den: 1n });
    expect(codeOf(() => exactRatio(1n, 0n))).toBe('invalid_totals');
    expect(codeOf(() => exactRatio(-1n, 3n))).toBe('invalid_totals');
    expect(codeOf(() => ceilDiv(1n, 0n))).toBe('invalid_totals');
  });
});

describe('F23 / v2-G06: unsolicited FIT never changes a quote', () => {
  it('FIT beyond the tracked principal is reported as unsolicited surplus', () => {
    expect(unsolicitedFit(510n, 500n)).toBe(10n);
    expect(unsolicitedFit(500n, 500n)).toBe(0n);
    expect(codeOf(() => unsolicitedFit(499n, 500n))).toBe('escrow_insolvent');
  });

  it('quotes read the tracked principal E, so a raw vault balance of E + D gives the same quote as E', () => {
    const donated = 10_000_000n * WAD;
    // The v0.1 oracle counts a raw donation in E; that would lower r from 100,000 to 98,000. F23 keeps D out of E.
    const rawBalanceReading = { ...half, escrow: half.escrow + donated };
    expect(conversionRate(rawBalanceReading)).toEqual({ num: 98_000n * WAD, den: 1n });
    expect(conversionRate(half)).toEqual({ num: 100_000n * WAD, den: 1n });
    expect(unsolicitedFit(half.escrow + donated, half.escrow)).toBe(donated);
  });
});

describe('F23 A3: per-Misfit FIT stream split', () => {
  it('EX03: 10m over 5,000 inside / 5,000 outside burns 5m and credits 5m', () => {
    const split = splitSlotStream(10_000_000n * WAD, 5000n, 10_000n, new Map([['alice', 5000n]]));
    expect(split.burned).toBe(5_000_000n * WAD);
    expect(split.credits).toEqual(new Map([['alice', 5_000_000n * WAD]]));
    expect(split.dust).toBe(0n);
  });

  it('floors each share; the dust stays with the source; zero-count owners get no entry', () => {
    const split = splitSlotStream(100n, 3n, 7n, new Map([['a', 1n], ['b', 3n], ['c', 0n]]));
    expect(split.burned).toBe(42n); // ⌊100·3/7⌋
    expect(split.credits).toEqual(new Map([['a', 14n], ['b', 42n]])); // ⌊100/7⌋, ⌊300/7⌋
    expect(split.credited).toBe(56n);
    expect(split.dust).toBe(2n);
  });

  it('refuses owner counts that do not add up to N − n, and negative budgets', () => {
    expect(codeOf(() => splitSlotStream(100n, 3n, 7n, new Map([['a', 3n]])))).toBe('invalid_totals');
    expect(codeOf(() => splitSlotStream(-1n, 3n, 7n, new Map([['a', 4n]])))).toBe('invalid_amount');
    expect(codeOf(() => splitSlotStream(1n, 0n, 7n, new Map([['a', 7n]])))).toBe('invalid_totals');
  });
});
