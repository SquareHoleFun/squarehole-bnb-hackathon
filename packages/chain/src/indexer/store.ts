/**
 * Persistence for the rebuildable log index. The index is a CACHE: losing it only costs a re-sync from the
 * deployment's start block, so every storage failure (private mode, quota, blocked IndexedDB, a schema change) falls
 * back to memory and never breaks a read. Nothing here holds entitlements or keys.
 */
import type { Hex } from 'viem';
import type { SerializedRegistryPair } from '../reads/registry-pair';
import type { JsonValue, LogRole, ApprovedEvent } from './events';

/** Bump when the stored shape changes; an older record is discarded and rebuilt from the chain. */
export const INDEX_SCHEMA_VERSION = 1;

export interface BlockPointer {
  readonly number: string;
  readonly hash: Hex;
}

export interface IndexedLog {
  /** Dedupe key `${chainId}:${blockHash}:${txHash}:${logIndex}` (03-FEED "Event ingestion"). */
  readonly key: string;
  readonly blockNumber: string;
  readonly blockHash: Hex;
  readonly txHash: Hex;
  readonly logIndex: number;
  /** Emitter, lowercase. */
  readonly address: string;
  readonly role: LogRole;
  /** App pair id the log belongs to, when known from the emitter or the event. */
  readonly pairId: string | null;
  readonly event: ApprovedEvent;
  readonly args: Readonly<Record<string, JsonValue>>;
}

export interface IndexedBlock {
  readonly hash: Hex;
  readonly timestamp: string;
}

export interface IndexState {
  readonly schemaVersion: number;
  readonly chainId: number;
  /** Deployment identity: the index belongs to one registry deployed at one start block. */
  readonly registry: string;
  readonly startBlock: string;
  /** Last block whose logs are completely indexed (null before the first range). */
  indexedTo: BlockPointer | null;
  /** Recent range-end pointers (ascending) used to find the common ancestor after a reorg. */
  checkpoints: BlockPointer[];
  /** The chain's finalized block at the last sync (null if the node does not report it). */
  finalizedBlock: string | null;
  /** Registry records by app pair id, from PairCreated. */
  pairs: Record<string, { readonly createdAtBlock: string; readonly record: SerializedRegistryPair }>;
  logs: Record<string, IndexedLog>;
  /** Headers of blocks that carry indexed logs (timestamps for the 24h window, hashes for reorg checks). */
  blocks: Record<string, IndexedBlock>;
}

export interface IndexStore {
  load(key: string): Promise<IndexState | null>;
  save(key: string, state: IndexState): Promise<void>;
  remove(key: string): Promise<void>;
  /** Human-readable kind for provenance ("memory", "indexeddb", "indexeddb (unavailable, memory only)"). */
  readonly kind: string;
}

export function indexKey(chainId: number, registry: string, startBlock: string): string {
  return `${chainId}:${registry.toLowerCase()}:${startBlock}`;
}

export function emptyIndexState(chainId: number, registry: string, startBlock: string): IndexState {
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    chainId,
    registry: registry.toLowerCase(),
    startBlock,
    indexedTo: null,
    checkpoints: [],
    finalizedBlock: null,
    pairs: {},
    logs: {},
    blocks: {},
  };
}

/** Structural check of a stored record: anything else is treated as absent (rebuild), never trusted. */
export function isUsableIndexState(value: unknown, chainId: number, registry: string, startBlock: string): value is IndexState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Partial<IndexState>;
  return (
    state.schemaVersion === INDEX_SCHEMA_VERSION &&
    state.chainId === chainId &&
    typeof state.registry === 'string' &&
    state.registry === registry.toLowerCase() &&
    state.startBlock === startBlock &&
    typeof state.logs === 'object' &&
    state.logs !== null &&
    typeof state.pairs === 'object' &&
    state.pairs !== null &&
    typeof state.blocks === 'object' &&
    state.blocks !== null &&
    Array.isArray(state.checkpoints)
  );
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** In-memory store (Node, tests, and the fallback when IndexedDB is unavailable). Copies on load/save. */
export function createMemoryIndexStore(): IndexStore {
  const records = new Map<string, string>();
  return {
    kind: 'memory',
    async load(key) {
      const text = records.get(key);
      return text === undefined ? null : (JSON.parse(text) as IndexState);
    },
    async save(key, state) {
      records.set(key, JSON.stringify(state));
    },
    async remove(key) {
      records.delete(key);
    },
  };
}

const DB_NAME = 'squarehole-chain-index';
const DB_VERSION = 1;
const OBJECT_STORE = 'indexes';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * IndexedDB-backed store (browser). Every operation is wrapped: an error or a missing `indexedDB` makes this store
 * behave like an empty memory store for the rest of the session, and the provenance says so.
 */
export function createIndexedDbIndexStore(factory: IDBFactory | null = globalThis.indexedDB ?? null): IndexStore {
  const memory = createMemoryIndexStore();
  let broken = factory === null;
  let dbPromise: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    if (!factory) return Promise.reject(new Error('IndexedDB is not available'));
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = factory.open(DB_NAME, DB_VERSION);
      } catch (error) {
        reject(error instanceof Error ? error : new Error('IndexedDB open failed'));
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(OBJECT_STORE)) db.createObjectStore(OBJECT_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
    return dbPromise;
  };

  const fail = (error: unknown): void => {
    broken = true;
    console.warn('Square Hole chain index: IndexedDB unavailable, keeping the index in memory only', error);
  };

  const store: IndexStore = {
    get kind() {
      return broken ? 'indexeddb (unavailable, memory only)' : 'indexeddb';
    },
    async load(key) {
      if (broken) return memory.load(key);
      try {
        const db = await open();
        const value = await request(db.transaction(OBJECT_STORE, 'readonly').objectStore(OBJECT_STORE).get(key));
        return value === undefined ? null : (clone(value) as IndexState);
      } catch (error) {
        fail(error);
        return memory.load(key);
      }
    },
    async save(key, state) {
      if (broken) return memory.save(key, state);
      try {
        const db = await open();
        const tx = db.transaction(OBJECT_STORE, 'readwrite');
        await request(tx.objectStore(OBJECT_STORE).put(clone(state), key));
      } catch (error) {
        fail(error);
        await memory.save(key, state);
      }
    },
    async remove(key) {
      await memory.remove(key);
      if (broken) return;
      try {
        const db = await open();
        await request(db.transaction(OBJECT_STORE, 'readwrite').objectStore(OBJECT_STORE).delete(key));
      } catch (error) {
        fail(error);
      }
    },
  };
  return store;
}
