/**
 * SH-EXISTING-NFTS-E08C: a set box's identity as the chain records it, checked with E-08A's routing rule before any
 * call names its vault or collection (design § 4.10 "Registry routing and box identity").
 *
 * At one block: the add-on registry's record of the coordinator (`boxIdOf`, `recordOf`: template, spec hash, creator and
 * all 24 roles), the runtime at role 3 and `checkSetIdentity` (the hashed, strictly decoded spec; only roles
 * 0/1/2/3/5/6/19 set, role 4 zero; the vault an exact clone of the pinned SetVault with its 138-byte arguments: roles,
 * creator, collection, count, set hash and pick fee). Beside it, the release-code checks the helper leaves to its
 * callers: the pinned vault and loader implementations' runtime hashes, and the loader an exact clone of its pinned
 * implementation whose 76-byte arguments name this coordinator, this vault and the spec's set hash and count.
 *
 * The outside collection always comes from the vault's arguments and the spec, never from role 4. Nothing here touches a
 * wallet; a refusal is thrown as SetIdentityError and nothing is sent.
 */
import { encodePacked, keccak256, sliceHex, type Address, type Hex } from 'viem';
import type { SetSpecV2 } from '@squarehole/box-spec';
import { checkSetIdentity, setRegistryV2Abi, type SetCoreManifest, type SetIdentityInput, type SetReleaseManifest } from '@squarehole/chain/core/set-v2';
import { isStandardCloneOf } from '../../../../../packages/chain/src/core/v2';
import type { SetSource } from './set-build';
import { same, type SetReads } from './set-reads';

export interface SetBoxIdentity {
  readonly chainId: number;
  readonly registry: Address;
  readonly boxId: bigint;
  readonly coordinator: Address;
  readonly token: Address;
  readonly vault: Address;
  readonly loader: Address;
  readonly creator: Address;
  readonly collection: Address;
  readonly spec: SetSpecV2;
  readonly specHash: Hex;
  readonly encodedSpec: Hex;
  /** The block every read above was taken at. */
  readonly block: bigint;
  /** The manifests the routing rule ran against, and its exact inputs as read at `block` (the record, all 24 roles,
   *  the vault's runtime): E-08B's executor re-runs the same rule on them before every send (`SetTargetV2`). */
  readonly core: SetCoreManifest;
  readonly release: SetReleaseManifest;
  readonly observed: SetIdentityInput;
}

export class SetIdentityError extends Error {
  override readonly name = 'SetIdentityError';
}

interface RecordRead {
  readonly templateId: Hex;
  readonly specHash: Hex;
  readonly creator: Address;
  readonly contracts: readonly Address[];
}

function refuse(message: string): never {
  throw new SetIdentityError(message);
}

/** The loader clone's 76 bytes of arguments (StarterSetLoaderV2: coordinator, vault, set hash, count). */
export const loaderArgsOf = (coordinator: Address, vault: Address, spec: Pick<SetSpecV2, 'setHash' | 'count'>): Hex =>
  encodePacked(['address', 'address', 'bytes32', 'uint32'], [coordinator, vault, spec.setHash, spec.count]);

/**
 * Reads and checks the box whose coordinator is `coordinator`, with `encodedSpec` as its spec bytes (the run's own, or an
 * indexer's, which the record's spec hash then authenticates). Throws SetIdentityError when anything differs.
 */
export async function readSetIdentity(reads: SetReads, source: SetSource, coordinator: Address, encodedSpec: Hex): Promise<SetBoxIdentity> {
  if (await reads.chainId() !== source.chainId) refuse('The chain this page reads is not the box’s.');
  const block = await reads.blockNumber();
  const registry = source.release.registry.address;
  const [recorded, boxId] = await reads.read(registry, setRegistryV2Abi, 'boxIdOf', [coordinator], block) as readonly [boolean, bigint];
  if (!recorded) refuse('This box is not in the add-on’s registry.');
  const record = await reads.read(registry, setRegistryV2Abi, 'recordOf', [boxId], block) as RecordRead;
  const roles = [...record.contracts];
  if (!same(roles[0], coordinator)) refuse('The registry names another coordinator.');
  const vaultAddress = roles[3];
  if (!vaultAddress) return refuse('The box has no vault.');
  const vaultCode = await reads.code(vaultAddress, block);
  const observed: SetIdentityInput = Object.freeze({ registry, templateId: record.templateId, specHash: record.specHash, encodedSpec, creator: record.creator, roles: Object.freeze(roles), vaultCode });
  let checked: ReturnType<typeof checkSetIdentity>;
  try {
    checked = checkSetIdentity(source.core, source.release, observed);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : 'The box is not the add-on’s.');
  }
  const loader = roles[19];
  const token = roles[1];
  if (!loader || !token) return refuse('The box has no loader.');
  const { vault: vaultPin, starterSetLoader: loaderPin } = source.release.implementations;
  const [vaultImplementation, loaderImplementation, loaderCode] = await Promise.all([reads.code(vaultPin.address, block), reads.code(loaderPin.address, block), reads.code(loader, block)]);
  if (keccak256(vaultImplementation) !== vaultPin.codeHash.toLowerCase()) refuse('The vault code is not the release’s.');
  if (keccak256(loaderImplementation) !== loaderPin.codeHash.toLowerCase()) refuse('The loader code is not the release’s.');
  if (!isStandardCloneOf(loaderCode, loaderPin.address) || loaderCode.length !== 2 + 2 * (45 + 76)
    || sliceHex(loaderCode, 45).toLowerCase() !== loaderArgsOf(coordinator, checked.vault, checked.spec).toLowerCase()) refuse('The loader is not this box’s.');
  return Object.freeze({
    chainId: source.chainId, registry, boxId, coordinator, token, vault: checked.vault, loader, creator: record.creator,
    collection: checked.collection, spec: checked.spec, specHash: record.specHash, encodedSpec, block,
    core: source.core, release: source.release, observed,
  });
}
