/**
 * SH-EXISTING-NFTS-E08C: who holds an item that is out of the box, read lazily for the rows on screen (a return names
 * only the caller's own items). One `ownerOf` per item over the source's RPC, a few at a time, kept for a short while;
 * a read that fails is unknown (never "yours"), and every return checks ownership again before it sends.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { Address } from 'viem';
import { ERC721_ABI } from './set-calls';
import type { SetReads } from './set-reads';

const KEEP_MS = 15_000;
const PARALLEL = 4;
type Entry = { readonly owner: string | null; readonly pending: boolean; readonly at: number };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const queue: (() => Promise<void>)[] = [];
let running = 0;
/** Counts `forgetOwners()` calls: each one sends the rows on screen to read their holders again. */
let generation = 0;
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
function pump(): void {
  while (running < PARALLEL && queue.length > 0) {
    const job = queue.shift();
    if (!job) break;
    running += 1;
    void job().finally(() => {
      running -= 1;
      pump();
    });
  }
}

/** The item's holder (lower case) once read, else null. `reads` null: nothing is read. */
export function useItemOwner(reads: Pick<SetReads, 'read'> | null, chainId: number, collection: Address, id: bigint): string | null {
  const key = reads ? `${chainId}:${collection.toLowerCase()}:${id.toString()}` : null;
  const round = useSyncExternalStore(subscribe, () => generation, () => 0);
  useEffect(() => {
    if (key === null || reads === null) return;
    const known = entries.get(key);
    if (known && (known.pending || Date.now() - known.at < KEEP_MS)) return;
    entries.set(key, { owner: known?.owner ?? null, pending: true, at: Date.now() });
    const asked = generation;
    queue.push(async () => {
      const owner = await reads.read(collection, ERC721_ABI, 'ownerOf', [id]).then((value) => (typeof value === 'string' ? value.toLowerCase() : null), () => null);
      // A read begun before the holders were forgotten is not kept: this row has read again since.
      if (asked !== generation) return;
      entries.set(key, { owner, pending: false, at: Date.now() });
      notify();
    });
    pump();
  }, [key, reads, collection, id, round]);
  return useSyncExternalStore(subscribe, () => (key === null ? null : entries.get(key)?.owner ?? null), () => null);
}

/** Forget every holder read (after a return or a pick moved items, and in tests); the rows on screen read again. */
export function forgetOwners(): void {
  entries.clear();
  queue.length = 0;
  generation += 1;
  notify();
}
