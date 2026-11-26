/**
 * Small helpers over sets of logs, shared by the pipeline's audit and repair paths. The rule they serve: a log that
 * any backend returned for a block HASH that is still canonical is real, so answers are merged (a union), never
 * subtracted from each other. Only a changed block hash takes logs away (a reorg).
 */
import type { Hex } from 'viem';
import { isStateRelevant, type DecodedEvent, type RawLog } from './events';

export function sameHash(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** Log indexes of the events the state depends on (what the audit compares and the store keeps per block). */
export function relevantIndexes(events: readonly DecodedEvent[]): number[] {
  return [...new Set(events.filter(isStateRelevant).map((e) => e.ref.logIndex))].sort((a, b) => a - b);
}

/** Logs grouped by block number, in the order given. */
export function groupByBlock(logs: readonly RawLog[]): Map<bigint, RawLog[]> {
  const out = new Map<bigint, RawLog[]>();
  for (const log of logs) out.set(log.blockNumber, [...(out.get(log.blockNumber) ?? []), log]);
  return out;
}

/** The union of several answers for the same block(s): one log per (block hash, log index), the first copy kept. */
export function unionLogs(...lists: readonly (readonly RawLog[])[]): RawLog[] {
  const seen = new Set<string>();
  const out: RawLog[] = [];
  for (const list of lists) {
    for (const log of list) {
      const key = `${log.blockHash.toLowerCase()}:${log.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(log);
    }
  }
  return out;
}

/** Only the logs of `blockHash` (an answer can carry another fork's logs when a backend lags). */
export function logsOfHash(logs: readonly RawLog[], blockHash: Hex): RawLog[] {
  return logs.filter((log) => sameHash(log.blockHash, blockHash));
}

/** Runs `fn` over `items` with at most `limit` in flight; results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
