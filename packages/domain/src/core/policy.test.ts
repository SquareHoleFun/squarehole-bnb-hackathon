import { describe, expect, it } from 'vitest';
import { DataValidationError } from '../errors';
import { readCoreV2Json } from '../test-support/core-v2';
import {
  MISFITS_FEE_POLICY_F23,
  MISFITS_QUOTE_POLICY_DRAFT,
  MISFITS_VAULT_POLICY_F23,
  PPM,
  conversionFeeFor,
  parseFeePolicy,
  parseQuotePolicy,
  parseVaultPolicy,
  policyRef,
  safeParseFeePolicy,
  safeParseQuotePolicy,
  safeParseVaultPolicy,
  unresolvedPolicyFields,
  type FeePolicy,
} from './index';

const clone = <T>(value: T): T => structuredClone(value) as T;
type Mutable = Record<string, unknown>;
const mutate = <T>(value: T, apply: (copy: Mutable) => void): unknown => {
  const copy = clone(value) as unknown as Mutable;
  apply(copy);
  return copy;
};
const at = (root: Mutable, ...path: (string | number)[]): Mutable =>
  path.reduce<Mutable>((node, key) => node[key] as Mutable, root);

const approval = { adr: 'ADR-0014', gates: ['G05', 'G07'], evidence: ['docs/evidence/SH-V2-T07.md#fee-trace'] };

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

describe('F23 fee policy (founder answered, not approved)', () => {
  it('has flat, burned conversion fees: draw 1%, return 5%, named pick 25% (F18(4), F23 A1/C3)', () => {
    expect(PPM).toBe(1_000_000);
    expect(MISFITS_FEE_POLICY_F23.conversion.fees).toEqual([
      { action: 'draw', kind: 'flat', ratePpm: 10_000, asset: 'FIT', basis: 'principal', destination: 'burn' },
      { action: 'return', kind: 'flat', ratePpm: 50_000, asset: 'FIT', basis: 'principal', destination: 'burn' },
      { action: 'named_pick', kind: 'flat', ratePpm: 250_000, asset: 'FIT', basis: 'principal', destination: 'burn' },
    ]);
    expect(conversionFeeFor(MISFITS_FEE_POLICY_F23, 'return').ratePpm).toBe(50_000);
  });

  it('has a static 1% pool fee; ETH side 2/15 to the treasury, the rest buys FIT and burns it (F23 C3, C5)', () => {
    expect(MISFITS_FEE_POLICY_F23.pool).toEqual({
      feePpm: 10_000,
      feeKind: 'static',
      fitSide: 'misfit_slot_stream',
      qSide: { treasuryShare: { num: 2, den: 15 }, remainder: 'buy_fit_and_burn' },
    });
  });

  it('routes the FIT stream per Misfit: inside burns, outside goes to the owner, claims never expire (F23 A3, C2)', () => {
    expect(MISFITS_FEE_POLICY_F23.slotStream).toEqual({ weights: 'equal', inside: 'burn', outside: 'owner_claim', claimExpiry: 'never' });
  });

  it('is not approved, cites its sources, and cannot be changed at runtime', () => {
    expect(MISFITS_FEE_POLICY_F23.status).toBe('founder_answered');
    expect(MISFITS_FEE_POLICY_F23.approval).toBeNull();
    expect(MISFITS_FEE_POLICY_F23.sources).toContain('F23 C3');
    expect(isDeepFrozen(MISFITS_FEE_POLICY_F23)).toBe(true);
    expect(parseFeePolicy(clone(MISFITS_FEE_POLICY_F23))).toEqual(MISFITS_FEE_POLICY_F23);
    expect(policyRef(MISFITS_FEE_POLICY_F23)).toEqual({ id: 'MISFITS_FEES_F23', version: 1 });
  });

  it.each([
    ['a rising return fee (F23 A1: fees stay flat)', (p: Mutable) => (at(p, 'conversion', 'fees', 1).kind = 'rising_with_shelf')],
    ['a conversion fee paid to the treasury (all burned)', (p: Mutable) => (at(p, 'conversion', 'fees', 0).destination = 'treasury')],
    ['a fee from the escrow surplus', (p: Mutable) => (at(p, 'conversion', 'fees', 0).destination = 'escrow_surplus')],
    ['a rate above 100%', (p: Mutable) => (at(p, 'conversion', 'fees', 0).ratePpm = PPM + 1)],
    ['a negative rate', (p: Mutable) => (at(p, 'conversion', 'fees', 0).ratePpm = -1)],
    ['a fractional rate', (p: Mutable) => (at(p, 'conversion', 'fees', 0).ratePpm = 0.5)],
    ['a duplicate action', (p: Mutable) => (at(p, 'conversion', 'fees', 2).action = 'draw')],
    ['a missing action', (p: Mutable) => (at(p, 'conversion').fees = (at(p, 'conversion').fees as unknown[]).slice(0, 2))],
    ['a treasury share above one', (p: Mutable) => (at(p, 'pool', 'qSide').treasuryShare = { num: 16, den: 15 })],
    ['a zero denominator', (p: Mutable) => (at(p, 'pool', 'qSide').treasuryShare = { num: 0, den: 0 })],
    ['a dynamic pool fee', (p: Mutable) => (at(p, 'pool').feeKind = 'dynamic')],
    ['claims that expire', (p: Mutable) => (at(p, 'slotStream').claimExpiry = '365d')],
    ['approved without an approval record', (p: Mutable) => (p.status = 'approved')],
    ['an approval on a policy that is not approved', (p: Mutable) => (p.approval = approval)],
    ['approved without G05', (p: Mutable) => Object.assign(p, { status: 'approved', approval: { ...approval, gates: ['G07'] } })],
    ['approved without evidence', (p: Mutable) => Object.assign(p, { status: 'approved', approval: { ...approval, evidence: [] } })],
    ['an extra field', (p: Mutable) => (p.sweep = true)],
  ])('rejects %s', (_name, apply) => {
    const result = safeParseFeePolicy(mutate(MISFITS_FEE_POLICY_F23, apply));
    expect(result.ok).toBe(false);
  });

  it('accepts an approved policy that names G05 and G07 and its evidence', () => {
    const approved = mutate(MISFITS_FEE_POLICY_F23, (p) => Object.assign(p, { status: 'approved', approval }));
    expect(parseFeePolicy(approved).status).toBe('approved');
  });

  it("rejects v2's simulation-only fee example: it is not a Square Hole fee policy", () => {
    const example = readCoreV2Json('examples/fee-policy.simulation-only.json');
    expect(() => parseFeePolicy(example)).toThrow(DataValidationError);
  });
});

describe('draft quote policy (limits and deadlines)', () => {
  it('rounds withdrawals up and returns down (v2 docs/03), and requires limits and a deadline', () => {
    expect(MISFITS_QUOTE_POLICY_DRAFT).toMatchObject({
      status: 'draft',
      rounding: { withdraw: 'ceil', return: 'floor' },
      limits: 'required',
      minFinality: 'confirmed',
      feeOrder: 'UNRESOLVED',
    });
    expect(MISFITS_QUOTE_POLICY_DRAFT.maxQuoteTtlSeconds).toBeGreaterThan(0);
    expect(isDeepFrozen(MISFITS_QUOTE_POLICY_DRAFT)).toBe(true);
    expect(parseQuotePolicy(clone(MISFITS_QUOTE_POLICY_DRAFT))).toEqual(MISFITS_QUOTE_POLICY_DRAFT);
  });

  it.each([
    ['withdrawals rounded down', (p: Mutable) => (at(p, 'rounding').withdraw = 'floor')],
    ['returns rounded up', (p: Mutable) => (at(p, 'rounding').return = 'ceil')],
    ['optional limits', (p: Mutable) => (p.limits = 'optional')],
    ['no deadline window', (p: Mutable) => (p.maxQuoteTtlSeconds = 0)],
    ['a deadline window over an hour', (p: Mutable) => (p.maxQuoteTtlSeconds = 3601)],
    ['no quantity', (p: Mutable) => (p.maxQuantityPerCall = 0)],
    ['pending blocks', (p: Mutable) => (p.minFinality = 'pending')],
  ])('rejects %s', (_name, apply) => {
    expect(safeParseQuotePolicy(mutate(MISFITS_QUOTE_POLICY_DRAFT, apply)).ok).toBe(false);
  });
});

describe('F23 vault policy', () => {
  it('locks and releases at (S-E)/n with equal weight, keeps surplus stuck, blocks the last withdrawal', () => {
    expect(MISFITS_VAULT_POLICY_F23).toMatchObject({
      status: 'founder_answered',
      mechanism: 'LOCK_RELEASE',
      formula: '(S-E)/n',
      financialWeight: 'equal',
      rarityAffectsPrincipal: false,
      mintAfterInitialization: false,
      surplus: 'PERMANENTLY_STUCK',
      emptyVault: 'BLOCK_LAST_WITHDRAWAL',
      unsolicitedFit: 'PERMANENT_SURPLUS',
      selection: { mode: 'UNRESOLVED', drawRequired: true },
      privileges: { admin: false, pause: false, upgrade: false, mint: false, rescue: false },
    });
    expect(isDeepFrozen(MISFITS_VAULT_POLICY_F23)).toBe(true);
    expect(parseVaultPolicy(clone(MISFITS_VAULT_POLICY_F23))).toEqual(MISFITS_VAULT_POLICY_F23);
  });

  it.each([
    ['a surplus sweep', (p: Mutable) => (p.surplus = 'SWEEP_TO_TEAM')],
    ['rarity-weighted principal', (p: Mutable) => (p.rarityAffectsPrincipal = true)],
    ['a mint after initialization', (p: Mutable) => (p.mintAfterInitialization = true)],
    ['a pause power (F23 C2)', (p: Mutable) => (at(p, 'privileges').pause = true)],
    ['a rescue power (F23 C2)', (p: Mutable) => (at(p, 'privileges').rescue = true)],
    ['pick-by-ID only while a draw is required (F23 A2)', (p: Mutable) => (at(p, 'selection').mode = 'EXPLICIT_ID')],
    ['an unknown empty-vault rule', (p: Mutable) => (p.emptyVault = 'LAST_ONE_FREE')],
  ])('rejects %s', (_name, apply) => {
    expect(safeParseVaultPolicy(mutate(MISFITS_VAULT_POLICY_F23, apply)).ok).toBe(false);
  });
});

describe('unresolved fields (what still blocks live use)', () => {
  it('names every open choice', () => {
    expect(unresolvedPolicyFields(MISFITS_VAULT_POLICY_F23)).toEqual(['selection.mode']);
    expect(unresolvedPolicyFields(MISFITS_QUOTE_POLICY_DRAFT)).toEqual(['feeOrder']);
    expect(unresolvedPolicyFields(MISFITS_FEE_POLICY_F23 as FeePolicy)).toEqual([]);
  });
});
