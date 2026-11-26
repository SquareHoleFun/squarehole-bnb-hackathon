/**
 * Launch draft validator (SH-009). Mirrors square-hole-handoff/schemas/launch.schema.json and adds guards the JSON
 * Schema cannot express. A valid draft is a local wizard record, never deployment authorization (G08).
 *
 * Deviations from the handoff schema (ADR-0008, tested in launch-draft.test.ts against ajv):
 * - `nftUnitRaw` is required and > 0 only for `nft_collection`; token drafts omit it (the schema requires it always).
 * - optional `description` (<= 500 code points; 01-PRODUCT Step 2), which the schema does not allow.
 * - optional `collectionSize` (whole NFTs; F08, ADR-0008 addendum), nft_collection only, which the schema does not allow.
 * Stricter guards: demo mode (or chain 31337) requires chain 31337, a draft policy, an unverified route, no
 * production authorization and unset root identities; policy numbers must equal BURN_NATIVE_T_ROUTE_Q_V1 exactly;
 * the zero address is rejected; identity text rejects control and bidi-override characters; an NFT unit must be a
 * ratio tier `10^k × 10^18` (k = 0…9), and with a collection size, N × r must not exceed 10^9 fractions (F08).
 */
import { z } from 'zod';
import { RAW_AMOUNT_PATTERN, isRawAmount } from './amounts';
import type { GuardIssue } from './guards';
import { fractionalizationIssues, fractionsPerNftFromUnitRaw } from './fractionalization';
import { DEMO_CHAIN_ID, isZeroAddress } from './ids';
import { BURN_NATIVE_T_ROUTE_Q_V1 } from './policy';
import type { SafeParseResult } from './schemas';
import type { TextRule } from './text';
import type { LaunchDraft } from './types';
import { addressField, chainIdField, isRecord, parseWith, reportIssues, safeParseWith, textField as text, txHashField } from './validation';

export const LAUNCH_TEXT_RULES = Object.freeze({
  name: Object.freeze<TextRule>({ min: 1, max: 64, innerSpaces: true, newlines: false }),
  symbol: Object.freeze<TextRule>({ min: 1, max: 32, innerSpaces: false, newlines: false }),
  description: Object.freeze<TextRule>({ min: 0, max: 500, innerSpaces: true, newlines: true }),
});

const identityAddress = addressField.refine((value) => !isZeroAddress(value), 'the zero address is not an identity');

const launchDraftShape = z.strictObject({
  schemaVersion: z.literal('1.0'),
  mode: z.enum(['demo', 'live']),
  chainId: chainIdField,
  assetType: z.enum(['token', 'nft_collection']),
  name: text(LAUNCH_TEXT_RULES.name),
  symbol: text(LAUNCH_TEXT_RULES.symbol),
  description: text(LAUNCH_TEXT_RULES.description).optional(),
  quoteAddress: identityAddress,
  rewardSide: z.enum(['T', 'Q']),
  feePolicyId: z.literal(BURN_NATIVE_T_ROUTE_Q_V1.policyId),
  feePolicyStatus: z.enum(['draft', 'approved']),
  headlineFeeTargetBps: z.number().int().min(0).max(10_000),
  qProtocolShareNumerator: z.number().int().min(0),
  qProtocolShareDenominator: z.number().int().min(1),
  nftUnitRaw: z.string().regex(RAW_AMOUNT_PATTERN, 'must be an unsigned decimal integer string').optional(),
  collectionSize: z.string().regex(RAW_AMOUNT_PATTERN, 'must be an unsigned decimal integer string').optional(),
  metadataManifestHash: txHashField.nullable(),
  rootTokenAddress: identityAddress.nullable(),
  rootNFTAddress: identityAddress.nullable(),
  externalRouteState: z.enum(['unverified', 'available', 'unavailable']),
  productionAuthorized: z.boolean(),
});

/** Whether the draft is demo data: declared demo mode OR the local demo chain (same rule as FEED-09). */
export function isDemoLaunchDraft(draft: Pick<LaunchDraft, 'mode' | 'chainId'>): boolean {
  return draft.mode === 'demo' || draft.chainId === DEMO_CHAIN_ID;
}

/** Guards beyond the JSON Schema. Total: tolerates partially malformed input. */
export function launchDraftIssues(draft: LaunchDraft): GuardIssue[] {
  const candidate: unknown = draft;
  if (!isRecord(candidate)) return [];
  const issues: GuardIssue[] = [];
  const add = (field: string, message: string): void => {
    issues.push({ path: [field], message });
  };
  const policy = BURN_NATIVE_T_ROUTE_Q_V1;
  const demo = isDemoLaunchDraft(draft);

  if (draft.mode === 'live' && draft.chainId === DEMO_CHAIN_ID) add('mode', 'chain 31337 is the local demo chain; a live draft needs a production chain');
  if (draft.mode === 'demo' && typeof draft.chainId === 'number' && draft.chainId !== DEMO_CHAIN_ID) add('chainId', 'demo drafts are on chain 31337 (D07)');
  if (demo && draft.feePolicyStatus === 'approved') add('feePolicyStatus', 'the fee policy is draft until economics approval (G05)');
  if (typeof draft.headlineFeeTargetBps === 'number' && draft.headlineFeeTargetBps !== policy.headlineFeeTargetBps) {
    add('headlineFeeTargetBps', `must equal the ${policy.policyId} constant (${policy.headlineFeeTargetBps} bps)`);
  }
  const num = draft.qProtocolShareNumerator;
  const den = draft.qProtocolShareDenominator;
  if (typeof num === 'number' && typeof den === 'number' && num > den) {
    add('qProtocolShareNumerator', 'the protocol share numerator must not exceed the denominator');
  } else if (typeof num === 'number' && num !== policy.qProtocolShare.num) {
    add('qProtocolShareNumerator', `must equal the policy constant (${policy.qProtocolShare.num})`);
  }
  if (typeof den === 'number' && den !== policy.qProtocolShare.den) {
    add('qProtocolShareDenominator', `must equal the policy constant (${policy.qProtocolShare.den})`);
  }
  if (draft.assetType === 'nft_collection') {
    if (draft.nftUnitRaw === undefined) add('nftUnitRaw', 'nft_collection requires nftUnitRaw');
    else if (isRawAmount(draft.nftUnitRaw) && BigInt(draft.nftUnitRaw) === 0n) add('nftUnitRaw', 'nftUnitRaw must be greater than zero');
    else if (isRawAmount(draft.nftUnitRaw)) {
      const tier = fractionsPerNftFromUnitRaw(draft.nftUnitRaw);
      if (tier === null) add('nftUnitRaw', 'nftUnitRaw must be r × 10^18 with r a power of ten from 1 to 10^9 (ADR-0009)');
      else if (draft.collectionSize !== undefined && isRawAmount(draft.collectionSize)) {
        for (const issue of fractionalizationIssues(draft.collectionSize, tier)) issues.push(issue);
      }
    }
  } else if (draft.assetType === 'token') {
    if (draft.nftUnitRaw !== undefined) add('nftUnitRaw', 'token drafts have no NFT unit (ADR-0008)');
    if (draft.collectionSize !== undefined) add('collectionSize', 'token drafts have no collection size (ADR-0008 addendum)');
  }
  if (demo && typeof draft.rootTokenAddress === 'string') add('rootTokenAddress', 'root identities are unset in demo (D06)');
  if (demo && typeof draft.rootNFTAddress === 'string') add('rootNFTAddress', 'root identities are unset in demo (D06)');
  if (demo && (draft.externalRouteState === 'available' || draft.externalRouteState === 'unavailable')) {
    add('externalRouteState', 'demo routes stay unverified (EXT-08)');
  }
  if (demo && draft.productionAuthorized === true) add('productionAuthorized', 'demo drafts are never production authorized (G08)');
  return issues;
}

export const launchDraftSchema: z.ZodType<LaunchDraft> = launchDraftShape.superRefine((draft, ctx) => {
  reportIssues(ctx, launchDraftIssues(draft));
});

export function safeParseLaunchDraft(input: unknown): SafeParseResult<LaunchDraft> {
  return safeParseWith(launchDraftSchema, input);
}

/** Throws `DataValidationError` listing every issue. */
export function parseLaunchDraft(input: unknown): LaunchDraft {
  return parseWith(launchDraftSchema, input, 'launch draft');
}
