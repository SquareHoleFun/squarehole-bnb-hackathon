/**
 * v2 T06 additions to the reference ledger: a Misfit sent straight to the vault (refused, the recommended v2-G06 rule,
 * founder to confirm) and the raw-balance reading of unsolicited FIT (ADR-0014 draft), kept beside F23's quote-neutral
 * `sendFitToVault` so the differential harness can trace both until the rule is ratified.
 */
import { describe, expect, it } from 'vitest';
import {
  conversionRate,
  createVaultLedger,
  donateFitToEscrow,
  ledgerTotals,
  sendFitToVault,
  sendMisfitToVault,
  transferMisfit,
  UNSOLICITED_MISFIT_POLICY,
  VaultRuleError,
  withdrawMisfits,
  type VaultLedger,
} from './index';
import { freshVault, raw } from './test-support/vault-examples';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof VaultRuleError) return error.code;
    throw error;
  }
  return 'no error';
};

const halfOut = (): VaultLedger => withdrawMisfits(freshVault(), { owner: 'alice', count: 5000 }).ledger;

describe('a Misfit sent to the vault outside a return (v2-G06, recommended rule)', () => {
  it('is refused for its owner and for everyone else, and nothing changes', () => {
    expect(UNSOLICITED_MISFIT_POLICY).toBe('refuse');
    const v = transferMisfit(halfOut(), 'alice', 'bob', 7);
    expect(codeOf(() => sendMisfitToVault(v, 'bob', 7))).toBe('unsolicited_misfit');
    expect(codeOf(() => sendMisfitToVault(v, 'alice', 7))).toBe('not_owner');
    expect(codeOf(() => sendMisfitToVault(v, 'alice', 9_000))).toBe('not_owner'); // inside the vault
    expect(codeOf(() => sendMisfitToVault(v, 'alice', 10_000))).toBe('not_owner'); // not in the collection
    expect(codeOf(() => sendMisfitToVault(v, '__vault__', 7))).toBe('reserved_account');
    expect(v.outside.get(7)).toBe('bob');
    expect(v.inventory.size).toBe(5000);
  });
});

describe('unsolicited FIT: F23 quote-neutral versus the ADR-0014 draft raw-balance reading', () => {
  it('raw-balance adds the FIT to E and lowers r by amount/n, as the oracle literal donation does (98,000)', () => {
    const donated = donateFitToEscrow(halfOut(), 'fees', raw(10_000_000n));
    expect(donated.escrow).toBe(raw(510_000_000n));
    expect(donated.unsolicited).toBe(0n);
    expect(conversionRate(ledgerTotals(donated))).toEqual({ num: raw(98_000n), den: 1n });
    const neutral = sendFitToVault(halfOut(), 'fees', raw(10_000_000n));
    expect(neutral.escrow).toBe(raw(500_000_000n));
    expect(neutral.unsolicited).toBe(raw(10_000_000n));
    expect(conversionRate(ledgerTotals(neutral))).toEqual({ num: raw(100_000n), den: 1n });
  });

  it('raw-balance refuses a send that would leave fewer than one raw FIT per inside Misfit; quote-neutral needs no guard', () => {
    const start = createVaultLedger({ allocations: { alice: 100_000n }, collectionSize: 10_000 });
    const tight = withdrawMisfits(start, { owner: 'alice', count: 5000 }).ledger; // E = 50,000 raw; A = 50,000; n = 5,000
    expect(codeOf(() => donateFitToEscrow(tight, 'alice', 45_001n))).toBe('dust_guard');
    expect(donateFitToEscrow(tight, 'alice', 45_000n).escrow).toBe(95_000n);
    expect(codeOf(() => donateFitToEscrow(tight, 'alice', 50_001n))).toBe('insufficient_fit');
    const neutral = sendFitToVault(tight, 'alice', 50_000n);
    expect([neutral.escrow, neutral.unsolicited]).toEqual([50_000n, 50_000n]);
    expect(conversionRate(ledgerTotals(neutral))).toEqual(conversionRate(ledgerTotals(tight)));
  });
});
