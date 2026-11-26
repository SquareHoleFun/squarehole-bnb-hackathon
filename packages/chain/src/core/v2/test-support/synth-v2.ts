/**
 * TEST ONLY (M1-52): a synthetic core v2 release, its manifest, its boxes and listings, the logs registry v2 and the
 * listing registry emit, and a scripted reader for code and view calls. Clone codes follow `BoxClones` (standard and
 * receiving runtimes); the expected forms themselves are pinned against Solidity's bytes in clones-v2.test.ts.
 */
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, parseAbiParameters, toHex, type Address, type Hex } from 'viem';
import { labelAddress, labelHash } from '../../test-support';
import { listingRegistryV2Abi, registryV2Abi } from '../abi-v2';
import { predictConverter, receivingRuntime, standardRuntime } from '../clones-v2';
import { parseCoreManifestV2, type DeployedCoreManifestV2 } from '../manifest-v2';
import type { BoxRecordV2, LogLike } from '../record-v2';
import { encodeBoxSpecV2, type BoxSpecV2, type BranchV2 } from '../spec-v2';

export const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const ZERO32 = `0x${'0'.repeat(64)}` as Hex;

export const IMPL_KEYS_V2 = ['coordinator', 'hook', 'hookExtension', 'launchRouter', 'receiver', 'collection', 'vault', 'tickets', 'royaltyRouter', 'token'] as const;
export type ImplKeyV2 = (typeof IMPL_KEYS_V2)[number];
const V1_IMPL_KEYS = ['coordinator', 'hook', 'hookExtension', 'launchRouter', 'receiver', 'receiverExtension', 'collection', 'vault', 'tickets', 'royaltyRouter', 'itemStream'] as const;

/** Any runtime for a non-clone contract, from a label (never a proxy). */
export const plainCode = (label: string): Hex => `0x6080604052${keccak256(toHex(label)).slice(2)}` as Hex;

export const V2 = Object.freeze({
  chainId: 31_337,
  poolManager: labelAddress('v2:pm'),
  weth: labelAddress('v2:weth'),
  randomness: labelAddress('v2:drand'),
  platformSafe: labelAddress('v2:safe'),
  v1Registry: labelAddress('v1:registry'),
  registry: labelAddress('v2:registry'),
  factory: labelAddress('v2:factory'),
  listingRegistry: labelAddress('v2:listings'),
  converterDeployer: labelAddress('v2:converter-deployer'),
  platformCap: labelAddress('v2:cap'),
  executor: labelAddress('v2:fit-executor'),
  ethInHelper: labelAddress('v2:eth-in-helper'),
  impl: (key: ImplKeyV2): Address => labelAddress(`v2:impl:${key}`),
  v1Impl: (key: string): Address => labelAddress(`v1:impl:${key}`),
});

const entry = (address: Address, code = plainCode(address)) => ({ address, codeHash: keccak256(code) });
const safePin = (role: 'fit' | 'platform') => ({
  ...entry(role === 'platform' ? V2.platformSafe : labelAddress(`safe:${role}`)), version: '1.4.1',
  singleton: labelAddress('safe:singleton'), singletonCodeHash: labelHash('safe:singleton'),
  owners: (role === 'platform' ? ['founder'] : ['founder', 'bot', 'backup']).map(n => labelAddress(`owner:${n}`)),
  threshold: role === 'platform' ? '1' : '2', guard: ZERO, guardCodeHash: ZERO32,
  handler: ZERO, handlerCodeHash: ZERO32, modulesEnabled: false,
});

/** The manifest as JSON (unparsed): a deployed v1 manifest with one v2 release (its ETH-in helper on request). */
export function synthManifestV2Json(o: { readonly ethInHelper?: boolean } = {}): Record<string, unknown> {
  return {
    schema: 'squarehole.core-deployment/v1',
    status: 'deployed',
    chainId: V2.chainId,
    network: 'local',
    chain: { poolManager: entry(V2.poolManager), weth: entry(V2.weth), randomness: entry(V2.randomness), platformSafe: entry(V2.platformSafe) },
    versions: [
      {
        version: 1,
        factory: entry(labelAddress('v1:factory')),
        registry: entry(V2.v1Registry),
        startBlock: '10',
        implementations: Object.fromEntries(V1_IMPL_KEYS.map((k) => [k, entry(V2.v1Impl(k))])),
        versionCodeHash: labelHash('v1:version'),
        supportedTemplates: [labelHash('v1:template-0')],
      },
    ],
    releases: [
      {
        version: 2,
        factory: entry(V2.factory),
        registry: entry(V2.registry),
        listingRegistry: entry(V2.listingRegistry),
        safes: { fit: safePin('fit'), platform: safePin('platform') },
        startBlock: '50',
        implementations: Object.fromEntries(IMPL_KEYS_V2.map((k) => [k, entry(V2.impl(k))])),
        versionCodeHash: labelHash('v2:version'),
        ...(o.ethInHelper ? { ethInHelper: entry(V2.ethInHelper) } : {}),
      },
    ],
    evidence: { block: { number: '60', hash: labelHash('v2:evidence') }, finality: 'confirmed' },
    gitCommit: null,
  };
}

export function synthManifestV2(o: { readonly ethInHelper?: boolean } = {}): DeployedCoreManifestV2 {
  return parseCoreManifestV2(synthManifestV2Json(o));
}

export interface PlugInSynth {
  readonly implementation: Address;
  readonly codeHash: Hex;
}

/** Canonical params (abi.encode of the members as a list, RecipeTypes.sol's wire rule). */
export const plugInParams = {
  rule: (p: PlugInSynth): Hex => encodeAbiParameters(parseAbiParameters('address, bytes32, uint16, uint16, uint16, bytes'), [p.implementation, p.codeHash, 5_000, 2_500, 7_500, '0x']),
  leg: (p: PlugInSynth): Hex => encodeAbiParameters(parseAbiParameters('address, bytes32, bytes'), [p.implementation, p.codeHash, '0xc0'] as const),
  target: (p: PlugInSynth): Hex => encodeAbiParameters(parseAbiParameters('uint8, uint32, address, address, bytes32, bytes'), [2, 0, ZERO, p.implementation, p.codeHash, '0x']),
  fixedShare: (bps: number): Hex => encodeAbiParameters(parseAbiParameters('uint16'), [bps]),
};

const NONE_BRANCH: BranchV2 = { leg: 0, dest: 0, legParams: '0x', destParams: '0x' };

export interface SynthBoxOptions {
  readonly boxId: bigint;
  readonly tokenName?: string;
  readonly pricing?: { readonly listingId: number; readonly token: Address };
  readonly raise?: bigint;
  readonly tokenOnly?: boolean;
  readonly rule?: PlugInSynth;
  readonly legs?: readonly PlugInSynth[];
  readonly target?: PlugInSynth;
  readonly humblePreset?: number;
  /** Implementations the parts are clones of (default: the release's). */
  readonly implOf?: (key: ImplKeyV2) => Address;
  /** Replaces one role's code at creation (its recorded hash follows it). */
  readonly codeOf?: Partial<Record<string, Hex>>;
  readonly creator?: Address;
  /** Edits the spec before it is encoded (the record's spec hash follows it). */
  readonly specOf?: (spec: BoxSpecV2) => BoxSpecV2;
  /** Further roles, each at its own address with its code (its recorded hash follows it). */
  readonly extra?: readonly { readonly index: number; readonly role: string; readonly code: Hex }[];
}

export interface SynthBoxV2 {
  readonly record: BoxRecordV2;
  readonly spec: BoxSpecV2;
  readonly encodedSpec: Hex;
  /** Code at creation, lowercase address → runtime. */
  readonly code: ReadonlyMap<string, Hex>;
}

/** The role index of each part a synthetic box has. */
const ROLE_INDEX = { coordinator: 0, token: 1, hook: 2, vault: 3, collection: 4, receiver: 5, launchRouter: 6, tickets: 7, royaltyRouter: 8, executor: 9, swapModule: 11, sampler: 13 } as const;

export function tArgs(holder: Address, vault: Address, supply: bigint, name: string, symbol: string): Hex {
  const text = (s: string, bytes: number): string => Buffer.from(s, 'utf8').toString('hex').padEnd(bytes * 2, '0');
  return `0x${holder.slice(2)}${vault.slice(2)}${ZERO.slice(2)}${supply.toString(16).padStart(64, '0')}${text(name, 32)}${Buffer.byteLength(name).toString(16).padStart(2, '0')}${text(symbol, 11)}${Buffer.byteLength(symbol).toString(16).padStart(2, '0')}`.toLowerCase() as Hex;
}

export function synthBoxV2(o: SynthBoxOptions): SynthBoxV2 {
  const implOf = o.implOf ?? V2.impl;
  const at = (role: string): Address => {
    const address = labelAddress(`v2:box${o.boxId}:${role}`);
    if (role !== 'token') return address;
    const p = BigInt(o.pricing?.token ?? ZERO);
    const room = ((1n << 160n) - p) / 2n;
    return toHex(p + 1n + BigInt(address) % (room - 1n), { size: 20 });
  };
  const tokenName = o.tokenName ?? `Box ${o.boxId}`;
  const tokenSymbol = `B${o.boxId}`;
  const pricing = o.pricing ?? { listingId: 0, token: ZERO };
  const raise = o.raise ?? 4_206_980_085_000_000_000n;
  const legs = o.legs ?? [];
  const buyersB: BranchV2 = o.target ? { leg: 4, dest: 2, legParams: plugInParams.target(o.target), destParams: '0x' } : NONE_BRANCH;
  const sellersB: BranchV2 = legs[1] ? { leg: 5, dest: 1, legParams: plugInParams.leg(legs[1]), destParams: '0x' } : NONE_BRANCH;
  const base: BoxSpecV2 = {
    format: 2, version: 2, boxType: o.tokenOnly ? 3 : 1, tokenName, tokenSymbol, collectionName: o.tokenOnly ? '' : `${tokenName} Items`, collectionSymbol: o.tokenOnly ? '' : `I${o.boxId}`,
    description: 'Demo box', n: o.tokenOnly ? 0 : 100, firstId: o.tokenOnly ? 0n : 1n, pricing, raise, layout: 1, gradLayout: 3, launchFormat: 1, openAt: 0, deadlineDays: 30,
    buyers: { a: { leg: 2, dest: 1, legParams: '0x', destParams: '0x' }, b: buyersB, split: o.rule ? 4 : o.target ? 2 : 1, splitParams: o.rule ? plugInParams.rule(o.rule) : o.target ? plugInParams.fixedShare(5_000) : '0x' },
    sellers: { a: legs[0] ? { leg: 5, dest: 4, legParams: plugInParams.leg(legs[0]), destParams: '0x' } : { leg: 1, dest: 4, legParams: '0x', destParams: '0x' }, b: sellersB, split: legs[1] ? 2 : 1, splitParams: legs[1] ? plugInParams.fixedShare(5_000) : '0x' },
    artMode: 1, revealRoot: labelHash('reveal'), metadataTable: o.tokenOnly ? '0x' : '0x0102', generatorHash: ZERO32, coverSha256: labelHash('cover'), revealListId: ZERO32, marketplaceOwner: ZERO,
    creatorFeeRecipient: o.humblePreset ? at('creator') : ZERO, creatorBuy: 0n, collectionCoverSha256: ZERO32,
    addOns: o.humblePreset ? [{ id: 10, params: encodeAbiParameters(parseAbiParameters('uint8'), [o.humblePreset]) }] : [], contentsParams: '0x', pickFeeBps: o.tokenOnly ? 0 : 2_500,
  };
  const spec = o.specOf ? o.specOf(base) : base;
  const encodedSpec = encodeBoxSpecV2(spec);
  const code = new Map<string, Hex>();
  const contracts: Address[] = Array.from({ length: 24 }, () => ZERO);
  const codeHashes: Hex[] = Array.from({ length: 24 }, () => ZERO32);
  const put = (index: number, role: string, runtime: Hex): void => {
    const address = role === 'executor' ? V2.executor : at(role);
    const actual = o.codeOf?.[role] ?? runtime;
    contracts[index] = address;
    codeHashes[index] = keccak256(actual);
    code.set(address.toLowerCase(), actual);
  };
  const vault = o.tokenOnly ? ZERO : at('vault');
  put(ROLE_INDEX.coordinator, 'coordinator', standardRuntime(implOf('coordinator')));
  put(ROLE_INDEX.token, 'token', standardRuntime(implOf('token'), tArgs(at('coordinator'), vault, 10n ** 27n, tokenName, tokenSymbol)));
  put(ROLE_INDEX.hook, 'hook', standardRuntime(implOf('hook')));
  if (!o.tokenOnly) {
    put(ROLE_INDEX.vault, 'vault', standardRuntime(implOf('vault')));
    put(ROLE_INDEX.collection, 'collection', standardRuntime(implOf('collection')));
    put(ROLE_INDEX.tickets, 'tickets', standardRuntime(implOf('tickets')));
    put(ROLE_INDEX.royaltyRouter, 'royaltyRouter', receivingRuntime(implOf('royaltyRouter')));
  }
  put(ROLE_INDEX.receiver, 'receiver', standardRuntime(implOf('receiver')));
  put(ROLE_INDEX.launchRouter, 'launchRouter', standardRuntime(implOf('launchRouter')));
  legs.forEach((leg, i) => put(14 + i, `leg${i}`, standardRuntime(leg.implementation, '0xc0')));
  for (const x of o.extra ?? []) put(x.index, x.role, x.code);
  const record: BoxRecordV2 = {
    boxId: o.boxId, templateId: labelHash(`v2:template:${o.boxId}`), specHash: keccak256(encodedSpec), creator: o.creator ?? at('creator'), pricingListingId: pricing.listingId, q: pricing.token, raise,
    poolManager: V2.poolManager, poolId: keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'), [pricing.token, at('token'), 10_000, 60, at('hook')])), creationBlock: 100n, openAt: 1_700_000_001n, randomness: V2.randomness, contracts, codeHashes,
  };
  return { record, spec, encodedSpec, code };
}

/** `BoxCreated` and `BoxSpec` as registry v2 emits them (address: the release's registry unless named). */
export function boxLogsV2(box: SynthBoxV2, registry: Address = V2.registry): [LogLike & { address: Address }, LogLike & { address: Address }] {
  const created = {
    address: registry,
    topics: encodeEventTopics({ abi: registryV2Abi, eventName: 'BoxCreated', args: { boxId: box.record.boxId, templateId: box.record.templateId, specHash: box.record.specHash } }) as Hex[],
    data: encodeAbiParameters([registryV2Abi.find((x) => x.type === 'event' && x.name === 'BoxCreated')?.inputs[3] as never], [box.record] as never),
  };
  const spec = {
    address: registry,
    topics: encodeEventTopics({ abi: registryV2Abi, eventName: 'BoxSpec', args: { boxId: box.record.boxId } }) as Hex[],
    data: encodeAbiParameters(parseAbiParameters('bytes'), [box.encodedSpec]),
  };
  return [created, spec];
}

export interface SynthListing {
  readonly id: number;
  readonly token: Address;
  readonly routeHash: Hex;
  readonly class: number;
  readonly kind: number;
  readonly raise: bigint;
  readonly converter: Address;
  readonly earlierListing: number;
  readonly converterCode: Hex;
}

export function synthListing(id: number, token: Address, o: { class?: number; kind?: number; raise?: bigint; earlierListing?: number } = {}): SynthListing {
  const routeHash = labelHash(`v2:route:${id}`);
  const converter = predictConverter({ deployer: V2.converterDeployer, implementation: labelAddress('v2:impl:converter'), listingRegistry: V2.listingRegistry, routeHash, listingId: id });
  const args = `0x${V2.listingRegistry.slice(2)}${id.toString(16).padStart(8, '0')}` as Hex;
  return { id, token, routeHash, class: o.class ?? 4, kind: o.kind ?? 1, raise: o.raise ?? 0n, converter, earlierListing: o.earlierListing ?? 0, converterCode: receivingRuntime(labelAddress('v2:impl:converter'), args) };
}

export function listingAddedLog(l: SynthListing): LogLike & { address: Address } {
  const event = listingRegistryV2Abi.find((x) => x.type === 'event' && x.name === 'ListingAdded');
  const inputs = (event && 'inputs' in event ? event.inputs : []).filter((i) => !('indexed' in i && i.indexed));
  return {
    address: V2.listingRegistry,
    topics: encodeEventTopics({ abi: listingRegistryV2Abi, eventName: 'ListingAdded', args: { id: l.id, token: l.token } }) as Hex[],
    data: encodeAbiParameters(inputs as never, [l.class, l.kind, l.raise] as never),
  };
}

/** A scripted reader of code (by address and block hash, else by address) and view calls (by selector). */
export class SynthReaderV2 {
  readonly code = new Map<string, Hex>();
  readonly calls = new Map<string, (data: Hex, blockHash: Hex) => Hex>();

  setCode(address: Address, code: Hex, blockHash?: Hex): this {
    this.code.set(blockHash ? `${address.toLowerCase()}@${blockHash.toLowerCase()}` : address.toLowerCase(), code);
    return this;
  }

  addBox(box: SynthBoxV2): this {
    for (const [address, runtime] of box.code) this.code.set(address, runtime);
    return this;
  }

  /** Answers `fn` on `to` for every call of that function (decoded by `listingRegistryV2Abi`). */
  answer(to: Address, fn: string, result: (args: readonly unknown[]) => readonly unknown[] | unknown): this {
    this.calls.set(`${to.toLowerCase()}:${fn}`, (data) => {
      const call = decodeFunctionData({ abi: listingRegistryV2Abi, data });
      const out = result(call.args ?? []);
      return encodeFunctionResult({ abi: listingRegistryV2Abi, functionName: fn as never, result: out as never });
    });
    return this;
  }

  async codeAt(address: Address, blockHash: Hex): Promise<Hex> {
    return this.code.get(`${address.toLowerCase()}@${blockHash.toLowerCase()}`) ?? this.code.get(address.toLowerCase()) ?? '0x';
  }

  async callAt(to: Address, data: Hex, blockHash: Hex): Promise<Hex> {
    const fn = decodeFunctionData({ abi: listingRegistryV2Abi, data }).functionName;
    const answer = this.calls.get(`${to.toLowerCase()}:${fn}`);
    if (!answer) throw new Error(`no answer for ${fn} on ${to}`);
    return answer(data, blockHash);
  }
}
