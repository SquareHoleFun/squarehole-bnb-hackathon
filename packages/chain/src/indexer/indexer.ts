/**
 * Rebuildable browser log indexer (03-FEED "Event ingestion"; 06-ARCHITECTURE "Data acceleration").
 *
 * - Starts at the deployment manifest's `startBlock` and indexes two streams over the same block ranges: the
 *   "contracts" stream (registry, converter and every launch's token / collector / ledger, approved topics only) and
 *   the "swaps" stream (the PoolManager's `Swap` events of the canonical Square Hole pools, filtered by pool id).
 * - Bounded, adaptively split getLogs ranges; a pair discovered in a range is back-filled from its creation block.
 * - Dedupe by chainId + blockHash + txHash + logIndex. Every block with logs has its header fetched and its hash
 *   compared with the logs' block hash; the first block of each range must chain onto the previous range's end.
 * - Reorgs: before extending, the stored head is re-read; on a hash mismatch, or when the chain no longer has that
 *   block (a shorter chain: anvil evm_revert / reset / restart), the index walks back through its stored checkpoints
 *   to the newest block still on the chain, deletes everything above it and re-indexes (a reorg deeper than every
 *   stored checkpoint rebuilds from the start block). The chain's `finalized` block bounds what must be re-checked.
 * - `covers()` says what the stored index holds; whether THIS sync succeeded is the caller's `SyncResult.complete`.
 *   Readers use both: a snapshot whose sync failed never takes metrics from the index (it may hold orphaned logs).
 * - Display only: it never computes or writes entitlements. Claims come from RewardLedger views.
 */
import { formatPairId } from '@squarehole/domain';
import { getAddress, type Address } from 'viem';
import type { ChainPublicClient } from '../client';
import type { ChainConfig } from '../config/config';
import { deployedManifest } from '../config/config';
import { ChainUnavailableError, throwIfAborted } from '../errors';
import type { BlockRef, ChainReader } from '../reads/reader';
import {
  deserializeRawRecord,
  serializeRawRecord,
  toRegistryPair,
  type RawPairRecord,
  type RegistryPair,
} from '../reads/registry-pair';
import { CONTRACT_STREAM_TOPICS, SWAP_TOPIC, decodeApprovedLog, type LogRole } from './events';
import { createAdaptiveRange, fetchLogsAdaptive, type AdaptiveRange, type RawRpcLog } from './log-fetch';
import {
  createMemoryIndexStore,
  emptyIndexState,
  indexKey,
  isUsableIndexState,
  type BlockPointer,
  type IndexState,
  type IndexStore,
  type IndexedLog,
} from './store';

export interface LogIndexerOptions {
  readonly store?: IndexStore;
  /** Upper bound of ranges per sync call (a first sync on a long chain continues on the next call). */
  readonly maxRangesPerSync?: number;
  /** Recent checkpoints kept for reorg ancestry (older ones below the finalized block are pruned). */
  readonly keepCheckpoints?: number;
}

export interface ReorgRecord {
  /** The stored head that was no longer on the chain. */
  readonly staleHead: BlockPointer;
  /** The newest stored block still on the chain; everything above it was rewound. Null = full rebuild. */
  readonly ancestor: BlockPointer | null;
  readonly logsRemoved: number;
}

export interface SyncResult {
  readonly indexedTo: BlockPointer | null;
  readonly target: BlockPointer;
  /** Whether every block up to and including `target` is indexed. */
  readonly complete: boolean;
  readonly finalizedBlock: bigint | null;
  readonly reorgs: readonly ReorgRecord[];
  readonly logsAdded: number;
  readonly logsIgnored: number;
  readonly ranges: number;
  readonly store: string;
}

interface RoleEntry {
  readonly role: LogRole;
  readonly pairId: string | null;
}

const MAX_RESTARTS = 3;

class RestartSync extends Error {}

export class LogIndexer {
  private state: IndexState | null = null;
  private running: Promise<SyncResult> | null = null;
  private readonly store: IndexStore;
  private readonly range: AdaptiveRange;
  private readonly maxRangesPerSync: number;
  private readonly keepCheckpoints: number;
  private readonly key: string;
  private readonly registry: Address;
  private readonly converter: Address | null;
  private readonly poolManager: Address;
  private readonly startBlock: bigint;
  /** Cached decoded pairs by app pair id (rebuilt from state.pairs). */
  private pairCache = new Map<string, RegistryPair>();

  constructor(
    private readonly config: ChainConfig,
    private readonly client: ChainPublicClient,
    private readonly reader: ChainReader,
    options: LogIndexerOptions = {},
  ) {
    const manifest = deployedManifest(config);
    this.store = options.store ?? createMemoryIndexStore();
    this.range = createAdaptiveRange(config.logs.initialRange, config.logs.minRange, config.logs.maxRange);
    this.maxRangesPerSync = options.maxRangesPerSync ?? 500;
    this.keepCheckpoints = options.keepCheckpoints ?? 128;
    this.registry = manifest.contracts.registry.address;
    this.converter = manifest.contracts.claimConverter?.address ?? null;
    this.poolManager = manifest.contracts.poolManager.address;
    this.startBlock = BigInt(manifest.startBlock);
    this.key = indexKey(config.chainId, this.registry, manifest.startBlock.toString());
  }

  get storeKind(): string {
    return this.store.kind;
  }

  /** Syncs the index up to `target` (a block the caller read at its tag). One sync runs at a time. */
  async sync(target: BlockRef, signal?: AbortSignal): Promise<SyncResult> {
    while (this.running) {
      try {
        const previous = await this.running;
        if (previous.complete && previous.target.hash === target.hash) return previous;
      } catch {
        // The earlier sync failed; this call runs its own.
      }
    }
    const run: Promise<SyncResult> = this.runSync(target, signal).finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  private async loadState(): Promise<IndexState> {
    if (this.state) return this.state;
    const startText = this.startBlock.toString();
    let loaded: IndexState | null;
    try {
      loaded = await this.store.load(this.key);
    } catch {
      loaded = null;
    }
    this.state = isUsableIndexState(loaded, this.config.chainId, this.registry, startText)
      ? loaded
      : emptyIndexState(this.config.chainId, this.registry, startText);
    this.rebuildPairCache();
    return this.state;
  }

  private rebuildPairCache(): void {
    this.pairCache = new Map();
    for (const [pairId, entry] of Object.entries(this.state?.pairs ?? {})) {
      this.pairCache.set(pairId, toRegistryPair(deserializeRawRecord(entry.record), this.config.chainId));
    }
  }

  private async runSync(target: BlockRef, signal?: AbortSignal): Promise<SyncResult> {
    const state = await this.loadState();
    const reorgs: ReorgRecord[] = [];
    let logsAdded = 0;
    let logsIgnored = 0;
    let ranges = 0;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const reorg = await this.checkHead(state, signal);
        if (reorg) reorgs.push(reorg);
        let from = state.indexedTo ? BigInt(state.indexedTo.number) + 1n : this.startBlock;
        while (from <= target.number && ranges < this.maxRangesPerSync) {
          throwIfAborted(signal);
          const span = BigInt(this.range.max);
          const to = from + span - 1n < target.number ? from + span - 1n : target.number;
          const added = await this.indexRange(state, from, to, signal);
          logsAdded += added.added;
          logsIgnored += added.ignored;
          ranges += 1;
          from = to + 1n;
        }
        break;
      } catch (error) {
        if (error instanceof RestartSync && attempt < MAX_RESTARTS) continue;
        if (error instanceof RestartSync) throw new ChainUnavailableError('The chain kept reorganising while indexing; try again');
        throw error;
      }
    }
    const finalized = await this.reader.optionalBlock('finalized');
    const finalizedText = finalized ? finalized.number.toString() : null;
    const changed = ranges > 0 || reorgs.length > 0 || finalizedText !== state.finalizedBlock;
    state.finalizedBlock = finalizedText;
    this.pruneCheckpoints(state);
    if (changed) await this.store.save(this.key, state);
    const indexedTo = state.indexedTo;
    return {
      indexedTo,
      target: { number: target.number.toString(), hash: target.hash },
      complete: indexedTo !== null && BigInt(indexedTo.number) >= target.number,
      finalizedBlock: finalized ? finalized.number : null,
      reorgs,
      logsAdded,
      logsIgnored,
      ranges,
      store: this.store.kind,
    };
  }

  /**
   * Re-reads the stored head; on a mismatch rewinds to the newest checkpoint still on the chain. A stored head (or
   * checkpoint) above the chain's tip, which the node reports as "no such block", is not on the chain either: the chain
   * got shorter (anvil `evm_revert` / reset / restart, a reorg onto a shorter fork), so it is handled as a reorg instead
   * of failing every sync while the orphaned logs stay in the index. A transport failure still fails the sync.
   */
  private async checkHead(state: IndexState, signal?: AbortSignal): Promise<ReorgRecord | null> {
    const head = state.indexedTo;
    if (!head) return null;
    throwIfAborted(signal);
    const current = await this.reader.blockOrNull(BigInt(head.number));
    if (current !== null && current.hash === head.hash) return null;
    const candidates = [...state.checkpoints].filter((cp) => BigInt(cp.number) < BigInt(head.number)).reverse();
    for (const checkpoint of candidates) {
      throwIfAborted(signal);
      const onChain = await this.reader.blockOrNull(BigInt(checkpoint.number));
      if (onChain !== null && onChain.hash === checkpoint.hash) {
        const removed = this.rewind(state, checkpoint);
        return { staleHead: head, ancestor: checkpoint, logsRemoved: removed };
      }
    }
    // Deeper than every stored checkpoint: rebuild from the deployment's start block.
    const removed = Object.keys(state.logs).length;
    const fresh = emptyIndexState(state.chainId, state.registry, state.startBlock);
    Object.assign(state, fresh);
    this.rebuildPairCache();
    return { staleHead: head, ancestor: null, logsRemoved: removed };
  }

  private rewind(state: IndexState, ancestor: BlockPointer): number {
    const limit = BigInt(ancestor.number);
    const before = Object.keys(state.logs).length;
    state.logs = Object.fromEntries(Object.entries(state.logs).filter(([, log]) => BigInt(log.blockNumber) <= limit));
    state.blocks = Object.fromEntries(Object.entries(state.blocks).filter(([number]) => BigInt(number) <= limit));
    state.pairs = Object.fromEntries(Object.entries(state.pairs).filter(([, entry]) => BigInt(entry.createdAtBlock) <= limit));
    const removed = before - Object.keys(state.logs).length;
    state.checkpoints = state.checkpoints.filter((cp) => BigInt(cp.number) <= limit);
    state.indexedTo = ancestor;
    this.rebuildPairCache();
    return removed;
  }

  private pruneCheckpoints(state: IndexState): void {
    const finalized = state.finalizedBlock === null ? null : BigInt(state.finalizedBlock);
    let kept = state.checkpoints;
    if (finalized !== null) {
      const final = kept.filter((cp) => BigInt(cp.number) <= finalized);
      const anchor = final.at(-1);
      kept = [...(anchor ? [anchor] : []), ...kept.filter((cp) => BigInt(cp.number) > finalized)];
    }
    state.checkpoints = kept.slice(-this.keepCheckpoints);
  }

  private roleMap(): Map<string, RoleEntry> {
    const roles = new Map<string, RoleEntry>();
    roles.set(this.registry.toLowerCase(), { role: 'registry', pairId: null });
    if (this.converter) roles.set(this.converter.toLowerCase(), { role: 'converter', pairId: null });
    for (const pair of this.pairCache.values()) {
      roles.set(pair.token.toLowerCase(), { role: 'token', pairId: pair.pairId });
      roles.set(pair.collector.toLowerCase(), { role: 'collector', pairId: pair.pairId });
      roles.set(pair.ledger.toLowerCase(), { role: 'ledger', pairId: pair.pairId });
    }
    return roles;
  }

  private contractAddresses(pairs: Iterable<RegistryPair>, includeSystem: boolean): Address[] {
    const out: Address[] = includeSystem ? [this.registry, ...(this.converter ? [this.converter] : [])] : [];
    for (const pair of pairs) out.push(pair.token, pair.collector, pair.ledger);
    return out;
  }

  private async fetchRange(pairs: readonly RegistryPair[], includeSystem: boolean, from: bigint, to: bigint, signal?: AbortSignal): Promise<RawRpcLog[]> {
    const contracts = await fetchLogsAdaptive(
      this.client,
      { address: this.contractAddresses(pairs, includeSystem), topics: [CONTRACT_STREAM_TOPICS] },
      from,
      to,
      this.range,
      signal,
    );
    const poolIds = pairs.map((pair) => pair.poolId);
    const swaps =
      poolIds.length === 0
        ? []
        : await fetchLogsAdaptive(this.client, { address: this.poolManager, topics: [SWAP_TOPIC, poolIds] }, from, to, this.range, signal);
    return [...contracts, ...swaps];
  }

  /** Indexes [from, to] completely or not at all (the state is only mutated after every check passed). */
  private async indexRange(state: IndexState, from: bigint, to: bigint, signal?: AbortSignal): Promise<{ added: number; ignored: number }> {
    const known = [...this.pairCache.values()];
    const raw = await this.fetchRange(known, true, from, to, signal);

    // Pairs created in this range: back-fill their own logs (their addresses were not in the filter yet).
    const discovered: { pair: RegistryPair; record: RawPairRecord }[] = [];
    for (const log of raw) {
      if (log.address.toLowerCase() !== this.registry.toLowerCase()) continue;
      const decoded = decodeApprovedLog('registry', log);
      if (decoded?.event !== 'PairCreated') continue;
      const record = deserializeRawRecord(decoded.args.record as never);
      const pair = toRegistryPair(record, this.config.chainId);
      if (!this.pairCache.has(pair.pairId) && !discovered.some((entry) => entry.pair.pairId === pair.pairId)) discovered.push({ pair, record });
    }
    for (const { pair } of discovered) {
      const start = pair.createdAtBlock > from ? pair.createdAtBlock : from;
      raw.push(...(await this.fetchRange([pair], false, start, to, signal)));
    }

    // Headers of every block with logs, plus the range's first and last block, for hashes and timestamps.
    const numbers = new Set<bigint>([from, to, ...raw.map((log) => log.blockNumber)]);
    const headers = new Map<bigint, BlockRef>();
    const list = [...numbers];
    for (let index = 0; index < list.length; index += 32) {
      throwIfAborted(signal);
      const batch = list.slice(index, index + 32);
      const read = await Promise.all(batch.map((number) => this.reader.block(number)));
      read.forEach((header, offset) => headers.set(batch[offset] as bigint, header));
    }
    const first = headers.get(from);
    const last = headers.get(to);
    if (!first || !last) throw new ChainUnavailableError('Block headers missing for an indexed range');
    if (state.indexedTo && BigInt(state.indexedTo.number) === from - 1n && first.parentHash !== state.indexedTo.hash) {
      throw new RestartSync('The range does not chain onto the indexed head (reorg)');
    }
    for (const log of raw) {
      if (headers.get(log.blockNumber)?.hash !== log.blockHash) throw new RestartSync('A log came from a block that is no longer canonical (reorg)');
    }

    // Commit.
    for (const { pair, record } of discovered) {
      state.pairs[pair.pairId] = { createdAtBlock: pair.createdAtBlock.toString(), record: serializeRawRecord(record) };
      this.pairCache.set(pair.pairId, pair);
    }
    const roles = this.roleMap();
    const poolToPair = new Map([...this.pairCache.values()].map((pair) => [pair.poolId.toLowerCase(), pair.pairId]));
    let added = 0;
    let ignored = 0;
    for (const log of raw) {
      const address = log.address.toLowerCase();
      const entry: RoleEntry | undefined = address === this.poolManager.toLowerCase() ? { role: 'pool_manager', pairId: null } : roles.get(address);
      const decoded = entry ? decodeApprovedLog(entry.role, log) : null;
      if (!entry || !decoded) {
        ignored += 1;
        continue;
      }
      let pairId = entry.pairId;
      if (entry.role === 'pool_manager') pairId = poolToPair.get(String(decoded.args.id).toLowerCase()) ?? null;
      if (entry.role === 'converter') pairId = formatPairId(this.config.chainId, getAddress(String(decoded.args.token)));
      if (entry.role === 'registry' && decoded.event === 'PairCreated') pairId = formatPairId(this.config.chainId, getAddress(String(decoded.args.token)));
      if (entry.role === 'pool_manager' && pairId === null) {
        ignored += 1;
        continue;
      }
      const key = `${this.config.chainId}:${log.blockHash.toLowerCase()}:${log.transactionHash.toLowerCase()}:${log.logIndex}`;
      if (state.logs[key]) continue;
      const indexed: IndexedLog = {
        key,
        blockNumber: log.blockNumber.toString(),
        blockHash: log.blockHash,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        address,
        role: entry.role,
        pairId,
        event: decoded.event,
        args: decoded.args,
      };
      state.logs[key] = indexed;
      added += 1;
      const header = headers.get(log.blockNumber);
      if (header) state.blocks[log.blockNumber.toString()] = { hash: header.hash, timestamp: header.timestamp.toString() };
    }
    const pointer: BlockPointer = { number: to.toString(), hash: last.hash };
    state.checkpoints.push(pointer);
    state.indexedTo = pointer;
    return { added, ignored };
  }

  // --- queries (display only) ---------------------------------------------------------------------------------

  /** Whether the index holds every approved log from the deployment start up to `blockNumber`. */
  covers(blockNumber: bigint): boolean {
    const head = this.state?.indexedTo;
    return head !== null && head !== undefined && BigInt(head.number) >= blockNumber;
  }

  get indexedTo(): BlockPointer | null {
    return this.state?.indexedTo ?? null;
  }

  get finalizedBlock(): bigint | null {
    const value = this.state?.finalizedBlock;
    return value === null || value === undefined ? null : BigInt(value);
  }

  /** Pairs created at or before `blockNumber`, in creation order. */
  pairsAt(blockNumber: bigint): RegistryPair[] {
    return [...this.pairCache.values()]
      .filter((pair) => pair.createdAtBlock <= blockNumber)
      .sort((a, b) => (a.createdAtBlock === b.createdAtBlock ? (a.pairId < b.pairId ? -1 : 1) : a.createdAtBlock < b.createdAtBlock ? -1 : 1));
  }

  pair(pairId: string): RegistryPair | null {
    return this.pairCache.get(pairId) ?? null;
  }

  /** Logs of one pair up to `blockNumber`, in (block, logIndex) order. */
  logsOf(pairId: string, blockNumber: bigint, events?: readonly string[]): IndexedLog[] {
    const logs = Object.values(this.state?.logs ?? {}).filter(
      (log) => log.pairId === pairId && BigInt(log.blockNumber) <= blockNumber && (!events || events.includes(log.event)),
    );
    return logs.sort((a, b) => {
      const byBlock = BigInt(a.blockNumber) - BigInt(b.blockNumber);
      return byBlock === 0n ? a.logIndex - b.logIndex : byBlock < 0n ? -1 : 1;
    });
  }

  blockTimestamp(blockNumber: bigint): bigint | null {
    const block = this.state?.blocks[blockNumber.toString()];
    return block ? BigInt(block.timestamp) : null;
  }

  /** Drops the stored index (next sync rebuilds from the start block). */
  async reset(): Promise<void> {
    this.state = emptyIndexState(this.config.chainId, this.registry, this.startBlock.toString());
    this.rebuildPairCache();
    await this.store.remove(this.key);
  }

  /** Test/diagnostic view of the raw state (a deep copy). */
  snapshotState(): IndexState | null {
    return this.state ? (JSON.parse(JSON.stringify(this.state)) as IndexState) : null;
  }
}
