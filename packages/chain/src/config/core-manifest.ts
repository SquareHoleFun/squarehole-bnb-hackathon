/**
 * The core v1 deployment manifest (`squarehole.core-deployment/v1`; S10a, docs/design/s10a-core-v1-site.md § 2.3),
 * separate from the first handoff's `squarehole.deployment/v1` (manifest.ts). One file per chain,
 * packages/contracts/deployments/core-v1/<chainId>.json, written by `scripts/write-core-manifest.mjs` from chain reads
 * after a broadcast (observed, never typed in).
 *
 * - `awaiting-broadcast`: core v1 is not on that chain yet; nothing but the chain is named, and the site says so and
 *   never guesses an address (Sepolia's file is committed this way until the founder broadcasts).
 * - `deployed`: the chain-wide contracts (PoolManager, WETH, the drand source, the platform Safe) and each factory
 *   version (factory, registry, the block box discovery starts from, the implementations, the version code hash, the
 *   template ids the site shows), each address with its code hash at the evidence block.
 *
 * There is no per-box field (BC-073): boxes come only from the registry's rows. Unknown fields are refused, so a
 * hand-added box address cannot slip in.
 *
 * Chain 1 (Ethereum mainnet, network `mainnet`; SH-188) is admitted as data only: its committed file is
 * `awaiting-broadcast` until the founder's broadcast, so every address is unknown and every consumer refuses it (the
 * v2 parser: "core v1 is not deployed"; the indexer: CoreNotDeployedError; the site has no mainnet source). Nothing
 * here can send: the write side has no chain 1 (write/chains.ts, G08).
 *
 * BNB Chain testnet (chain 97, network `bnb-testnet`; SH-258) carries the v2 release only: no box 0, so no core v1
 * version. Its `deployed` file has `versions: []` (required empty: box 0 is never on 97) and the release in
 * `releases` (core/v2/manifest-v2.ts). Whether a build reads it is the build's choice (the `SH_TESTNET` profile).
 */
import { PLATFORM_SAFE_MAINNET } from '@squarehole/box-spec';
import { isAddress } from '@squarehole/domain';
import type { Address, Hex } from 'viem';
import { z } from 'zod';
import { ChainConfigError } from '../errors';
import { BNB_TESTNET_CHAIN_ID } from './testnet-profile';

export const CORE_MANIFEST_SCHEMA = 'squarehole.core-deployment/v1';
const ZERO = '0x0000000000000000000000000000000000000000';

const address = z
  .string()
  .refine(isAddress, 'must be a 0x-prefixed 20-byte address')
  .refine((value) => value.toLowerCase() !== ZERO, 'the zero address is not a contract identity')
  .transform((value) => value as Address);
const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex value')
  .transform((value) => value.toLowerCase() as Hex);
const blockNumber = z.string().regex(/^(0|[1-9][0-9]{0,19})$/, 'must be a decimal block number');

const contract = z.object({ address, codeHash: bytes32 }).strict();

/** The implementations factory v1 names (IBoxFactoryV1.Implementations) and its two extensions. */
const implementations = z
  .object({
    coordinator: contract,
    hook: contract,
    hookExtension: contract,
    launchRouter: contract,
    receiver: contract,
    receiverExtension: contract,
    collection: contract,
    vault: contract,
    tickets: contract,
    royaltyRouter: contract,
    itemStream: contract,
  })
  .strict();

const version = z
  .object({
    version: z.number().int().min(1).max(65_535),
    factory: contract,
    registry: contract,
    /** Box discovery starts here: box 0's creation block for version 1 (the registry emits nothing before its first record). */
    startBlock: blockNumber,
    implementations,
    versionCodeHash: bytes32,
    /** Template ids the site shows (box 0's for version 1); a box of another template gets one row and no indexing. */
    supportedTemplates: z.array(bytes32).min(1),
  })
  .strict();

const evidence = z
  .object({
    block: z.object({ number: blockNumber, hash: bytes32 }).strict(),
    finality: z.enum(['finalized', 'confirmed']),
  })
  .strict();

const network = z.enum(['mainnet', 'sepolia', 'local', 'bnb-testnet']);
/**
 * Ethereum mainnet (chain 1, network `mainnet` only); Sepolia, and a local twin of it (an anvil with Sepolia's chain id:
 * the drand pin, plan § 7.1), or a local 31337; BNB Chain testnet (97, network `bnb-testnet` only).
 */
const chainId = z.union([z.literal(1), z.literal(11_155_111), z.literal(31_337), z.literal(BNB_TESTNET_CHAIN_ID)]);

/**
 * Mainnet is chain 1 and chain 1 is mainnet: a local twin of mainnet or a "mainnet" Sepolia file is refused. BNB Chain
 * testnet likewise: `bnb-testnet` is exactly chain 97.
 */
function checkNetwork(manifest: { readonly chainId: number; readonly network: string }, ctx: z.RefinementCtx): void {
  if ((manifest.network === 'mainnet') !== (manifest.chainId === 1)) {
    ctx.addIssue({ code: 'custom', path: ['network'], message: 'network mainnet is exactly chain 1' });
  }
  if ((manifest.network === 'bnb-testnet') !== (manifest.chainId === BNB_TESTNET_CHAIN_ID)) {
    ctx.addIssue({ code: 'custom', path: ['network'], message: 'network bnb-testnet is exactly chain 97' });
  }
}

const awaiting = z
  .object({
    schema: z.literal(CORE_MANIFEST_SCHEMA),
    status: z.literal('awaiting-broadcast'),
    chainId,
    network,
    /** Why, in one line (shown to people); optional. */
    note: z.string().max(200).optional(),
  })
  .strict()
  .superRefine(checkNetwork);

const deployed = z
  .object({
    schema: z.literal(CORE_MANIFEST_SCHEMA),
    status: z.literal('deployed'),
    chainId,
    network,
    chain: z
      .object({
        poolManager: contract,
        weth: contract,
        randomness: contract,
        /** The platform Safe (box 0's capped 2/15); its code hash is the empty-code hash on a local twin. */
        platformSafe: contract,
      })
      .strict(),
    /** At least one version (box 0's is version 1); none on BNB Chain testnet, where box 0 never exists. */
    versions: z.array(version),
    evidence,
    gitCommit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const seen = new Set<number>();
    for (const [i, v] of manifest.versions.entries()) {
      if (seen.has(v.version)) ctx.addIssue({ code: 'custom', path: ['versions', i, 'version'], message: 'version listed twice' });
      seen.add(v.version);
      if (BigInt(v.startBlock) > BigInt(manifest.evidence.block.number)) {
        ctx.addIssue({ code: 'custom', path: ['versions', i, 'startBlock'], message: 'startBlock is after the evidence block' });
      }
    }
    if (manifest.chainId === BNB_TESTNET_CHAIN_ID) {
      if (manifest.versions.length !== 0) ctx.addIssue({ code: 'custom', path: ['versions'], message: 'chain 97 has no core v1 version (no box 0 on BNB Chain testnet)' });
    } else {
      // Both issues, as before SH-258 (the array's minimum and the missing version 1).
      if (manifest.versions.length === 0) ctx.addIssue({ code: 'custom', path: ['versions'], message: 'Too small: expected array to have >=1 items' });
      if (!seen.has(1)) ctx.addIssue({ code: 'custom', path: ['versions'], message: 'version 1 (box 0\'s factory) is missing' });
    }
    if (manifest.network === 'sepolia' && manifest.chainId !== 11_155_111) ctx.addIssue({ code: 'custom', path: ['chainId'], message: 'a Sepolia manifest is for chain 11155111' });
    checkNetwork(manifest, ctx);
    // Box 0's spec, BoxSpecV1 and DeployCoreV2 all name this one Safe on chain 1 (mainnet-launch.md step 6).
    if (manifest.chainId === 1 && manifest.chain.platformSafe.address.toLowerCase() !== PLATFORM_SAFE_MAINNET.toLowerCase()) {
      ctx.addIssue({ code: 'custom', path: ['chain', 'platformSafe'], message: `chain 1's platform Safe is ${PLATFORM_SAFE_MAINNET}` });
    }
  });

const manifestSchema = z.discriminatedUnion('status', [awaiting, deployed]);

export type CoreManifest = z.output<typeof manifestSchema>;
export type DeployedCoreManifest = Extract<CoreManifest, { status: 'deployed' }>;
export type CoreVersion = DeployedCoreManifest['versions'][number];
export type CoreContractEntry = z.output<typeof contract>;
export type CoreImplementationName = keyof CoreVersion['implementations'];

/** Strict parse. Throws `ChainConfigError('invalid_manifest')` naming the first problems. */
export function parseCoreManifest(input: unknown): CoreManifest {
  const result = manifestSchema.safeParse(input);
  if (!result.success) {
    const summary = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ChainConfigError('invalid_manifest', `Core v1 manifest rejected (${result.error.issues.length} issue(s)): ${summary}`);
  }
  return result.data;
}

/** The version-1 entry (box 0's factory and registry). */
export function coreVersion1(manifest: DeployedCoreManifest): CoreVersion {
  const v1 = manifest.versions.find((v) => v.version === 1);
  if (!v1) throw new ChainConfigError('invalid_manifest', 'Core v1 manifest without version 1');
  return v1;
}

/** Where a build reads a chain's core v1 state from, in words for people. */
export function coreManifestState(input: unknown): { readonly status: 'deployed'; readonly manifest: DeployedCoreManifest } | { readonly status: 'awaiting-broadcast'; readonly chainId: number; readonly network: CoreManifest['network'] } | { readonly status: 'none' } | { readonly status: 'invalid'; readonly reason: string } {
  if (input === null || input === undefined) return { status: 'none' };
  try {
    const manifest = parseCoreManifest(input);
    return manifest.status === 'deployed' ? { status: 'deployed', manifest } : { status: 'awaiting-broadcast', chainId: manifest.chainId, network: manifest.network };
  } catch (error) {
    return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
}
