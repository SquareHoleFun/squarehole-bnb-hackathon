/** Only explicitly selected, sender-independent views enter this adapter. Simulations keep CoreReader.callAt. */
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import type { CoreReader } from './core-reader';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
const aggregate3 = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
export interface ViewCall { readonly to: Address; readonly data: Hex }
export type ViewResult = PromiseSettledResult<Hex>;
export type ViewReader = Pick<CoreReader, 'callAt' | 'callViewsAt'>;

/** Bound both calldata and sub-call count; one unusually large view stays a single eth_call. */
export const MAX_VIEW_CALLS = 128;
const MAX_VIEW_BYTES = 48 * 1024;
type Pending = ViewCall & { resolve(value: Hex): void; reject(error: unknown): void };
// Share only outstanding work across boxes. Completed values belong to the individual read scope below.
const queues = new WeakMap<ViewReader, Map<Hex, Pending[]>>();

export async function aggregateViews(reader: Pick<CoreReader, 'callAt'>, calls: readonly ViewCall[], hash: Hex): Promise<readonly ViewResult[]> {
  const results: ViewResult[] = [];
  for (let start = 0; start < calls.length;) {
    let end = start, bytes = 68;
    while (end < calls.length && end - start < MAX_VIEW_CALLS) {
      const size = Math.ceil(((calls[end] as ViewCall).data.length - 2) / 64) * 32 + 160;
      if (bytes + size > MAX_VIEW_BYTES) break;
      bytes += size; end++;
    }
    if (end === start) {
      const call = calls[start] as ViewCall;
      results.push(...await Promise.allSettled([reader.callAt(call.to, call.data, hash)]));
      start++; continue;
    }
    const chunk = calls.slice(start, end);
    const data = encodeFunctionData({ abi: aggregate3, functionName: 'aggregate3', args: [chunk.map(call => ({ target: call.to, allowFailure: true, callData: call.data }))] });
    const raw = await reader.callAt(MULTICALL3, data, hash);
    // A chain may have deployed Multicall3 after this historical block. Do not change its cached head capability.
    if (raw === '0x') results.push(...await Promise.allSettled(chunk.map(call => reader.callAt(call.to, call.data, hash))));
    else {
      const decoded = decodeFunctionResult({ abi: aggregate3, functionName: 'aggregate3', data: raw });
      if (decoded.length !== chunk.length) throw new Error('Multicall3 result length mismatch');
      for (const result of decoded) results.push(result.success ? { status: 'fulfilled', value: result.returnData } : {
        status: 'rejected',
        // Same EVM refusal classification and exact bytes as a single eth_call, including custom InvalidClaim.
        reason: Object.assign(new Error('execution reverted'), { name: 'ExecutionRevertedError', code: 3, data: result.returnData }),
      });
    }
    start = end;
  }
  return results;
}

/**
 * One read operation's view scope. Coalesce concurrently requested views by hash, retaining the existing decoders
 * and each caller's catch policy. Identical calls share a promise only inside this scope, never across blocks/reads.
 */
export function batchViews(reader: ViewReader): Pick<CoreReader, 'callAt'> {
  if (!reader.callViewsAt) return reader;
  const pending = queues.get(reader) ?? new Map<Hex, Pending[]>();
  queues.set(reader, pending);
  const memo = new Map<string, Promise<Hex>>();
  return { callAt(to, data, hash) {
    const key = `${hash.toLowerCase()}:${to.toLowerCase()}:${data.toLowerCase()}`;
    const known = memo.get(key);
    if (known) return known;
    const promise = new Promise<Hex>((resolve, reject) => {
      const group = pending.get(hash);
      const call = { to, data, resolve, reject };
      if (group) { group.push(call); return; }
      pending.set(hash, [call]);
      queueMicrotask(() => {
        const calls = pending.get(hash) as Pending[];
        pending.delete(hash);
        void reader.callViewsAt?.(calls, hash).then(results => {
          if (results.length !== calls.length) throw new Error('view result length mismatch');
          results.forEach((result, i) => {
            const next = calls[i] as Pending;
            if (result.status === 'fulfilled') next.resolve(result.value);
            else next.reject(result.reason);
          });
        }).catch((error: unknown) => { for (const next of calls) next.reject(error); });
      });
    });
    memo.set(key, promise);
    // A transient refusal must not prevent a later independent attempt in the same read from succeeding.
    void promise.catch(() => memo.delete(key));
    return promise;
  } };
}
