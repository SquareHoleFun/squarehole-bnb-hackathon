/**
 * Placeholder tickets (F36 a; docs/design/draw-and-reveal.md; stage 1): the fee arithmetic of ADR-0014 § G05 and the
 * ticket, gate and reveal rules of the reference ledger. The vault only counts: a ticket locks the quote and burns the
 * 1% draw fee while n and h fall; the Misfit is delivered later, after the gate opens; a ticket handed back before
 * the gate opens pays the 5% return fee, after it none; named picks take revealed shelf Misfits only (25%); returns
 * need the reveal (5%).
 */
import { describe, expect, it } from 'vitest';
import {
  createVaultLedger,
  deliverTickets,
  escrowSurplus,
  F23_FEES,
  flatFee,
  isEscrowSolvent,
  ledgerTotals,
  NO_FEES,
  openVaultGate,
  pickMisfits,
  quoteHandBack,
  quotePick,
  quoteReturnNet,
  quoteTake,
  releaseTickets,
  returnRevealedMisfits,
  revealMisfits,
  takeTickets,
  transferTicket,
  vaultCounts,
  VaultRuleError,
  type VaultLedger,
  type VaultTotals,
} from './index';
import { createPrng } from './test-support/prng';
import { raw } from './test-support/vault-examples';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof VaultRuleError) return error.code;
    throw error;
  }
  return 'no error';
};

const vault = (fees: 'none' | 'flat-f23' = 'flat-f23', collectionSize = 10_000): VaultLedger =>
  createVaultLedger({
    allocations: { alice: raw(800_000_000n), bob: raw(50_000_000n), fees: raw(100_000_000n), pool: raw(50_000_000n) },
    collectionSize,
    fees,
  });
const bal = (v: VaultLedger, account: string): bigint => v.balances.get(account) ?? 0n;
const kn = (v: VaultLedger): bigint => {
  const t = ledgerTotals(v);
  return t.escrow * t.inside - (t.collectionSize - t.inside) * (t.supply - t.escrow);
};
const counts = (v: VaultLedger) => vaultCounts(v);

describe('flat fees (ADR-0014 § G05: ceil(p × bps ÷ 10,000), F23 C3)', () => {
  it('rounds up, in the vault’s favour, and is exact on multiples', () => {
    expect(flatFee(0n, 100n)).toBe(0n);
    expect(flatFee(1n, 100n)).toBe(1n);
    expect(flatFee(99n, 100n)).toBe(1n);
    expect(flatFee(100n, 100n)).toBe(1n);
    expect(flatFee(101n, 100n)).toBe(2n);
    expect(flatFee(10_000n, 100n)).toBe(100n);
    expect(flatFee(10_001n, 100n)).toBe(101n);
    expect(flatFee(raw(100_000n), 2_500n)).toBe(raw(25_000n));
    expect(flatFee(raw(100_000n), 500n)).toBe(raw(5_000n));
    expect(flatFee(12_345n, 0n)).toBe(0n);
    expect(flatFee(7n, 10_000n)).toBe(7n);
  });

  it('never exceeds the principal and is off by less than one raw unit from the exact rate', () => {
    const prng = createPrng(0x36a0_0001);
    for (let i = 0; i < 2000; i += 1) {
      const p = prng.bigDigits(40);
      const bps = BigInt(prng.int(10_001));
      const fee = flatFee(p, bps);
      expect(fee <= p).toBe(true);
      expect(fee * 10_000n >= p * bps).toBe(true);
      expect(fee * 10_000n - p * bps < 10_000n).toBe(true);
    }
  });

  it('refuses a negative principal and a rate outside 0 … 10,000 bps', () => {
    expect(codeOf(() => flatFee(-1n, 100n))).toBe('invalid_amount');
    expect(codeOf(() => flatFee(1n, -1n))).toBe('invalid_amount');
    expect(codeOf(() => flatFee(1n, 10_001n))).toBe('invalid_amount');
  });

  it('F23 rates: draw 1%, named pick 25%, return 5%; none is all zero', () => {
    expect(F23_FEES).toEqual({ drawBps: 100n, pickBps: 2_500n, returnBps: 500n });
    expect(NO_FEES).toEqual({ drawBps: 0n, pickBps: 0n, returnBps: 0n });
  });
});

describe('ticket quotes', () => {
  const half: VaultTotals = { supply: raw(1_000_000_000n), escrow: raw(500_000_000n), inside: 5000n, collectionSize: 10_000n };

  it('quoteTake: ⌈A·k/n⌉ plus the 1% draw fee; refuses k above h, the last Misfit and k = 0', () => {
    expect(quoteTake(half, 1n, 5000n, F23_FEES)).toEqual({ principal: raw(100_000n), fee: raw(1_000n), total: raw(101_000n) });
    expect(quoteTake(half, 3n, 10n, F23_FEES)).toEqual({ principal: raw(300_000n), fee: raw(3_000n), total: raw(303_000n) });
    expect(quoteTake(half, 3n, 10n, NO_FEES)).toEqual({ principal: raw(300_000n), fee: 0n, total: raw(300_000n) });
    expect(codeOf(() => quoteTake(half, 4n, 3n, F23_FEES))).toBe('no_hidden');
    expect(codeOf(() => quoteTake(half, 5000n, 5000n, F23_FEES))).toBe('last_misfit');
    expect(codeOf(() => quoteTake(half, 0n, 5000n, F23_FEES))).toBe('invalid_quantity');
    expect(codeOf(() => quoteTake(half, 5001n, 5000n, F23_FEES))).toBe('invalid_quantity');
  });

  it('quoteHandBack: ⌊A·k/n⌋ less 5% while the gate is closed, the full principal once it is open', () => {
    expect(quoteHandBack(half, 1n, 7n, false, F23_FEES)).toEqual({ principal: raw(100_000n), fee: raw(5_000n), net: raw(95_000n) });
    expect(quoteHandBack(half, 2n, 7n, true, F23_FEES)).toEqual({ principal: raw(200_000n), fee: 0n, net: raw(200_000n) });
    expect(codeOf(() => quoteHandBack(half, 8n, 7n, false, F23_FEES))).toBe('invalid_quantity');
    expect(codeOf(() => quoteHandBack(half, 0n, 7n, false, F23_FEES))).toBe('invalid_quantity');
  });

  it('quotePick (+25%) and quoteReturnNet (−5%)', () => {
    expect(quotePick(half, 2n, F23_FEES)).toEqual({ principal: raw(200_000n), fee: raw(50_000n), total: raw(250_000n) });
    expect(quoteReturnNet(half, 2n, F23_FEES)).toEqual({ principal: raw(200_000n), fee: raw(10_000n), net: raw(190_000n) });
  });
});

describe('tickets on the reference ledger', () => {
  it('a take locks ⌈A·k/n⌉, burns the draw fee at the new occupancy, lowers n and h, and reserves the lowest hidden IDs', () => {
    const v0 = vault();
    const { ledger: v1, ids, principal, fee } = takeTickets(v0, { owner: 'alice', count: 3 });
    expect(ids).toEqual([0, 1, 2]);
    expect(principal).toBe(raw(300_000n));
    expect(fee).toBe(raw(3_000n));
    expect(bal(v1, 'alice')).toBe(bal(v0, 'alice') - raw(303_000n));
    expect(v1.escrow).toBe(raw(300_000n));
    expect(v1.supply).toBe(v0.supply - fee);
    expect(v1.burned).toBe(fee);
    expect(counts(v1)).toEqual({ inside: 9_997, hidden: 9_997, tickets: 3, shelf: 0, outside: 3, misfitsOutside: 0 });
    expect([...v1.tickets]).toEqual([
      [0, 'alice'],
      [1, 'alice'],
      [2, 'alice'],
    ]);
    // K·n grows by exactly fee·m′ against the same take without a fee (the burn lands at n′ = n − k).
    const free = takeTickets(createVaultLedger({ allocations: Object.fromEntries(v0.balances), collectionSize: 10_000, fees: 'none' }), {
      owner: 'alice',
      count: 3,
    }).ledger;
    expect(kn(v1) - kn(free)).toBe(fee * 3n);
    expect(v0.tickets.size).toBe(0); // the input ledger is never changed
    expect(v0.inventory.size).toBe(10_000);
  });

  it('the take works while the gate is closed (the curve) and after it opens (draws)', () => {
    let v = takeTickets(vault(), { owner: 'alice', count: 1 }).ledger;
    expect(v.gateOpen).toBe(false);
    v = openVaultGate(v);
    v = takeTickets(v, { owner: 'bob', count: 2 }).ledger;
    expect(counts(v).tickets).toBe(3);
  });

  it('a hand-back before the gate opens releases ⌊A·k/n⌋ less 5%; after it opens (a cancel) the full principal', () => {
    let v = takeTickets(vault(), { owner: 'alice', count: 4 }).ledger;
    const before = bal(v, 'alice');
    const r1 = releaseTickets(v, { owner: 'alice', ids: [1] });
    expect(r1.fee).toBe(flatFee(r1.principal, 500n));
    expect(bal(r1.ledger, 'alice') - before).toBe(r1.principal - r1.fee);
    expect(r1.ledger.burned - v.burned).toBe(r1.fee);
    expect(counts(r1.ledger)).toEqual({ inside: 9_997, hidden: 9_997, tickets: 3, shelf: 0, outside: 3, misfitsOutside: 0 });
    expect(r1.ledger.hidden.has(1)).toBe(true);
    v = openVaultGate(r1.ledger);
    const r2 = releaseTickets(v, { owner: 'alice', ids: [0, 2] });
    expect(r2.fee).toBe(0n);
    expect(r2.ledger.burned).toBe(v.burned);
  });

  it('delivery needs the gate open and the holder’s ticket; it moves no FIT and keeps m', () => {
    let v = takeTickets(vault(), { owner: 'alice', count: 2 }).ledger;
    expect(codeOf(() => deliverTickets(v, { owner: 'alice', ids: [0] }))).toBe('gate_closed');
    v = openVaultGate(v);
    expect(codeOf(() => deliverTickets(v, { owner: 'bob', ids: [0] }))).toBe('not_owner');
    expect(codeOf(() => deliverTickets(v, { owner: 'alice', ids: [5] }))).toBe('not_owner');
    expect(codeOf(() => deliverTickets(v, { owner: 'alice', ids: [] }))).toBe('invalid_id_list');
    expect(codeOf(() => deliverTickets(v, { owner: 'alice', ids: [0, 0] }))).toBe('invalid_id_list');
    const d = deliverTickets(v, { owner: 'alice', ids: [1] });
    expect(d.supply).toBe(v.supply);
    expect(d.escrow).toBe(v.escrow);
    expect(d.balances).toEqual(v.balances);
    expect(counts(d)).toEqual({ inside: 9_998, hidden: 9_998, tickets: 1, shelf: 0, outside: 2, misfitsOutside: 1 });
    expect(d.outside.get(1)).toBe('alice');
    expect(d.ownerCounts.get('alice')).toBe(2);
    expect(codeOf(() => openVaultGate(d))).toBe('gate_already_open');
  });

  it('placeholder transfers move the ticket and its stream count, nothing else', () => {
    const v = takeTickets(vault(), { owner: 'alice', count: 2 }).ledger;
    expect(codeOf(() => transferTicket(v, 'bob', 'carol', 0))).toBe('not_owner');
    const t = transferTicket(v, 'alice', 'bob', 0);
    expect(t.tickets.get(0)).toBe('bob');
    expect([t.ownerCounts.get('alice'), t.ownerCounts.get('bob')]).toEqual([1, 1]);
    expect(t.balances).toEqual(v.balances);
  });

  it('refusals: no_hidden, last_misfit, max_fit_exceeded (principal + fee), insufficient_fit, dust_guard', () => {
    const tiny = createVaultLedger({ allocations: { alice: 1_000n, fees: 3n }, collectionSize: 3, fees: 'flat-f23' });
    expect(codeOf(() => takeTickets(tiny, { owner: 'alice', count: 3 }))).toBe('last_misfit');
    let v = takeTickets(tiny, { owner: 'alice', count: 1 }).ledger;
    v = takeTickets(v, { owner: 'alice', count: 1 }).ledger;
    expect(counts(v).hidden).toBe(1);
    expect(codeOf(() => takeTickets(v, { owner: 'alice', count: 1 }))).toBe('last_misfit');

    const big = vault();
    const q = quoteTake(ledgerTotals(big), 1n, 10_000n, F23_FEES);
    expect(codeOf(() => takeTickets(big, { owner: 'alice', count: 1, maxFit: q.total - 1n }))).toBe('max_fit_exceeded');
    expect(takeTickets(big, { owner: 'alice', count: 1, maxFit: q.total }).principal).toBe(q.principal);
    expect(codeOf(() => takeTickets(big, { owner: 'nobody', count: 1 }))).toBe('insufficient_fit');
    const exact = createVaultLedger({ allocations: { alice: q.total - 1n, fees: raw(1_000_000_000n) - q.total + 1n }, collectionSize: 10_000, fees: 'flat-f23' });
    expect(codeOf(() => takeTickets(exact, { owner: 'alice', count: 1 }))).toBe('insufficient_fit');

    // A = n: one raw FIT per Misfit. A take's fee would push A′ below n′: the burn is refused (dust guard).
    const edge = createVaultLedger({ allocations: { alice: 10n }, collectionSize: 10, fees: 'flat-f23' });
    expect(codeOf(() => takeTickets(edge, { owner: 'alice', count: 1 }))).toBe('dust_guard');
    const edgeFree = createVaultLedger({ allocations: { alice: 10n }, collectionSize: 10, fees: 'none' });
    expect(takeTickets(edgeFree, { owner: 'alice', count: 1 }).principal).toBe(1n);

    const five = createVaultLedger({ allocations: { alice: raw(1_000_000_000n) }, collectionSize: 5, fees: 'flat-f23' });
    let h = takeTickets(five, { owner: 'alice', count: 2 }).ledger;
    h = takeTickets(h, { owner: 'alice', count: 2 }).ledger;
    expect(counts(h)).toMatchObject({ inside: 1, hidden: 1, tickets: 4 });
    expect(codeOf(() => takeTickets(h, { owner: 'alice', count: 1 }))).toBe('last_misfit');
  });

  it('no_hidden: tickets draw only from Misfits never out; the shelf does not count', () => {
    let v = takeTickets(vault('flat-f23', 6), { owner: 'alice', count: 4 }).ledger;
    v = openVaultGate(v);
    v = deliverTickets(v, { owner: 'alice', ids: [0, 1, 2, 3] });
    v = revealMisfits(v, [0, 1, 2]);
    v = returnRevealedMisfits(v, { owner: 'alice', ids: [0, 1, 2] }).ledger;
    expect(counts(v)).toEqual({ inside: 5, hidden: 2, tickets: 0, shelf: 3, outside: 1, misfitsOutside: 1 });
    expect(codeOf(() => takeTickets(v, { owner: 'alice', count: 3 }))).toBe('no_hidden');
    expect(takeTickets(v, { owner: 'alice', count: 2 }).ids).toEqual([4, 5]);
  });
});

describe('named picks and returns (the shelf; Fable R-09, R-14)', () => {
  const graduated = (): VaultLedger => {
    let v = takeTickets(vault(), { owner: 'alice', count: 5 }).ledger;
    v = openVaultGate(v);
    return deliverTickets(v, { owner: 'alice', ids: [0, 1, 2, 3, 4] });
  };

  it('returns need the gate and the reveal; they release ⌊A·k/n⌋ less 5%, burned after the release', () => {
    const closed = takeTickets(vault(), { owner: 'alice', count: 1 }).ledger;
    expect(codeOf(() => returnRevealedMisfits(closed, { owner: 'alice', ids: [0] }))).toBe('gate_closed');
    let v = graduated();
    expect(codeOf(() => returnRevealedMisfits(v, { owner: 'alice', ids: [0] }))).toBe('not_revealed');
    expect(codeOf(() => revealMisfits(v, [9]))).toBe('not_revealable');
    v = revealMisfits(v, [0, 1]);
    expect(codeOf(() => revealMisfits(v, [0]))).toBe('already_revealed');
    expect(codeOf(() => returnRevealedMisfits(v, { owner: 'bob', ids: [0] }))).toBe('not_owner');
    expect(codeOf(() => returnRevealedMisfits(v, { owner: 'alice', ids: [0, 2] }))).toBe('not_revealed');
    const q = quoteReturnNet(ledgerTotals(v), 2n, F23_FEES);
    expect(codeOf(() => returnRevealedMisfits(v, { owner: 'alice', ids: [0, 1], minFit: q.net + 1n }))).toBe('min_fit_not_met');
    const r = returnRevealedMisfits(v, { owner: 'alice', ids: [1, 0], minFit: q.net });
    expect([r.principal, r.fee]).toEqual([q.principal, q.fee]);
    expect(bal(r.ledger, 'alice') - bal(v, 'alice')).toBe(q.net);
    expect(r.ledger.burned - v.burned).toBe(q.fee);
    expect(counts(r.ledger)).toMatchObject({ shelf: 2, hidden: 9_995 });
  });

  it('named picks take revealed shelf Misfits only, for the quote plus 25%', () => {
    let v = revealMisfits(graduated(), [0, 1, 2]);
    v = returnRevealedMisfits(v, { owner: 'alice', ids: [0, 1, 2] }).ledger;
    expect(codeOf(() => pickMisfits(v, { owner: 'bob', ids: [7] }))).toBe('hidden_misfit');
    expect(codeOf(() => pickMisfits(v, { owner: 'bob', ids: [3] }))).toBe('ineligible_ids');
    expect(codeOf(() => pickMisfits(v, { owner: 'bob', ids: [0, 0] }))).toBe('ineligible_ids');
    expect(codeOf(() => pickMisfits(v, { owner: 'bob', ids: [10_000] }))).toBe('ineligible_ids');
    const q = quotePick(ledgerTotals(v), 2n, F23_FEES);
    expect(codeOf(() => pickMisfits(v, { owner: 'bob', ids: [0, 1], maxFit: q.total - 1n }))).toBe('max_fit_exceeded');
    const p = pickMisfits(v, { owner: 'bob', ids: [1, 0], maxFit: q.total });
    expect([p.principal, p.fee]).toEqual([q.principal, q.fee]);
    expect(bal(v, 'bob') - bal(p.ledger, 'bob')).toBe(q.total);
    expect(counts(p.ledger)).toMatchObject({ shelf: 1, hidden: 9_995 });
    const unrevealed = returnRevealedMisfits(revealMisfits(p.ledger, [3]), { owner: 'alice', ids: [3] }).ledger;
    expect(codeOf(() => pickMisfits(unrevealed, { owner: 'bob', ids: [2] }))).toBe('no error');
    const closed = vault();
    expect(codeOf(() => pickMisfits(closed, { owner: 'bob', ids: [0] }))).toBe('gate_closed');
    // a reserved ID has never left: named picks refuse it like any hidden ID
    const reserved = openVaultGate(takeTickets(vault(), { owner: 'alice', count: 1 }).ledger);
    expect(codeOf(() => pickMisfits(reserved, { owner: 'bob', ids: [0] }))).toBe('hidden_misfit');
  });
});

describe('properties: tickets and fees keep every docs/03 identity (seeded)', () => {
  it('E·n ≥ m·A, n = h + s, S + burned = issuance, and inputs are never changed, over random ticket traces', () => {
    const prng = createPrng(0x36a0_0002);
    let steps = 0;
    for (let run = 0; run < 150; run += 1) {
      const size = 2 + prng.int(30);
      let v = createVaultLedger({
        allocations: { alice: BigInt(size) * (1n + prng.bigDigits(12)), bob: prng.bigDigits(10), fees: BigInt(size) },
        collectionSize: size,
        fees: prng.int(3) === 0 ? 'none' : 'flat-f23',
      });
      for (let i = 0; i < 40; i += 1) {
        const snapshot = JSON.stringify([...v.tickets], null) + v.supply.toString() + [...v.hidden].join();
        const owner = prng.pick(['alice', 'bob']);
        const roll = prng.int(8);
        try {
          if (roll < 3) v = takeTickets(v, { owner, count: 1 + prng.int(3) }).ledger;
          else if (roll === 3) {
            const mine = [...v.tickets].filter(([, o]) => o === owner).map(([id]) => id);
            v = releaseTickets(v, { owner, ids: mine.slice(0, 1 + prng.int(2)) }).ledger;
          } else if (roll === 4 && !v.gateOpen && prng.int(3) === 0) v = openVaultGate(v);
          else if (roll === 5) {
            const mine = [...v.tickets].filter(([, o]) => o === owner).map(([id]) => id);
            v = deliverTickets(v, { owner, ids: mine.slice(0, 1) });
          } else if (roll === 6) {
            const out = [...v.outside].filter(([id]) => !v.revealed.has(id)).map(([id]) => id);
            v = revealMisfits(v, out.slice(0, 2));
          } else {
            const mine = [...v.outside].filter(([id, o]) => o === owner && v.revealed.has(id)).map(([id]) => id);
            v = returnRevealedMisfits(v, { owner, ids: mine.slice(0, 1 + prng.int(2)) }).ledger;
          }
        } catch (error) {
          if (!(error instanceof VaultRuleError)) throw error;
          expect(JSON.stringify([...v.tickets], null) + v.supply.toString() + [...v.hidden].join()).toBe(snapshot);
        }
        const c = counts(v);
        expect(c.inside).toBe(c.hidden + c.shelf);
        expect(c.outside).toBe(c.misfitsOutside + c.tickets);
        expect(isEscrowSolvent(ledgerTotals(v))).toBe(true);
        expect(escrowSurplus(ledgerTotals(v)).num >= 0n).toBe(true);
        expect(v.supply + v.burned).toBe(v.initialSupply);
        steps += 1;
      }
    }
    expect(steps).toBe(6000);
  });
});
