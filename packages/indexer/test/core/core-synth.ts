/**
 * TEST ONLY: synthetic core v1 worlds for the pipeline (S10a § 9 steps 5-7): a manifest, boxes whose records, code and
 * registry logs are consistent (each clone's code is the EIP-1167 runtime of the manifest's implementation, its hash the
 * record's), blocks of encoded events (generated ABIs), branches for reorgs, and audit answers that agree with the
 * pipeline unless told otherwise.
 */
import { BOX_0_MISFITS, encodeBoxSpecV1, specHash, type BoxSpecV1 } from '@squarehole/box-spec';
import { boxRowFromRecord, effectiveOpenAt, poolStateSlot, ROLE_NAMES, rolesRequired, type BoxRow, type DeployedCoreManifest, type RegistryRecord, type RoleName } from '@squarehole/chain';
import { boxCoordinatorAbi, boxHookAbi, boxItemStreamAbi, boxLaunchRouterAbi, boxReceiverAbi, boxTokenAbi, boxVaultAbi, poolManagerAbi } from '@squarehole/chain/abi';
import { labelAddress, labelHash, registryLogs, testQList, TEST_Q, type TestQName } from '@squarehole/chain/core/test-support';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, keccak256, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import { auditSpecs, derivedValues } from '../../src/core/audit';
import type { CoreChainIndexer } from '../../src/core/chain-indexer';
import { CONTRACT_PHASE, type CorePhase } from '../../src/core/derive-core';
import type { RawLog } from '../../src/events';
import type { BlockHeader } from '../../src/model';
import { ScriptedCoreChain } from './scripted-core-chain';

export const CHAIN_ID = 11_155_111;
export const REGISTRY = labelAddress('synth:registry');
export const POOL_MANAGER = labelAddress('synth:pool-manager');
export const DRAND = labelAddress('synth:drand');
export const TEMPLATE_0 = labelHash('synth:template-0');
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

const IMPL_KEYS = ['coordinator', 'hook', 'hookExtension', 'launchRouter', 'receiver', 'receiverExtension', 'collection', 'vault', 'tickets', 'royaltyRouter', 'itemStream'] as const;
const impl = (key: string): Address => labelAddress(`synth:impl:${key}`);

export function synthManifest(supportedTemplates: readonly Hex[] = [TEMPLATE_0]): DeployedCoreManifest {
  const entry = (address: Address) => ({ address, codeHash: labelHash(`code:${address}`) });
  return {
    schema: 'squarehole.core-deployment/v1',
    status: 'deployed',
    chainId: CHAIN_ID,
    network: 'local',
    chain: { poolManager: entry(POOL_MANAGER), weth: entry(labelAddress('synth:weth')), randomness: entry(DRAND), platformSafe: entry(labelAddress('synth:safe')) },
    versions: [
      {
        version: 1,
        factory: entry(labelAddress('synth:factory')),
        registry: entry(REGISTRY),
        startBlock: '10',
        implementations: Object.fromEntries(IMPL_KEYS.map((k) => [k, entry(impl(k))])) as DeployedCoreManifest['versions'][number]['implementations'],
        versionCodeHash: labelHash('synth:version'),
        supportedTemplates: [...supportedTemplates],
      },
    ],
    evidence: { block: { number: '10', hash: labelHash('synth:evidence') }, finality: 'confirmed' },
    gitCommit: null,
  };
}

/** The runtime code of each role: clones of the manifest's implementations; the others any code. */
export function codeOf(role: RoleName, label: string): Hex {
  const args = keccak256(`0x${Buffer.from(label).toString('hex')}`).slice(2, 18);
  const standard = (key: string) => `0x363d3d373d3d3d363d73${impl(key).slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3${args}` as Hex;
  switch (role) {
    case 'royaltyRouter':
      return `0x36600557005b363d3d373d3d3d363d73${impl('royaltyRouter').slice(2).toLowerCase()}5af43d82803e903d91603157fd5bf3${args}` as Hex;
    case 'coordinator':
    case 'hook':
    case 'launchRouter':
    case 'receiver':
    case 'collection':
    case 'vault':
    case 'tickets':
    case 'itemStream':
      return standard(role);
    default:
      return `0x6001600255${args}` as Hex;
  }
}

export interface SynthBox {
  readonly row: BoxRow;
  readonly record: RegistryRecord;
  readonly encodedSpec: Hex;
  readonly codes: ReadonlyMap<string, Hex>;
}

export interface SynthBoxOptions {
  readonly boxId: bigint;
  readonly creationBlock: bigint;
  readonly q?: TestQName;
  /** T's address relative to Q: 'low' sorts before every test Q (T currency0 unless Q is native ETH), 'high' after. */
  readonly order?: 'low' | 'high';
  readonly templateId?: Hex;
  readonly spec?: BoxSpecV1;
  /** Break one role's code at creation (the code check must refuse the box). */
  readonly badCode?: RoleName;
  /**
   * The spec's openAt (Unix seconds; 0 = Now). Default: 20 blocks of 12 s after the creation block's time
   * (`synthTimeOf`), so the open falls on block creation + 20 and the window ends on block creation + 52.
   */
  readonly openAt?: number;
}

/** Block 0's time on every synthetic World (its default `startTime`); block n is 12 s × n later. */
export const SYNTH_START_TIME = 1_800_000_000n;
export const synthTimeOf = (block: bigint): bigint => SYNTH_START_TIME + block * 12n;

export function synthBox(options: SynthBoxOptions): SynthBox {
  const q = TEST_Q[options.q ?? 'NATIVE_ETH'];
  const creationTime = synthTimeOf(options.creationBlock);
  const openAt = options.openAt ?? Number(creationTime + 20n * 12n);
  const spec: BoxSpecV1 = { ...(options.spec ?? { ...BOX_0_MISFITS, q: q.token }), openAt };
  const label = `synth:box:${options.boxId}`;
  const required = rolesRequired(spec);
  const tokenAddress = options.order === 'high' ? (`0xf${keccak256(`0x${Buffer.from(label).toString('hex')}`).slice(3, 42)}` as Address) : (`0x1${keccak256(`0x${Buffer.from(label).toString('hex')}`).slice(3, 42)}` as Address);
  const contracts = ROLE_NAMES.map((role) => (required[role] === true ? (role === 'token' ? tokenAddress : labelAddress(`${label}:${role}`)) : ZERO));
  const codes = new Map<string, Hex>();
  const codeHashes = contracts.map((address, i) => {
    if (address === ZERO) return `0x${'0'.repeat(64)}` as Hex;
    const role = ROLE_NAMES[i] as RoleName;
    const code = codeOf(role, label);
    codes.set(address.toLowerCase(), options.badCode === role ? (`${code}00` as Hex) : code);
    return keccak256(code);
  });
  const record: RegistryRecord = {
    boxId: options.boxId,
    templateId: options.templateId ?? TEMPLATE_0,
    specHash: specHash(spec),
    creator: labelAddress('synth:creator'),
    q: spec.q,
    raise: spec.raise,
    poolManager: POOL_MANAGER,
    poolId: labelHash(`${label}:pool`),
    creationBlock: options.creationBlock,
    openAt: effectiveOpenAt(spec.openAt, creationTime),
    randomness: DRAND,
    contracts,
    codeHashes,
  };
  const encodedSpec = encodeBoxSpecV1(spec);
  const row = boxRowFromRecord(record, encodedSpec, { chainId: CHAIN_ID, registry: REGISTRY, box0Registry: REGISTRY, qList: testQList() });
  return { row, record, encodedSpec, codes };
}

/** One event as a log (its block fields filled by the World). */
export interface PendingLog {
  readonly address: Address;
  readonly topics: Hex[];
  readonly data: Hex;
}

export function event(abi: Abi, address: Address, eventName: string, args: Record<string, unknown>): PendingLog {
  const item = abi.find((x) => x.type === 'event' && x.name === eventName) as AbiEvent | undefined;
  if (!item) throw new Error(`no event ${eventName}`);
  const topics = encodeEventTopics({ abi: [item], eventName, args: Object.fromEntries(item.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name as string]])) } as never) as Hex[];
  const data = encodeAbiParameters(item.inputs.filter((i) => !i.indexed), item.inputs.filter((i) => !i.indexed).map((i) => args[i.name as string]) as never);
  return { address, topics, data };
}

/** A box's typical events. */
export const ev = {
  initialize: (box: SynthBox, sqrtPriceX96: bigint, tick: number): PendingLog =>
    event(poolManagerAbi as Abi, POOL_MANAGER, 'Initialize', { id: box.row.poolId, currency0: box.row.tIsCurrency0 ? box.row.contracts.token : box.row.q, currency1: box.row.tIsCurrency0 ? box.row.q : box.row.contracts.token, fee: 10_000, tickSpacing: 60, hooks: box.row.contracts.hook, sqrtPriceX96, tick }),
  swap: (box: SynthBox, o: { amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; tick: number; liquidity: bigint; sender?: Address }): PendingLog =>
    event(poolManagerAbi as Abi, POOL_MANAGER, 'Swap', { id: box.row.poolId, sender: o.sender ?? labelAddress('synth:router'), amount0: o.amount0, amount1: o.amount1, sqrtPriceX96: o.sqrtPriceX96, liquidity: o.liquidity, tick: o.tick, fee: 10_000 }),
  mint: (box: SynthBox, to: Address, value: bigint): PendingLog => event(boxTokenAbi as Abi, box.row.contracts.token as Address, 'Transfer', { from: ZERO, to, amount: value }),
  transfer: (box: SynthBox, from: Address, to: Address, value: bigint): PendingLog => event(boxTokenAbi as Abi, box.row.contracts.token as Address, 'Transfer', { from, to, amount: value }),
  closed: (box: SynthBox, blockNumber: bigint, sqrtPriceX96: bigint): PendingLog => event(boxHookAbi as Abi, box.row.contracts.hook as Address, 'CurveClosed', { poolId: box.row.poolId, blockNumber, sqrtPriceX96 }),
  migrated: (box: SynthBox): PendingLog =>
    event(boxHookAbi as Abi, box.row.contracts.hook as Address, 'Migrated', { poolId: box.row.poolId, qFromCurve: box.row.raise, tFromCurve: 0n, askLiquidity: 1_000n, bidLiquidity: 1_000n, sentinelLiquidity: 10n, tokenPulled: 5n, qDust: 0n }),
  graduated: (box: SynthBox, caller: Address, blockNumber: bigint): PendingLog => event(boxCoordinatorAbi as Abi, box.row.contracts.coordinator as Address, 'Graduated', { caller, blockNumber, poolShare: 1n, tokenDustBurned: 0n, reward: 7n }),
  taxedBuy: (box: SynthBox, buyer: Address, qIn: bigint, tax: bigint, tokensOut: bigint): PendingLog =>
    event(boxLaunchRouterAbi as Abi, box.row.contracts.launchRouter as Address, 'TaxedBuy', { buyer, recipient: buyer, step: 1n, qIn, tax, tokensOut, refund: 0n }),
  bootstrapped: (box: SynthBox, qIn: bigint, tokensOut: bigint): PendingLog => event(boxLaunchRouterAbi as Abi, box.row.contracts.launchRouter as Address, 'Bootstrapped', { recipient: ZERO, qIn, tokensOut }),
  collected: (box: SynthBox, q: bigint, t: bigint): PendingLog => event(boxReceiverAbi as Abi, box.row.contracts.receiver as Address, 'Collected', { caller: labelAddress('synth:keeper'), tipTo: labelAddress('synth:keeper'), q, t, qToReserve: 0n, tip: q / 10n }),
  split: (box: SynthBox, qFit: bigint, qDepth: bigint, qPlatform: bigint, tBurned: bigint, tDepth: bigint): PendingLog =>
    event(boxReceiverAbi as Abi, box.row.contracts.receiver as Address, 'BatchSplit', { qReward: 0n, qFit, qDepth, qPlatform, tReward: 0n, tFit: 0n, tDepth, tBurned }),
  depthHeld: (box: SynthBox, q: bigint, t: bigint): PendingLog => event(boxReceiverAbi as Abi, box.row.contracts.receiver as Address, 'DepthHeld', { q, t }),
  vault: (box: SynthBox, count: bigint, escrowAfter: bigint, insideAfter: bigint, ticketsAfter: bigint): PendingLog =>
    event(boxVaultAbi as Abi, box.row.contracts.vault as Address, 'TicketsOpened', { count, principal: 1n, fee: 0n, supplyAfter: 0n, escrowAfter, insideAfter, hiddenAfter: insideAfter, ticketsAfter }),
  streamClaimed: (box: SynthBox, account: Address, amount: bigint): PendingLog => event(boxItemStreamAbi as Abi, box.row.contracts.itemStream as Address, 'Claimed', { account, to: account, amount }),
};

/** A chain of synthetic blocks with branches (block hashes carry their branch label). */
export class World {
  readonly headers: BlockHeader[] = [];
  readonly logs: RawLog[] = [];
  readonly boxes: SynthBox[] = [];
  private txCount = 0;

  constructor(
    readonly branch = 'a',
    readonly startTime = SYNTH_START_TIME,
  ) {}

  /** The header of block `n` on this branch (parents from this world's own previous block). */
  private makeHeader(n: bigint, parent: BlockHeader | undefined): BlockHeader {
    return { number: n, hash: labelHash(`block:${this.branch}:${n}`), parentHash: parent?.hash ?? labelHash('block:genesis'), timestamp: this.startTime + n * 12n };
  }

  /** Appends block `n` (empty blocks fill any gap) with these logs, each in its own transaction unless `tx` is given. */
  block(n: bigint, logs: readonly (PendingLog | readonly PendingLog[])[] = []): BlockHeader {
    let parent = this.headers.at(-1);
    if (parent && parent.number >= n) throw new Error(`block ${n} after block ${parent.number}: build blocks in order`);
    for (let gap = (parent?.number ?? n - 1n) + 1n; gap < n; gap += 1n) {
      parent = this.makeHeader(gap, parent);
      this.headers.push(parent);
    }
    const header = this.makeHeader(n, parent);
    this.headers.push(header);
    let index = 0;
    for (const group of logs) {
      const tx = labelHash(`tx:${this.branch}:${this.txCount++}`);
      for (const log of Array.isArray(group) ? group : [group]) {
        this.logs.push({ ...(log as PendingLog), blockNumber: n, blockHash: header.hash, transactionHash: tx, transactionIndex: 0, logIndex: index++ });
      }
    }
    return header;
  }

  /** Box creation logs (BoxCreated + BoxSpec, then the box's own creation events) in one transaction. */
  created(box: SynthBox, extra: readonly PendingLog[] = []): PendingLog[] {
    this.boxes.push(box);
    const [created, spec] = registryLogs({ spec: box.row.spec, record: box.record, encodedSpec: box.encodedSpec }, { registry: REGISTRY, blockNumber: 0n, blockHash: labelHash('x') });
    return [...extra, { address: created.address, topics: [...created.topics], data: created.data }, { address: spec.address, topics: [...spec.topics], data: spec.data }];
  }

  /** Extends to `n` with empty blocks. */
  to(n: bigint): void {
    const last = this.headers.at(-1);
    if (!last || last.number < n) this.block(n);
  }

  /** A copy of this world up to block `keep` under a new branch label (later blocks get new hashes). */
  fork(keep: bigint, branch: string): World {
    const w = new World(branch, this.startTime);
    for (const h of this.headers) if (h.number <= keep) w.headers.push(h);
    for (const l of this.logs) if (l.blockNumber <= keep) w.logs.push(l);
    for (const b of this.boxes) if (b.row.creationBlock <= keep) w.boxes.push(b);
    w.txCount = this.txCount;
    return w;
  }

  /** A scripted chain of this world (code answers from every box ever created in any branch). */
  chain(allBoxes: readonly SynthBox[] = this.boxes): ScriptedCoreChain {
    const codes = new Map<string, Hex>();
    for (const b of allBoxes) for (const [a, c] of b.codes) codes.set(a, c);
    return new ScriptedCoreChain(CHAIN_ID, this.headers, this.logs, (address) => codes.get(address.toLowerCase()));
  }
}

const PHASE_INDEX: Readonly<Record<CorePhase, number>> = Object.fromEntries(Object.entries(CONTRACT_PHASE).map(([i, p]) => [p, Number(i)])) as Record<CorePhase, number>;

/**
 * Answers every audit read of every shown box from the pipeline's own derived values (a chain that agrees), except the
 * values `skew` changes (a chain that disagrees for one box).
 */
export function agreeingCalls(indexer: CoreChainIndexer, skew: (token: string, key: string, value: string) => string = (_t, _k, v) => v): (to: Address, data: Hex, hash: Hex) => Hex | undefined {
  return (to, data) => {
    for (const [token, entry] of indexer.boxes) {
      const head = indexer.head();
      const state = head ? indexer.stateAt(entry, head) : null;
      if (!state || !head) continue;
      const d = derivedValues({ ...state, block: head.number, timestamp: head.timestamp }, entry.row);
      const value = (key: string, fallback = '0'): bigint => {
        const v = d[key] ?? fallback;
        const s = skew(token, key, v);
        return key === 'hook.phase' ? BigInt(PHASE_INDEX[s as CorePhase] ?? 0) : BigInt(s);
      };
      for (const spec of auditSpecs(entry.row)) {
        if (spec.to.toLowerCase() !== to.toLowerCase()) continue;
        const call = encodeFunctionData({ abi: spec.abi, functionName: spec.fn, args: spec.args ?? [] } as never);
        if (call.toLowerCase() !== data.toLowerCase()) continue;
        const results: Record<string, unknown> = {
          'token.totalSupply': value('token.totalSupply'),
          'token.totalBurned': value('token.totalBurned'),
          'hook.phase': Number(value('hook.phase')),
          'hook.closedAtBlock': value('hook.closedAtBlock'),
          'hook.migratedAtBlock': value('hook.migratedAtBlock'),
          'hook.graduatedLayout': [value('hook.askLiquidity'), value('hook.bidLiquidity'), value('hook.sentinelLiquidity')],
          'hook.pairedLiquidity': value('hook.pairedLiquidity'),
          'hook.depthBudget': [0n, 0n],
          'hook.reserveMinted': 0n,
          'coordinator.poolShare': value('coordinator.poolShare'),
          'receiver.depthHeld': [value('receiver.depthHeldQ'), value('receiver.depthHeldT')],
          'receiver.platformEpoch': [value('receiver.platformEpoch'), value('receiver.platformKept'), 0n],
          'receiver.platformOwed': value('receiver.platformOwed'),
          'receiver.fitOwed': value('receiver.fitOwed'),
          'receiver.totals': [value('receiver.toFit'), value('receiver.toPlatform'), value('receiver.qToDepth'), value('receiver.tToDepth'), value('receiver.tBurnedOrPending'), 0n, 0n],
          'receiver.platformHeld': value('receiver.platformHeld'),
          'receiver.tBurnPending': 0n,
          'vault.escrowPrincipal': value('vault.escrow'),
          'vault.inside': value('vault.inside'),
          'vault.hiddenCount': value('vault.hidden'),
          'vault.pendingTickets': value('vault.tickets'),
          'vault.outside': value('vault.outside'),
          'stream.totals': [value('stream.claimed'), value('stream.burned')],
          'stream.index': 0n,
          'stream.outsideCount': 0n,
          'token.balanceOf': value('stream.heldT'),
        };
        return encodeFunctionResult({ abi: spec.abi, functionName: spec.fn, result: results[`${spec.name}.${spec.fn}`] } as never);
      }
      if (to.toLowerCase() === entry.row.poolManager.toLowerCase()) {
        // extsload: slot0 or liquidity of this box's pool, in StateLibrary's layout.
        const slot = data.slice(10).toLowerCase();
        const base = BigInt(`0x${slot}`);
        const ownBase = BigInt(poolStateSlot(entry.row.poolId));
        if (base !== ownBase && base !== ownBase + 3n) continue;
        const sqrt = value('pool.sqrtPriceX96');
        const tick = Number(value('pool.tick'));
        const word = base === ownBase ? sqrt | (BigInt.asUintN(24, BigInt(tick)) << 160n) : value('pool.liquidity');
        return encodeFunctionResult({ abi: poolManagerAbi as Abi, functionName: 'extsload', result: `0x${word.toString(16).padStart(64, '0')}` } as never);
      }
    }
    return undefined;
  };
}

export { testQList };
