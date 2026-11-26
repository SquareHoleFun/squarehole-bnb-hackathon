/**
 * v2 T05: reproduce the core worked examples EX01–EX08 (square-hole-core-v2/docs/08-WORKED-EXAMPLES.md) exactly, raw
 * unit for raw unit, against the preserved oracle's output examples/reference-results.json (read-only).
 */
import { describe, expect, it } from 'vitest';
import {
  conversionRate,
  escrowSurplus,
  quoteReturnPrincipal,
  quoteWithdrawPrincipal,
  splitSlotStream,
} from './index';
import { buildReferenceResults, ex08Factor, ex08RateText, raw } from './test-support/vault-examples';
import { readV2Json } from './test-support/vault-oracle';

type Results = ReturnType<typeof buildReferenceResults>;
const expected = readV2Json('examples/reference-results.json') as Results;
const actual = buildReferenceResults();

const whole = (value: bigint) => ({ num: value, den: 1n });

describe('v2 worked examples against examples/reference-results.json', () => {
  it('reproduces the whole reference file (scope, EX01–EX08) exactly', () => {
    expect(actual).toEqual(expected);
  });

  it('EX01: taking half the Misfits out does not change the rate; returns pay the current rate', () => {
    expect(actual.EX01).toEqual(expected.EX01);
    expect(actual.EX01.halfOutside.escrowRaw).toBe(raw(500_000_000n).toString());
    expect(actual.EX01.after2500Return.escrowRaw).toBe(raw(250_000_000n).toString());
    expect(actual.EX01.after2500Return.rate).toEqual({ numerator_raw: raw(100_000n).toString(), denominator: '1' });
  });

  it('EX02: a 50m burn and 50m stuck surplus are separate; all returned leaves E = K = 50m', () => {
    expect(actual.EX02).toEqual(expected.EX02);
    expect(actual.EX02.allReturned.escrowRaw).toBe(raw(50_000_000n).toString());
    expect(actual.EX02.allReturned.trueBurnedRaw).toBe(raw(50_000_000n).toString());
    expect(actual.EX02.allReturned.surplus.numerator_raw).toBe(raw(50_000_000n).toString());
  });

  it('EX03: a 10m slot budget burns 5m (inside) and credits 5m (outside); rate 99,000', () => {
    expect(actual.EX03).toEqual(expected.EX03);
    expect(actual.EX03.state.rate.numerator_raw).toBe(raw(99_000n).toString());
    expect(actual.EX03.state.claimsRaw).toEqual({ alice: raw(5_000_000n).toString() });
  });

  it('EX04: credits stay with the owner at allocation time; claiming changes nothing else', () => {
    expect(actual.EX04).toEqual(expected.EX04);
    expect(actual.EX04.alicePaidRaw).toBe(raw(1000n).toString());
    expect(actual.EX04.bobPaidRaw).toBe(raw(2000n).toString());
  });

  it('EX05: the same 5m burn at n = 5,000 and at n = 1,000 gives rates 99,000 and 95,000', () => {
    expect(actual.EX05).toEqual(expected.EX05);
    expect(actual.EX05.immediate.rate.numerator_raw).toBe(raw(99_000n).toString());
    expect(actual.EX05.delayed.rate.numerator_raw).toBe(raw(95_000n).toString());
  });

  it('EX06: a withdrawal and a separate burn leave the pool balances alone', () => {
    expect(actual.EX06).toEqual(expected.EX06);
    expect(actual.EX06.unchanged).toBe(true);
  });

  it('EX07: returning 100 Misfits releases 9m FIT; selling it moves the pool (Q exit is not guaranteed)', () => {
    expect(actual.EX07).toEqual(expected.EX07);
    expect(actual.EX07.returnedFitRaw).toBe(raw(9_000_000n).toString());
  });

  it('EX08: closed-form long-run rates match the 50-digit reference strings', () => {
    expect(actual.EX08).toEqual(expected.EX08);
    // Doc 08 table: at 50% outside, burn = n·(r0 − r) = 5,000·(100,000 − r) FIT, and K equals it (m = n).
    const burnedMillionsTimes1000 = (text: string): bigint => {
      const [int = '', frac = ''] = text.split('.');
      const r45 = BigInt(int + frac.padEnd(45, '0'));
      const burn45 = 5000n * (100_000n * 10n ** 45n - r45);
      return (burn45 + 5n * 10n ** 47n) / 10n ** 48n; // FIT → thousands, rounded half up
    };
    expect(burnedMillionsTimes1000(ex08RateText(100_000n))).toBe(24_385n);
    expect(burnedMillionsTimes1000(ex08RateText(1_000_000n))).toBe(196_735n);
  });

  it('EX08: 1,000 funded fee events through splitSlotStream track the closed form within 1 raw unit', () => {
    const inside = 5000n;
    const total = 10_000n;
    let active = raw(500_000_000n);
    for (let event = 0; event < 1000; event += 1) {
      const budget = (active * 5n) / (1000n * inside); // 0.5% of one current NFT-equivalent notional
      const split = splitSlotStream(budget, inside, total, new Map([['outside', total - inside]]));
      active -= split.burned;
    }
    const closedRaw = (raw(100_000n) * ex08Factor(1000n)) / 10n ** 140n;
    const diff = active / inside - closedRaw;
    expect(diff >= -1n && diff <= 1n).toBe(true);
  });
});

describe('v2 docs/03 normative examples through the quote functions', () => {
  const half = { supply: raw(1_000_000_000n), escrow: raw(500_000_000n), inside: 5000n, collectionSize: 10_000n };

  it('round trip: rate 100,000 on both sides at half outside', () => {
    expect(conversionRate(half)).toEqual(whole(raw(100_000n)));
    expect(quoteWithdrawPrincipal(half, 1n)).toBe(raw(100_000n));
    expect(quoteReturnPrincipal(half, 2500n)).toBe(raw(250_000_000n));
  });

  it('burn and return: S = 950m keeps r = 90,000 and K = 50m through every return', () => {
    const burned = { ...half, supply: raw(950_000_000n) };
    expect(conversionRate(burned)).toEqual(whole(raw(90_000n)));
    expect(escrowSurplus(burned)).toEqual(whole(raw(50_000_000n)));
    const allBack = { ...burned, escrow: raw(50_000_000n), inside: 10_000n };
    expect(conversionRate(allBack)).toEqual(whole(raw(90_000n)));
    expect(escrowSurplus(allBack)).toEqual(whole(raw(50_000_000n)));
  });
});
