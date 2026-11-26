/**
 * v2 policy objects (SH-V2-T03): the fee policy, the quote policy (rounding, limits, deadlines) and the vault
 * policy. Each has an id and version that quotes and manifests bind to.
 *
 * Status is honest: `founder_answered` means DECISION-LOG F23 answered it but no accepted ADR with a fee-order trace
 * and tests exists yet (v2 G05, docs/03 "Fee ordering"), so it cannot back a live manifest. Only `approved` policies,
 * with an ADR that closes the named gates and no UNRESOLVED field, can.
 */
import { z } from 'zod';
import type { GuardIssue } from '../guards';
import type { SafeParseResult } from '../schemas';
import { isRecord, parseWith, reportIssues, safeParseWith } from '../validation';
import { ADR_PATTERN, gateIdField, refField, type GateId } from './gates';
import { isPolicyId, type PolicyId } from './ids';

/** Parts per million (Uniswap v4 fee pips use the same unit). */
export const PPM = 1_000_000;

export type PolicyStatus = 'simulation_only' | 'draft' | 'founder_answered' | 'approved';

export interface PolicyApproval {
  readonly adr: string;
  /** The gates the ADR closes for this policy. */
  readonly gates: readonly GateId[];
  readonly evidence: readonly string[];
}

export interface PolicyRef {
  readonly id: PolicyId;
  readonly version: number;
}

interface PolicyHeader {
  readonly id: PolicyId;
  readonly version: number;
  readonly status: PolicyStatus;
  /** Decision sources, e.g. "F23 C3" or "v2 docs/03". */
  readonly sources: readonly string[];
  readonly approval: PolicyApproval | null;
}

// --- Fee policy ---------------------------------------------------------------------------------------------------

export type ConversionFeeAction = 'draw' | 'return' | 'named_pick';

/** A flat conversion fee in FIT on the principal, burned. No rising or occupancy-based kind exists (F23 A1). */
export interface ConversionFee {
  readonly action: ConversionFeeAction;
  readonly kind: 'flat';
  readonly ratePpm: number;
  readonly asset: 'FIT';
  readonly basis: 'principal';
  readonly destination: 'burn';
}

export interface FeePolicy extends PolicyHeader {
  readonly pool: {
    readonly feePpm: number;
    /** One static LP fee for the pool's life (ADR-0013 § 4.1). */
    readonly feeKind: 'static';
    /** FIT-side pool fees feed the equal per-Misfit stream (F23 A3). */
    readonly fitSide: 'misfit_slot_stream';
    readonly qSide: {
      /** Share of Q-side (ETH) fees to the treasury, as an exact fraction. */
      readonly treasuryShare: { readonly num: number; readonly den: number };
      /** The rest buys FIT and burns it (F23 C5). When this runs is v2 G07. */
      readonly remainder: 'buy_fit_and_burn';
    };
  };
  readonly conversion: {
    /** Fee rounding in raw units; up, so a burn is never short. Proposed until G05. */
    readonly rounding: 'ceil';
    readonly fees: readonly ConversionFee[];
  };
  readonly slotStream: {
    readonly weights: 'equal';
    /** The share of a Misfit inside the vault is burned. */
    readonly inside: 'burn';
    /** The share of a Misfit outside belongs to its owner at the time (a claim). */
    readonly outside: 'owner_claim';
    readonly claimExpiry: 'never';
  };
}

// --- Quote policy -------------------------------------------------------------------------------------------------

export type FinalityRequirement = 'confirmed' | 'finalized';
/** v2 docs/03: whether a fee burn sees pre- or post-conversion occupancy. Part of G05. */
export type FeeOrder = 'PRE_OPERATION_OCCUPANCY' | 'POST_OPERATION_OCCUPANCY' | 'UNRESOLVED';

export interface QuotePolicy extends PolicyHeader {
  /** v2 docs/03: withdraw rounds up, return rounds down, in raw units. */
  readonly rounding: { readonly withdraw: 'ceil'; readonly return: 'floor' };
  /** Every quote carries maxFIT (withdraw) or minFIT (return), fees included. */
  readonly limits: 'required';
  readonly maxQuantityPerCall: number;
  /** A quote expires at most this many seconds after it was made. */
  readonly maxQuoteTtlSeconds: number;
  /** The snapshot block must be at least this final. */
  readonly minFinality: FinalityRequirement;
  readonly feeOrder: FeeOrder;
}

// --- Vault policy -------------------------------------------------------------------------------------------------

export type EmptyVaultRule = 'BLOCK_LAST_WITHDRAWAL' | 'RETAINED_RATE' | 'UNRESOLVED';
export type UnsolicitedFitRule = 'PERMANENT_SURPLUS' | 'REJECTED_BY_TOKEN' | 'UNRESOLVED';
export type SelectionMode = 'EXPLICIT_ID' | 'VERIFIABLE_RANDOM' | 'DRAW_AND_NAMED_PICK' | 'UNRESOLVED';

export interface VaultPolicy extends PolicyHeader {
  readonly mechanism: 'LOCK_RELEASE';
  readonly formula: '(S-E)/n';
  readonly financialWeight: 'equal';
  readonly rarityAffectsPrincipal: false;
  readonly mintAfterInitialization: false;
  /** Surplus K stays in the escrow for good: no sweep, rescue, burn or reuse (v2 C05). */
  readonly surplus: 'PERMANENTLY_STUCK';
  readonly emptyVault: EmptyVaultRule;
  readonly unsolicitedFit: UnsolicitedFitRule;
  readonly selection: { readonly mode: SelectionMode; readonly drawRequired: boolean };
  /** F23 C2: no admin, pause, upgrade, mint or rescue power. Only `false` parses. */
  readonly privileges: { readonly admin: false; readonly pause: false; readonly upgrade: false; readonly mint: false; readonly rescue: false };
}

export type CorePolicy = FeePolicy | QuotePolicy | VaultPolicy;

// --- Constants ----------------------------------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const flat = (action: ConversionFeeAction, ratePpm: number): ConversionFee => ({ action, kind: 'flat', ratePpm, asset: 'FIT', basis: 'principal', destination: 'burn' });

/**
 * F23 (2026-09-28) with F18(4): flat vault fees, all burned; a static 1% pool fee; ETH-side fees 2/15 (≈13.3%) to
 * the treasury and the rest to FIT buy-and-burn (ADR-0013 § 4.1: ⅓ platform × 40% treasury; F23 C3 "~13%"); the
 * FIT side feeds the per-Misfit stream. Founder answered, not approved: G05 needs an exact fee-order trace.
 * Superseded for box 0's pool split by F77 (2026-10-03): ETH side 11/15 FIT buy-and-burn, 2/15 into box 0's own pool,
 * 2/15 to the platform under the 32 ETH / 30-day cap; FIT side 13/15 to the stream (burned before graduation), 2/15
 * into the pool. This dated record (read only by tests and fixtures) keeps F23's numbers; the version's split is
 * BoxSpecV1's constants (BOX0_FEE_SHARE_FIT, FEE_SHARE_DEPTH, BOX0_FEE_SHARE_PLATFORM, BOX0_FEE_SHARE_T_BURN).
 */
export const MISFITS_FEE_POLICY_F23: FeePolicy = deepFreeze({
  id: 'MISFITS_FEES_F23' as PolicyId,
  version: 1,
  status: 'founder_answered',
  sources: ['F18(4)', 'F23 A1', 'F23 A3', 'F23 C2', 'F23 C3', 'F23 C5', 'ADR-0013 §4.1'],
  pool: {
    feePpm: 10_000,
    feeKind: 'static',
    fitSide: 'misfit_slot_stream',
    qSide: { treasuryShare: { num: 2, den: 15 }, remainder: 'buy_fit_and_burn' },
  },
  conversion: { rounding: 'ceil', fees: [flat('draw', 10_000), flat('return', 50_000), flat('named_pick', 250_000)] },
  slotStream: { weights: 'equal', inside: 'burn', outside: 'owner_claim', claimExpiry: 'never' },
  approval: null,
});

/** Draft quote rules. Rounding is v2's; the call size and deadline window are placeholders until gas is measured. */
export const MISFITS_QUOTE_POLICY_DRAFT: QuotePolicy = deepFreeze({
  id: 'MISFITS_QUOTES_DRAFT' as PolicyId,
  version: 1,
  status: 'draft',
  sources: ['v2 docs/03', 'v2 AGENTS.md'],
  rounding: { withdraw: 'ceil', return: 'floor' },
  limits: 'required',
  maxQuantityPerCall: 10,
  maxQuoteTtlSeconds: 600,
  minFinality: 'confirmed',
  feeOrder: 'UNRESOLVED',
  approval: null,
});

/**
 * v2's lock/release vault with F23's answers: the last Misfit cannot leave (C2), FIT sent to the vault is permanent
 * surplus and never swept (C2), no privileged powers (C2). A draw is required but its mechanism is open (A2, G08).
 */
export const MISFITS_VAULT_POLICY_F23: VaultPolicy = deepFreeze({
  id: 'MISFITS_VAULT_F23' as PolicyId,
  version: 1,
  status: 'founder_answered',
  sources: ['v2 C03', 'v2 C04', 'v2 C05', 'F23 A1', 'F23 A2', 'F23 C2'],
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
  approval: null,
});

// --- Helpers ------------------------------------------------------------------------------------------------------

export function policyRef(policy: CorePolicy): PolicyRef {
  return Object.freeze({ id: policy.id, version: policy.version });
}

export function samePolicyRef(a: PolicyRef, b: PolicyRef): boolean {
  return a.id === b.id && a.version === b.version;
}

export function conversionFeeFor(policy: FeePolicy, action: ConversionFeeAction): ConversionFee {
  const fee = policy.conversion.fees.find((entry) => entry.action === action);
  if (!fee) throw new RangeError(`Fee policy ${policy.id} has no ${action} fee`);
  return fee;
}

/** Reads a nested value from possibly malformed input (guards must be total: zod may run them on partial data). */
const pick = (value: unknown, ...path: string[]): unknown => path.reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), value);

/** Fields still UNRESOLVED; a live-ready manifest needs none. Total: tolerates malformed input. */
export function unresolvedPolicyFields(policy: CorePolicy): string[] {
  const value: unknown = policy;
  if (!isRecord(value)) return [];
  if ('mechanism' in value) {
    const open: string[] = [];
    if (value.emptyVault === 'UNRESOLVED') open.push('emptyVault');
    if (value.unsolicitedFit === 'UNRESOLVED') open.push('unsolicitedFit');
    if (pick(value, 'selection', 'mode') === 'UNRESOLVED') open.push('selection.mode');
    return open;
  }
  if ('limits' in value) return value.feeOrder === 'UNRESOLVED' ? ['feeOrder'] : [];
  return [];
}

/** Gates an approval must close, per policy kind. */
export const REQUIRED_APPROVAL_GATES = Object.freeze({
  fee: Object.freeze(['G05', 'G07'] as const),
  quote: Object.freeze(['G05'] as const),
  vault: Object.freeze(['G04', 'G06', 'G08', 'G09'] as const),
});

// --- Schemas ------------------------------------------------------------------------------------------------------

const idField = z
  .string()
  .refine(isPolicyId, 'must be an upper-case policy id')
  .transform((value) => value as PolicyId);
const ppmField = z.number().int().min(0).max(PPM);
const approvalSchema = z.strictObject({ adr: z.string().regex(ADR_PATTERN), gates: z.array(gateIdField).min(1), evidence: z.array(refField).min(1) });
const header = {
  id: idField,
  version: z.number().int().min(1),
  status: z.enum(['simulation_only', 'draft', 'founder_answered', 'approved']),
  sources: z.array(z.string().min(1).max(80)).min(1),
  approval: approvalSchema.nullable(),
};

function approvalIssues(policy: unknown, required: readonly GateId[]): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const status = pick(policy, 'status');
  const approval = pick(policy, 'approval');
  if (status === 'approved' && approval === null) issues.push({ path: ['approval'], message: 'an approved policy names the ADR that approved it' });
  if (status !== 'approved' && isRecord(approval)) issues.push({ path: ['approval'], message: 'only an approved policy carries an approval' });
  const gates = pick(approval, 'gates');
  if (status === 'approved' && Array.isArray(gates)) {
    const missing = required.filter((gate) => !gates.includes(gate));
    if (missing.length > 0) issues.push({ path: ['approval', 'gates'], message: `the approval must close ${missing.join(', ')}` });
  }
  if (status === 'approved') {
    for (const field of unresolvedPolicyFields(policy as CorePolicy)) issues.push({ path: field.split('.'), message: 'an approved policy has no UNRESOLVED field' });
  }
  return issues;
}

const conversionFeeSchema = z.strictObject({
  action: z.enum(['draw', 'return', 'named_pick']),
  kind: z.literal('flat'),
  ratePpm: ppmField,
  asset: z.literal('FIT'),
  basis: z.literal('principal'),
  destination: z.literal('burn'),
});

const feePolicyShape = z.strictObject({
  ...header,
  pool: z.strictObject({
    feePpm: ppmField,
    feeKind: z.literal('static'),
    fitSide: z.literal('misfit_slot_stream'),
    qSide: z.strictObject({
      treasuryShare: z.strictObject({ num: z.number().int().min(0), den: z.number().int().min(1) }),
      remainder: z.literal('buy_fit_and_burn'),
    }),
  }),
  conversion: z.strictObject({ rounding: z.literal('ceil'), fees: z.array(conversionFeeSchema) }),
  slotStream: z.strictObject({ weights: z.literal('equal'), inside: z.literal('burn'), outside: z.literal('owner_claim'), claimExpiry: z.literal('never') }),
});

export const feePolicySchema: z.ZodType<FeePolicy> = feePolicyShape
  .superRefine((policy, ctx) => {
    const num = pick(policy, 'pool', 'qSide', 'treasuryShare', 'num');
    const den = pick(policy, 'pool', 'qSide', 'treasuryShare', 'den');
    if (typeof num === 'number' && typeof den === 'number' && num > den) {
      reportIssues(ctx, [{ path: ['pool', 'qSide', 'treasuryShare'], message: 'the treasury share is at most one' }]);
    }
    const fees = pick(policy, 'conversion', 'fees');
    if (Array.isArray(fees)) {
      const actions = fees.map((fee: unknown) => pick(fee, 'action'));
      for (const action of ['draw', 'return', 'named_pick'] as const) {
        const count = actions.filter((entry) => entry === action).length;
        if (count !== 1) reportIssues(ctx, [{ path: ['conversion', 'fees'], message: `exactly one ${action} fee (found ${count})` }]);
      }
    }
    reportIssues(ctx, approvalIssues(policy, REQUIRED_APPROVAL_GATES.fee));
  })
  .transform((policy) => policy as FeePolicy);

const quotePolicyShape = z.strictObject({
  ...header,
  rounding: z.strictObject({ withdraw: z.literal('ceil'), return: z.literal('floor') }),
  limits: z.literal('required'),
  maxQuantityPerCall: z.number().int().min(1).max(100),
  maxQuoteTtlSeconds: z.number().int().min(1).max(3_600),
  minFinality: z.enum(['confirmed', 'finalized']),
  feeOrder: z.enum(['PRE_OPERATION_OCCUPANCY', 'POST_OPERATION_OCCUPANCY', 'UNRESOLVED']),
});

export const quotePolicySchema: z.ZodType<QuotePolicy> = quotePolicyShape
  .superRefine((policy, ctx) => {
    reportIssues(ctx, approvalIssues(policy, REQUIRED_APPROVAL_GATES.quote));
  })
  .transform((policy) => policy as QuotePolicy);

const vaultPolicyShape = z.strictObject({
  ...header,
  mechanism: z.literal('LOCK_RELEASE'),
  formula: z.literal('(S-E)/n'),
  financialWeight: z.literal('equal'),
  rarityAffectsPrincipal: z.literal(false),
  mintAfterInitialization: z.literal(false),
  surplus: z.literal('PERMANENTLY_STUCK'),
  emptyVault: z.enum(['BLOCK_LAST_WITHDRAWAL', 'RETAINED_RATE', 'UNRESOLVED']),
  unsolicitedFit: z.enum(['PERMANENT_SURPLUS', 'REJECTED_BY_TOKEN', 'UNRESOLVED']),
  selection: z.strictObject({ mode: z.enum(['EXPLICIT_ID', 'VERIFIABLE_RANDOM', 'DRAW_AND_NAMED_PICK', 'UNRESOLVED']), drawRequired: z.boolean() }),
  privileges: z.strictObject({ admin: z.literal(false), pause: z.literal(false), upgrade: z.literal(false), mint: z.literal(false), rescue: z.literal(false) }),
});

export const vaultPolicySchema: z.ZodType<VaultPolicy> = vaultPolicyShape
  .superRefine((policy, ctx) => {
    if (pick(policy, 'selection', 'drawRequired') === true && pick(policy, 'selection', 'mode') === 'EXPLICIT_ID') {
      reportIssues(ctx, [{ path: ['selection', 'mode'], message: 'a draw is required (F23 A2), so pick-by-ID alone is not enough' }]);
    }
    reportIssues(ctx, approvalIssues(policy, REQUIRED_APPROVAL_GATES.vault));
  })
  .transform((policy) => policy as VaultPolicy);

export const parseFeePolicy = (input: unknown): FeePolicy => parseWith(feePolicySchema, input, 'fee policy');
export const parseQuotePolicy = (input: unknown): QuotePolicy => parseWith(quotePolicySchema, input, 'quote policy');
export const parseVaultPolicy = (input: unknown): VaultPolicy => parseWith(vaultPolicySchema, input, 'vault policy');
export const safeParseFeePolicy = (input: unknown): SafeParseResult<FeePolicy> => safeParseWith(feePolicySchema, input);
export const safeParseQuotePolicy = (input: unknown): SafeParseResult<QuotePolicy> => safeParseWith(quotePolicySchema, input);
export const safeParseVaultPolicy = (input: unknown): SafeParseResult<VaultPolicy> => safeParseWith(vaultPolicySchema, input);
