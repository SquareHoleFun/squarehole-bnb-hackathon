/** Alchemist uses the existing generic action wire. Amounts stay in their own raw currency units. */
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, type Address, type Hex } from 'viem';
import { receiverModulesV21Abi } from './abi-v2';
import type { SideV2 } from './spec-v2';
import type { WriteCallV2, WriteTargetV2 } from './write-calls-v2';

export const alchemistV21Abi = parseAbi([
  'function conversionTrigger() view returns (address)',
  'function inputCap() view returns (uint256)',
  'function dustMax() view returns (uint256)',
  'function feeActionVersion() pure returns (uint256)',
  'function priceCoin() view returns (address)',
  'function pileCoin() view returns (address)',
  'function poolManager() view returns (address)',
  'function receiverImplementation() view returns (address)',
  'function coordinatorImplementation() view returns (address)',
  'function executor() view returns (address)',
  'function executorCodeHash() view returns (bytes32)',
  'event PileConverted(address indexed receiver,address indexed pile,address indexed asset,uint256 amountIn,uint256 amountOut)',
  'event DustToDepth(address indexed receiver,address indexed hook,address indexed asset,uint256 amount)',
]);
export const alchemistRouteV21Abi = parseAbi([
  'function module() view returns (address)',
  'function manager() view returns (address)',
  'function length() view returns (uint256)',
  'function dustMax() view returns (uint256)',
  'function hop(uint256 i) view returns ((uint8 kind,address tokenIn,address tokenOut,address pool,uint24 fee,int24 tickSpacing))',
]);
export const alchemistDirectoryV21Abi = parseAbi([
  'function register(address module) returns (uint32)',
  'function record(uint32 id) view returns (address,bytes32,uint64,bool)',
  'function resolve(uint32 id) view returns (address,bytes32)',
  'function count() view returns (uint256)',
  'function DELAY() view returns (uint256)',
]);
/** Creation-only selection. Resolve the active mature row and check both coins/route before quoting. */
export function alchemistSideV21(id: number): SideV2 {
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new Error('invalid directory id');
  return { split: 1, splitParams: '0x', a: { leg: 1, dest: 9, legParams: '0x', destParams: encodeAbiParameters(parseAbiParameters('uint32'),[id]) },
    b: { leg: 0, dest: 0, legParams: '0x', destParams: '0x' } };
}
/** Permissionless graduated receiver call; no caller-selected amount, route, recipient, tip or native value. */
export function executeModuleCallV21(target: WriteTargetV2, sellers: boolean): WriteCallV2 {
  return { to: target.receiver, data: encodeFunctionData({ abi: receiverModulesV21Abi, functionName: 'executeModule', args: [sellers] }), value: 0n };
}
/** Prepared Safe transaction only. Only the directory's lister can send it; use its returned readyAt. */
export function registerAlchemistV21(directory: Address, module: Address): WriteCallV2 {
  return { to: directory, data: encodeFunctionData({ abi: alchemistDirectoryV21Abi, functionName: 'register', args: [module] }), value: 0n };
}

/**
 * SH-V21-FE14: finding and checking The Alchemist for a new box, read only (no wallet, no funds). A row is offered only
 * when every part the integrator listed (SH-V21-08 request 2) is read and agrees:
 * - the release's own directory (`receiverCode()` of the release receiver) resolves the id: active, mature, live
 *   codehash equal to the recorded one (`resolve` refuses anything else);
 * - the module answers as a version-1 Alchemist action of this release: its PoolManager and its receiver and
 *   coordinator implementations are the release's, and its price and pile coins are exactly the box's (and differ);
 *   it answers its creation-fixed per-call cap (`inputCap`, positive, at most int128's maximum), its dust size
 *   (`dustMax`, positive, at most the cap) and its fixed conversion trigger (`conversionTrigger`, never zero), the
 *   G1 getters a site states before selection;
 * - its route helper's live codehash is the module's pinned `executorCodeHash`, the helper names this module and
 *   manager, and the route it holds (1 to 3 hops, kinds 2/3/4, each hop's coin following the last, from the price coin
 *   to the pile coin, a v4 hop in this manager) is read from the helper itself, never supplied or invented.
 * Whether a v2 or v3 pool is a real Uniswap deployment is the lister Safe's review before registering; this check
 * cannot prove it and does not claim to.
 */
export interface AlchemistReadsV21 {
  /** One view call: its return data, or null when it reverts or returns nothing (absent or refused). */
  call(to: Address, data: Hex): Promise<Hex | null>;
  /** The runtime code at an address ('0x' for none). */
  code(address: Address): Promise<Hex>;
}
/** The release parts a row must match (manifest: implementations and the chain's PoolManager). */
export interface AlchemistReleaseV21 {
  readonly directory: Address;
  readonly poolManager: Address;
  readonly receiverImplementation: Address;
  readonly coordinatorImplementation: Address;
}
/** AlchemistRouteV21 kinds: 2 a canonical 0.3% v2 pair, 3 a v3 pool, 4 a static-fee hookless v4 pool in the manager. */
export type AlchemistHopKindV21 = 2 | 3 | 4;
export interface AlchemistHopV21 {
  readonly kind: AlchemistHopKindV21;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly pool: Address;
  /** Pips (1,000,000 = 100%). */
  readonly fee: number;
  readonly tickSpacing: number;
}
export interface AlchemistModuleV21 {
  readonly module: Address;
  readonly codeHash: Hex;
  readonly priceCoin: Address;
  readonly pileCoin: Address;
  readonly executor: Address;
  readonly executorCodeHash: Hex;
  readonly route: readonly AlchemistHopV21[];
  /** The most raw price coin one conversion call spends (G1 A1): the rest of a side's queue stays waiting. */
  readonly inputCap: bigint;
  /**
   * The largest step, in raw price coin, that goes as claims to the box hook when a pool would pay out nothing for it (RC5-B):
   * a larger step with nothing to pay out refuses and waits, whatever the pool's price.
   */
  readonly dustMax: bigint;
  /** The account that alone starts conversions until a side has waited seven days without one (G1 D1/D2). */
  readonly conversionTrigger: Address;
}
export interface AlchemistRowV21 extends AlchemistModuleV21 {
  readonly id: number;
  /** The directory's ready time (seconds), one day after registration. */
  readonly readyAt: bigint;
}
export type AlchemistRefusalReasonV21 = 'not-selectable' | 'not-an-alchemist' | 'other-release' | 'other-coins' | 'helper-changed' | 'bad-route';
export class AlchemistRefusalV21 extends Error {
  constructor(readonly reason: AlchemistRefusalReasonV21, message: string) { super(message); this.name = 'AlchemistRefusalV21'; }
}
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ZERO = '0x0000000000000000000000000000000000000000';
/** AlchemistFeeModuleV21's constructor bound on its cap: int128's maximum. */
const MAX_INPUT_CAP = (1n << 127n) - 1n;
const refuse = (reason: AlchemistRefusalReasonV21, message: string): never => { throw new AlchemistRefusalV21(reason, message); };
type ViewAbi = typeof alchemistV21Abi | typeof alchemistRouteV21Abi | typeof alchemistDirectoryV21Abi | typeof receiverModulesV21Abi;
async function view<T>(reads: AlchemistReadsV21, to: Address, abi: ViewAbi, functionName: string, args: readonly unknown[] = []): Promise<T | null> {
  const data = await reads.call(to, encodeFunctionData({ abi, functionName, args } as never));
  if (data === null) return null;
  try { return decodeFunctionResult({ abi, functionName, data } as never) as T; } catch { return null; }
}
const codeHashOf = async (reads: AlchemistReadsV21, address: Address): Promise<Hex | null> => {
  const code = await reads.code(address);
  return code === '0x' ? null : keccak256(code);
};

/** The release's module directory, from its receiver implementation's `receiverCode()`; null when it does not answer. */
export async function releaseDirectoryV21(reads: AlchemistReadsV21, receiverImplementation: Address): Promise<Address | null> {
  const code = await view<readonly [Address, Address, Address]>(reads, receiverImplementation, receiverModulesV21Abi, 'receiverCode');
  return code ? code[2] : null;
}

/**
 * One module as The Alchemist of this release for these coins (an existing box's snapshot needs no directory row:
 * withdrawal never changes it). Throws AlchemistRefusalV21 with the first part that does not agree.
 */
export async function alchemistModuleV21(reads: AlchemistReadsV21, release: Omit<AlchemistReleaseV21, 'directory'>, module: Address, codeHash: Hex, coins: { readonly priceCoin: Address; readonly pileCoin: Address }): Promise<AlchemistModuleV21> {
  if ((await codeHashOf(reads, module)) !== codeHash.toLowerCase()) refuse('not-selectable', 'the module\'s live code is not the recorded code');
  const get = <T>(functionName: string) => view<T>(reads, module, alchemistV21Abi, functionName);
  const [version, manager, receiver, coordinator, priceCoin, pileCoin, executor, executorCodeHash, inputCap, dustMax, conversionTrigger] = await Promise.all([
    get<bigint>('feeActionVersion'), get<Address>('poolManager'), get<Address>('receiverImplementation'), get<Address>('coordinatorImplementation'),
    get<Address>('priceCoin'), get<Address>('pileCoin'), get<Address>('executor'), get<Hex>('executorCodeHash'),
    get<bigint>('inputCap'), get<bigint>('dustMax'), get<Address>('conversionTrigger'),
  ]);
  if (version !== 1n || !manager || !receiver || !coordinator || priceCoin === null || pileCoin === null || !executor || !executorCodeHash) refuse('not-an-alchemist', 'the module does not answer as a version-1 Alchemist');
  // An Alchemist without the G1 getters (or with a zero cap, dust size or trigger) is not the one whose limits the site states.
  if (inputCap === null || inputCap <= 0n || inputCap > MAX_INPUT_CAP || !conversionTrigger || sameAddress(conversionTrigger, ZERO)) refuse('not-an-alchemist', 'the module does not answer its fixed cap and trigger');
  // G1-INT: the constructor's bound on the dust size, positive and at most the cap.
  if (dustMax === null || dustMax <= 0n || dustMax > (inputCap as bigint)) refuse('not-an-alchemist', 'the module does not answer its fixed dust size');
  if (!sameAddress(manager as Address, release.poolManager) || !sameAddress(receiver as Address, release.receiverImplementation) || !sameAddress(coordinator as Address, release.coordinatorImplementation)) {
    refuse('other-release', 'the module belongs to another release');
  }
  if (!sameAddress(priceCoin as Address, coins.priceCoin) || !sameAddress(pileCoin as Address, coins.pileCoin) || sameAddress(coins.priceCoin, coins.pileCoin)) refuse('other-coins', 'the module converts other coins');
  if ((await codeHashOf(reads, executor as Address)) !== (executorCodeHash as Hex).toLowerCase()) refuse('helper-changed', 'the route helper is not the pinned code');
  const route = await routeOf(reads, executor as Address, module, release.poolManager, coins);
  return { module, codeHash, priceCoin: priceCoin as Address, pileCoin: pileCoin as Address, executor: executor as Address, executorCodeHash: executorCodeHash as Hex, route,
    inputCap: inputCap as bigint, dustMax: dustMax as bigint, conversionTrigger: conversionTrigger as Address };
}

async function routeOf(reads: AlchemistReadsV21, executor: Address, module: Address, manager: Address, coins: { readonly priceCoin: Address; readonly pileCoin: Address }): Promise<AlchemistHopV21[]> {
  const [owner, pm, length] = await Promise.all([
    view<Address>(reads, executor, alchemistRouteV21Abi, 'module'), view<Address>(reads, executor, alchemistRouteV21Abi, 'manager'), view<bigint>(reads, executor, alchemistRouteV21Abi, 'length'),
  ]);
  if (!owner || !sameAddress(owner, module) || !pm || !sameAddress(pm, manager)) refuse('helper-changed', 'the route helper serves another module or manager');
  if (length === null || length < 1n || length > 3n) refuse('bad-route', 'the route has no 1 to 3 hops');
  const hops: AlchemistHopV21[] = [];
  for (let i = 0n; i < (length as bigint); i++) {
    const h = await view<{ kind: number; tokenIn: Address; tokenOut: Address; pool: Address; fee: number; tickSpacing: number }>(reads, executor, alchemistRouteV21Abi, 'hop', [i]);
    if (!h || (h.kind !== 2 && h.kind !== 3 && h.kind !== 4)) refuse('bad-route', 'a hop has no admitted kind');
    const hop = h as NonNullable<typeof h>;
    if (hop.fee < 3000 || hop.fee >= 1_000_000 || (hop.kind === 2 && hop.fee !== 3000)) refuse('bad-route', 'a hop fee is outside the Alchemist fee floor');
    if (hop.kind === 4 && !sameAddress(hop.pool, manager)) refuse('bad-route', 'a v4 hop is outside the release PoolManager');
    const from = i === 0n ? coins.priceCoin : hops[hops.length - 1]?.tokenOut;
    if (!from || !sameAddress(hop.tokenIn, from) || sameAddress(hop.tokenIn, hop.tokenOut)) refuse('bad-route', 'the hops do not follow one another from the price coin');
    hops.push({ kind: hop.kind as AlchemistHopKindV21, tokenIn: hop.tokenIn, tokenOut: hop.tokenOut, pool: hop.pool, fee: hop.fee, tickSpacing: hop.tickSpacing });
  }
  if (!sameAddress(hops[hops.length - 1]?.tokenOut ?? '', coins.pileCoin)) refuse('bad-route', 'the route does not end in the pile coin');
  return hops;
}

/** One directory row as The Alchemist for a new box with these coins, or AlchemistRefusalV21. */
export async function alchemistRowV21(reads: AlchemistReadsV21, release: AlchemistReleaseV21, id: number, coins: { readonly priceCoin: Address; readonly pileCoin: Address }): Promise<AlchemistRowV21> {
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) refuse('not-selectable', 'invalid directory id');
  const [resolved, record] = await Promise.all([
    view<readonly [Address, Hex]>(reads, release.directory, alchemistDirectoryV21Abi, 'resolve', [id]),
    view<readonly [Address, Hex, bigint, boolean]>(reads, release.directory, alchemistDirectoryV21Abi, 'record', [id]),
  ]);
  // resolve refuses an immature, withdrawn or code-changed row; the record must be that same row.
  if (!resolved || !record || record[3] || !sameAddress(record[0], resolved[0]) || record[1].toLowerCase() !== resolved[1].toLowerCase()) refuse('not-selectable', 'the row is not active and mature');
  const [module, codeHash] = resolved as readonly [Address, Hex];
  return { ...(await alchemistModuleV21(reads, release, module, codeHash, coins)), id, readyAt: (record as readonly [Address, Hex, bigint, boolean])[2] };
}

/**
 * Every row of the release's directory that resolves as The Alchemist for these coins, newest first, reading at most
 * the newest `limit` rows (the directory is add-only). A row that does not resolve is skipped, never repaired.
 */
export async function alchemistRowsV21(reads: AlchemistReadsV21, release: AlchemistReleaseV21, coins: { readonly priceCoin: Address; readonly pileCoin: Address }, limit = 64): Promise<AlchemistRowV21[]> {
  if (sameAddress(coins.priceCoin, coins.pileCoin)) return [];
  const count = await view<bigint>(reads, release.directory, alchemistDirectoryV21Abi, 'count');
  if (count === null) throw new Error('the module directory does not answer');
  const ids: number[] = [];
  for (let id = count - 1n; id >= 0n && ids.length < limit; id--) ids.push(Number(id));
  const rows = await Promise.all(ids.map(async (id) => {
    try { return await alchemistRowV21(reads, release, id, coins); } catch (error) { if (error instanceof AlchemistRefusalV21) return null; throw error; }
  }));
  return rows.filter((row): row is AlchemistRowV21 => row !== null);
}
