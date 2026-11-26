/** CQ11 deployed releases beside the unchanged v1 envelope. Only surviving identities and
 * deployment-attested Safe pins belong here; box 0 owns its executor configuration. */
import { isAddress } from '@squarehole/domain';
import type { Address, Hex } from 'viem';
import { z } from 'zod';
import { coreManifestState, parseCoreManifest, type DeployedCoreManifest } from '../../config/core-manifest';
import { BNB_TESTNET_CHAIN_ID } from '../../config/testnet-profile';
import { ChainConfigError } from '../../errors';
import { safePinV2Schema } from './safe-config-v2';

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
const contract = z.object({ address, codeHash: bytes32 }).strict();

/** Surviving clone implementations and the shared hook extension (Amendment 3 C2/C14). */
const implementations = z
  .object({
    coordinator: contract,
    hook: contract,
    hookExtension: contract,
    launchRouter: contract,
    receiver: contract,
    collection: contract,
    vault: contract,
    tickets: contract,
    royaltyRouter: contract,
    token: contract,
    // Optional for older M1 releases; a box using one must prove the corresponding pinned clone.
    itemLedger: contract.optional(),
    pileVault: contract.optional(),
    tokenLedger: contract.optional(),
    holderLedger: contract.optional(),
    shopVault: contract.optional(),
    starterSetLoader: contract.optional(),
  })
  .strict();

const release = z
  .object({
    version: z.literal(2),
    factory: contract,
    registry: contract,
    listingRegistry: contract,
    // Older release entries predate the time-dependent directory check.
    feeModuleDirectory: contract.optional(),
    safes: z.strictObject({ fit: safePinV2Schema, platform: safePinV2Schema }),
    /**
     * The custody roles behind the Safe pins (F151 R68-SAFE, F164 D2), as DeployCoreV2 reads them from its
     * configuration and the burn bot names them. Required on chain 1, where the platform Safe is 2-of-3 and only the
     * roles say which owner is the founder and which account the bot; optional elsewhere (Sepolia's releases predate it).
     */
    owners: z.strictObject({ founder: address, bot: address, backup: address }).optional(),
    startBlock: z.string().regex(/^(0|[1-9][0-9]{0,19})$/, 'must be a decimal block number'),
    implementations,
    versionCodeHash: bytes32,
  })
  .strict();

export type ReleaseV2 = z.output<typeof release>;
export type ImplementationNameV2 = keyof ReleaseV2['implementations'];
export type DeployedCoreManifestV2 = DeployedCoreManifest & { readonly releases: readonly ReleaseV2[] };

const releasesSchema = z.array(release).min(1, 'a v2 manifest names at least one release');

function fail(summary: string): never {
  throw new ChainConfigError('invalid_manifest', `Core v2 manifest rejected: ${summary}`);
}

/** Ethereum mainnet, where the platform Safe is 2-of-3 (F151 R68-SAFE). */
export const MAINNET_CHAIN_ID = 1;

/**
 * Each protocol Safe's owner count and threshold on a chain. FIT is 2-of-3 everywhere (bot, founder, backup). The
 * platform Safe is 2-of-3 on mainnet (F151 R68-SAFE: the founder and two owners he names) and stays the founder alone,
 * 1-of-1, on Sepolia and the local chains.
 */
export function custodyPolicy(chainId: number): Readonly<Record<'fit' | 'platform', { readonly threshold: string; readonly count: number }>> {
  return chainId === MAINNET_CHAIN_ID
    ? { fit: { threshold: '2', count: 3 }, platform: { threshold: '2', count: 3 } }
    : { fit: { threshold: '2', count: 3 }, platform: { threshold: '1', count: 1 } };
}

/**
 * Who owns what (F151, F164 D2): FIT's owners are exactly the bot, the founder and the backup; the founder owns the
 * platform Safe, at any position (Safe's getOwners() lists the newest owner first, so after the two additions of the
 * launch runbook's step 6 he is last), and the bot never does. On chain 1 the release must name the roles; without them
 * (Sepolia's older releases) the platform's sole owner is the founder and must be one of FIT's owners.
 */
function checkOwnerRoles(r: ReleaseV2, chainId: number, at: string): void {
  const lower = (list: readonly string[]) => list.map((a) => a.toLowerCase());
  const fit = lower(r.safes.fit.owners);
  const platform = lower(r.safes.platform.owners);
  if (!r.owners) {
    if (chainId === MAINNET_CHAIN_ID) fail(`${at}.owners: the founder, bot and backup roles are required on chain 1`);
    const founder = platform[0];
    if (!founder || !fit.includes(founder)) fail(`${at}.safes: founder/bot/backup owner set mismatch`);
    return;
  }
  const roles = { founder: r.owners.founder.toLowerCase(), bot: r.owners.bot.toLowerCase(), backup: r.owners.backup.toLowerCase() };
  if (new Set(Object.values(roles)).size !== 3) fail(`${at}.owners: the founder, bot and backup must be three accounts`);
  if ([...fit].sort().join() !== [roles.bot, roles.founder, roles.backup].sort().join()) {
    fail(`${at}.safes.fit: owners are not the bot, the founder and the backup`);
  }
  if (!platform.includes(roles.founder)) fail(`${at}.safes.platform: the founder is not an owner`);
  if (platform.includes(roles.bot)) fail(`${at}.safes.platform: the bot is never a platform owner`);
}

/**
 * Strict parse of a deployed v1 manifest with `releases`. Throws `ChainConfigError('invalid_manifest')`.
 *
 * BNB Chain testnet (chain 97; SH-258) has no Safe and no box 0: its two fee addresses are holding contracts of the
 * deployer (the alpha path's custody doubles), pinned in the same Safe-shaped record. The release must still name two
 * different accounts, the platform one being the manifest's `chain.platformSafe`; the owner-count, threshold and
 * owner-role rules (F151, F164: the founder's Safes on mainnet and Sepolia) do not apply there. Its chain check is
 * `checkTestnetReleaseOnChain` (testnet-release-check.ts): the chain id and the code at every address.
 */
export function parseCoreManifestV2(input: unknown): DeployedCoreManifestV2 {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('not an object');
  const { releases: rawReleases, ...rest } = input as Record<string, unknown>;
  const v1 = parseCoreManifest(rest);
  if (v1.status !== 'deployed') fail('core v1 is not deployed on this chain, so no v2 release can be');
  const parsed = releasesSchema.safeParse(rawReleases);
  if (!parsed.success) {
    fail(parsed.error.issues.slice(0, 5).map((issue) => `releases.${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '));
  }
  const evidence = BigInt(v1.evidence.block.number);
  const registries = new Set<string>();
  for (const [i, r] of parsed.data.entries()) {
    const key = r.registry.address.toLowerCase();
    if (registries.has(key)) fail(`releases.${i}: registry ${r.registry.address} listed twice`);
    registries.add(key);
    const safes = r.safes;
    if (new Set(Object.values(safes).map(s => s.address)).size !== 2) fail(`releases.${i}.safes: distinct accounts required`);
    if (safes.platform.address !== v1.chain.platformSafe.address.toLowerCase()) fail(`releases.${i}.safes: platform differs from box 0`);
    if (v1.chainId !== BNB_TESTNET_CHAIN_ID) {
      const custody = custodyPolicy(v1.chainId);
      for (const role of ['fit', 'platform'] as const) {
        const s = safes[role];
        const { threshold, count } = custody[role];
        if (s.threshold !== threshold || s.owners.length !== count || new Set(s.owners).size !== count) {
          fail(`releases.${i}.safes.${role}: owner/threshold mismatch (${count} owners at threshold ${threshold} on chain ${v1.chainId})`);
        }
      }
      checkOwnerRoles(r, v1.chainId, `releases.${i}`);
    }
    if (BigInt(r.startBlock) > evidence) fail(`releases.${i}.startBlock: after the evidence block`);
    if (v1.versions.some((v) => v.registry.address.toLowerCase() === key)) fail(`releases.${i}: registry ${r.registry.address} is a v1 version's`);
  }
  return { ...v1, releases: parsed.data };
}

/** The v2 release whose registry v2 is `registry`, or null (a v1 registry or a look-alike). */
export function releaseOfRegistry(manifest: DeployedCoreManifestV2, registry: Address): ReleaseV2 | null {
  return manifest.releases.find((r) => r.registry.address.toLowerCase() === registry.toLowerCase()) ?? null;
}

/** Validate all releases before exposing the v1 projection to a v1-only consumer. */
export function coreDeploymentState(input: unknown): ReturnType<typeof coreManifestState> {
  try {
    if (typeof input === 'object' && input !== null && 'releases' in input) {
      const { releases, ...v1 } = parseCoreManifestV2(input);
      void releases;
      return coreManifestState(v1);
    }
    return coreManifestState(input);
  } catch (error) {
    return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
}
