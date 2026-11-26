/**
 * Stage-1 review of the placeholder tickets (2026-09-30), the vault rules the reference ledger mirrors:
 * - the F38 (4) hook: the launch coordinator waives the return fee on hand-backs before graduation, once, for good
 *   (`MisfitsVault.waiveHandBackFee`); refused once the gate is open;
 * - a Misfit that left through the reveal fallback can be returned unrevealed once the adapter's return fallback has
 *   passed (`MisfitsPlaceholders.returnableFrom`), and then waits on the shelf, where a named pick still needs the
 *   reveal. The ledger has no clock: the caller passes the IDs the adapter reports returnable, as the vault asks it.
 */
import { describe, expect, it } from 'vitest';
import {
  createVaultLedger,
  deliverTickets,
  ledgerTotals,
  openVaultGate,
  pickMisfits,
  quoteHandBack,
  releaseTickets,
  returnRevealedMisfits,
  revealMisfits,
  takeTickets,
  vaultCounts,
  VaultRuleError,
  waiveHandBackFee as waive,
  F23_FEES,
  type VaultLedger,
} from './index';
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

const vault = (): VaultLedger =>
  createVaultLedger({
    allocations: { alice: raw(800_000_000n), bob: raw(50_000_000n), fees: raw(150_000_000n) },
    collectionSize: 10_000,
    fees: 'flat-f23',
  });

describe('the hand-back fee waiver (F38 4 hook, MisfitsVault.waiveHandBackFee)', () => {
  it('makes later hand-backs before graduation fee-free, once, for good; takes still pay the draw fee', () => {
    let v = takeTickets(vault(), { owner: 'alice', count: 3 }).ledger;
    const charged = releaseTickets(v, { owner: 'alice', ids: [0] });
    expect(charged.fee).toBeGreaterThan(0n);
    v = charged.ledger;
    expect(v.handBackFeeWaived).toBe(false);
    const w = waive(v);
    expect(w.handBackFeeWaived).toBe(true);
    expect(v.handBackFeeWaived).toBe(false); // the input is untouched
    expect(codeOf(() => waive(w))).toBe('fee_already_waived');
    const q = quoteHandBack(ledgerTotals(w), 1n, BigInt(w.tickets.size), true, F23_FEES);
    const free = releaseTickets(w, { owner: 'alice', ids: [1], minFit: q.net });
    expect([free.principal, free.fee]).toEqual([q.principal, 0n]);
    expect(free.ledger.burned).toBe(w.burned);
    expect(takeTickets(free.ledger, { owner: 'bob', count: 1 }).fee).toBeGreaterThan(0n);
    // Graduation still works after it; the waiver is refused once the gate is open.
    const open = openVaultGate(free.ledger);
    expect(codeOf(() => waive(open))).toBe('gate_already_open');
  });
});

describe('the unrevealed return after the adapter’s return fallback (MisfitsPlaceholders.returnableFrom)', () => {
  it('lets the caller return an unrevealed Misfit the adapter reports returnable; it then waits on the shelf', () => {
    let v = takeTickets(vault(), { owner: 'alice', count: 2 }).ledger;
    v = openVaultGate(v);
    v = deliverTickets(v, { owner: 'alice', ids: [0, 1] });
    expect(codeOf(() => returnRevealedMisfits(v, { owner: 'alice', ids: [0] }))).toBe('not_revealed');
    // Only the IDs the adapter reports count: another unrevealed one is still refused.
    expect(codeOf(() => returnRevealedMisfits(v, { owner: 'alice', ids: [0, 1], returnableUnrevealed: [0] }))).toBe('not_revealed');
    const r = returnRevealedMisfits(v, { owner: 'alice', ids: [0], returnableUnrevealed: [0] });
    expect(r.fee).toBeGreaterThan(0n);
    expect(vaultCounts(r.ledger)).toMatchObject({ shelf: 1 });
    expect(r.ledger.revealed.has(0)).toBe(false);
    expect(codeOf(() => pickMisfits(r.ledger, { owner: 'bob', ids: [0] }))).toBe('not_revealed');
    const revealed = revealMisfits(r.ledger, [0]);
    expect(codeOf(() => pickMisfits(revealed, { owner: 'bob', ids: [0] }))).toBe('no error');
  });
});
