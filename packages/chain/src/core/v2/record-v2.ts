/**
 * One v2 box as registry v2 records it (ticket M1-52; IBoxRegistryV2.sol): `BoxCreated(boxId, templateId, specHash,
 * record)` with `BoxRecordV2`, and `BoxSpec(boxId, encodedSpec)` with format 2's spec, keccak256(encodedSpec) ==
 * specHash. The record's 24 roles are read by `ROLE_V2` (roles.ts); a zero address is an absent role.
 */
import { decodeEventLog, type Address, type Hex } from 'viem';
import { ROLE_V2, ROLE_V2_COUNT, ROLE_V2_NAMES, type RoleNameV2 } from '../roles';
import { registryV2Abi } from './abi-v2';

/** A log as the chain returns it (enough to decode). */
export interface LogLike {
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

export interface BoxRecordV2 {
  readonly boxId: bigint;
  readonly templateId: Hex;
  readonly specHash: Hex;
  readonly creator: Address;
  readonly pricingListingId: number;
  readonly q: Address;
  readonly raise: bigint;
  readonly poolManager: Address;
  readonly poolId: Hex;
  readonly creationBlock: bigint;
  readonly openAt: bigint;
  readonly randomness: Address;
  readonly contracts: readonly Address[];
  readonly codeHashes: readonly Hex[];
}

/** The record and the spec disagree, or the spec bytes do not decode as format 2. */
export class SpecRecordMismatch extends Error {
  override readonly name = 'SpecRecordMismatch';
}

const ZERO = /^0x0{40}$/i;
const ZERO32 = /^0x0{64}$/i;

export function decodeBoxCreatedV2(log: LogLike): { readonly boxId: bigint; readonly templateId: Hex; readonly specHash: Hex; readonly record: BoxRecordV2 } {
  const out = decodeEventLog({ abi: registryV2Abi, eventName: 'BoxCreated', topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
  if (out.eventName !== 'BoxCreated') throw new SpecRecordMismatch('not BoxCreated');
  const record = out.args.record as BoxRecordV2;
  if (record.contracts.length !== ROLE_V2_COUNT || record.codeHashes.length !== ROLE_V2_COUNT) throw new SpecRecordMismatch(`box ${out.args.boxId}: a record of ${record.contracts.length} roles`);
  if (record.boxId !== out.args.boxId || record.templateId.toLowerCase() !== out.args.templateId.toLowerCase() || record.specHash.toLowerCase() !== out.args.specHash.toLowerCase()) {
    throw new SpecRecordMismatch(`box ${out.args.boxId}: the record's id, template or spec hash differs from the event's topics`);
  }
  return { boxId: out.args.boxId, templateId: out.args.templateId, specHash: out.args.specHash, record };
}

export function decodeBoxSpecLogV2(log: LogLike): { readonly boxId: bigint; readonly encodedSpec: Hex } {
  const out = decodeEventLog({ abi: registryV2Abi, eventName: 'BoxSpec', topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
  if (out.eventName !== 'BoxSpec') throw new SpecRecordMismatch('not BoxSpec');
  return { boxId: out.args.boxId, encodedSpec: out.args.encodedSpec };
}

export interface RolesV2 {
  readonly contracts: Readonly<Record<RoleNameV2, Address | null>>;
  readonly codeHashes: Readonly<Record<RoleNameV2, Hex | null>>;
}

/** The record's roles by name; an absent role (zero address) is null, with a null code hash. */
export function rolesOfV2(record: BoxRecordV2): RolesV2 {
  const contracts = {} as Record<RoleNameV2, Address | null>;
  const codeHashes = {} as Record<RoleNameV2, Hex | null>;
  for (const role of ROLE_V2_NAMES) {
    const address = record.contracts[ROLE_V2[role]];
    const hash = record.codeHashes[ROLE_V2[role]];
    const present = address !== undefined && !ZERO.test(address);
    contracts[role] = present ? address : null;
    codeHashes[role] = present && hash !== undefined && !ZERO32.test(hash) ? hash : null;
  }
  return { contracts, codeHashes };
}
