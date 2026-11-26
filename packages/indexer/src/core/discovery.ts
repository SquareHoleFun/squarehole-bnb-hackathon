/**
 * Box discovery (S10a § 3.1; BC-073): rows come only from the manifest's registries, and each box's code is checked at
 * its CREATION block (by the block's hash) before it is shown:
 *
 * - every present role's `eth_getCode` hashes to the record's code hash (the registry took them at creation);
 * - each clone is a clone of the manifest's implementation for its role: the TypeScript twin of `BoxClones.isCloneOf`
 *   (EIP-1167 runtime `363d3d373d3d3d363d73 ‖ impl ‖ 5af43d82803e903d91602b57fd5bf3`) and `isReceivingCloneOf` (the
 *   royalty router's 6-byte prefix and its moved jump; packages/contracts/src/box/libraries/BoxClones.sol:93-121);
 * - the PoolManager and the box's source are the manifest's; a distinct DrandSource behind it has its pinned code.
 *
 * A failed check: the box is not shown, and the indexer says why. Classification is minimal (BC-074 and the rest are
 * S10b): a template id on the manifest's `supportedTemplates` is shown; anything else gets its row and no indexing.
 */
import { drandSourceOf, type BoxRow, type CoreVersion, type DeployedCoreManifest, type RoleName } from '@squarehole/chain';
import { keccak256, type Address, type Hex } from 'viem';
import type { CoreReader } from './core-reader';

const PROXY_HEAD = '363d3d373d3d3d363d73';
const PROXY_TAIL = '5af43d82803e903d91602b57fd5bf3';
const RECEIVE_PREFIX = '36600557005b';
const RECEIVING_PROXY_TAIL = '5af43d82803e903d91603157fd5bf3';

/** Whether `code` begins with the standard clone proxy of `implementation` (BoxClones.isCloneOf). */
export function isCloneOf(code: Hex, implementation: Address): boolean {
  return code.toLowerCase().slice(2, 2 + 90) === `${PROXY_HEAD}${implementation.toLowerCase().slice(2)}${PROXY_TAIL}`;
}

/** Whether `code` begins with the receiving clone runtime of `implementation` (BoxClones.isReceivingCloneOf). */
export function isReceivingCloneOf(code: Hex, implementation: Address): boolean {
  return code.toLowerCase().slice(2, 2 + 102) === `${RECEIVE_PREFIX}${PROXY_HEAD}${implementation.toLowerCase().slice(2)}${RECEIVING_PROXY_TAIL}`;
}

/** Roles created as clones of a version implementation, and the implementation key each must be a clone of. */
const CLONES: readonly (readonly [RoleName, keyof CoreVersion['implementations'], 'standard' | 'receiving'])[] = [
  ['coordinator', 'coordinator', 'standard'],
  ['hook', 'hook', 'standard'],
  ['launchRouter', 'launchRouter', 'standard'],
  ['receiver', 'receiver', 'standard'],
  ['collection', 'collection', 'standard'],
  ['vault', 'vault', 'standard'],
  ['tickets', 'tickets', 'standard'],
  ['itemStream', 'itemStream', 'standard'],
  ['royaltyRouter', 'royaltyRouter', 'receiving'],
];

/**
 * shown; unsupported (a template this build does not show); refused (fails the code checks). A box's pictures never
 * decide its listing (SH-NO-PICTURE-GATE, founder 2026-10-24): the site shows a placeholder until they load.
 */
export type Classification = 'shown' | 'unsupported' | 'refused';

export interface BoxVerdict {
  readonly classification: Classification;
  /** Why the box is not shown (refused or unsupported); null when shown. */
  readonly reason: string | null;
}

/** The manifest version a row's registry belongs to, or null (a look-alike). */
export function versionOf(manifest: DeployedCoreManifest, registry: Address): CoreVersion | null {
  return manifest.versions.find((v) => v.registry.address.toLowerCase() === registry.toLowerCase()) ?? null;
}

/** Checks a row's code at its creation block (`creationHash`: that block's hash). Never throws for a bad box. */
export async function checkBoxAtCreation(reader: CoreReader, manifest: DeployedCoreManifest, row: BoxRow, creationHash: Hex): Promise<BoxVerdict> {
  const version = versionOf(manifest, row.registry);
  if (!version) return { classification: 'refused', reason: `registry ${row.registry} is not in the manifest` };
  if (row.poolManager.toLowerCase() !== manifest.chain.poolManager.address.toLowerCase()) return { classification: 'refused', reason: `PoolManager ${row.poolManager} is not the manifest's` };
  if (row.randomness.toLowerCase() !== manifest.chain.randomness.address.toLowerCase()) return { classification: 'refused', reason: `drand source ${row.randomness} is not the manifest's` };
  const roles = (Object.keys(row.contracts) as RoleName[]).filter((role) => row.contracts[role] !== null);
  const codes = new Map<RoleName, Hex>();
  const drand = drandSourceOf(manifest);
  let drandCode: Hex | null = null;
  try {
    if (drand.address.toLowerCase() !== row.randomness.toLowerCase()) drandCode = await reader.codeAt(drand.address, creationHash);
    await Promise.all(
      roles.map(async (role) => {
        codes.set(role, await reader.codeAt(row.contracts[role] as Address, creationHash));
      }),
    );
  } catch (error) {
    // A transport failure is not a verdict: the caller retries.
    throw new Error(`box ${row.boxId}: code at creation unavailable (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
  if (drandCode !== null && keccak256(drandCode).toLowerCase() !== drand.codeHash.toLowerCase()) {
    return { classification: 'refused', reason: 'drand source code is not the pinned DrandSource' };
  }
  for (const role of roles) {
    const code = codes.get(role) ?? '0x';
    if (code === '0x') return { classification: 'refused', reason: `${role} has no code at the creation block` };
    if (keccak256(code).toLowerCase() !== row.codeHashes[role]?.toLowerCase()) return { classification: 'refused', reason: `${role}'s code at the creation block does not hash to the record's` };
  }
  for (const [role, impl, kind] of CLONES) {
    const code = codes.get(role);
    if (code === undefined) continue;
    const implementation = version.implementations[impl].address;
    const ok = kind === 'standard' ? isCloneOf(code, implementation) : isReceivingCloneOf(code, implementation);
    if (!ok) return { classification: 'refused', reason: `${role} is not a clone of the version's ${impl} implementation` };
  }
  if (!version.supportedTemplates.some((t) => t.toLowerCase() === row.templateId.toLowerCase())) {
    return { classification: 'unsupported', reason: `template ${row.templateId} is not shown in this build (S10b classifies more)` };
  }
  return { classification: 'shown', reason: null };
}
