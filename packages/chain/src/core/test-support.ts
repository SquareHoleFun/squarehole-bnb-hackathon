/**
 * TEST ONLY: synthetic core v1 registry rows and their logs (S10a § 9 steps 2, 5-7). Builds a registry record for a
 * spec, encodes the `BoxCreated` and `BoxSpec` logs the registry would emit, and offers test Q lists for every Q class
 * (BC-083, BC-086). Never imported by the app or the service.
 */
import { AddOnId, BOX_0_MISFITS, BoxType, encodeBoxSpecV1, QClass, specHash, type BoxSpecV1, type QAsset } from '@squarehole/box-spec';
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { boxRegistryAbi } from '../abi/boxRegistry';
import { rolesRequired, ZERO_ADDRESS, ZERO_HASH, type RegistryLog, type RegistryRecord } from './box-row';
import { effectiveOpenAt } from './open-time';
import { ROLE_NAMES, type RoleName } from './roles';

/** A deterministic address from a label (keccak of the label, last 20 bytes). */
export function labelAddress(label: string): Address {
  return getAddress(`0x${keccak256(toHex(label)).slice(-40)}`);
}

/** A deterministic 32-byte value from a label. */
export function labelHash(label: string): Hex {
  return keccak256(toHex(`hash:${label}`));
}

/** Test Q assets of every class (BC-083's matrix): placed below or above a token address by the caller's choice. */
export const TEST_Q = Object.freeze({
  NATIVE_ETH: { token: ZERO_ADDRESS, decimals: 18, qClass: QClass.NATIVE_ETH },
  ERC20_18: { token: '0x8000000000000000000000000000000000000018' as Address, decimals: 18, qClass: QClass.ERC20 },
  ERC20_6: { token: '0x8000000000000000000000000000000000000006' as Address, decimals: 6, qClass: QClass.ERC20 },
  FIT: { token: '0x800000000000000000000000000000000000f17e' as Address, decimals: 18, qClass: QClass.FIT },
  BOX_T: { token: '0x8000000000000000000000000000000000000b07' as Address, decimals: 18, qClass: QClass.BOX_T },
});
export type TestQName = keyof typeof TEST_Q;

/** A Q list holding every test Q with each raise the specs use. */
export function testQList(raises: readonly bigint[] = [BOX_0_MISFITS.raise]): readonly QAsset[] {
  return Object.values(TEST_Q).map((q) => ({ ...q, raisePresets: [...raises] }));
}

export interface SyntheticBox {
  readonly spec: BoxSpecV1;
  readonly record: RegistryRecord;
  readonly encodedSpec: Hex;
}

export interface SyntheticBoxOptions {
  readonly boxId?: bigint;
  readonly spec?: BoxSpecV1;
  readonly label?: string;
  readonly creationBlock?: bigint;
  /**
   * The creation block's time (Unix seconds; default 12 s a block from SYNTHETIC_TIME_AT_BLOCK_0): the record's openAt
   * is the spec's, or this + 1 for Now (`effectiveOpenAt`).
   */
  readonly creationTime?: bigint;
  /** Overrides of single roles' addresses (null: absent). */
  readonly contracts?: Partial<Record<RoleName, Address | null>>;
  readonly templateId?: Hex;
  readonly creator?: Address;
  readonly poolManager?: Address;
}

/** Block 0's time in synthetic chains (2026-10-01 00:00 UTC); block n is 12 s × n later (`syntheticTimeOf`). */
export const SYNTHETIC_TIME_AT_BLOCK_0 = 1_790_812_800n;
export const syntheticTimeOf = (block: bigint): bigint => SYNTHETIC_TIME_AT_BLOCK_0 + block * 12n;

/** A box's record as the registry would build it for `spec` (every role the spec needs, labelled addresses). */
export function syntheticBox(options: SyntheticBoxOptions = {}): SyntheticBox {
  const spec = options.spec ?? BOX_0_MISFITS;
  const label = options.label ?? `box-${options.boxId ?? 0n}`;
  const required = rolesRequired(spec);
  const creationBlock = options.creationBlock ?? 100n;
  const contracts = ROLE_NAMES.map((role) => {
    const override = options.contracts?.[role];
    if (override !== undefined) return override ?? ZERO_ADDRESS;
    return required[role] === false ? ZERO_ADDRESS : required[role] === true ? labelAddress(`${label}:${role}`) : ZERO_ADDRESS;
  });
  const codeHashes = contracts.map((address, i) => (address === ZERO_ADDRESS ? ZERO_HASH : labelHash(`${label}:code:${ROLE_NAMES[i]}`)));
  const record: RegistryRecord = {
    boxId: options.boxId ?? 0n,
    templateId: options.templateId ?? labelHash('template-0'),
    specHash: specHash(spec),
    creator: options.creator ?? labelAddress('creator'),
    q: spec.q,
    raise: spec.raise,
    poolManager: options.poolManager ?? labelAddress('pool-manager'),
    poolId: labelHash(`${label}:pool`),
    creationBlock,
    openAt: effectiveOpenAt(spec.openAt, options.creationTime ?? syntheticTimeOf(creationBlock)),
    randomness: labelAddress('drand'),
    contracts,
    codeHashes,
  };
  return { spec, record, encodedSpec: encodeBoxSpecV1(spec) };
}

/** A spec like box 0's but priced in `q` (the raise kept), for the Q-class matrix. */
export function specWithQ(q: Address, base: BoxSpecV1 = BOX_0_MISFITS): BoxSpecV1 {
  return { ...base, q };
}

/** A token-only spec (no items: no vault, collection or table; no add-ons that need items). */
export function tokenOnlySpec(base: BoxSpecV1 = BOX_0_MISFITS): BoxSpecV1 {
  return { ...base, boxType: BoxType.TOKEN_ONLY, addOns: base.addOns.filter((a) => a.id === AddOnId.CreatorFeeCap) };
}

export interface LogPlace {
  readonly registry: Address;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly txHash?: Hex;
  readonly logIndex?: number;
  readonly transactionIndex?: number;
}

const createdEvent = boxRegistryAbi.find((item) => item.type === 'event' && item.name === 'BoxCreated');
const specEvent = boxRegistryAbi.find((item) => item.type === 'event' && item.name === 'BoxSpec');

/** The `BoxCreated` and `BoxSpec` logs of one box, in one transaction, as the registry emits them. */
export function registryLogs(box: SyntheticBox, place: LogPlace): [RegistryLog & { transactionIndex: number }, RegistryLog & { transactionIndex: number }] {
  if (!createdEvent || createdEvent.type !== 'event' || !specEvent || specEvent.type !== 'event') throw new Error('registry ABI without its events');
  const r = box.record;
  const txHash = place.txHash ?? labelHash(`tx:${place.blockHash}:${r.boxId}`);
  const logIndex = place.logIndex ?? 0;
  const base = { address: place.registry, blockNumber: place.blockNumber, blockHash: place.blockHash, transactionHash: txHash, transactionIndex: place.transactionIndex ?? 0 };
  const createdTopics = encodeEventTopics({ abi: boxRegistryAbi, eventName: 'BoxCreated', args: { boxId: r.boxId, templateId: r.templateId, specHash: r.specHash } }) as Hex[];
  const recordData = encodeAbiParameters(createdEvent.inputs.filter((input) => !input.indexed), [
    { ...r, contracts: r.contracts as never, codeHashes: r.codeHashes as never },
  ]);
  const specTopics = encodeEventTopics({ abi: boxRegistryAbi, eventName: 'BoxSpec', args: { boxId: r.boxId } }) as Hex[];
  const specData = encodeAbiParameters(specEvent.inputs.filter((input) => !input.indexed), [box.encodedSpec]);
  return [
    { ...base, topics: createdTopics, data: recordData, logIndex },
    { ...base, topics: specTopics, data: specData, logIndex: logIndex + 1 },
  ];
}
