/**
 * The deployment manifest (`squarehole.deployment/v1`, written by packages/contracts/script/WriteManifest.s.sol after a
 * broadcast; ADR-0011 §10) is the ONLY source of Square Hole contract identities in the app: chain id, registry,
 * hook, converter, per-launch token / mirror / ledger / collector and pool id. Never a symbol, never a guess.
 *
 * Only `status: "deployed"` manifests are accepted (a "simulated" dry run or a "pending-broadcast" plan never
 * describes a chain). Unknown extra fields are ignored; every field the readers use is checked.
 */
import { isAddress, RAW_AMOUNT_PATTERN } from '@squarehole/domain';
import type { Address, Hex } from 'viem';
import { z } from 'zod';
import { ChainConfigError } from '../errors';

export const MANIFEST_SCHEMA = 'squarehole.deployment/v1';
const ZERO = '0x0000000000000000000000000000000000000000';

const address = z.string().refine(isAddress, 'must be a 0x-prefixed 20-byte address').transform((value) => value as Address);
const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex value')
  .transform((value) => value as Hex);
const raw = z.string().regex(RAW_AMOUNT_PATTERN, 'must be an unsigned decimal string');
const block = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const int24 = z.number().int().min(-8_388_608).max(8_388_607);

const contractEntry = z.object({
  address,
  codehash: bytes32,
  contract: z.string().min(1),
  deployedAtBlock: block.optional(),
  deploymentTx: bytes32.optional(),
});

const templateEntry = z.object({
  version: z.number().int().min(1),
  quote: address,
  startFdvQ: raw,
  minStartUnitValueQ: raw,
  tickSpacing: int24,
  rangeTicks: int24,
  shape: z.number().int(),
  active: z.boolean(),
  addedAtBlock: block,
  maxCollectionUnits: raw,
});

const launchEntry = z.object({
  appPairId: z.string(),
  pairId: bytes32,
  kind: z.enum(['token', 'collection']),
  name: z.string(),
  symbol: z.string(),
  decimals: z.literal(18),
  rewardSide: z.enum(['T', 'Q']),
  quote: address,
  converter: address,
  units: raw,
  fractionsPerNft: raw,
  initialSupply: raw,
  templateVersion: z.number().int().min(1),
  startFdvQ: raw,
  minStartUnitValueQ: raw,
  poolId: bytes32,
  lpFeePips: z.number().int().min(0).max(1_000_000),
  tickSpacing: int24,
  tickLower: int24,
  tickUpper: int24,
  liquidity: raw,
  sqrtPriceX96: raw,
  metadataManifestHash: bytes32,
  creator: address,
  createdAtBlock: block,
  contracts: z.object({ token: contractEntry, mirror: contractEntry, rewardLedger: contractEntry, feeCollector: contractEntry }),
});

const manifestSchema = z
  .object({
    schema: z.literal(MANIFEST_SCHEMA),
    status: z.literal('deployed'),
    chainId: z.number().int().min(1),
    network: z.string(),
    startBlock: block,
    endBlock: block,
    startTimestamp: z.number().int().min(0).nullable().optional(),
    gitCommit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
    gitDirty: z.boolean().nullable(),
    deployer: address,
    registryAdmin: address,
    treasury: address,
    contracts: z.object({
      registry: contractEntry,
      launcher: contractEntry,
      hook: contractEntry.extend({ permissionFlags: z.string().optional() }),
      poolManager: contractEntry,
      claimConverter: contractEntry.optional(),
      WETH: contractEntry.optional(),
      USDC: contractEntry.optional(),
      USDT: contractEntry.optional(),
    }),
    templates: z.record(z.string(), templateEntry),
    launches: z.record(z.string(), launchEntry),
  })
  .superRefine((manifest, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: 'custom', path, message });
    };
    if (manifest.endBlock < manifest.startBlock) issue(['endBlock'], 'endBlock is before startBlock');
    // Identities the writers send to or trust must be real contracts, never the zero address.
    for (const key of ['registry', 'launcher', 'hook', 'poolManager'] as const) {
      if (manifest.contracts[key].address === ZERO) issue(['contracts', key, 'address'], 'the zero address is not a contract identity');
    }
    for (const key of ['registryAdmin', 'treasury'] as const) {
      if (manifest[key] === ZERO) issue([key], 'the zero address is not an identity');
    }
    // Templates: one entry per version, and the N bound the registry enforces (ADR-0011 §4).
    const versions = new Set<number>();
    for (const [key, template] of Object.entries(manifest.templates)) {
      if (versions.has(template.version)) issue(['templates', key, 'version'], 'template version listed twice');
      versions.add(template.version);
      const minUnit = BigInt(template.minStartUnitValueQ);
      if (minUnit === 0n || BigInt(template.startFdvQ) / minUnit !== BigInt(template.maxCollectionUnits)) {
        issue(['templates', key, 'maxCollectionUnits'], 'maxCollectionUnits must equal startFdvQ / minStartUnitValueQ');
      }
    }
    for (const [key, launch] of Object.entries(manifest.launches)) {
      const token = launch.contracts.token.address.toLowerCase();
      if (launch.appPairId !== `${manifest.chainId}:${token}`) issue(['launches', key, 'appPairId'], 'must be "<chainId>:<lowercase token>"');
      const hasMirror = launch.contracts.mirror.address !== ZERO;
      if (hasMirror !== (launch.kind === 'collection')) issue(['launches', key, 'contracts', 'mirror'], 'a collection has a mirror, a token has none');
      if (launch.createdAtBlock < manifest.startBlock) issue(['launches', key, 'createdAtBlock'], 'launch before the deployment start');
      if ((launch.rewardSide === 'T') !== (launch.converter !== ZERO)) issue(['launches', key, 'converter'], 'R = T launches name the converter; R = Q launches do not');
    }
  });

export type DeploymentManifest = z.output<typeof manifestSchema>;
export type ManifestLaunch = DeploymentManifest['launches'][string];
export type ManifestTemplate = DeploymentManifest['templates'][string];
export type ManifestContract = z.output<typeof contractEntry>;

/** Strict parse of a deployed manifest. Throws `ChainConfigError('invalid_manifest')` listing the first problems. */
export function parseDeploymentManifest(input: unknown): DeploymentManifest {
  const result = manifestSchema.safeParse(input);
  if (!result.success) {
    const summary = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ChainConfigError('invalid_manifest', `Deployment manifest rejected (${result.error.issues.length} issue(s)): ${summary}`);
  }
  return result.data;
}

/**
 * Picks `deployments/<chainId>.json` out of a module map such as Vite's
 * `import.meta.glob('<repo>/packages/contracts/deployments/*.json', { eager: true, import: 'default' })`. Files in
 * `dry-run/` or `pending/` never match (they are plans, not deployments). Returns null when the chain has none.
 */
export function selectManifestModule(chainId: number, modules: Readonly<Record<string, unknown>>): unknown {
  const suffix = `/deployments/${chainId}.json`;
  const match = Object.keys(modules).find((path) => path.replaceAll('\\', '/').endsWith(suffix));
  return match === undefined ? null : (modules[match] ?? null);
}
