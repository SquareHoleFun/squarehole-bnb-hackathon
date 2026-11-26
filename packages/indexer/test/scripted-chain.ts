/**
 * A scripted chain for tests: canonical headers by number, every header ever seen by hash (so orphaned branches stay
 * reachable by parent hash, as on a real node right after a reorg), logs by block hash, tx senders, and a pool slot /
 * total supply per block hash. `blockLogs` honours the header bloom exactly as the RPC reader does, so recorded
 * Sepolia blooms are exercised. Built from the recorded fixture or by hand for reorg scenarios.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address, Hex } from 'viem';
import { bloomQuery } from '../src/bloom';
import type { BlockLogs, ChainReader, Finality, PoolSlot } from '../src/chain-reader';
import type { PoolTarget } from '../src/config';
import { LAUNCH_TOPIC0, POOL_MANAGER_TOPIC0, TOPICS, type RawLog } from '../src/events';
import type { BlockHeader } from '../src/model';

export interface RecordedFixture {
  readonly chainId: number;
  readonly poolId: Hex;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly logs: readonly RawLog[];
  readonly headers: readonly BlockHeader[];
  readonly senders: ReadonlyMap<Hex, Address>;
  readonly atEnd: { readonly block: bigint; readonly hash: Hex; readonly sqrtPriceX96: bigint; readonly tick: number; readonly liquidity: bigint; readonly totalSupply: bigint };
  readonly taxTable: readonly number[];
}

interface FixtureJson {
  chainId: number;
  poolId: Hex;
  fromBlock: string;
  toBlock: string;
  logs: (Omit<RawLog, 'blockNumber'> & { blockNumber: string })[];
  headers: { number: string; hash: Hex; parentHash: Hex; timestamp: string; logsBloom?: Hex }[];
  senders: Record<Hex, Address>;
  atEnd: { block: string; hash: Hex; sqrtPriceX96: string; tick: number; liquidity: string; totalSupply: string };
  taxTable: number[];
}

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function loadRecordedFixture(name = 'sepolia-rehearsal.json'): RecordedFixture {
  const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as FixtureJson;
  return {
    chainId: raw.chainId,
    poolId: raw.poolId,
    fromBlock: BigInt(raw.fromBlock),
    toBlock: BigInt(raw.toBlock),
    logs: raw.logs.map((l) => ({ ...l, blockNumber: BigInt(l.blockNumber) })),
    headers: raw.headers.map((h) => ({ number: BigInt(h.number), hash: h.hash, parentHash: h.parentHash, timestamp: BigInt(h.timestamp), ...(h.logsBloom ? { logsBloom: h.logsBloom } : {}) })),
    senders: new Map(Object.entries(raw.senders) as [Hex, Address][]),
    atEnd: { block: BigInt(raw.atEnd.block), hash: raw.atEnd.hash, sqrtPriceX96: BigInt(raw.atEnd.sqrtPriceX96), tick: raw.atEnd.tick, liquidity: BigInt(raw.atEnd.liquidity), totalSupply: BigInt(raw.atEnd.totalSupply) },
    taxTable: raw.taxTable,
  };
}

export class ScriptedChain implements ChainReader {
  readonly byHash = new Map<Hex, BlockHeader>();
  readonly canonical = new Map<bigint, Hex>();
  readonly logs = new Map<Hex, RawLog[]>();
  readonly senders = new Map<Hex, Address>();
  readonly slots = new Map<Hex, PoolSlot>();
  readonly supplies = new Map<Hex, bigint>();
  headNumber = 0n;
  finalityTags: Finality = { safe: null, finalized: null };
  readonly calls: Record<string, number> = {};
  private readonly target: PoolTarget;

  constructor(target: PoolTarget) {
    this.target = target;
  }

  static fromFixture(fixture: RecordedFixture, target: PoolTarget, upTo: bigint = fixture.toBlock): ScriptedChain {
    const chain = new ScriptedChain(target);
    for (const header of fixture.headers) if (header.number <= upTo) chain.addBlock(header, []);
    for (const log of fixture.logs) if (log.blockNumber <= upTo) chain.logs.set(log.blockHash, [...(chain.logs.get(log.blockHash) ?? []), log]);
    for (const [tx, from] of fixture.senders) chain.senders.set(tx, from);
    chain.slots.set(fixture.atEnd.hash, { sqrtPriceX96: fixture.atEnd.sqrtPriceX96, tick: fixture.atEnd.tick, liquidity: fixture.atEnd.liquidity });
    chain.supplies.set(fixture.atEnd.hash, fixture.atEnd.totalSupply);
    return chain;
  }

  private count(method: string): void {
    this.calls[method] = (this.calls[method] ?? 0) + 1;
  }

  /** Adds a header (canonical at its number) and its logs; moves the head if it is higher. */
  addBlock(header: BlockHeader, logs: readonly RawLog[]): void {
    this.byHash.set(header.hash, header);
    this.canonical.set(header.number, header.hash);
    if (logs.length > 0) this.logs.set(header.hash, [...logs]);
    if (header.number > this.headNumber) this.headNumber = header.number;
  }

  /** Makes `headers` canonical from their first number on; later canonical numbers are dropped. */
  reorgTo(headers: readonly { header: BlockHeader; logs: readonly RawLog[] }[]): void {
    const first = headers[0]?.header.number;
    if (first === undefined) return;
    for (const number of [...this.canonical.keys()]) if (number >= first) this.canonical.delete(number);
    this.headNumber = first - 1n;
    for (const { header, logs } of headers) this.addBlock(header, logs);
  }

  headerAt(number: bigint): BlockHeader {
    const hash = this.canonical.get(number);
    const header = hash ? this.byHash.get(hash) : undefined;
    if (!header) throw new Error(`scripted chain has no block ${number}`);
    return header;
  }

  async latestHeader(): Promise<BlockHeader> {
    this.count('latestHeader');
    return this.headerAt(this.headNumber);
  }

  async headerByNumber(number: bigint): Promise<BlockHeader | null> {
    this.count('headerByNumber');
    const hash = this.canonical.get(number);
    return hash ? (this.byHash.get(hash) ?? null) : null;
  }

  async headerByHash(hash: Hex): Promise<BlockHeader | null> {
    this.count('headerByHash');
    return this.byHash.get(hash) ?? null;
  }

  /** Blocks whose per-block getLogs answers empty (a lagging backend), while range queries still see the logs. */
  readonly hiddenFromBlockLogs = new Set<Hex>();
  /** Blocks whose logs a range getLogs leaves out (the backend answering the range is behind or drops a log). */
  readonly hiddenFromRange = new Set<Hex>();
  /** Blocks the two-endpoint by-hash read does not see either (both backends behind). */
  readonly hiddenFromByHash = new Set<Hex>();
  /** Extra logs a range answer carries for a number (e.g. an orphaned block's logs from a backend on another fork). */
  readonly rangeExtra = new Map<bigint, RawLog[]>();
  /** Sender lookups: delay each by this long; fail the next `senderFailures` calls. */
  senderDelayMs = 0;
  senderFailures = 0;

  private isPool(log: RawLog): boolean {
    return log.address.toLowerCase() === this.target.poolManager.toLowerCase();
  }

  /** The RPC reader's topic filters: pool topics + poolId on the PoolManager, LAUNCH_TOPIC0 on the contracts. */
  private matches(log: RawLog): boolean {
    if (this.isPool(log)) return POOL_MANAGER_TOPIC0.includes(log.topics[0] as Hex) && log.topics[1]?.toLowerCase() === this.target.poolId.toLowerCase();
    return LAUNCH_TOPIC0.includes(log.topics[0] as Hex);
  }

  async blockLogs(header: BlockHeader): Promise<BlockLogs> {
    const query = bloomQuery(header.logsBloom, this.target);
    const all = this.hiddenFromBlockLogs.has(header.hash) ? [] : (this.logs.get(header.hash) ?? []).filter((l) => this.matches(l));
    let calls = 0;
    const out: RawLog[] = [];
    if (query.pool) {
      calls += 1;
      out.push(...all.filter((l) => this.isPool(l)));
    }
    if (query.contracts) {
      calls += 1;
      out.push(...all.filter((l) => !this.isPool(l)));
    }
    this.calls['getLogs'] = (this.calls['getLogs'] ?? 0) + calls;
    return { logs: out, calls };
  }

  async rangeLogs(fromBlock: bigint, toBlock: bigint): Promise<readonly RawLog[]> {
    this.count('rangeLogs');
    const out: RawLog[] = [];
    for (let n = fromBlock; n <= toBlock; n += 1n) {
      const hash = this.canonical.get(n);
      if (hash && !this.hiddenFromRange.has(hash)) out.push(...(this.logs.get(hash) ?? []).filter((l) => this.matches(l)));
      out.push(...(this.rangeExtra.get(n) ?? []));
    }
    return out;
  }

  async logsByHash(blockHash: Hex): Promise<readonly RawLog[]> {
    this.count('logsByHash');
    return this.hiddenFromByHash.has(blockHash) ? [] : (this.logs.get(blockHash) ?? []).filter((l) => this.matches(l));
  }

  private async senderCall(method: string): Promise<void> {
    this.count(method);
    if (this.senderDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.senderDelayMs));
    if (this.senderFailures > 0) {
      this.senderFailures -= 1;
      throw new Error('429 Too Many Requests (scripted)');
    }
  }

  async txSender(hash: Hex): Promise<Address | null> {
    await this.senderCall('txSender');
    return this.senders.get(hash) ?? null;
  }

  async blockSenders(blockHash: Hex): Promise<ReadonlyMap<Hex, Address>> {
    await this.senderCall('blockSenders');
    const txs = new Set((this.logs.get(blockHash) ?? []).map((l) => l.transactionHash));
    return new Map([...txs].flatMap((tx) => {
      const from = this.senders.get(tx);
      return from ? [[tx, from] as const] : [];
    }));
  }

  async poolSlot(blockHash: Hex): Promise<PoolSlot> {
    const slot = this.slots.get(blockHash);
    if (!slot) throw new Error('no recorded pool slot at that block');
    return slot;
  }

  async totalSupply(blockHash: Hex): Promise<bigint> {
    const supply = this.supplies.get(blockHash);
    if (supply === undefined) throw new Error('no recorded supply at that block');
    return supply;
  }

  async finality(): Promise<Finality> {
    return this.finalityTags;
  }
}

/** A hand-made header chain for reorg tests: hashes encode (branch, number) so they are readable in failures. */
export function fakeHash(branch: number, number: bigint): Hex {
  return `0x${branch.toString(16).padStart(8, '0')}${number.toString(16).padStart(56, '0')}` as Hex;
}

export function fakeHeader(branch: number, number: bigint, parentHash: Hex, timestamp: bigint): BlockHeader {
  return { number, hash: fakeHash(branch, number), parentHash, timestamp };
}

/** Clones a recorded swap-transaction's logs into another block (for branches that carry a trade). */
export function moveLogs(logs: readonly RawLog[], header: BlockHeader, txSalt: string): RawLog[] {
  return logs.map((log) => ({ ...log, blockNumber: header.number, blockHash: header.hash, transactionHash: `0x${txSalt.padStart(8, '0')}${log.transactionHash.slice(10)}` as Hex }));
}

export function swapTxLogs(fixture: RecordedFixture, index: number): RawLog[] {
  const swapTxs = [...new Set(fixture.logs.filter((l) => l.topics[0] === TOPICS.Swap).map((l) => l.transactionHash))];
  const tx = swapTxs[index];
  if (!tx) throw new Error(`no swap tx #${index}`);
  return fixture.logs.filter((l) => l.transactionHash === tx);
}
