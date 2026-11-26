import { authorizeRevealTestTarget } from './reveal-test-seam.test-support';
// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { indexedDBRevealStore as rawStore, RevealStorageRefusal } from './reveal-indexeddb';
import { readRevealProgress, saveRevealIntent, journalRevision } from './reveal-items-store';
import { addr, digest, must } from './reveal-items.test-support';
afterEach(() => vi.unstubAllGlobals());
const intent = { attempt: 'a', ids: ['1'], account: addr(50), createdAt: 0, capWei: '123', status: 'intent' as const };
it('af2 B resolves only after committed records and atomic index are visible in another connection', async () => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange); const factory = new IDBFactory();
  const a = indexedDBRevealStore(factory, 'shared'), b = indexedDBRevealStore(factory, 'shared');
  const p = await readRevealProgress(a, 'key', digest(1));
  await saveRevealIntent(a, 'key', p, intent);
  const read = await readRevealProgress(b, 'key', digest(1)); expect(read.intents).toEqual([intent]); expect(journalRevision(read)).toBe(1);
  await saveRevealIntent(b, 'key', read, { ...intent, status: 'unknown' });
  expect((await readRevealProgress(a, 'key', digest(1))).intents[0]?.status).toBe('unknown');
});
it('af2 B aborted and stale writes cannot land later over newer history', async () => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange); const store = indexedDBRevealStore(new IDBFactory(), 'abort');
  const p = await readRevealProgress(store, 'key', digest(1));
  const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const result = put.call(this, value, key); if (this.name === 'index') this.transaction.abort(); return result;
  });
  await expect(saveRevealIntent(store, 'key', p, intent)).rejects.toBeInstanceOf(RevealStorageRefusal);
  spy.mockRestore(); expect((await readRevealProgress(store, 'key', digest(1))).intents).toEqual([]);
  await saveRevealIntent(store, 'key', p, { ...intent, attempt: 'new' });
  await expect(must(store.records).commit('key', 0, { revision: 1, specHash: digest(1), count: 1, bytes: 1 }, [{ attempt: 'a', text: 'old' }])).rejects.toMatchObject({ reason: 'storage-conflict' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect((await readRevealProgress(store, 'key', digest(1))).intents.map(i => i.attempt)).toEqual(['new']);
});
it('af2 B unavailable and quota storage give typed refusals', async () => {
  vi.stubGlobal('indexedDB', undefined);
  await expect(indexedDBRevealStore().get('key')).rejects.toMatchObject({ reason: 'storage-unavailable' });
  vi.stubGlobal('IDBKeyRange', IDBKeyRange); const store = indexedDBRevealStore(new IDBFactory(), 'full');
  const p = await readRevealProgress(store, 'key', digest(1));
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
  try { await expect(saveRevealIntent(store, 'key', p, intent)).rejects.toMatchObject({ reason: 'storage-full' }); }
  finally { spy.mockRestore(); }
  expect((await readRevealProgress(store, 'key', digest(1))).intents).toHaveLength(0);
});

vi.mock('./reveal-test-seam', async () => import('./reveal-test-seam.test-support'));

const indexedDBRevealStore = (...args: Parameters<typeof rawStore>) => authorizeRevealTestTarget(rawStore(...args));
