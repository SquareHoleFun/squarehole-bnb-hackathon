/**
 * Asset registry entries (M2 step 1; G06). The registry is the authority for quote identity: exact chain + address,
 * never a ticker, name or logo. In demo only `supported_demo` and `rejected` exist, and only on chain 31337.
 * ADR-0012: `supported_testnet` is a quote admitted by a template of the Sepolia registry (chain 11155111 only); it is
 * a testnet admission, never a G06 production admission, so it can never claim a verified issuer.
 */
import { z } from 'zod';
import type { GuardIssue } from './guards';
import { isDemoChain, isZeroAddress, sameAddress } from './ids';
import { assetIdentitySchema, provenanceSchema, type SafeParseResult } from './schemas';
import type { AssetIdentity, AssetRegistryEntry } from './types';
import { isRecord, parseWith, reportIssues, safeParseWith, textField } from './validation';

/** Same asset: chain id, address (case-insensitive) and decimals. Symbols never decide identity. */
export function sameAssetIdentity(a: AssetIdentity, b: AssetIdentity): boolean {
  return a.chainId === b.chainId && sameAddress(a.address, b.address) && a.decimals === b.decimals;
}

/** ADR-0012: chains whose on-chain registry admissions are `supported_testnet` (Sepolia). */
export const TESTNET_REGISTRY_CHAIN_IDS: readonly number[] = Object.freeze([11_155_111]);

const entryShape = z.strictObject({
  asset: assetIdentitySchema,
  issuerFamily: textField({ min: 1, max: 64, innerSpaces: true, newlines: false }).optional(),
  admission: z.enum(['supported_demo', 'supported_testnet', 'rejected']),
  rejection: z.strictObject({ gate: z.literal('G06'), reason: textField({ min: 1, max: 200, innerSpaces: true, newlines: false }) }).optional(),
  provenance: provenanceSchema,
});
type EntryShape = z.output<typeof entryShape>;

/** Guards beyond structure. Total: tolerates partially malformed input. */
export function registryEntryIssues(entry: EntryShape): GuardIssue[] {
  const candidate: unknown = entry;
  if (!isRecord(candidate) || !isRecord(candidate.asset)) return [];
  const issues: GuardIssue[] = [];
  const { asset } = entry;
  const provenance: unknown = entry.provenance;
  const demo =
    isDemoChain(asset.chainId) || (isRecord(provenance) && (provenance.state === 'mock' || provenance.coverage === 'demo'));
  if (isZeroAddress(asset.address)) issues.push({ path: ['asset', 'address'], message: 'the zero address is not an asset identity' });
  if (demo && asset.issuerStatus === 'verified') issues.push({ path: ['asset', 'issuerStatus'], message: 'demo data must not claim a verified issuer (FEED-09)' });
  if (entry.admission === 'supported_demo' && !isDemoChain(asset.chainId)) {
    issues.push({ path: ['admission'], message: 'supported_demo is only valid on the demo chain 31337 (production registry is empty, D07)' });
  }
  if (entry.admission === 'supported_testnet' && !TESTNET_REGISTRY_CHAIN_IDS.includes(asset.chainId)) {
    issues.push({ path: ['admission'], message: 'supported_testnet is only valid on a testnet registry chain (11155111)' });
  }
  if (entry.admission === 'supported_testnet' && asset.issuerStatus === 'verified') {
    issues.push({ path: ['asset', 'issuerStatus'], message: 'a testnet admission is not an issuer verification (G06)' });
  }
  if ((entry.admission === 'supported_demo' || entry.admission === 'supported_testnet') && entry.rejection !== undefined) {
    issues.push({ path: ['rejection'], message: 'a supported entry carries no rejection' });
  }
  if (entry.admission === 'rejected' && entry.rejection === undefined) {
    issues.push({ path: ['rejection'], message: 'a rejected entry states its G06 reason' });
  }
  return issues;
}

export const assetRegistryEntrySchema: z.ZodType<AssetRegistryEntry> = entryShape
  .superRefine((entry, ctx) => {
    reportIssues(ctx, registryEntryIssues(entry));
  })
  // Sound after the guards: `rejection` is present exactly when `admission` is 'rejected'.
  .transform((entry) => entry as AssetRegistryEntry);

const registrySchema: z.ZodType<AssetRegistryEntry[]> = z.array(entryShape).superRefine((entries, ctx) => {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    reportIssues(ctx, registryEntryIssues(entry), [index]);
    const asset: unknown = entry.asset;
    if (!isRecord(asset) || typeof asset.address !== 'string') return;
    const key = `${String(asset.chainId)}:${asset.address.toLowerCase()}`;
    if (seen.has(key)) reportIssues(ctx, [{ path: [index, 'asset', 'address'], message: 'duplicate asset identity (chain + address)' }]);
    seen.add(key);
  });
}).transform((entries) => entries as AssetRegistryEntry[]);

export function safeParseAssetRegistryEntry(input: unknown): SafeParseResult<AssetRegistryEntry> {
  return safeParseWith(assetRegistryEntrySchema, input);
}

export function validateAssetRegistryEntry(input: unknown): AssetRegistryEntry {
  return parseWith(assetRegistryEntrySchema, input, 'asset registry entry');
}

/** A whole registry: every entry valid and each chain + address listed once. */
export function validateAssetRegistry(input: unknown): AssetRegistryEntry[] {
  return parseWith(registrySchema, input, 'asset registry');
}
