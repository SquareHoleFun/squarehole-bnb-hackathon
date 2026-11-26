/**
 * SH-192 (BOXSPEC-AUTOSAVE, founder 2026-11-02: "this should never be possible to happen"): this browser's own copy of
 * each box's reveal data, in IndexedDB (`sh.reveal.keep.v1`), keyed by the chain and the box's predicted token address.
 * Create writes it before anything that commits a reveal root is sent (useCreateSend `keep`), reads it back to check
 * the write, and the box page offers it again to the creator ("download again") until every item is revealed on chain,
 * then removes it. It never leaves the device: nothing here sends, uploads or logs it. Listed in the privacy notice
 * (features/legal/privacy.ts).
 *
 * What a copy holds (`text`, the file the creator would use): open art's BoxSpec without its picture bytes (format
 * `squarehole.boxspec/2`, the spec, its bytes and hash, and the reveal list with every salt: what
 * packages/chain/scripts/reveal-open-v2.ts reads); hidden art's reveal file (create-model.ts `revealFile`, what the box
 * page's "Load reveal file" reads). The picture bytes stay in the full box file saved at Create.
 */
import { isAddress, type Address, type Hex } from 'viem';

/** The database name, as the browser's developer tools show it. */
export const REVEAL_KEEP_DB = 'sh.reveal.keep.v1';
const STORE = 'boxes';
const VERSION = 1;
export const REVEAL_KEEP_FORMAT = 'squarehole.reveal-keep/1';

export type KeptArtMode = 'open' | 'hidden';

export interface KeptReveal {
  readonly format: typeof REVEAL_KEEP_FORMAT;
  /** `<chainId>:<token, lower case>` (`keptKey`). */
  readonly key: string;
  readonly chainId: number;
  /** The box's token address, lower case. */
  readonly token: Address;
  readonly creator: Address;
  /** keccak256 of the spec bytes the box was created with (the registry's and the coordinator's specHash). */
  readonly specHash: Hex;
  readonly revealRoot: Hex;
  readonly artMode: KeptArtMode;
  /** How many items the list holds. */
  readonly n: number;
  /** The name the file is saved under again. */
  readonly fileName: string;
  /** The file's text, byte for byte. */
  readonly text: string;
  /** When it was written (ms since 1970). */
  readonly savedAt: number;
  /** Unique write attempt; timestamps are not cross-tab identities. */
  readonly attempt?: string;
  /** Shared active/possibly-sent attempts. Only a confirmed unsent owner releases itself. */
  readonly owners?: readonly string[];
  /** A confirmed unsent attempt was abandoned; retry removal on the next app visit. */
  readonly abandoned?: boolean;
  /** No request/send remains, but absence still needs a successful chain read. */
  readonly discardWhenAbsent?: boolean;
}

/** The copy could not be written, read back or found where IndexedDB is unavailable. */
export class RevealKeepError extends Error {
  override readonly name = 'RevealKeepError';
}

export const keptKey = (chainId: number, token: string): string => `${chainId}:${token.toLowerCase()}`;

// Kept copies omit asset bytes. Match the reveal parsers' 64 MiB retained-text bound before any Blob/copy.
export const MAX_KEPT_REVEAL_CHARS = 64 * 1024 * 1024;

const HASH = /^0x[0-9a-fA-F]{64}$/;

/** A stored value read back, or null when it is not a copy (damaged, or another version's). */
export function parseKept(value: unknown): KeptReveal | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.format !== REVEAL_KEEP_FORMAT || !Number.isSafeInteger(v.chainId) || (v.chainId as number) <= 0) return null;
  if (typeof v.token !== 'string' || !isAddress(v.token) || typeof v.creator !== 'string' || !isAddress(v.creator)) return null;
  if (v.key !== keptKey(v.chainId as number, v.token)) return null;
  if (typeof v.specHash !== 'string' || !HASH.test(v.specHash) || typeof v.revealRoot !== 'string' || !HASH.test(v.revealRoot)) return null;
  if ((v.artMode !== 'open' && v.artMode !== 'hidden') || !Number.isSafeInteger(v.n) || (v.n as number) < 1) return null;
  if (typeof v.fileName !== 'string' || v.fileName === '' || typeof v.text !== 'string' || v.text === '' || v.text.length > MAX_KEPT_REVEAL_CHARS || !Number.isFinite(v.savedAt)) return null;
  return {
    format: REVEAL_KEEP_FORMAT, key: v.key, chainId: v.chainId as number, token: v.token.toLowerCase() as Address, creator: v.creator as Address,
    specHash: v.specHash.toLowerCase() as Hex, revealRoot: v.revealRoot.toLowerCase() as Hex, artMode: v.artMode, n: v.n as number,
    fileName: v.fileName, text: v.text, savedAt: v.savedAt as number,
    ...(typeof v.attempt === 'string' ? { attempt: v.attempt } : {}),
    ...(Array.isArray(v.owners) && v.owners.every((owner) => typeof owner === 'string') ? { owners: v.owners as string[] } : {}),
    ...(v.abandoned === true ? { abandoned: true } : {}),
    ...(v.discardWhenAbsent === true ? { discardWhenAbsent: true } : {}),
  };
}

function idb(given?: IDBFactory): IDBFactory {
  let found: IDBFactory | undefined = given;
  try {
    found ??= globalThis.indexedDB;
  } catch {
    // A browser that throws on the accessor (blocked site data): no copy can be kept.
  }
  if (!found) throw new RevealKeepError('IndexedDB is unavailable');
  return found;
}

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(REVEAL_KEEP_DB, VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new RevealKeepError('IndexedDB could not open'));
    request.onblocked = () => reject(new RevealKeepError('IndexedDB is blocked by another tab'));
  });
}

/** Runs `work` in one transaction and resolves once that transaction is committed. */
async function inStore<T>(factory: IDBFactory, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open(factory);
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result: T;
      const request = work(tx.objectStore(STORE));
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? request.error ?? new RevealKeepError('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new RevealKeepError('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

/**
 * Writes the copy, then reads it back in a new transaction and checks it is the same text for the same box: only a
 * copy that reads back with a persistence grant counts as durable.
 * Throws RevealKeepError when IndexedDB is unavailable or the write does not read back.
 */
export async function keepReveal(record: KeptReveal, given?: IDBFactory): Promise<void> {
  const factory = idb(given);
  const checked = parseKept(record);
  if (!checked) throw new RevealKeepError('Not a reveal copy');
  try {
    await updateKept(checked.key, (previous) => {
      if (!checked.attempt) return checked;
      if (previous?.owners?.length && (previous.text !== checked.text || previous.specHash !== checked.specHash || previous.revealRoot !== checked.revealRoot)) {
        throw new RevealKeepError('Another attempt owns this copy');
      }
      return { ...checked, abandoned: false, discardWhenAbsent: false,
        owners: [...new Set([...(previous?.owners ?? []), checked.attempt])] };
    }, factory);
  } catch (error) {
    throw error instanceof RevealKeepError ? error : new RevealKeepError('The copy could not be written');
  }
  const back = await readKept(checked.chainId, checked.token, factory);
  if (!back || back.text !== checked.text || back.specHash !== checked.specHash || back.revealRoot !== checked.revealRoot || (checked.attempt && !back.owners?.includes(checked.attempt))) throw new RevealKeepError('The copy did not read back');
  if (!(await persistStorage())) throw new RevealKeepError('Storage persistence was not granted');
}

/** The copy for this box on this device, or null (none, a damaged one, or no IndexedDB here). */
export async function readKept(chainId: number, token: string, given?: IDBFactory): Promise<KeptReveal | null> {
  let factory: IDBFactory;
  try {
    factory = idb(given);
  } catch {
    return null;
  }
  try {
    return parseKept(await inStore(factory, 'readonly', (store) => store.get(keptKey(chainId, token)) as IDBRequest<unknown>));
  } catch {
    return null;
  }
}

/** Removes this box's copy (after every item is revealed on chain). */
export async function forgetKept(chainId: number, token: string, given?: IDBFactory): Promise<void> {
  await inStore(idb(given), 'readwrite', (store) => store.delete(keptKey(chainId, token)));
}

/** A temporary/private-session copy never counts as durable. Always await the browser's decision. */
async function persistStorage(): Promise<boolean> {
  try {
    const storage = (globalThis.navigator as Navigator | undefined)?.storage;
    return typeof storage?.persist === 'function' && await storage.persist() === true;
  } catch {
    return false;
  }
}

/** Enumerates only this app's reveal copies; no wallet or network access. */
export async function listKept(given?: IDBFactory): Promise<readonly KeptReveal[]> {
  const values = await inStore(idb(given), 'readonly', (store) => store.getAll() as IDBRequest<unknown[]>);
  return values.flatMap((value) => { const copy = parseKept(value); return copy ? [copy] : []; });
}

/** Read/modify/write in one shared transaction, including ownership changes by other tabs. */
async function updateKept(key: string, update: (copy: KeptReveal | null) => KeptReveal | null, factory = idb()): Promise<KeptReveal | null> {
  const db = await open(factory);
  try {
    return await new Promise<KeptReveal | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const request = store.get(key);
      let result: KeptReveal | null = null;
      request.onsuccess = () => {
        try {
          result = update(parseKept(request.result));
          if (result) store.put(result); else store.delete(key);
        } catch (error) { tx.abort(); reject(error); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(tx.error ?? new RevealKeepError('Copy cleanup failed'));
    });
  } finally { db.close(); }
}

/** Compare the captured version, never a record freshly selected after an asynchronous chain read. */
async function changeKept(copy: KeptReveal, replacement: KeptReveal | null): Promise<void> {
  await updateKept(copy.key, (current) => JSON.stringify(current) === JSON.stringify(parseKept(copy)) ? replacement : current);
}

export const forgetKeptCopy = (copy: KeptReveal): Promise<void> => changeKept(copy, null);
const abandonedRetries = new Map<string, KeptReveal>();

async function removeAbandoned(copy: KeptReveal): Promise<void> {
  const marked = { ...copy, abandoned: true };
  await changeKept(copy, marked);
  // Remember the marked version too if deletion fails; it is also discoverable after a reload.
  abandonedRetries.set(copy.key, marked);
  await forgetKeptCopy(marked);
  abandonedRetries.delete(copy.key);
}

/** Called only after confirming no send/pending wallet request and no created box. */
export async function abandonKept(copy: KeptReveal): Promise<void> {
  if (copy.owners?.length) return;
  abandonedRetries.set(copy.key, copy);
  await removeAbandoned(copy).catch(() => undefined);
}

/** Failed removals retry while the app is open; the durable abandoned marker also survives a reload. */
export async function retryAbandonedKept(): Promise<void> {
  for (const copy of abandonedRetries.values()) await removeAbandoned(copy).catch(() => undefined);
}

/** Release only this press's ownership. An older press cannot mark a newer write, even after a reload. */
export async function markUnsentKept(chainId: number, token: string, attempt: string): Promise<KeptReveal | null> {
  const copy = await updateKept(keptKey(chainId, token), (current) => {
    if (!current?.owners?.includes(attempt)) return current;
    const owners = current.owners.filter((owner) => owner !== attempt);
    return { ...current, owners, ...(current.attempt === attempt && owners.length === 0 ? { discardWhenAbsent: true } : {}) };
  });
  return copy?.attempt === attempt && copy.discardWhenAbsent && !copy.owners?.length ? copy : null;
}
