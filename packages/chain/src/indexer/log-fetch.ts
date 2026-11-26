/**
 * Bounded eth_getLogs with adaptive splitting (03-FEED "Event ingestion"; public RPCs cap ranges and result sizes).
 * A range the provider refuses as too large is halved (down to `minRange` blocks) and retried; after successes the
 * span grows back towards `maxRange`. Any other failure is `ChainUnavailableError` (never an empty result).
 */
import { hexToBigInt, numberToHex, type Address, type Hex } from 'viem';
import type { ChainPublicClient } from '../client';
import { ChainDataError, ChainUnavailableError, isAbortError, throwIfAborted } from '../errors';

export interface RawRpcLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly logIndex: number;
}

export interface LogFilter {
  readonly address: Address | readonly Address[];
  readonly topics?: readonly (Hex | readonly Hex[] | null)[];
}

/** Mutable span state shared by consecutive fetches (the indexer keeps one per chain). */
export interface AdaptiveRange {
  current: number;
  readonly min: number;
  readonly max: number;
  successes: number;
}

export function createAdaptiveRange(initial: number, min: number, max: number): AdaptiveRange {
  return { current: initial, min, max, successes: 0 };
}

const RANGE_MESSAGE =
  /block range|range (?:is )?too (?:large|wide|big)|limit exceeded|too many (?:results|logs|blocks)|exceeds? (?:the )?(?:max|limit)|more than \d+|query returned more than|response (?:size|too large)|max(?:imum)? (?:block )?range|log response size|query timeout|range limit/i;

/** Whether a failure is the provider refusing the SIZE of a getLogs request (worth splitting). */
export function isRangeLimitError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
    const candidate = current as { code?: unknown; status?: unknown; message?: unknown; details?: unknown; cause?: unknown };
    if (candidate.code === -32005 || candidate.status === 413) return true;
    const text = `${typeof candidate.message === 'string' ? candidate.message : ''} ${typeof candidate.details === 'string' ? candidate.details : ''}`;
    if (RANGE_MESSAGE.test(text)) return true;
    current = candidate.cause;
  }
  return false;
}

interface RpcLogJson {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex | null;
  blockHash: Hex | null;
  transactionHash: Hex | null;
  logIndex: Hex | null;
  removed?: boolean;
}

function toRawLog(log: RpcLogJson, from: bigint, to: bigint): RawRpcLog | null {
  if (log.removed === true) return null;
  if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null) {
    throw new ChainDataError('inconsistent_state', 'eth_getLogs returned a pending log for a mined range');
  }
  const blockNumber = hexToBigInt(log.blockNumber);
  if (blockNumber < from || blockNumber > to) throw new ChainDataError('inconsistent_state', 'eth_getLogs returned a log outside the requested range');
  return {
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    logIndex: Number(hexToBigInt(log.logIndex)),
  };
}

async function getLogsOnce(client: ChainPublicClient, filter: LogFilter, from: bigint, to: bigint): Promise<RawRpcLog[]> {
  const params = {
    address: Array.isArray(filter.address) ? [...filter.address] : filter.address,
    topics: filter.topics ? filter.topics.map((topic) => (topic === null ? null : Array.isArray(topic) ? [...topic] : topic)) : undefined,
    fromBlock: numberToHex(from),
    toBlock: numberToHex(to),
  };
  const result = (await client.request({ method: 'eth_getLogs', params: [params] } as never)) as unknown;
  if (!Array.isArray(result)) throw new ChainDataError('inconsistent_state', 'eth_getLogs did not return an array');
  return (result as RpcLogJson[]).map((log) => toRawLog(log, from, to)).filter((log): log is RawRpcLog => log !== null);
}

/** Logs of `filter` in [from, to], fetched in adaptive bounded ranges, in (block, logIndex) order. */
export async function fetchLogsAdaptive(
  client: ChainPublicClient,
  filter: LogFilter,
  from: bigint,
  to: bigint,
  range: AdaptiveRange,
  signal?: AbortSignal,
): Promise<RawRpcLog[]> {
  if (to < from) return [];
  const addresses = Array.isArray(filter.address) ? filter.address : [filter.address];
  if (addresses.length === 0) return [];
  const out: RawRpcLog[] = [];
  let cursor = from;
  while (cursor <= to) {
    throwIfAborted(signal);
    const span = BigInt(Math.max(range.min, Math.min(range.current, range.max)));
    const end = cursor + span - 1n < to ? cursor + span - 1n : to;
    try {
      out.push(...(await getLogsOnce(client, filter, cursor, end)));
    } catch (error) {
      if (isAbortError(error) || error instanceof ChainDataError) throw error;
      const size = Number(end - cursor + 1n);
      if (isRangeLimitError(error) && size > range.min) {
        range.current = Math.max(range.min, Math.floor(size / 2));
        range.successes = 0;
        continue;
      }
      throw new ChainUnavailableError(`eth_getLogs failed for blocks ${cursor}-${end}`, { cause: error });
    }
    cursor = end + 1n;
    range.successes += 1;
    if (range.successes >= 2 && range.current < range.max) {
      range.current = Math.min(range.max, range.current * 2);
      range.successes = 0;
    }
  }
  return out.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
}
