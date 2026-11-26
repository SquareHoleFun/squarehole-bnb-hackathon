import { royaltyRouterV2Abi } from '../../src/core/v2/chain-v2';
/**
 * TEST ONLY: a scripted chain for the core v1 pipeline. Canonical headers up to a movable tip, every header ever seen by
 * hash (an orphaned branch stays reachable by parent hash, as on a node right after a reorg), logs by block hash
 * filtered as RPC filters them (contracts by address/topic0; PoolManager by pool id; settlements by Trade owner),
 * code and call answers by (address, block hash). Loads the recorded local life (fixtures/core-local-life.json) or a
 * synthetic world (core-synth.ts).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCoreManifest, type DeployedCoreManifest } from '@squarehole/chain';
import type { Address, Hex } from 'viem';
import type { Finality } from '../../src/chain-reader';
import type { BlockAnchor, CoreReader, LogFilter } from '../../src/core/core-reader';
import type { RawLog } from '../../src/events';
import type { BlockHeader } from '../../src/model';

const lower = (a: string): string => a.toLowerCase();

export type CodeAnswer = (address: Address, blockHash: Hex) => Hex | undefined;
export type CallAnswer = (to: Address, data: Hex, blockHash: Hex) => Hex | undefined;

export class ScriptedCoreChain implements CoreReader {
  readonly byHash = new Map<string, BlockHeader>();
  readonly canonical = new Map<bigint, Hex>();
  readonly logsOf = new Map<string, RawLog[]>();
  tip: bigint;
  calls = 0;
  codeAnswers: CodeAnswer;
  callAnswers: CallAnswer;
  /** Every block hash a `logsByHash` asked for (tests count the per-block requests). */
  readonly asked: Hex[] = [];

  constructor(readonly id: number, headers: readonly BlockHeader[], logs: readonly RawLog[], code: CodeAnswer = () => undefined, call: CallAnswer = () => undefined) {
    for (const h of headers) {
      this.byHash.set(lower(h.hash), h);
      this.canonical.set(h.number, h.hash);
    }
    for (const log of logs) {
      const list = this.logsOf.get(lower(log.blockHash)) ?? [];
      list.push(log);
      this.logsOf.set(lower(log.blockHash), list);
    }
    this.tip = headers.reduce((max, h) => (h.number > max ? h.number : max), 0n);
    this.codeAnswers = code;
    this.callAnswers = call;
  }

  /** Replaces the canonical chain above `parent` with `headers` (a reorg), adding their logs. */
  setBranch(headers: readonly BlockHeader[], logs: readonly RawLog[]): void {
    const first = headers[0];
    if (!first) return;
    for (const n of [...this.canonical.keys()]) if (n >= first.number) this.canonical.delete(n);
    for (const h of headers) {
      this.byHash.set(lower(h.hash), h);
      this.canonical.set(h.number, h.hash);
    }
    for (const log of logs) {
      const list = this.logsOf.get(lower(log.blockHash)) ?? [];
      list.push(log);
      this.logsOf.set(lower(log.blockHash), list);
    }
    this.tip = headers.reduce((max, h) => (h.number > max ? h.number : max), 0n);
  }

  header(n: bigint): BlockHeader {
    const hash = this.canonical.get(n);
    const header = hash ? this.byHash.get(lower(hash)) : undefined;
    if (!header) throw new Error(`no canonical block ${n}`);
    return header;
  }

  async chainId(): Promise<number> {
    return this.id;
  }

  async latestHeader(): Promise<BlockHeader> {
    return this.header(this.tip);
  }

  async headerByNumber(n: bigint): Promise<BlockHeader | null> {
    if (n > this.tip) return null;
    const hash = this.canonical.get(n);
    return hash ? (this.byHash.get(lower(hash)) ?? null) : null;
  }

  async headerByHash(hash: Hex): Promise<BlockHeader | null> {
    return this.byHash.get(lower(hash)) ?? null;
  }

  private match(log: RawLog, filter: LogFilter): boolean {
    const topic0 = lower(log.topics[0] ?? '');
    if (filter.poolManager && lower(log.address) === lower(filter.poolManager)) {
      return filter.poolTopics.some((t) => lower(t) === topic0) && filter.poolIds.some((id) => lower(id) === lower(log.topics[1] ?? ''));
    }
    if (filter.settlementAddresses.some(a => lower(a) === lower(log.address))) {
      return filter.settlementTopics.some(t => lower(t) === topic0)
        && filter.settlementOwners.some(owner => lower(owner) === lower(log.topics[1] ?? ''));
    }
    return filter.addresses.some((a) => lower(a) === lower(log.address)) && filter.topics.some((t) => lower(t) === topic0);
  }

  async logsByHash(blockHash: Hex, filter: LogFilter): Promise<readonly RawLog[]> {
    this.calls += 1;
    this.asked.push(blockHash);
    return (this.logsOf.get(lower(blockHash)) ?? []).filter((log) => this.match(log, filter));
  }

  async rangeLogs(fromBlock: bigint, toBlock: bigint, filter: LogFilter, anchors: readonly BlockAnchor[] = []): Promise<readonly RawLog[]> {
    this.calls += 1;
    // As the RPC reader's endpoints: a chain that does not hold every anchor refuses the read.
    for (const a of anchors) if (a.number > this.tip || this.canonical.get(a.number)?.toLowerCase() !== a.hash.toLowerCase()) throw new Error(`not on block ${a.number} ${a.hash}`);
    const out: RawLog[] = [];
    for (let n = fromBlock; n <= toBlock && n <= this.tip; n += 1n) {
      const hash = this.canonical.get(n);
      if (hash) out.push(...(this.logsOf.get(lower(hash)) ?? []).filter((log) => this.match(log, filter)));
    }
    return out;
  }

  async codeAt(address: Address, blockHash: Hex): Promise<Hex> {
    const code = this.codeAnswers(address, blockHash);
    if (code === undefined) throw new Error(`no code answer for ${address} at ${blockHash}`);
    return code;
  }

  async callAt(to: Address, data: Hex, blockHash: Hex): Promise<Hex> {
    const result = this.callAnswers(to, data, blockHash);
    if (result === undefined) throw new Error(`no call answer for ${to} ${data.slice(0, 10)} at ${blockHash}`);
    return result;
  }

  async finality(): Promise<Finality> {
    return { safe: null, finalized: null };
  }
}

// ------------------------------------------------------------------------------------------------ the recorded life

export interface CoreLife {
  readonly manifest: DeployedCoreManifest;
  readonly chain: ScriptedCoreChain;
  readonly headers: readonly BlockHeader[];
  readonly logs: readonly RawLog[];
  readonly phases: ReadonlyMap<bigint, string>;
  readonly recordOf0: Hex;
  readonly creationBlock: bigint;
  /** Box 0's open and window end (Unix seconds). */
  readonly openAt: bigint;
  readonly windowEndsAt: bigint;
  readonly head: bigint;
  readonly stages: Readonly<Record<string, number>>;
  readonly accounts: Readonly<Record<string, Address>>;
  readonly contracts: Readonly<Record<string, Address>>;
  /** Block hashes the recorded run audited at (where the call answers exist). */
  readonly auditHashes: ReadonlySet<string>;
}

interface LifeJson {
  chainId: number;
  manifest: unknown;
  accounts: Record<string, Address>;
  contracts: Record<string, Address>;
  creationBlock: string;
  openAt: string;
  windowEndsAt: string;
  stages: Record<string, number>;
  head: string;
  headers: { number: string; hash: Hex; parentHash: Hex; timestamp: string }[];
  logs: (Omit<RawLog, 'blockNumber'> & { blockNumber: string })[];
  codes: Record<string, Hex>;
  calls: Record<string, Hex>;
  phases: Record<string, string>;
  recordOf0: Hex;
}

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');

export function loadCoreLife(): CoreLife {
  const raw = JSON.parse(readFileSync(join(FIXTURES, 'core-local-life.json'), 'utf8')) as LifeJson;
  const manifest = parseCoreManifest(raw.manifest);
  if (manifest.status !== 'deployed') throw new Error('the recorded manifest is not deployed');
  const headers = raw.headers.map((h) => ({ number: BigInt(h.number), hash: h.hash, parentHash: h.parentHash, timestamp: BigInt(h.timestamp) }));
  const logs = raw.logs.map((l) => ({ ...l, blockNumber: BigInt(l.blockNumber) }));
  const codes = new Map(Object.entries(raw.codes));
  const calls = new Map(Object.entries(raw.calls));
  const chain = new ScriptedCoreChain(
    raw.chainId,
    headers,
    logs,
    (address, hash) => codes.get(`${lower(address)}@${lower(hash)}`),
    (to, data, hash) => calls.get(`${lower(to)}|${lower(data)}|${lower(hash)}`),
  );
  // Audits read T's totalSupply (0x18160ddd); the display reads at other blocks do not.
  const auditHashes = new Set([...calls.keys()].filter((k) => k.split('|')[1]?.startsWith('0x18160ddd')).map((k) => k.split('|')[2] ?? ''));
  return {
    manifest,
    chain,
    headers,
    logs,
    phases: new Map(Object.entries(raw.phases).map(([n, p]) => [BigInt(n), p])),
    recordOf0: raw.recordOf0,
    creationBlock: BigInt(raw.creationBlock),
    openAt: BigInt(raw.openAt),
    windowEndsAt: BigInt(raw.windowEndsAt),
    head: BigInt(raw.head),
    stages: raw.stages,
    accounts: raw.accounts,
    contracts: raw.contracts,
    auditHashes,
  };
}

// V2 service fixtures use the actual frozen event encodings and clone runtimes.
export { synthManifestV2, V2 } from '../../../chain/src/core/v2/test-support/synth-v2';
import { boxLogsV2 as rawBoxLogsV2, listingAddedLog as rawListingAddedLog, synthBoxV2, synthListing, SynthReaderV2, V2, type SynthBoxV2 } from '../../../chain/src/core/v2/test-support/synth-v2';
import { decodeEventLog, decodeFunctionData, encodeFunctionResult, encodeAbiParameters, encodeEventTopics, type Abi, type AbiEvent } from 'viem';
import { poolManagerAbi, boxTokenAbi } from '@squarehole/chain/abi';
import { coordinatorV2Abi, hookV2Abi, receiverV2Abi } from '../../src/core/v2/chain-v2';
import { EVENT_ABI_V2, type EventSourceV2 } from '../../src/core/v2/chain-v2';

export function serviceBoxV2(id = 4n, creationBlock = 100n, addressSeed = id): SynthBoxV2 {
  const box = synthBoxV2({ boxId: addressSeed, pricing: { listingId: 7, token: V2.weth } });
  return { ...box, record: { ...box.record, boxId: id, creationBlock } };
}
export const serviceListingV2 = () => synthListing(7, V2.weth);
export function eventV2(source: EventSourceV2, name: string, address: Address, args: Record<string, unknown>): { address: Address; topics: Hex[]; data: Hex } {
  const abi = EVENT_ABI_V2[source] ?? [];
  const event = abi.find((e) => e.type === 'event' && e.name === name) as AbiEvent;
  return { address, topics: encodeEventTopics({ abi: [event], args }) as Hex[], data: encodeAbiParameters(event.inputs.filter((i) => !i.indexed), event.inputs.filter((i) => !i.indexed).map((i) => args[i.name ?? ''])) };
}
export function receiverEventV2(box: SynthBoxV2, name: 'FitPaid' | 'PlatformPaid' | 'CreatorClaimed', extra: Record<string, unknown> = {}) {
  return eventV2('receiver', name, requiredV2(box.record.contracts[5]), { safe: V2.executor, payee: box.record.creator, token: box.record.q, to: box.record.creator, amount: 100n, ...extra });
}
export function serviceChainV2(world: { headers: readonly BlockHeader[]; logs: readonly RawLog[] }, boxes: readonly SynthBoxV2[], answer?: (box: SynthBoxV2, key: string, hash: Hex) => unknown): ScriptedCoreChain {
  const codes = new Map(boxes.flatMap((b) => [...b.code]));
  const listing = serviceListingV2();
  const views = new SynthReaderV2();
  views.answer(V2.listingRegistry, 'listing', (args) => ({
    id: args[0], token: listing.token, decimals: 6, class: listing.class, kind: listing.kind,
    listedAt: 1n, raise: listing.raise,
    q: { bootstrapQ: 1n, batchMinQ: 1n, tipMaxQ: 1n, swapStepMinQ: 1n },
  }));
  const chain = new ScriptedCoreChain(V2.chainId, world.headers, world.logs, (address) => codes.get(address.toLowerCase()) ?? '0x');
  chain.callAt = async (to, data, hash) => {
    if (to.toLowerCase() === V2.listingRegistry.toLowerCase()) return views.callAt(to, data, hash);
    if (to.toLowerCase() === V2.poolManager.toLowerCase()) {
      const fn = decodeFunctionData({ abi: poolManagerAbi, data }).functionName;
      if (fn === 'extsload') return encodeFunctionResult({ abi: poolManagerAbi, functionName: 'extsload', result: `0x${'0'.repeat(64)}` });
      return encodeFunctionResult({ abi: poolManagerAbi, functionName: 'balanceOf', result: 0n });
    }
    for (const box of boxes) for (const [slot, part, abi] of [[0, 'coordinator', coordinatorV2Abi], [1, 'token', boxTokenAbi], [2, 'hook', hookV2Abi], [5, 'receiver', receiverV2Abi], [8, 'royaltyRouter', royaltyRouterV2Abi]] as const) {
      if (box.record.contracts[slot]?.toLowerCase() !== to.toLowerCase()) continue;
      const decoded = decodeFunctionData({ abi: abi as Abi, data });
      const fn = abi.find((f) => f.type === 'function' && f.name === decoded.functionName);
      if (!fn || fn.type !== 'function') throw new Error('unhandled fixture read');
      let result = answer?.(box, `${part}.${fn.name}`, hash);
      if (result === undefined && fn.name === 'buyersChoice') result = 2;
      if (result === undefined && fn.name === 'sellersChoice') result = 3;
      if (result === undefined && fn.name === 'totalSupply') {
        let supply = 0n; let header = chain.byHash.get(hash.toLowerCase());
        while (header) {
          for (const log of chain.logsOf.get(header.hash.toLowerCase()) ?? []) {
            if (log.address.toLowerCase() !== to.toLowerCase()) continue;
            const e = decodeEventLog({ abi: boxTokenAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
            if (e.eventName === 'Transfer') {
              if (/^0x0{40}$/i.test(e.args.from)) supply += e.args.amount;
              if (/^0x0{40}$/i.test(e.args.to)) supply -= e.args.amount;
            }
          }
          header = chain.byHash.get(header.parentHash.toLowerCase());
        }
        result = supply;
      }
      if (result === undefined) {
        const defaults = fn.outputs.map((output) => output.type === 'bool' ? false : output.type === 'address' ? V2.platformSafe : output.type === 'uint8' ? 2 : 0n);
        result = defaults.length === 1 ? defaults[0] : defaults;
      }
      return encodeFunctionResult({ abi: abi as Abi, functionName: fn.name, result } as never);
    }
    throw new Error(`unhandled v2 read ${to}`);
  };
  return chain;
}

export const boxLogsV2 = (...args: Parameters<typeof rawBoxLogsV2>) => rawBoxLogsV2(...args).map((l) => ({ ...l, topics: [...l.topics] }));
export const listingAddedLog = (...args: Parameters<typeof rawListingAddedLog>) => { const l = rawListingAddedLog(...args); return { ...l, topics: [...l.topics] }; };

/** Fail at the fixture boundary when a required slot or indexed entry is missing. */
export function requiredV2<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing v2 fixture value');
  return value;
}
