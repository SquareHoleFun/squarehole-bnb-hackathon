/**
 * v2 VLT-10 ("both candidate n = 0 policies tested; only the accepted policy enabled"), T07.
 *
 * The contract (packages/contracts/src/v2/MisfitsVault.sol) enables only `block-last` (F23 C2, v2-G04): the last Misfit
 * never leaves, and its Foundry tests show n ≥ 1 on every path. The rejected candidate, `retain_rate`, exists only in
 * the preserved oracle (square-hole-core-v2/reference/v0_1/model.py). This file runs both on a hash-checked scratch copy
 * of the oracle (never inside the handoff) and pins what each one does at the boundary, so the choice stays visible.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVaultLedger, withdrawMisfits } from './index';
import { makeOracleCopy, runPython, type OracleCopy } from './test-support/vault-oracle';
import { VaultRuleError } from './errors';

let copy: OracleCopy | undefined;
beforeAll(() => {
  copy = makeOracleCopy();
});
afterAll(() => copy?.cleanup());

interface Boundary {
  readonly supply: string;
  readonly activeAtOne: string;
  readonly lastQuote: string;
  readonly refusedWhileOthersHoldFit: string;
  readonly afterLast: { readonly n: number; readonly active: string; readonly escrow: string; readonly rateNum: string; readonly rateDen: string };
  readonly firstReturn: string;
  readonly afterReturn: { readonly n: number; readonly active: string; readonly escrow: string };
  readonly blockLast: string;
}

const SCRIPT = [
  'import importlib.util, json, sys',
  "spec = importlib.util.spec_from_file_location('sh_v2_oracle_model', sys.argv[1])",
  'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
  'def run(policy):',
  "    v = m.Vault({'alice': 1_000, 'bob': 203}, nfts=4, empty_policy=policy)",
  "    v.withdraw('alice', 3)",
  '    return v',
  "v = run('retain_rate')",
  'active_at_one = v.active',
  'last_quote = v.quote_withdraw(1)',
  'try:',
  "    v.withdraw('alice', 1)",
  "    refused = ''",
  'except m.RuleViolation as e:',
  '    refused = str(e)',
  "v.transfer('bob', 'alice', v.balances['bob'])",
  "v.withdraw('alice', 1)",
  "after_last = {'n': v.n, 'active': str(v.active), 'escrow': str(v.escrow), 'rateNum': str(v.rate.numerator), 'rateDen': str(v.rate.denominator)}",
  "first_return = v.return_nfts('alice', [0])",
  "after_return = {'n': v.n, 'active': str(v.active), 'escrow': str(v.escrow)}",
  'v.assert_invariants(deep=True)',
  "b = run('block_last')",
  'try:',
  "    b.transfer('bob', 'alice', b.balances['bob'])",
  "    b.withdraw('alice', 1)",
  "    block = ''",
  'except m.RuleViolation as e:',
  '    block = str(e)',
  "print(json.dumps({'supply': str(v.total_supply), 'activeAtOne': str(active_at_one), 'lastQuote': str(last_quote),",
  "  'refusedWhileOthersHoldFit': refused, 'afterLast': after_last, 'firstReturn': str(first_return),",
  "  'afterReturn': after_return, 'blockLast': block}))",
].join('\n');

describe('VLT-10: the two empty-vault candidates on the oracle', () => {
  it('retain_rate: the last Misfit costs every FIT outside E; at n = 0 the old rate prices the first return', () => {
    if (!copy) throw new Error('oracle copy missing');
    const run = runPython(['-c', SCRIPT, copy.modelPath]);
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout) as Boundary;
    // S = 1,203 raw, N = 4. Withdrawing 3 locks ⌈1,203·3/4⌉ = 903, so A = 300 at n = 1.
    expect(out.supply).toBe('1203');
    expect(out.activeAtOne).toBe('300');
    // The last withdrawal would lock ⌈A·1/1⌉ = A: all FIT outside E, wherever it sits (pool, wallets, claims).
    expect(out.lastQuote).toBe(out.activeAtOne);
    expect(out.refusedWhileOthersHoldFit).toBe('Insufficient owner FIT');
    // Once one holder has all of it: n = 0, A = 0, every FIT is in E, and the rate is the retained one (300 / 1).
    expect(out.afterLast).toEqual({ n: 0, active: '0', escrow: '1203', rateNum: '300', rateDen: '1' });
    // The first return at n = 0 pays ⌊retained rate⌋, then n = 1 and (S − E)/n applies again.
    expect(out.firstReturn).toBe('300');
    expect(out.afterReturn).toEqual({ n: 1, active: '300', escrow: '903' });
  });

  it('block_last (the accepted policy, the only one the contract enables): the last Misfit is refused', () => {
    if (!copy) throw new Error('oracle copy missing');
    const run = runPython(['-c', SCRIPT, copy.modelPath]);
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout) as Boundary;
    expect(out.blockLast).toBe('Last NFT withdrawal disabled by scenario policy');

    // The TypeScript reference (T05) refuses it the same way, with the code the contract's LastMisfit maps to.
    let ledger = createVaultLedger({ allocations: { alice: 1_203n }, collectionSize: 4 });
    ledger = withdrawMisfits(ledger, { owner: 'alice', count: 3 }).ledger;
    expect(() => withdrawMisfits(ledger, { owner: 'alice', count: 1 })).toThrow(VaultRuleError);
    try {
      withdrawMisfits(ledger, { owner: 'alice', count: 1 });
    } catch (error) {
      expect((error as VaultRuleError).code).toBe('last_misfit');
    }
  });
});
