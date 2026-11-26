/**
 * One box as the registry records it (S10a, docs/design/s10a-core-v1-site.md § 2.2): the one decoder the indexer and the
 * site use, so a box is the same whether it came from the registry's logs (`BoxCreated` + `BoxSpec`) or from
 * `registry.recordOf(id)` with the `BoxSpec` log of its creation block. Nothing about a box is configured anywhere else
 * (BC-073, BC-086): its addresses, Q, decimals, token order, curve, opening time and window come from this row.
 *
 * Refused, never guessed: a spec whose hash is not the record's (`specHashOfEncoded`), a Q that is not on the version's
 * Q list, a role the spec needs that is absent (or one it excludes that is present), an address without its code hash
 * (or the reverse), and a `BoxSpec` log without its `BoxCreated` (or two of either for one id).
 *
 * Amounts are bigint; the JSON form (`boxRowToJson`) carries decimal strings and the encoded spec, and is decoded back
 * through the same checks (`boxRowFromJson`).
 */
import {
  AddOnId,
  BoxType,
  boxCurve,
  decodeBoxSpecV1,
  Q_LIST_V1,
  Q_LIST_V2,
  QClass,
  specHashOfEncoded,
  tIsCurrency0,
  type BoxCurve,
  type BoxSpecV1,
  type QAsset,
} from '@squarehole/box-spec';
import { decodeEventLog, encodeEventTopics, getAddress, type Address, type Hex } from 'viem';
import { boxRegistryAbi } from '../abi/boxRegistry';
import { windowEndsAtOf } from './open-time';
import { ROLE, ROLE_COUNT, ROLE_NAMES, type RoleName } from './roles';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
export const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;

/** The Q classes a box can be priced in (BoxSpecV1 QClass; ERC-20s split by decimals only in tests and labels). */
export type QClassName = 'NATIVE_ETH' | 'ERC20' | 'FIT' | 'BOX_T';
const Q_CLASS_NAMES: Readonly<Record<number, QClassName>> = { [QClass.NATIVE_ETH]: 'NATIVE_ETH', [QClass.ERC20]: 'ERC20', [QClass.FIT]: 'FIT', [QClass.BOX_T]: 'BOX_T' };

export interface QAssetView {
  readonly token: Address;
  readonly decimals: number;
  readonly qClass: QClassName;
  /** "ETH" for native ETH; another Q's symbol when the caller knows it (S12 reads it), else null. */
  readonly symbol: string | null;
}

/** The registry record as `BoxCreated` and `recordOf` carry it (IBoxRegistry.BoxRecord). */
export interface RegistryRecord {
  readonly boxId: bigint;
  readonly templateId: Hex;
  readonly specHash: Hex;
  readonly creator: Address;
  readonly q: Address;
  readonly raise: bigint;
  readonly poolManager: Address;
  readonly poolId: Hex;
  readonly creationBlock: bigint;
  /** When trading opens (Unix seconds): the spec's openAt, or the creation block's time + 1 for Now (IBoxRegistry). */
  readonly openAt: bigint;
  readonly randomness: Address;
  readonly contracts: readonly Address[];
  readonly codeHashes: readonly Hex[];
}

/** Where the row's `BoxCreated` was emitted (the indexer's logs; absent for a row read with `recordOf`). */
export interface RowOrigin {
  readonly blockHash: Hex;
  readonly txHash: Hex;
  readonly logIndex: number;
}

export interface BoxRow {
  readonly chainId: number;
  readonly registry: Address;
  readonly boxId: bigint;
  readonly templateId: Hex;
  readonly specHash: Hex;
  readonly creator: Address;
  readonly q: Address;
  readonly raise: bigint;
  readonly poolManager: Address;
  readonly poolId: Hex;
  readonly creationBlock: bigint;
  /** When trading opens (Unix seconds; BoxHook.openAt): the first block whose timestamp is at or after it opens. */
  readonly openAt: bigint;
  /** openAt + WINDOW_SECONDS (384; BoxHook.windowEndsAt): the launch window is [openAt, windowEndsAt). */
  readonly windowEndsAt: bigint;
  readonly randomness: Address;
  /** Every role's address; null when the role is absent (zero in the record). */
  readonly contracts: Readonly<Record<RoleName, Address | null>>;
  readonly codeHashes: Readonly<Record<RoleName, Hex | null>>;
  readonly encodedSpec: Hex;
  readonly spec: BoxSpecV1;
  readonly qAsset: QAssetView;
  readonly tIsCurrency0: boolean;
  readonly curve: BoxCurve;
  /** The manifest's version-1 registry and box id 0 (never a name; BC-088's rule). */
  readonly isBox0: boolean;
  readonly origin: RowOrigin | null;
}

export type BoxRowRefusal =
  | 'spec_hash_mismatch'
  | 'spec_undecodable'
  | 'unknown_q'
  | 'role_missing'
  | 'role_unexpected'
  | 'code_hash_mismatch'
  | 'spec_without_record'
  | 'record_without_spec'
  | 'duplicate'
  | 'malformed';

export class BoxRowError extends Error {
  override readonly name = 'BoxRowError';
  readonly reason: BoxRowRefusal;
  constructor(reason: BoxRowRefusal, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** The Q list of a version (BoxSpecV1 contexts v1 and v2). */
export function qListOfVersion(version: number): readonly QAsset[] {
  if (version === 1) return Q_LIST_V1;
  if (version === 2) return Q_LIST_V2;
  throw new BoxRowError('unknown_q', `no Q list for spec version ${version}`);
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const checksum = (a: string): Address => getAddress(a);

const hasAddOn = (spec: BoxSpecV1, id: number): boolean => spec.addOns.some((a) => a.id === id);

/**
 * Which roles a spec requires (true), excludes (false) or leaves open (undefined): the factory's wiring
 * (IBoxFactoryV1 notes; CoreBox0Kit.prepare): every box has a coordinator, token, hook, receiver, launch router and
 * FIT's executor; a box with items its vault, collection and metadata table; the tickets, the per-item stream and the
 * royalty router follow their add-ons; the swap module exists for every Standard box (version 2) and never in version 1.
 */
export function rolesRequired(spec: BoxSpecV1): Readonly<Record<RoleName, boolean | undefined>> {
  const items = spec.boxType !== BoxType.TOKEN_ONLY;
  return {
    coordinator: true,
    token: true,
    hook: true,
    vault: items,
    collection: items,
    receiver: true,
    launchRouter: true,
    tickets: hasAddOn(spec, AddOnId.Placeholders),
    royaltyRouter: hasAddOn(spec, AddOnId.Royalties),
    executor: true,
    itemStream: hasAddOn(spec, AddOnId.PerItemStream),
    swapModule: spec.version === 1 ? false : true,
    metadataTable: items,
  };
}

export interface RowOptions {
  readonly chainId: number;
  readonly registry: Address;
  /** The manifest's version-1 registry, for `isBox0` (null: no box is box 0). */
  readonly box0Registry: Address | null;
  /** The version's Q list (default: the spec version's, `qListOfVersion`). */
  readonly qList?: readonly QAsset[];
  /** Known symbols of non-native Q (lowercase address → symbol), when the caller read them. */
  readonly qSymbols?: Readonly<Record<string, string>>;
  readonly origin?: RowOrigin | null;
}

/** A row from a registry record and the spec bytes of its `BoxSpec` log. Throws `BoxRowError`. */
export function boxRowFromRecord(record: RegistryRecord, encodedSpec: Hex, options: RowOptions): BoxRow {
  if (record.contracts.length !== ROLE_COUNT || record.codeHashes.length !== ROLE_COUNT) {
    throw new BoxRowError('malformed', `box ${record.boxId}: the record has ${record.contracts.length} contracts and ${record.codeHashes.length} code hashes (${ROLE_COUNT} each)`);
  }
  let hashOfSpec: Hex;
  let spec: BoxSpecV1;
  try {
    hashOfSpec = specHashOfEncoded(encodedSpec);
    spec = decodeBoxSpecV1(encodedSpec);
  } catch (error) {
    throw new BoxRowError('spec_undecodable', `box ${record.boxId}: the BoxSpec bytes do not decode (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!same(hashOfSpec, record.specHash)) throw new BoxRowError('spec_hash_mismatch', `box ${record.boxId}: the BoxSpec hashes to ${hashOfSpec}, the record names ${record.specHash}`);
  if (!same(spec.q, record.q) || spec.raise !== record.raise) throw new BoxRowError('spec_hash_mismatch', `box ${record.boxId}: the record's Q or raise differs from its spec`);
  const qList = options.qList ?? qListOfVersion(spec.version);
  const listed = qList.find((entry) => same(entry.token, record.q));
  if (!listed) throw new BoxRowError('unknown_q', `box ${record.boxId}: Q ${record.q} is not on the version's Q list`);
  const qClass = Q_CLASS_NAMES[listed.qClass];
  if (!qClass) throw new BoxRowError('unknown_q', `box ${record.boxId}: Q class ${listed.qClass} is unknown`);

  const required = rolesRequired(spec);
  const contracts = {} as Record<RoleName, Address | null>;
  const codeHashes = {} as Record<RoleName, Hex | null>;
  for (const role of ROLE_NAMES) {
    const address = record.contracts[ROLE[role]] ?? ZERO_ADDRESS;
    const hash = record.codeHashes[ROLE[role]] ?? ZERO_HASH;
    const present = !same(address, ZERO_ADDRESS);
    if (present !== !same(hash, ZERO_HASH)) throw new BoxRowError('code_hash_mismatch', `box ${record.boxId}: role ${role} has ${present ? 'an address without a code hash' : 'a code hash without an address'}`);
    if (required[role] === true && !present) throw new BoxRowError('role_missing', `box ${record.boxId}: role ${role} is absent but its spec needs it`);
    if (required[role] === false && present) throw new BoxRowError('role_unexpected', `box ${record.boxId}: role ${role} is present but its spec excludes it`);
    contracts[role] = present ? checksum(address) : null;
    codeHashes[role] = present ? (hash.toLowerCase() as Hex) : null;
  }
  const token = contracts.token;
  if (token === null) throw new BoxRowError('role_missing', `box ${record.boxId}: no token`);
  const tIsC0 = tIsCurrency0(token, record.q);
  const registry = checksum(options.registry);
  const isBox0 = options.box0Registry !== null && same(options.box0Registry, registry) && record.boxId === 0n;
  const symbol = qClass === 'NATIVE_ETH' ? 'ETH' : (options.qSymbols?.[record.q.toLowerCase()] ?? null);
  return Object.freeze({
    chainId: options.chainId,
    registry,
    boxId: record.boxId,
    templateId: record.templateId.toLowerCase() as Hex,
    specHash: record.specHash.toLowerCase() as Hex,
    creator: checksum(record.creator),
    q: checksum(record.q),
    raise: record.raise,
    poolManager: checksum(record.poolManager),
    poolId: record.poolId.toLowerCase() as Hex,
    creationBlock: record.creationBlock,
    openAt: record.openAt,
    windowEndsAt: windowEndsAtOf(record.openAt),
    randomness: checksum(record.randomness),
    contracts: Object.freeze(contracts),
    codeHashes: Object.freeze(codeHashes),
    encodedSpec: encodedSpec.toLowerCase() as Hex,
    spec,
    qAsset: Object.freeze({ token: checksum(listed.token), decimals: listed.decimals, qClass, symbol }),
    tIsCurrency0: tIsC0,
    curve: boxCurve(record.raise, tIsC0),
    isBox0,
    origin: options.origin ?? null,
  });
}

// ------------------------------------------------------------------------------------------------ logs

/** A log as the RPC returns it, narrowed to what decoding needs. */
export interface RegistryLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly logIndex: number;
  readonly removed?: boolean;
}

export const BOX_CREATED_TOPIC: Hex = encodeEventTopics({ abi: boxRegistryAbi, eventName: 'BoxCreated' })[0] as Hex;
export const BOX_SPEC_TOPIC: Hex = encodeEventTopics({ abi: boxRegistryAbi, eventName: 'BoxSpec' })[0] as Hex;
export const REGISTRY_TOPIC0: readonly Hex[] = Object.freeze([BOX_CREATED_TOPIC, BOX_SPEC_TOPIC]);

export type RegistryEvent =
  | { readonly kind: 'created'; readonly boxId: bigint; readonly record: RegistryRecord; readonly log: RegistryLog }
  | { readonly kind: 'spec'; readonly boxId: bigint; readonly encodedSpec: Hex; readonly log: RegistryLog };

/** Decodes one registry log (null: another event, or not decodable). The caller filters by the registry's address. */
export function decodeRegistryLog(log: RegistryLog): RegistryEvent | null {
  if (log.removed) return null;
  let decoded;
  try {
    decoded = decodeEventLog({ abi: boxRegistryAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
  } catch {
    return null;
  }
  if (decoded.eventName === 'BoxCreated') {
    const r = decoded.args.record;
    if (r.boxId !== decoded.args.boxId || !same(r.templateId, decoded.args.templateId) || !same(r.specHash, decoded.args.specHash)) return null;
    return {
      kind: 'created',
      boxId: decoded.args.boxId,
      record: { ...r, contracts: [...r.contracts], codeHashes: [...r.codeHashes] },
      log,
    };
  }
  if (decoded.eventName === 'BoxSpec') return { kind: 'spec', boxId: decoded.args.boxId, encodedSpec: decoded.args.encodedSpec, log };
  return null;
}

export interface RowsFromLogs {
  readonly rows: readonly BoxRow[];
  /** Boxes the registry recorded that the decoder refused, with why (BC-075's full rule is S10b's). */
  readonly refused: readonly { readonly boxId: bigint; readonly error: BoxRowError }[];
}

/**
 * Rows from a registry's logs (any order; only logs from `options.registry` count: anyone can emit the same
 * signatures). The registry emits `BoxCreated` then `BoxSpec` in one transaction, so a pair shares its transaction.
 */
export function rowsFromRegistryLogs(logs: readonly RegistryLog[], options: Omit<RowOptions, 'origin'>): RowsFromLogs {
  const created = new Map<bigint, Extract<RegistryEvent, { kind: 'created' }>[]>();
  const specs = new Map<bigint, Extract<RegistryEvent, { kind: 'spec' }>[]>();
  for (const log of logs) {
    if (!same(log.address, options.registry)) continue;
    const event = decodeRegistryLog(log);
    if (!event) continue;
    const into = event.kind === 'created' ? created : specs;
    const list = (into.get(event.boxId) ?? []) as RegistryEvent[];
    list.push(event);
    into.set(event.boxId, list as never);
  }
  const rows: BoxRow[] = [];
  const refused: { boxId: bigint; error: BoxRowError }[] = [];
  const ids = [...new Set([...created.keys(), ...specs.keys()])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const boxId of ids) {
    const c = created.get(boxId) ?? [];
    const s = specs.get(boxId) ?? [];
    try {
      if (c.length > 1 || s.length > 1) throw new BoxRowError('duplicate', `box ${boxId}: ${c.length} BoxCreated and ${s.length} BoxSpec logs`);
      const record = c[0];
      const spec = s[0];
      if (!record) throw new BoxRowError('spec_without_record', `box ${boxId}: a BoxSpec log without its BoxCreated`);
      if (!spec) throw new BoxRowError('record_without_spec', `box ${boxId}: a BoxCreated log without its BoxSpec`);
      if (!same(record.log.transactionHash, spec.log.transactionHash)) throw new BoxRowError('malformed', `box ${boxId}: BoxCreated and BoxSpec in different transactions`);
      rows.push(boxRowFromRecord(record.record, spec.encodedSpec, { ...options, origin: { blockHash: record.log.blockHash, txHash: record.log.transactionHash, logIndex: record.log.logIndex } }));
    } catch (error) {
      refused.push({ boxId, error: error instanceof BoxRowError ? error : new BoxRowError('malformed', String(error)) });
    }
  }
  return { rows, refused };
}

// ------------------------------------------------------------------------------------------------ JSON

/** The row in JSON: the record as the registry gives it (decimal strings) and the encoded spec; derived fields omitted. */
export interface BoxRowJson {
  readonly chainId: number;
  readonly registry: Address;
  readonly isBox0: boolean;
  readonly record: {
    readonly boxId: string;
    readonly templateId: Hex;
    readonly specHash: Hex;
    readonly creator: Address;
    readonly q: Address;
    readonly raise: string;
    readonly poolManager: Address;
    readonly poolId: Hex;
    readonly creationBlock: string;
    readonly openAt: string;
    readonly randomness: Address;
    readonly contracts: readonly Address[];
    readonly codeHashes: readonly Hex[];
  };
  readonly encodedSpec: Hex;
  readonly qSymbol: string | null;
  readonly origin: RowOrigin | null;
}

export function recordOfRow(row: BoxRow): RegistryRecord {
  return {
    boxId: row.boxId,
    templateId: row.templateId,
    specHash: row.specHash,
    creator: row.creator,
    q: row.q,
    raise: row.raise,
    poolManager: row.poolManager,
    poolId: row.poolId,
    creationBlock: row.creationBlock,
    openAt: row.openAt,
    randomness: row.randomness,
    contracts: ROLE_NAMES.map((role) => row.contracts[role] ?? ZERO_ADDRESS),
    codeHashes: ROLE_NAMES.map((role) => row.codeHashes[role] ?? ZERO_HASH),
  };
}

export function boxRowToJson(row: BoxRow): BoxRowJson {
  const r = recordOfRow(row);
  return {
    chainId: row.chainId,
    registry: row.registry,
    isBox0: row.isBox0,
    record: {
      ...r,
      boxId: r.boxId.toString(),
      raise: r.raise.toString(),
      creationBlock: r.creationBlock.toString(),
      openAt: r.openAt.toString(),
    },
    encodedSpec: row.encodedSpec,
    qSymbol: row.qAsset.symbol,
    origin: row.origin,
  };
}

const UINT = /^(0|[1-9][0-9]{0,77})$/;
const uint = (value: unknown, what: string): bigint => {
  if (typeof value !== 'string' || !UINT.test(value)) throw new BoxRowError('malformed', `${what} must be a decimal string`);
  return BigInt(value);
};
const hex = (value: unknown, what: string, bytes?: number): Hex => {
  const pattern = bytes === undefined ? /^0x([0-9a-fA-F]{2})*$/ : new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`);
  if (typeof value !== 'string' || !pattern.test(value)) throw new BoxRowError('malformed', `${what} must be ${bytes === undefined ? 'hex bytes' : `${bytes} hex bytes`}`);
  return value as Hex;
};
const addr = (value: unknown, what: string): Address => hex(value, what, 20) as Address;

/**
 * A row from its JSON form (an indexer answer, a fixture), through every check of `boxRowFromRecord`. `isBox0` is
 * recomputed from `box0Registry`, never taken from the JSON.
 */
export function boxRowFromJson(input: unknown, options: Omit<RowOptions, 'chainId' | 'registry' | 'origin'> & { readonly chainId?: number }): BoxRow {
  if (typeof input !== 'object' || input === null) throw new BoxRowError('malformed', 'a row must be an object');
  const json = input as Partial<BoxRowJson>;
  const record = json.record as Partial<BoxRowJson['record']> | undefined;
  if (typeof json.chainId !== 'number' || !Number.isSafeInteger(json.chainId)) throw new BoxRowError('malformed', 'chainId must be an integer');
  if (options.chainId !== undefined && json.chainId !== options.chainId) throw new BoxRowError('malformed', `the row is for chain ${json.chainId}, not ${options.chainId}`);
  if (!record || !Array.isArray(record.contracts) || !Array.isArray(record.codeHashes)) throw new BoxRowError('malformed', 'record.contracts and record.codeHashes must be arrays');
  const origin = json.origin ?? null;
  const parsed: RegistryRecord = {
    boxId: uint(record.boxId, 'record.boxId'),
    templateId: hex(record.templateId, 'record.templateId', 32),
    specHash: hex(record.specHash, 'record.specHash', 32),
    creator: addr(record.creator, 'record.creator'),
    q: addr(record.q, 'record.q'),
    raise: uint(record.raise, 'record.raise'),
    poolManager: addr(record.poolManager, 'record.poolManager'),
    poolId: hex(record.poolId, 'record.poolId', 32),
    creationBlock: uint(record.creationBlock, 'record.creationBlock'),
    openAt: uint(record.openAt, 'record.openAt'),
    randomness: addr(record.randomness, 'record.randomness'),
    contracts: record.contracts.map((a, i) => addr(a, `record.contracts[${i}]`)),
    codeHashes: record.codeHashes.map((h, i) => hex(h, `record.codeHashes[${i}]`, 32)),
  };
  const qSymbols = typeof json.qSymbol === 'string' && json.qSymbol.length <= 11 ? { [parsed.q.toLowerCase()]: json.qSymbol } : options.qSymbols;
  return boxRowFromRecord(parsed, hex(json.encodedSpec, 'encodedSpec'), {
    ...options,
    chainId: json.chainId,
    registry: addr(json.registry, 'registry'),
    ...(qSymbols ? { qSymbols } : {}),
    origin: origin === null ? null : { blockHash: hex(origin.blockHash, 'origin.blockHash', 32), txHash: hex(origin.txHash, 'origin.txHash', 32), logIndex: Number(origin.logIndex) },
  });
}

/** Every address of a box (present roles), lowercase: the indexer routes logs by these. */
export function rowAddresses(row: BoxRow): ReadonlyMap<string, RoleName> {
  const out = new Map<string, RoleName>();
  for (const role of ROLE_NAMES) {
    const address = row.contracts[role];
    if (address) out.set(address.toLowerCase(), role);
  }
  return out;
}
