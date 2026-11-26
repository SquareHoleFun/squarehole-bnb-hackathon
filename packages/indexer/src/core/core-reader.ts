/**
 * Read access to one chain for the core v1 pipeline (S10a § 3), behind an interface the tests replace with a scripted
 * chain. Every block-scoped request is pinned by HASH (EIP-234 for logs, EIP-1898 for code and calls), never by number.
 * The RPC implementation tries keyless HTTP endpoints in configured order. History gaps and rate limits have
 * separate cooldowns; an archive fallback never takes preference for head reads.
 *
 * Logs use three requests per scope (chunked as needed): contracts (registries, shown boxes, drand) with their
 * topics, PoolManager with pool ids (topic 1), and CoW settlements with Trade owners (topic 1).
 */
import { createPublicClient, http, InvalidParamsRpcError, ResponseBodyTooLargeError, RpcRequestError, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { fromRpcLog, headerOf, type Finality } from '../chain-reader';
import type { RawLog } from '../events';
import { unionLogs } from '../log-sets';
import type { BlockHeader } from '../model';
import { aggregateViews, MULTICALL3, type ViewCall, type ViewResult } from './multicall';

export interface LogFilter {
  /** Contracts whose logs count (lowercase or checksummed). */
  readonly addresses: readonly Address[];
  /** topic0 values of those contracts' events. */
  readonly topics: readonly Hex[];
  /** The PoolManager and the pool ids whose `Swap`, `ModifyLiquidity`, `Initialize`, `Donate` count. */
  readonly poolManager: Address | null;
  readonly poolIds: readonly Hex[];
  readonly poolTopics: readonly Hex[];
  /** CoW Trade receipts: settlement addresses, Trade topic0, and inbox owners padded to topic 1. */
  readonly settlementAddresses: readonly Address[];
  readonly settlementTopics: readonly Hex[];
  readonly settlementOwners: readonly Hex[];
}

/** Pure eth_getLogs filters; the caller adds the same hash/range scope and anchors to every request. */
export function logRequestPlan(filter: LogFilter, maxAddresses: number) {
  const requests: { address: Address | readonly Address[]; topics: readonly (readonly Hex[])[] }[] = [];
  for (let i = 0; i < filter.addresses.length; i += maxAddresses) {
    requests.push({ address: filter.addresses.slice(i, i + maxAddresses), topics: [filter.topics] });
  }
  if (filter.poolManager && filter.poolIds.length > 0) {
    requests.push({ address: filter.poolManager, topics: [filter.poolTopics, filter.poolIds] });
  }
  if (filter.settlementAddresses.length > 0) {
    for (let i = 0; i < filter.settlementOwners.length; i += maxAddresses) {
      requests.push({ address: filter.settlementAddresses,
        topics: [filter.settlementTopics, filter.settlementOwners.slice(i, i + maxAddresses)] });
    }
  }
  return requests;
}

/** A block a range read must agree with: the range's logs come from the branch that holds every anchor (R2). */
export interface BlockAnchor {
  readonly number: bigint;
  readonly hash: Hex;
}

export interface CoreReader {
  chainId(): Promise<number>;
  /** A head notice may arrive over WS before any HTTP endpoint knows its hash. */
  observeHead?(header: BlockHeader): void;
  latestHeader(): Promise<BlockHeader>;
  headerByNumber(number: bigint): Promise<BlockHeader | null>;
  headerByHash(hash: Hex): Promise<BlockHeader | null>;
  logsByHash(blockHash: Hex, filter: LogFilter): Promise<readonly RawLog[]>;
  /**
   * Logs of [fromBlock, toBlock] by number. With anchors, every answer comes from a source whose chain holds each
   * anchor (by number and hash) before and after the read; when none does, it throws.
   */
  rangeLogs(fromBlock: bigint, toBlock: bigint, filter: LogFilter, anchors?: readonly BlockAnchor[]): Promise<readonly RawLog[]>;
  codeAt(address: Address, blockHash: Hex): Promise<Hex>;
  callAt(to: Address, data: Hex, blockHash: Hex): Promise<Hex>;
  /** Sender-independent views only; each sub-call keeps its own success or EVM refusal. */
  callViewsAt?(calls: readonly ViewCall[], blockHash: Hex): Promise<readonly ViewResult[]>;
  finality(): Promise<Finality>;
}

type LogPlan = ReturnType<typeof logRequestPlan>;
type RpcLogFilter = LogPlan[number] & ({ blockHash: Hex } | { fromBlock: Hex; toBlock: Hex });

interface RpcLogShape {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: Hex | null;
  readonly blockHash: Hex | null;
  readonly transactionHash: Hex | null;
  readonly transactionIndex: Hex | null;
  readonly logIndex: Hex | null;
  readonly removed?: boolean;
}

const logOrder = (a: RawLog, b: RawLog) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Throws unless this endpoint's chain holds every anchor now (a lagging endpoint lacks the block; a forked one differs). */
async function agrees(client: PublicClient, anchors: readonly BlockAnchor[], signal: AbortSignal): Promise<void> {
  // One anchor after another, as at 171c3b4e (job306 point 7: the parallel reads of SH-259 are undone).
  for (const anchor of anchors) {
    signal.throwIfAborted();
    const block = await client.getBlock({ blockNumber: anchor.number }).catch((cause: unknown) => {
      const kind = failureKind(cause);
      const detail = kind.limited ? 'rate limited' : kind.unavailable || kind.unknownBlock ? 'block not held'
        : cause instanceof Error ? cause.message : String(cause);
      throw Object.assign(new Error(`anchor unavailable: ${detail}`, { cause }), { unavailableBlock: anchor.number });
    });
    if (block.hash?.toLowerCase() !== anchor.hash.toLowerCase()) throw new Error(`endpoint is not on block ${anchor.number} ${anchor.hash} (it has ${block.hash ?? 'none'})`);
  }
}

// A short gap can still be crossing HTTP replicas. One delayed second pass covers two seconds of propagation.
const NEAR_HEAD_BLOCKS = 4n;
const HEAD_RETRY_MS = 2_000;
const MAX_COOLDOWN_WAIT_MS = 30_000;
// The server got 12/12 archive answers sequentially but only 7/12 in a burst.
const MAX_ARCHIVE_REQUESTS = 4;
// PublicNode served six concurrent address groups in M3.
const LOG_GROUPS_PER_WAVE = 6;
const MAX_LOG_GROUPS = 32;
// enqueue observes each feed head before catch-up. A rebuild takes its target from latestHeader(), which only remembers it.
// Half the indexer's RANGE_TAIL lets a rebuild group logs when its target is up to 16 blocks above the last observed head.
// repairBox and refold can group at the index's head once it trails the newest observed head by at least 16 blocks.
export const LOG_GROUP_TAIL = 16n;
// viem's transport timeout covers response headers. Also bound the attempt while reading the body.
const ATTEMPT_GRACE_MS = 5_000;
const MAX_CODE_ENTRIES = 2_048;
const MAX_OVERSIZED_RANGES = 4_096;

// Another read can learn a smaller range while this request waits for an archive slot, anchors or a group wave.
class KnownOversizedRange extends Error {
  constructor(readonly cut: bigint) { super('log range contains a previous oversized answer'); }
}

class LogResultLimitError extends Error {
  constructor(count: string, readonly suggestedEnd: bigint | undefined, cause: InvalidParamsRpcError) {
    super(`the endpoint reports more than ${count} results`, { cause });
  }
}

function oversizedAnswer(error: unknown): error is ResponseBodyTooLargeError | LogResultLimitError {
  return error instanceof ResponseBodyTooLargeError || error instanceof LogResultLimitError;
}

type ReadScope = { readonly number?: bigint; readonly hash?: Hex };
interface Endpoint {
  readonly client: PublicClient;
  active: number;
  readonly waiters: (() => void)[];
  limitedUntil: number;
  limitFailures: number;
  historyUntil: number;
  unavailableThrough: bigint | undefined;
  readonly unavailableHashes: Map<string, number>;
}

/** Walk viem's error causes, which retain HTTP status and JSON-RPC code/details. */
function failureKind(error: unknown): { limited: boolean; unavailable: boolean; unknownBlock: boolean; number?: bigint } {
  let limited = false, unavailable = false, unknownBlock = false;
  let number: bigint | undefined;
  for (let i = 0; i < 10 && error && typeof error === 'object'; i++) {
    const e = error as { status?: number; code?: number; name?: string; message?: string; details?: string; cause?: unknown; unavailableBlock?: bigint };
    const message = `${e.message ?? ''} ${e.details ?? ''}`;
    limited ||= e.status === 429 || e.status === 403 || e.code === 429
      || ((e.code === -32005 || e.code === -33200) && /rate limit|rate exceeded|too many requests|limit exceeded/i.test(message));
    unknownBlock ||= /\bunknown block\b/i.test(message);
    unavailable ||= e.code === 4444 || e.name === 'BlockNotFoundError'
      || /pruned history|missing trie node|header not found|block not found|historical state.*(?:unavailable|not available)/i.test(message);
    number ??= e.unavailableBlock;
    error = e.cause;
  }
  return { limited, unavailable, unknownBlock, ...(number === undefined ? {} : { number }) };
}

export interface RpcCoreReaderOptions {
  readonly urls: readonly string[];
  readonly timeoutMs?: number;
  /** Largest block span per getLogs in a backfill (public RPCs refuse wide ranges). */
  readonly maxRange?: bigint;
  /** Maximum number of minimal oversized ranges retained by this reader. */
  readonly maxOversizedRanges?: number;
  /** Addresses per getLogs request (public RPCs cap the list). */
  readonly maxAddresses?: number;
}

export class RpcCoreReader implements CoreReader {
  private readonly clients: readonly Endpoint[];
  private readonly attemptTimeoutMs: number;
  private readonly maxRange: bigint;
  private readonly maxOversizedRanges: number;
  private oversizedRanges: { from: bigint; to: bigint }[] = [];
  private readonly maxAddresses: number;
  private readonly logAddressLimits = new Map<PublicClient, number>();
  private readonly blockNumbers = new Map<string, bigint>();
  private readonly codes = new Map<string, Hex>();
  private newestHead: bigint | undefined;
  /** This reader belongs to one configured chain. Cache absence too; never cache an RPC error as absence. */
  private multicallCode: Promise<boolean> | undefined;

  constructor(options: RpcCoreReaderOptions) {
    if (options.urls.length === 0) throw new Error('at least one RPC URL');
    const timeout = options.timeoutMs ?? 10_000;
    this.attemptTimeoutMs = timeout + ATTEMPT_GRACE_MS;
    this.clients = options.urls.map((url) => ({ client: createPublicClient({ transport: http(url, { timeout, retryCount: 0, batch: false }) }) as PublicClient,
      active: 0, waiters: [], limitedUntil: 0, limitFailures: 0, historyUntil: 0, unavailableThrough: undefined, unavailableHashes: new Map() }));
    this.maxRange = options.maxRange ?? 5_000n;
    this.maxOversizedRanges = options.maxOversizedRanges ?? MAX_OVERSIZED_RANGES;
    if (!Number.isInteger(this.maxOversizedRanges) || this.maxOversizedRanges < 1 || this.maxOversizedRanges > MAX_OVERSIZED_RANGES) {
      throw new Error(`maxOversizedRanges must be between 1 and ${MAX_OVERSIZED_RANGES}`);
    }
    this.maxAddresses = options.maxAddresses ?? 200;
  }

  private async withFallback<T>(method: string, fn: (client: PublicClient, signal: AbortSignal) => Promise<T>, scope: ReadScope = {}, anchors: readonly BlockAnchor[] = []): Promise<T> {
    let lastError: unknown;
    let propagationAt = 0;
    let archiveOnly = false;
    const required = [scope, ...anchors];
    const skipUnavailableHistory = (entry: Endpoint) => {
      const unavailable = required.some(at => {
        const hash = at.hash?.toLowerCase();
        const number = at.number ?? (hash ? this.blockNumbers.get(hash) : undefined);
        return (number !== undefined && Date.now() < entry.historyUntil && entry.unavailableThrough !== undefined && number <= entry.unavailableThrough)
          || (hash !== undefined && Date.now() < (entry.unavailableHashes.get(hash) ?? 0));
      });
      if (unavailable) archiveOnly = true;
      return unavailable;
    };
    const hash = scope.hash?.toLowerCase();
    const number = scope.number ?? (hash ? this.blockNumbers.get(hash) : undefined);
    let remaining = MAX_COOLDOWN_WAIT_MS;
    // Ordinary failures get the original second pass. Only rate limits can extend it.
    const secondPass = new Set<Endpoint>();
    const readyAt = (entry: Endpoint) => Math.max(entry.limitedUntil, secondPass.has(entry) ? propagationAt : 0);
    let candidates = this.clients;
    while (candidates.length) {
      const pending: Endpoint[] = [];
      const skip = (entry: Endpoint) => {
        if (skipUnavailableHistory(entry)) return true;
        if (Date.now() >= readyAt(entry)) return false;
        pending.push(entry);
        return true;
      };
      for (const entry of candidates) {
        if (skip(entry)) continue;
        const takesSlot = archiveOnly;
        let backoff = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // An archive-only slot covers the callback, including both anchor checks.
          if (takesSlot) {
            if (entry.active < MAX_ARCHIVE_REQUESTS) entry.active++;
            else {
              await new Promise<void>(resolve => entry.waiters.push(resolve));
              if (skip(entry)) continue;
            }
          }
          const attempt = new AbortController();
          const result = await Promise.race([
            fn(entry.client, attempt.signal),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                const error = new Error(`${method} timed out after ${this.attemptTimeoutMs} ms`);
                attempt.abort(error);
                reject(error);
              }, this.attemptTimeoutMs);
            }),
          ]);
          entry.limitFailures = 0;
          return result;
        } catch (error) {
          // An oversized log answer is specific to the filter and span. Anchor errors are wrapped by agrees.
          if (method === 'eth_getLogs' && (oversizedAnswer(error) || error instanceof KnownOversizedRange)) throw error;
          lastError = error;
          const failure = failureKind(error);
          const at = failure.number ?? number;
          if (failure.limited) {
            entry.limitFailures = Math.min(6, entry.limitFailures + 1);
            entry.limitedUntil = Date.now() + Math.min(30_000, 1_000 * 2 ** (entry.limitFailures - 1));
            pending.push(entry);
          } else if ((failure.unavailable || failure.unknownBlock) && at !== undefined
            && this.newestHead !== undefined && at >= this.newestHead - NEAR_HEAD_BLOCKS) {
            if (!propagationAt) propagationAt = Date.now() + HEAD_RETRY_MS;
          } else if (failure.unavailable) {
            archiveOnly ||= at !== undefined || hash !== undefined;
            if (at !== undefined) {
              entry.unavailableThrough = Date.now() >= entry.historyUntil || entry.unavailableThrough === undefined || at > entry.unavailableThrough ? at : entry.unavailableThrough;
              entry.historyUntil = Date.now() + 60_000;
            } else if (hash) {
              entry.unavailableHashes.set(hash, Date.now() + 60_000);
              if (entry.unavailableHashes.size > 256) entry.unavailableHashes.delete(entry.unavailableHashes.keys().next().value as string);
            }
          } else {
            const attempt = this.clients.indexOf(entry) + (secondPass.has(entry) ? this.clients.length : 0);
            if (!propagationAt && attempt >= this.clients.length - 1) backoff = 150 * (attempt + 1);
          }
          if (!failure.limited && !secondPass.has(entry)) {
            secondPass.add(entry);
            pending.push(entry);
          }
        } finally {
          clearTimeout(timer);
          if (takesSlot) {
            const next = entry.waiters.shift();
            if (next) next();
            else entry.active--;
          }
        }
        if (backoff) await sleep(backoff);
      }
      candidates = pending.filter(entry => !skipUnavailableHistory(entry));
      if (!candidates.length) break;
      const earliest = Math.min(...candidates.map(readyAt));
      const started = Date.now();
      const delay = Math.max(0, earliest - started);
      // A fresh-head retry keeps its own deadline even if another endpoint is rate-limited.
      const propagation = earliest === propagationAt && candidates.some(entry => secondPass.has(entry) && readyAt(entry) === earliest);
      const wait = propagation ? delay : Math.min(delay, remaining);
      if (wait > 0) await sleep(wait);
      // Charge at least the requested wait so the budget expires even under a clock that does not move.
      if (!propagation && wait > 0) remaining = Math.max(0, remaining - Math.max(wait, Date.now() - started));
      if (wait < delay) break;
    }
    if (lastError === undefined) throw new Error(`${method} unavailable: every endpoint is cooling down`);
    throw lastError instanceof Error ? lastError : new Error(`${method} failed on every endpoint`);
  }

  private remember(block: BlockHeader): BlockHeader {
    this.blockNumbers.set(block.hash.toLowerCase(), block.number);
    if (this.blockNumbers.size > 4_096) this.blockNumbers.delete(this.blockNumbers.keys().next().value as string);
    return block;
  }

  async chainId(): Promise<number> {
    return this.withFallback('eth_chainId', (c) => c.getChainId());
  }

  observeHead(header: BlockHeader): void {
    if (header.number > 0n) this.remember({ ...header, hash: header.parentHash, number: header.number - 1n });
    this.remember(header);
    if (this.newestHead === undefined || header.number > this.newestHead) this.newestHead = header.number;
  }

  async latestHeader(): Promise<BlockHeader> {
    return this.remember(headerOf(await this.withFallback('eth_getBlockByNumber', (c) => c.getBlock({ blockTag: 'latest' }))));
  }

  async headerByNumber(number: bigint): Promise<BlockHeader | null> {
    try {
      return this.remember(headerOf(await this.withFallback('eth_getBlockByNumber', (c) => c.getBlock({ blockNumber: number }), { number })));
    } catch (error) {
      if (error instanceof Error && error.name === 'BlockNotFoundError') return null;
      throw error;
    }
  }

  async headerByHash(hash: Hex): Promise<BlockHeader | null> {
    try {
      return this.remember(headerOf(await this.withFallback('eth_getBlockByHash', (c) => c.getBlock({ blockHash: hash }), { hash })));
    } catch (error) {
      if (error instanceof Error && error.name === 'BlockNotFoundError') return null;
      throw error;
    }
  }

  /** A result cap splits the range. Return true only when the endpoint supplied an address cap. */
  private handleLogRefusal(client: PublicClient, params: RpcLogFilter, error: unknown): boolean {
    if (!(error instanceof InvalidParamsRpcError)) return false;
    // viem keeps the RPC message in details and the provider's data on the underlying request error.
    const data = error.cause instanceof RpcRequestError ? error.cause.data : undefined;
    const text = typeof data === 'string' ? `${error.details}; ${data}` : error.details;
    const count = /\bmore\s+than\s+(0*[1-9]\d*)\s+results\b/i.exec(text)?.[1];
    if (count) {
      const hint = /\[\s*(0x[0-9a-f]+)\s*,\s*(0x[0-9a-f]+)\s*\]/i.exec(text);
      let suggestedEnd: bigint | undefined;
      if ('fromBlock' in params && hint?.[1] && hint[2]) {
        const start = BigInt(hint[1]), end = BigInt(hint[2]);
        if (start === BigInt(params.fromBlock) && start <= end && end < BigInt(params.toBlock)) suggestedEnd = end;
      }
      throw new LogResultLimitError(count, suggestedEnd, error);
    }
    const match = /\bmaximum of (\d+) addresses\b/i.exec(error.details);
    const limit = Number(match?.[1]);
    if (!Number.isSafeInteger(limit) || limit < 1) return false;
    const known = this.logAddressLimits.get(client);
    if (known === undefined || limit < known) this.logAddressLimits.set(client, limit);
    return true;
  }

  /** An undefined size means that the planned filter can go in one request. */
  private logGroupSize(client: PublicClient, params: RpcLogFilter): number | undefined {
    const limit = this.logAddressLimits.get(client);
    if (limit === undefined || typeof params.address === 'string' || params.address.length <= limit) return undefined;
    if ('toBlock' in params && (this.newestHead === undefined || BigInt(params.toBlock) > this.newestHead - LOG_GROUP_TAIL)) {
      throw new Error('cannot group a by-number log read near the head');
    }
    if (params.address.length > limit * MAX_LOG_GROUPS) throw new Error(`log read requires more than ${MAX_LOG_GROUPS} address groups`);
    return limit;
  }

  private async logGroups(client: PublicClient, params: RpcLogFilter, signal: AbortSignal): Promise<RpcLogShape[][]> {
    const request = (address: RpcLogFilter['address']): Promise<RpcLogShape[]> => {
      if ('fromBlock' in params && this.oversizedRanges.length) {
        const end = BigInt(params.toBlock);
        const cut = this.beforeOversizedRange(BigInt(params.fromBlock), end);
        if (cut < end) return Promise.reject(new KnownOversizedRange(cut));
      }
      return client.request({ method: 'eth_getLogs', params: [{ ...params, address }] } as never) as Promise<RpcLogShape[]>;
    };
    const { address } = params;
    signal.throwIfAborted();
    let limit = this.logGroupSize(client, params);
    if (limit === undefined || typeof address === 'string') {
      try {
        return [await request(address)];
      } catch (error) {
        if (!this.handleLogRefusal(client, params, error)) throw error;
        limit = this.logGroupSize(client, params);
        if (limit === undefined || typeof address === 'string') throw error;
      }
    }
    const groups: RpcLogShape[][] = [];
    const waveSize = LOG_GROUPS_PER_WAVE * limit;
    for (let start = 0; start < address.length; start += waveSize) {
      signal.throwIfAborted();
      if (this.logAddressLimits.get(client) !== limit) throw new Error('endpoint reduced its log address limit');
      const wave: Promise<RpcLogShape[]>[] = [];
      for (let i = start; i < Math.min(start + waveSize, address.length); i += limit) {
        wave.push(request(address.slice(i, i + limit)).catch((error: unknown) => {
          this.handleLogRefusal(client, params, error);
          throw error;
        }));
      }
      try {
        groups.push(...await Promise.all(wave));
      } catch (error) {
        const settled = await Promise.allSettled(wave);
        for (const group of settled) {
          if (group.status === 'rejected' && oversizedAnswer(group.reason)) throw group.reason;
        }
        throw error;
      }
    }
    return groups;
  }

  /** The deadline, archive slot and both anchor checks cover the entire planned request. */
  private raw(params: RpcLogFilter, anchors: readonly BlockAnchor[], scope: ReadScope): Promise<RawLog[]> {
    return this.withFallback('eth_getLogs', async (c, signal) => {
      if (anchors.length) {
        this.logGroupSize(c, params); // Skip an ineligible endpoint before making even an anchor request.
        await agrees(c, anchors, signal);
      }
      const groups = await this.logGroups(c, params, signal);
      await agrees(c, anchors, signal);
      const logs = groups.flatMap(group => group.map(fromRpcLog));
      if (groups.length > 1) logs.sort(logOrder);
      return logs;
    }, scope, anchors);
  }

  private oversizedBlock(block: bigint | Hex, cause?: ResponseBodyTooLargeError | LogResultLimitError): Error {
    const reason = cause instanceof LogResultLimitError ? cause.message : "the answer is larger than the client's limit";
    return new Error(`block ${block}: ${reason}`, { cause });
  }

  /** A provider hint consumes only its prefix. The next ordinary span then starts at the first unread block. */
  private async rangePiece(request: LogPlan[number], from: bigint, to: bigint, anchors: readonly BlockAnchor[],
    onSplit: () => void): Promise<{ logs: RawLog[]; end: bigint }> {
    try {
      const logs = await this.raw({ ...request, fromBlock: toHex(from), toBlock: toHex(to) }, anchors, { number: from });
      return { logs, end: to };
    } catch (error) {
      if (oversizedAnswer(error)) {
        if (from === to) throw this.oversizedBlock(from, error);
        this.rememberOversizedRange(from, to);
      } else if (!(error instanceof KnownOversizedRange)) throw error;
      const hint = error instanceof LogResultLimitError ? error.suggestedEnd : undefined;
      const cut = error instanceof KnownOversizedRange ? error.cut : hint ?? (from + to) / 2n;
      onSplit();
      const left = await this.rangePiece(request, from, cut, anchors, onSplit);
      if (hint !== undefined || left.end < cut) return left;
      const right = await this.rangePiece(request, cut + 1n, to, anchors, onSplit);
      return { logs: left.logs.concat(right.logs), end: right.end };
    }
  }

  private rememberOversizedRange(from: bigint, to: bigint): void {
    if (this.oversizedRanges.some(r => from <= r.from && r.to <= to)) return;
    this.oversizedRanges = this.oversizedRanges.filter(r => !(r.from <= from && to <= r.to));
    this.oversizedRanges.push({ from, to });
    if (this.oversizedRanges.length > this.maxOversizedRanges) this.oversizedRanges.shift();
  }

  private beforeOversizedRange(start: bigint, end: bigint): bigint {
    for (const range of this.oversizedRanges) {
      if (start <= range.from && range.to <= end) end = range.to - 1n;
    }
    return end;
  }

  async logsByHash(blockHash: Hex, filter: LogFilter): Promise<readonly RawLog[]> {
    let answers: RawLog[][];
    try {
      answers = await Promise.all(logRequestPlan(filter, this.maxAddresses).map(request =>
        this.raw({ ...request, blockHash }, [], { hash: blockHash })));
    } catch (error) {
      if (oversizedAnswer(error)) throw this.oversizedBlock(this.blockNumbers.get(blockHash.toLowerCase()) ?? blockHash, error);
      throw error;
    }
    const out = answers.flat();
    for (const log of out) if (log.blockHash.toLowerCase() !== blockHash.toLowerCase()) throw new Error(`getLogs returned a log of block ${log.blockHash}`);
    return out;
  }

  async rangeLogs(fromBlock: bigint, toBlock: bigint, filter: LogFilter, anchors: readonly BlockAnchor[] = []): Promise<readonly RawLog[]> {
    if (fromBlock > toBlock) return [];
    let pending = logRequestPlan(filter, this.maxAddresses).map(request => ({ request, next: fromBlock }));
    const out: RawLog[] = [];
    let split = false;
    const onSplit = () => { split = true; };
    // Planned filters start each round together. A hint can move just one filter's next range boundary.
    while (pending.length) {
      const answers = await Promise.all(pending.map(async cursor => {
        const last = cursor.next + this.maxRange - 1n;
        const end = last < toBlock ? last : toBlock;
        const cut = this.beforeOversizedRange(cursor.next, end);
        if (cut < cursor.next) throw this.oversizedBlock(cursor.next);
        if (cut < end) onSplit();
        const part = await this.rangePiece(cursor.request, cursor.next, cut, anchors, onSplit);
        cursor.next = part.end + 1n;
        return part.logs;
      }));
      for (const logs of answers) for (const log of logs) out.push(log);
      pending = pending.filter(cursor => cursor.next <= toBlock);
    }
    return split ? unionLogs(out).sort(logOrder) : out;
  }

  async codeAt(address: Address, blockHash: Hex): Promise<Hex> {
    const key = `${address.toLowerCase()}:${blockHash.toLowerCase()}`;
    const known = this.codes.get(key);
    if (known !== undefined) return known;
    const code = await this.withFallback('eth_getCode', async (c) => (await c.request({ method: 'eth_getCode', params: [address, { blockHash }] } as never)) as Hex, { hash: blockHash });
    // An endpoint missing historical state can also return empty code. Let the next discovery retry it.
    if (typeof code !== 'string' || !/^0x(?:[\da-fA-F]{2})+$/.test(code)) return code;
    this.codes.set(key, code);
    if (this.codes.size > MAX_CODE_ENTRIES) this.codes.delete(this.codes.keys().next().value as string);
    return code;
  }

  callAt(to: Address, data: Hex, blockHash: Hex): Promise<Hex> {
    return this.withFallback('eth_call', async (c) => (await c.request({ method: 'eth_call', params: [{ to, data }, { blockHash }] } as never)) as Hex, { hash: blockHash });
  }

  async callViewsAt(calls: readonly ViewCall[], blockHash: Hex): Promise<readonly ViewResult[]> {
    if (calls.length === 0) return [];
    this.multicallCode ??= this.codeAt(MULTICALL3, blockHash).then(code => code !== '0x').catch((error: unknown) => {
      this.multicallCode = undefined;
      throw error;
    });
    if (!await this.multicallCode) return Promise.allSettled(calls.map(call => this.callAt(call.to, call.data, blockHash)));
    return aggregateViews(this, calls, blockHash);
  }

  async finality(): Promise<Finality> {
    const read = async (blockTag: 'safe' | 'finalized'): Promise<bigint | null> => {
      try {
        const block = await this.withFallback(`eth_getBlockByNumber(${blockTag})`, (c) => c.getBlock({ blockTag }));
        return block.number;
      } catch {
        return null;
      }
    };
    const [safe, finalized] = await Promise.all([read('safe'), read('finalized')]);
    return { safe, finalized };
  }
}
