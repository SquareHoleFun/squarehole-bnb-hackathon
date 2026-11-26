/**
 * SH-192 (BOXSPEC-AUTOSAVE): this browser's copy of a box's reveal data (reveal-keep.ts) in IndexedDB, here an in-memory
 * IndexedDB (fake-indexeddb): written and read back, keyed by chain and token in any letter case, refused when it does
 * not parse, removed after the reveal, and absent (never thrown on a read) where the browser has no IndexedDB.
 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REVEAL_KEEP_DB, REVEAL_KEEP_FORMAT, RevealKeepError, forgetKept, keepReveal, keptKey, parseKept, readKept, type KeptReveal } from './reveal-keep';

const TOKEN = '0xAbCdEf0000000000000000000000000000000001';
const record = (patch: Partial<KeptReveal> = {}): KeptReveal => ({
  format: REVEAL_KEEP_FORMAT, key: keptKey(11155111, TOKEN), chainId: 11155111, token: TOKEN.toLowerCase() as KeptReveal['token'],
  creator: '0x00000000000000000000000000000000000000c1', specHash: `0x${'a1'.repeat(32)}`, revealRoot: `0x${'b2'.repeat(32)}`,
  artMode: 'open', n: 500, fileName: 'rentfree-reveal-data-v2.json', text: '{"format":"squarehole.boxspec/2"}\n', savedAt: 1_793_000_000_000, ...patch,
});

beforeEach(() => vi.stubGlobal('navigator', { storage: { persist: vi.fn(async () => true) } }));
afterEach(() => vi.unstubAllGlobals());

describe('SH-192 the reveal copy in IndexedDB', () => {
  it.each(['denied', 'missing', 'throws'] as const)('refuses nonpersistent storage: %s', async (mode) => {
    vi.stubGlobal('navigator', { storage: mode === 'missing' ? {} : { persist: async () => { if (mode === 'throws') throw new Error('private session'); return false; } } });
    await expect(keepReveal(record(), new IDBFactory())).rejects.toThrow('Storage persistence was not granted');
  });

  it('waits for the persistence grant after the committed write and read-back', async () => {
    let grant!: (answer: boolean) => void;
    const persist = vi.fn(() => new Promise<boolean>((resolve) => { grant = resolve; }));
    vi.stubGlobal('navigator', { storage: { persist } });
    let finished = false;
    const pending = keepReveal(record(), new IDBFactory()).then(() => { finished = true; });
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    expect(finished).toBe(false);
    grant(true);
    await pending;
    expect(finished).toBe(true);
  });

  it('writes, reads back by chain and token in any case, and removes it after the reveal', async () => {
    const idb = new IDBFactory();
    await keepReveal(record(), idb);
    expect(await readKept(11155111, TOKEN, idb)).toEqual(record());
    expect(await readKept(11155111, TOKEN.toLowerCase(), idb)).toEqual(record());
    // Another chain or token holds nothing.
    expect(await readKept(1, TOKEN, idb)).toBeNull();
    expect(await readKept(11155111, `0x${'0'.repeat(39)}2`, idb)).toBeNull();
    // A later write for the same box replaces it (one copy per box).
    await keepReveal(record({ text: '{"v":2}\n', savedAt: 1_793_000_000_001 }), idb);
    expect((await readKept(11155111, TOKEN, idb))?.text).toBe('{"v":2}\n');
    await forgetKept(11155111, TOKEN, idb);
    expect(await readKept(11155111, TOKEN, idb)).toBeNull();
  });

  it('keeps the copy in its own database, by name, across page loads (a new connection reads it)', async () => {
    const idb = new IDBFactory();
    await keepReveal(record(), idb);
    const names = (await idb.databases()).map((db) => db.name);
    expect(names).toEqual([REVEAL_KEEP_DB]);
    expect(REVEAL_KEEP_DB).toBe('sh.reveal.keep.v1');
    expect(await readKept(11155111, TOKEN, idb)).not.toBeNull();
  });

  it('refuses a copy that is not one, and reads a damaged stored value as none', async () => {
    const idb = new IDBFactory();
    await expect(keepReveal(record({ text: '' }), idb)).rejects.toBeInstanceOf(RevealKeepError);
    await expect(keepReveal(record({ key: 'other' }), idb)).rejects.toBeInstanceOf(RevealKeepError);
    await expect(keepReveal(record({ specHash: '0x12' }), idb)).rejects.toBeInstanceOf(RevealKeepError);
    expect(await readKept(11155111, TOKEN, idb)).toBeNull();
    for (const bad of [null, 'x', { ...record(), format: 'other' }, { ...record(), artMode: 'later' }, { ...record(), n: 0 }, { ...record(), token: 'me' }]) expect(parseKept(bad)).toBeNull();
    expect(parseKept({ ...record(), specHash: `0x${'A1'.repeat(32)}` })?.specHash).toBe(`0x${'a1'.repeat(32)}`);
  });

  it('without IndexedDB: a write is refused (Create then sends nothing), a read is none', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(keepReveal(record())).rejects.toBeInstanceOf(RevealKeepError);
    expect(await readKept(11155111, TOKEN)).toBeNull();
  });

  it('a write that does not read back the same text is refused', async () => {
    const idb = new IDBFactory();
    // A store that drops what it is given (as a full disk or a cleared site would): the put succeeds, the read finds none.
    const open = idb.open.bind(idb);
    const dropping = Object.assign(Object.create(idb) as IDBFactory, {
      open: (name: string, version?: number) => {
        const request = open(name, version);
        const success = () => {
          const db = request.result;
          const transaction = db.transaction.bind(db);
          db.transaction = ((stores: string | string[], mode?: IDBTransactionMode) => {
            const tx = transaction(stores, mode);
            const objectStore = tx.objectStore.bind(tx);
            tx.objectStore = (store: string) => {
              const os = objectStore(store);
              os.put = () => os.count() as unknown as IDBRequest<IDBValidKey>;
              return os;
            };
            return tx;
          }) as IDBDatabase['transaction'];
        };
        request.addEventListener('success', success);
        return request;
      },
    });
    await expect(keepReveal(record(), dropping)).rejects.toThrow('The copy did not read back');
  });
});
