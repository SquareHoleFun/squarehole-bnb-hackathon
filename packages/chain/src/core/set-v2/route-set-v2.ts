import { keccak256, sliceHex, zeroAddress, type Address, type Hex } from 'viem';
import {
  SET_FORMAT, SET_SCHEMA, SET_RELEASE, SET_TEMPLATE, decodeSetSpecV2, setAddressSchema, type SetSpecV2,
} from '@squarehole/box-spec';
import type { CoreVersion } from '../../config/core-manifest';
import { isStandardCloneOf } from '../v2/clones-v2';
import type { ReleaseV2 } from '../v2/manifest-v2';
import type { SetCoreManifest, SetReleaseManifest } from './manifest-set-v2';

export type RegistryRelease =
  | { readonly kind: 'v1'; readonly release: CoreVersion }
  | { readonly kind: 'v2.1'; readonly release: ReleaseV2 }
  | { readonly kind: 'set-v2'; readonly release: SetReleaseManifest };

/** Dispatch only on the log's emitting address in parsed manifests. Unknown registries remain unknown. */
export function releaseKindOfRegistry(core: SetCoreManifest, set: SetReleaseManifest | null, registry: Address): RegistryRelease | null {
  const key = setAddressSchema.parse(registry).toLowerCase();
  const v1 = core.versions.find(r => r.registry.address.toLowerCase() === key);
  if (v1) return { kind: 'v1', release: v1 };
  const v2 = 'releases' in core ? core.releases.find(r => r.registry.address.toLowerCase() === key) : undefined;
  if (v2) return { kind: 'v2.1', release: v2 };
  return set?.registry.address.toLowerCase() === key ? { kind: 'set-v2', release: set } : null;
}
export interface SetIdentityInput {
  /** Log emitter; never a registry supplied by event payload or metadata. */
  readonly registry: Address;
  readonly templateId: Hex;
  readonly specHash: Hex;
  readonly encodedSpec: Hex;
  readonly creator: Address;
  readonly roles: readonly Address[];
  /** Runtime read at roles[3] on the manifest chain at the same block as the record. */
  readonly vaultCode: Hex;
}
export interface SetIdentity {
  readonly release: SetReleaseManifest;
  readonly spec: SetSpecV2;
  readonly collection: Address;
  readonly vault: Address;
}
function refuse(message: string): never { throw new Error(`Set identity refused: ${message}`); }

/** Strict schema/domain routing plus the 138-byte SetVault args; role 4 is never the outside collection. */
export function checkSetIdentity(core: SetCoreManifest, set: SetReleaseManifest, input: SetIdentityInput): SetIdentity {
  const route = releaseKindOfRegistry(core, set, input.registry);
  if (route?.kind !== 'set-v2') refuse('registry');
  if (input.templateId.toLowerCase() !== SET_TEMPLATE) refuse('template');
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(input.encodedSpec) || keccak256(input.encodedSpec) !== input.specHash.toLowerCase()) refuse('spec hash');
  const spec = decodeSetSpecV2(input.encodedSpec);
  if (spec.format !== SET_FORMAT || spec.schema.toLowerCase() !== SET_SCHEMA || spec.release.toLowerCase() !== SET_RELEASE) refuse('spec domain');
  const roles = input.roles.map(r => setAddressSchema.parse(r).toLowerCase() as Address);
  if (roles.length !== 24) refuse('role count');
  const active = [0, 1, 2, 3, 5, 6, 19];
  for (const [i, role] of roles.entries()) {
    if (active.includes(i) ? role === zeroAddress : role !== zeroAddress) refuse(`role ${i}`);
  }
  if (new Set(active.map(i => roles[i])).size !== active.length) refuse('aliased roles');
  const code = input.vaultCode;
  if (!/^0x[0-9a-fA-F]{366}$/.test(code) || !isStandardCloneOf(code, set.implementations.vault.address)) refuse('vault runtime');
  const args = sliceHex(code, 45);
  const at = (offset: number, length: number): Hex => sliceHex(args, offset, offset + length).toLowerCase() as Hex;
  for (const [offset, role] of [[0, 0], [20, 1], [40, 19]] as const) {
    if (at(offset, 20) !== roles[role]) refuse('vault role args');
  }
  if (at(60, 20) !== setAddressSchema.parse(input.creator).toLowerCase()) refuse('creator');
  const collection = at(80, 20);
  if (collection === zeroAddress || collection !== spec.collection.toLowerCase()) refuse('collection');
  if (BigInt(at(100, 4)) !== BigInt(spec.count) || at(104, 32) !== spec.setHash.toLowerCase() || BigInt(at(136, 2)) !== BigInt(spec.pickFeeBps)) refuse('commitment/fee args');
  const vault = roles[3];
  if (!vault) refuse('missing vault');
  return { release: route.release, spec, collection, vault };
}
