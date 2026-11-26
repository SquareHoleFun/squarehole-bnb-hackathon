import { encodeFunctionData, type PublicClient } from 'viem';
import { sepolia } from 'viem/chains';

/** Explicit deployment metadata; unknown chains keep ordinary JSON-RPC batching. */
export const keeperContracts = (chainId: number) => chainId === sepolia.id ? sepolia.contracts : undefined;
// Child calldata bytes, not the encoded aggregate's size. Offline gas/response margins: SH-KEEPER-BATCH.
export const keeperMulticall = (chainId: number) => chainId === sepolia.id ? { multicall: { batchSize: 16 * 1024, wait: 8 } } : undefined;

/** Bound in-flight boxes while letting each dependency stage share viem's batch window. Preserve registry order. */
export async function readWindows<T, R>(items: Iterable<T>, read: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let window: Promise<R>[] = [];
  for (const item of items) {
    window.push(read(item));
    if (window.length === 32) { out.push(...await Promise.all(window)); window = []; }
  }
  out.push(...await Promise.all(window));
  return out;
}

/** Only caller-independent views at an explicit block. Pending calls, simulations and finality checks stay fresh. */
export class TickReads {
  private active = false;
  private readonly pending = new Map<string, Promise<unknown>>();
  readonly client: PublicClient;
  constructor(client: PublicClient) {
    this.client = new Proxy(client, { get: (target, method, receiver) => {
      const value = Reflect.get(target, method, receiver) as unknown;
      if (!['readContract', 'getChainId', 'getBalance', 'getBytecode', 'getStorageAt'].includes(String(method)) || typeof value !== 'function') return value;
      return (args?: Record<string, unknown>) => {
        const cacheable = this.active && (method === 'getChainId' || (typeof args?.blockNumber === 'bigint' && !args.account && !args.stateOverride));
        if (!cacheable) return value.call(target, args);
        const input = method === 'readContract' ? { address: args?.address, blockNumber: args?.blockNumber,
          data: encodeFunctionData(args as never) } : args;
        const key = `${String(method)}:${JSON.stringify(input, (_k, v: unknown) => typeof v === 'bigint' ? String(v) : v)}`;
        let promise = this.pending.get(key);
        if (!promise) {
          promise = Promise.resolve().then(() => value.call(target, args));
          this.pending.set(key, promise);
          if (this.pending.size > 8192) { const oldest = this.pending.keys().next().value; if (oldest !== undefined) this.pending.delete(oldest); }
        }
        return promise;
      };
    } });
  }
  begin() { this.active = true; this.pending.clear(); }
}
