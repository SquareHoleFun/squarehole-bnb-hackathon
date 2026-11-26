/** Origin-wide public journal. Each attempt and the scalar index commit in one transaction. */
import { requireRevealAuthority } from './reveal-session';
import { PROGRESS_MAX_BYTES, PROGRESS_MAX_INTENTS, PROGRESS_MAX_RECORD_BYTES, type JournalIndex, type RevealProgressStore } from './reveal-items-store';

export class RevealStorageRefusal extends Error {
  constructor(readonly reason: 'storage-unavailable' | 'storage-full' | 'storage-conflict' | 'storage-invalid') { super(reason); }
}
const refusal = (error: unknown): RevealStorageRefusal => error instanceof RevealStorageRefusal ? error
  : new RevealStorageRefusal(error instanceof DOMException && error.name === 'QuotaExceededError' ? 'storage-full' : 'storage-unavailable');
const request = <T>(req: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
});
/** The rejection deadline aborts the transaction first. Late callbacks cannot publish anything. */
async function transaction<T>(db: IDBDatabase, mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const tx = db.transaction(['index', 'attempts', 'legacy'], mode, { durability: 'strict' });
  let value: T, failure: unknown;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { failure = new RevealStorageRefusal('storage-unavailable'); try { tx.abort(); } catch { /* already ended */ } }, 15_000);
    tx.oncomplete = () => { clearTimeout(timer); resolve(value); };
    tx.onabort = () => { clearTimeout(timer); reject(refusal(failure ?? tx.error)); };
    tx.onerror = () => { failure ??= tx.error; };
    void work(tx).then(result => { value = result; }).catch(error => {
      failure = error; try { tx.abort(); } catch { clearTimeout(timer); reject(refusal(error)); }
    });
  });
}
export function indexedDBRevealStore(factory?: IDBFactory, name = 'squarehole-reveal-run-v2'): RevealProgressStore {
  try { factory ??= globalThis.indexedDB; } catch { /* An unavailable accessor also fails with the typed refusal on read. */ }
  let opening: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => opening ??= new Promise((resolve, reject) => {
    if (!factory) { reject(new RevealStorageRefusal('storage-unavailable')); return; }
    const req = factory.open(name, 1); let expired = false;
    const timer = setTimeout(() => { expired = true; reject(new RevealStorageRefusal('storage-unavailable')); }, 15_000);
    req.onupgradeneeded = () => { for (const store of ['index', 'attempts', 'legacy']) req.result.createObjectStore(store); };
    req.onsuccess = () => {
      clearTimeout(timer); if (expired) { req.result.close(); return; }
      req.result.onversionchange = () => req.result.close(); resolve(req.result);
    };
    req.onerror = () => { clearTimeout(timer); reject(refusal(req.error)); };
    req.onblocked = () => { clearTimeout(timer); expired = true; reject(new RevealStorageRefusal('storage-unavailable')); };
  });
  const store: RevealProgressStore = {
    get: async key => transaction(await open(), 'readonly', async tx => (await request(tx.objectStore('legacy').get(key)) as string | undefined) ?? null),
    put: async (key, value) => { requireRevealAuthority(store); return transaction(await open(), 'readwrite', async tx => { await request(tx.objectStore('legacy').put(value, key)); }); },
    records: {
      read: async (key, knownRevision) => transaction(await open(), 'readonly', async tx => {
        const index = await request(tx.objectStore('index').get(key)) as JournalIndex | undefined;
        if (!index) return null;
        if (!Number.isSafeInteger(index.revision) || index.revision < 1 || index.count > PROGRESS_MAX_INTENTS || index.bytes > PROGRESS_MAX_BYTES) throw new RevealStorageRefusal('storage-invalid');
        if (index.revision === knownRevision) return { index };
        const rows = await new Promise<string[]>((resolve, reject) => {
          const rows: string[] = []; let bytes = 0;
          const cursor = tx.objectStore('attempts').openCursor(IDBKeyRange.bound([key, ''], [key, '\uffff']));
          cursor.onerror = () => reject(cursor.error);
          cursor.onsuccess = () => {
            const row = cursor.result; if (!row) { resolve(rows); return; }
            if (typeof row.value !== 'string' || row.value.length > PROGRESS_MAX_RECORD_BYTES) { reject(new RevealStorageRefusal('storage-invalid')); return; }
            const size = new TextEncoder().encode(row.value).length; bytes += size;
            if (size > PROGRESS_MAX_RECORD_BYTES || bytes > PROGRESS_MAX_BYTES || rows.length >= PROGRESS_MAX_INTENTS) { reject(new RevealStorageRefusal('storage-invalid')); return; }
            rows.push(row.value); row.continue();
          };
        });
        if (rows.length !== index.count) throw new RevealStorageRefusal('storage-invalid');
        return { index, records: rows };
      }),
      commit: async (key, previous, index, changes) => {
        requireRevealAuthority(store);
        return transaction(await open(), 'readwrite', async tx => {
        const current = await request(tx.objectStore('index').get(key)) as JournalIndex | undefined;
        if ((current?.revision ?? 0) !== previous) throw new RevealStorageRefusal('storage-conflict');
        if (index.revision !== previous + 1 || index.count > PROGRESS_MAX_INTENTS || index.bytes > PROGRESS_MAX_BYTES) throw new RevealStorageRefusal('storage-invalid');
        const writes = changes.map(c => request(tx.objectStore('attempts').put(c.text, [key, c.attempt])));
        writes.push(request(tx.objectStore('index').put(index, key)));
        await Promise.all(writes);
        });
      },
    },
  };
  return store;
}
