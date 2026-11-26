/**
 * v2 T05 ledger tests: VLT-01 to VLT-04 on the immutable reference ledger, the F23 rules (last Misfit stays;
 * unsolicited FIT is permanent surplus that never moves a quote) and seeded random-trace properties.
 */
import { describe, expect, it } from 'vitest';
import {
  accrueSlotStream,
  burnFit,
  claimSlotStream,
  conversionRate,
  createVaultLedger,
  escrowSurplus,
  isEscrowSolvent,
  ledgerTotals,
  quoteReturnPrincipal,
  quoteWithdrawPrincipal,
  returnMisfits,
  sendFitToVault,
  transferFit,
  transferMisfit,
  VaultRuleError,
  withdrawMisfits,
  type VaultLedger,
} from './index';
import { createPrng } from './test-support/prng';
import { idRange, raw } from './test-support/vault-examples';
import { applyTraceOp, createTraceLedger, generateTrace, traceState } from './test-support/vault-traces';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof VaultRuleError) return error.code;
    throw error;
  }
  return 'no error';
};

const vault = (collectionSize = 10_000): VaultLedger =>
  createVaultLedger({
    allocations: { alice: raw(800_000_000n), bob: raw(50_000_000n), fees: raw(100_000_000n), pool: raw(50_000_000n) },
    collectionSize,
  });
const rate = (v: VaultLedger) => conversionRate(ledgerTotals(v));
const bal = (v: VaultLedger, account: string): bigint => v.balances.get(account) ?? 0n;

describe('VLT-01 current quote', () => {
  it('both directions price from the same pre-operation (S − E)/n', () => {
    const v = withdrawMisfits(vault(), { owner: 'alice', count: 4000 }).ledger;
    const totals = ledgerTotals(v);
    expect(totals.supply - totals.escrow).toBe(raw(600_000_000n));
    expect(quoteWithdrawPrincipal(totals, 3n)).toBe(raw(300_000n));
    expect(quoteReturnPrincipal(totals, 3n)).toBe(raw(300_000n));
  });

  it('pool, fee, stream-reserve and unsolicited FIT all stay in A: moving FIT between them never moves r', () => {
    let v = withdrawMisfits(vault(), { owner: 'alice', count: 10 }).ledger;
    const before = rate(v);
    v = transferFit(v, 'alice', 'pool', raw(1_000_000n));
    v = transferFit(v, 'pool', 'treasury', raw(5_000n));
    v = accrueSlotStream(v, 'fees', 0n).ledger;
    v = sendFitToVault(v, 'bob', raw(7n));
    expect(rate(v)).toEqual(before);
  });
});

describe('VLT-02 withdrawal conservation', () => {
  it('principal moves from the owner into E, the Misfits move out, S is unchanged', () => {
    const v0 = vault();
    const { ledger: v1, ids, principal } = withdrawMisfits(v0, { owner: 'bob', count: 3, ids: [7, 9, 11] });
    expect(principal).toBe(raw(300_000n));
    expect(v1.supply).toBe(v0.supply);
    expect(v1.escrow - v0.escrow).toBe(principal);
    expect(bal(v0, 'bob') - bal(v1, 'bob')).toBe(principal);
    expect(ids).toEqual([7, 9, 11]);
    expect(ids.map((id) => v1.outside.get(id))).toEqual(['bob', 'bob', 'bob']);
    expect(ids.some((id) => v1.inventory.has(id))).toBe(false);
    expect(v1.inventory.size).toBe(9997);
  });

  it('refusals leave the ledger untouched', () => {
    const v0 = vault(10);
    const snapshot = traceState(v0);
    expect(codeOf(() => withdrawMisfits(v0, { owner: 'bob', count: 1, maxFit: 1n }))).toBe('max_fit_exceeded');
    expect(codeOf(() => withdrawMisfits(v0, { owner: 'carol', count: 1 }))).toBe('insufficient_fit');
    expect(codeOf(() => withdrawMisfits(v0, { owner: 'alice', count: 2, ids: [1, 1] }))).toBe('ineligible_ids');
    expect(codeOf(() => withdrawMisfits(v0, { owner: 'alice', count: 1, ids: [99] }))).toBe('ineligible_ids');
    expect(codeOf(() => withdrawMisfits(v0, { owner: '__escrow', count: 1 }))).toBe('reserved_account');
    expect(traceState(v0)).toEqual(snapshot);
  });
});

describe('VLT-03 return conservation', () => {
  it('principal leaves E only for an eligible outside Misfit the caller owns; S is unchanged', () => {
    const v1 = withdrawMisfits(vault(), { owner: 'alice', count: 5 }).ledger; // IDs 0..4
    const snapshot = traceState(v1);
    expect(codeOf(() => returnMisfits(v1, { owner: 'alice', ids: [] }))).toBe('invalid_id_list');
    expect(codeOf(() => returnMisfits(v1, { owner: 'alice', ids: [0, 0] }))).toBe('invalid_id_list');
    expect(codeOf(() => returnMisfits(v1, { owner: 'alice', ids: [5] }))).toBe('not_owner'); // inside
    expect(codeOf(() => returnMisfits(v1, { owner: 'alice', ids: [10_000] }))).toBe('not_owner'); // foreign
    expect(codeOf(() => returnMisfits(v1, { owner: 'bob', ids: [0] }))).toBe('not_owner'); // someone else's
    expect(codeOf(() => returnMisfits(v1, { owner: 'alice', ids: [0], minFit: raw(100_001n) }))).toBe('min_fit_not_met');
    expect(traceState(v1)).toEqual(snapshot);

    const { ledger: v2, principal } = returnMisfits(v1, { owner: 'alice', ids: [3, 1] });
    expect(principal).toBe(raw(200_000n));
    expect(v2.supply).toBe(v1.supply);
    expect(v1.escrow - v2.escrow).toBe(principal);
    expect(bal(v2, 'alice') - bal(v1, 'alice')).toBe(principal);
    expect(v2.inventory.has(1) && v2.inventory.has(3)).toBe(true);
  });

  it('the return right follows the NFT: the new owner can return, the old owner cannot', () => {
    let v = withdrawMisfits(vault(), { owner: 'alice', count: 1, ids: [42] }).ledger;
    v = transferMisfit(v, 'alice', 'bob', 42);
    expect(codeOf(() => returnMisfits(v, { owner: 'alice', ids: [42] }))).toBe('not_owner');
    expect(returnMisfits(v, { owner: 'bob', ids: [42] }).principal).toBe(raw(100_000n));
  });
});

describe('VLT-04 no historic refund', () => {
  it('a return pays the current rate, not what was locked', () => {
    let v = withdrawMisfits(vault(), { owner: 'alice', count: 5000 }).ledger; // locked 100,000 each
    v = burnFit(v, 'fees', raw(50_000_000n)); // r: 100,000 → 90,000
    expect(returnMisfits(v, { owner: 'alice', ids: [0] }).principal).toBe(raw(90_000n));
    v = withdrawMisfits(v, { owner: 'bob', count: 1 }).ledger; // bob locks 90,000
    expect(returnMisfits(v, { owner: 'alice', ids: [1] }).principal).toBe(raw(90_000n));
  });

  it('return order does not favour anyone: exact at an integer rate, at most 1 raw per Misfit otherwise', () => {
    const prng = createPrng(0x7005_0401);
    for (let round = 0; round < 300; round += 1) {
      const size = 4 + prng.int(60);
      const supply = BigInt(size) + prng.bigDigits(25);
      let v = createVaultLedger({ allocations: { alice: supply, bob: supply }, collectionSize: size });
      const ka = 1 + prng.int(Math.floor(size / 3));
      const kb = 1 + prng.int(Math.floor(size / 3));
      v = withdrawMisfits(v, { owner: 'alice', count: ka }).ledger;
      v = withdrawMisfits(v, { owner: 'bob', count: kb }).ledger;
      if (prng.int(2) === 0) {
        const room = (supply * 2n - v.escrow - BigInt(size)) / BigInt(2 + prng.int(9));
        v = burnFit(v, 'bob', room < bal(v, 'bob') ? room : bal(v, 'bob'));
      }
      const idsOf = (owner: string) => [...v.outside].filter(([, o]) => o === owner).map(([id]) => id);
      const aFirst = returnMisfits(v, { owner: 'alice', ids: idsOf('alice') });
      const bSecond = returnMisfits(aFirst.ledger, { owner: 'bob', ids: idsOf('bob') });
      const bFirst = returnMisfits(v, { owner: 'bob', ids: idsOf('bob') });
      const aSecond = returnMisfits(bFirst.ledger, { owner: 'alice', ids: idsOf('alice') });
      const gapA = aFirst.principal - aSecond.principal;
      const gapB = bFirst.principal - bSecond.principal;
      expect(gapA >= 0n && gapA <= BigInt(ka)).toBe(true);
      expect(gapB >= 0n && gapB <= BigInt(kb)).toBe(true);
      if (rate(v).den === 1n) {
        expect(gapA).toBe(0n);
        expect(gapB).toBe(0n);
      }
    }
  });
});

describe('F23: the last Misfit cannot leave', () => {
  it('a vault can go down to one Misfit and no further', () => {
    let v = createVaultLedger({ allocations: { alice: 1_000n }, collectionSize: 4 });
    expect(codeOf(() => withdrawMisfits(v, { owner: 'alice', count: 4 }))).toBe('last_misfit');
    v = withdrawMisfits(v, { owner: 'alice', count: 3 }).ledger;
    expect(v.inventory.size).toBe(1);
    expect(codeOf(() => withdrawMisfits(v, { owner: 'alice', count: 1 }))).toBe('last_misfit');
    const one = createVaultLedger({ allocations: { alice: 5n }, collectionSize: 1 });
    expect(codeOf(() => withdrawMisfits(one, { owner: 'alice', count: 1 }))).toBe('last_misfit');
  });
});

describe('F23: unsolicited FIT sent to the vault', () => {
  it('changes no quote, S or E, and is never paid out, even after every Misfit is back', () => {
    let v = withdrawMisfits(vault(), { owner: 'alice', count: 5000 }).ledger;
    v = burnFit(v, 'fees', raw(50_000_000n));
    const before = ledgerTotals(v);
    const sent = raw(12_345_678n) + 9n;
    v = sendFitToVault(v, 'bob', sent);
    expect(ledgerTotals(v)).toEqual(before);
    expect(quoteWithdrawPrincipal(ledgerTotals(v), 1n)).toBe(raw(90_000n));
    expect(quoteReturnPrincipal(ledgerTotals(v), 1n)).toBe(raw(90_000n));
    expect(v.unsolicited).toBe(sent);
    v = returnMisfits(v, { owner: 'alice', ids: idRange(0, 5000) }).ledger;
    expect(v.inventory.size).toBe(10_000);
    // The vault still holds K (stuck principal) plus every unit that was sent to it.
    expect(v.escrow).toBe(raw(50_000_000n));
    expect(escrowSurplus(ledgerTotals(v))).toEqual({ num: raw(50_000_000n), den: 1n });
    expect(v.escrow + v.unsolicited).toBe(raw(50_000_000n) + sent);
  });

  it('random traces: unsolicited only grows, only by sendFitToVault, and never moves r, S or E', () => {
    const prng = createPrng(0x7005_2306);
    for (let t = 0; t < 120; t += 1) {
      const { trace } = generateTrace(prng, { collectionSize: 1 + prng.int(30), ops: 50 });
      let v = createTraceLedger(trace);
      for (const op of trace.ops) {
        const prev = v;
        const applied = applyTraceOp(prev, op);
        v = applied.ledger;
        if ('error' in applied.outcome) {
          expect(v).toBe(prev);
          continue;
        }
        if (op.op === 'sendFitToVault') {
          expect(v.unsolicited - prev.unsolicited).toBe(BigInt(op.amount));
          expect(ledgerTotals(v)).toEqual(ledgerTotals(prev));
        } else {
          expect(v.unsolicited).toBe(prev.unsolicited);
        }
        if (op.op !== 'burn' && op.op !== 'accrue') expect(v.supply).toBe(prev.supply);
        if (op.op !== 'withdraw' && op.op !== 'return') expect(v.escrow).toBe(prev.escrow);
        expect(isEscrowSolvent(ledgerTotals(v))).toBe(true);
      }
    }
  });
});

describe('F23 A3: per-Misfit stream on the ledger', () => {
  it('inside shares burn, outside shares are credited; claims pay the owner and change nothing else', () => {
    let v = withdrawMisfits(vault(), { owner: 'alice', count: 2500 }).ledger;
    v = transferMisfit(v, 'alice', 'bob', 0);
    const { ledger, allocation } = accrueSlotStream(v, 'fees', raw(1_000_000n) + 7n);
    expect(allocation.burned).toBe(((raw(1_000_000n) + 7n) * 7500n) / 10_000n);
    expect(ledger.claims.get('alice')).toBe(((raw(1_000_000n) + 7n) * 2499n) / 10_000n);
    expect(ledger.claims.get('bob')).toBe((raw(1_000_000n) + 7n) / 10_000n);
    expect(allocation.dustRetainedBySource).toBe(raw(1_000_000n) + 7n - allocation.burned - allocation.credited);
    const totals = ledgerTotals(ledger);
    const claimed = claimSlotStream(ledger, 'bob');
    expect(ledgerTotals(claimed.ledger)).toEqual(totals);
    expect(claimed.ledger.claims.get('bob')).toBe(0n);
    expect(bal(claimed.ledger, 'bob') - bal(ledger, 'bob')).toBe(claimed.paid);
  });

  it('an unfunded budget or a burn below one raw FIT per inside Misfit is refused', () => {
    const v = createVaultLedger({ allocations: { fees: 12n }, collectionSize: 10 });
    expect(codeOf(() => accrueSlotStream(v, 'fees', 13n))).toBe('stream_not_funded');
    expect(codeOf(() => accrueSlotStream(v, 'fees', 3n))).toBe('dust_guard');
    expect(accrueSlotStream(v, 'fees', 2n).allocation.burned).toBe(2n);
  });
});
