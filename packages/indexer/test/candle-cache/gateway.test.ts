import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryHistory } from '../../src/history/memory-history';
import { required, expanded, gateway, recorded, steps, type Recorded } from './fixture';

let f: Recorded;
beforeAll(async () => { f = await recorded(); });
async function setup() {
  const store = new MemoryHistory();
  for (const block of f.blocks) await store.writeBlock(block);
  return { store, ...gateway(f, store) };
}

describe('cached HTTP responses without a listener', () => {
  it.each(['v1/boxes', 'v2/boxes'])('CC-1/2: %s accepts six steps and rejects malformed intervals/limits before reading', async route => {
    const { send, store } = await setup(); const read = vi.spyOn(store, 'candles');
    for (const step of steps) expect((await send('candles', `?interval=${step}&limit=1`, undefined, route)).status).toBe(200);
    const calls = read.mock.calls.length;
    for (const limit of ['0', '1001', '-1', '1.5', 'NaN', 'Infinity', '', '1e2', '0x10', '+2', ' 2 ', '2x']) {
      expect((await send('candles', `?limit=${encodeURIComponent(limit)}`, undefined, route)).status, limit).toBe(400);
    }
    for (const interval of ['5m', '', '12', '1H']) {
      const res = await send('candles', `?interval=${interval}`, undefined, route);
      expect(res.status).toBe(400); for (const step of steps) expect(res.json()['error']).toContain(step);
    }
    expect(read).toHaveBeenCalledTimes(calls);
  });

  it('CC-3: 200 simultaneous charts share one store read; a trade and undo each require exactly one more', async () => {
    const { send, store } = await setup(); const read = vi.spyOn(store, 'candles');
    const requests = await Promise.all(Array.from({ length: 200 }, (_, i) => send('candles', i % 2 ? '?limit=01000&interval=1h' : '')));
    expect(read).toHaveBeenCalledTimes(1);
    expect(new Set(requests.map(r => r.body)).size).toBe(1);
    expect(required(requests[0]).headers['cache-control']).toBe('public, max-age=1');
    const next = expanded(f, 2); await store.writeBlock(next);
    const changed = await send(); expect(read).toHaveBeenCalledTimes(2); expect(changed.json()['candles']).not.toEqual(required(requests[0]).json()['candles']);
    await store.undoAbove(f.indexer.chainId, required(required(next.boxes[0]).trades[0]).block - 1n);
    const undone = await send(); expect(read).toHaveBeenCalledTimes(3); expect(undone.json()['candles']).toEqual(required(requests[0]).json()['candles']);
    await send(); expect(read).toHaveBeenCalledTimes(3);
  });

  it('CC-3: a read spanning a commit cannot serve or overwrite the new version', async () => {
    const { send, store } = await setup(); const original = store.candles.bind(store);
    let release!: () => void; let entered!: () => void;
    const held = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
    const read = vi.spyOn(store, 'candles').mockImplementationOnce(async (...args) => {
      const old = await original(...args); entered(); await held; return old;
    });
    const oldRequest = send(); await started;
    await store.writeBlock(expanded(f, 3));
    const fresh = await send(); release();
    expect((await oldRequest).json()).toEqual(fresh.json());
    expect((await send()).json()).toEqual(fresh.json()); expect(read).toHaveBeenCalledTimes(2);
  });

  it('CC-3: failures and absent answers are not cached', async () => {
    const { send, store, source } = await setup(); const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const read = vi.spyOn(store, 'candles').mockRejectedValueOnce(new Error('read failed'));
      expect((await send()).status).toBe(500); expect((await send()).status).toBe(200); expect(read).toHaveBeenCalledTimes(2);
      const noPage = vi.spyOn(source, 'activity').mockResolvedValueOnce(null);
      expect((await send('activity')).status).toBe(404); expect((await send('activity')).status).toBe(200); expect(noPage).toHaveBeenCalledTimes(2);
    } finally { log.mockRestore(); }
  });

  it('CC-3: candles keep the data ETag across heads, accept weak/strong lists, and replace a stale ETag', async () => {
    const { send, store } = await setup(); const read = vi.spyOn(store, 'candles'); const first = await send();
    const tag = required(first.headers['etag']); expect(tag).toMatch(/^W\/"[a-f0-9]+"$/);
    const head = required(f.indexer.asOf()); const asOf = vi.spyOn(f.indexer, 'asOf').mockReturnValue({ ...head, block: '999', hash: `0x${'ab'.repeat(32)}` });
    try {
      const fresh = await send(); expect(fresh.headers['etag']).toBe(tag); expect(fresh.json()['asOf']).toMatchObject({ block: '999' }); expect(read).toHaveBeenCalledTimes(1);
      // A committed empty block invalidates data reads but leaves the chart validator unchanged.
      const b = expanded(f, 2); await store.writeBlock({ ...b, boxes: [] });
      expect((await send()).headers['etag']).toBe(tag); expect(read).toHaveBeenCalledTimes(2);
      for (const condition of [tag, tag.slice(2), `"stale", ${tag}`, `W/"stale", ${tag.slice(2)}`, '*']) {
        const unchanged = await send('candles', '', condition);
        expect(unchanged.status).toBe(304); expect(unchanged.body).toBe(''); expect(unchanged.headers['etag']).toBe(tag);
        expect(unchanged.headers['cache-control']).toBe('public, max-age=1'); expect(unchanged.headers['access-control-allow-origin']).toBe('*');
        expect(unchanged.headers['access-control-expose-headers']).toContain('ETag');
      }
      await store.writeBlock({ ...b, block: { ...b.block, number: b.block.number + 1n } });
      const changed = await send('candles', '', tag); expect(changed.status).toBe(200); expect(changed.headers['etag']).not.toBe(tag); expect(changed.json()['candles']).not.toEqual(first.json()['candles']);
    } finally { asOf.mockRestore(); }
  });

  it.each(['v1/boxes', 'v2/boxes'])('CC-3: %s activity shares reads and refreshes asOf on cache hits, with no ETag', async route => {
    const { send, store } = await setup(); const read = vi.spyOn(store, 'activityPage');
    const pages = await Promise.all(Array.from({ length: 200 }, () => send('activity', '?limit=2', undefined, route)));
    expect(read).toHaveBeenCalledTimes(1);
    const first = required(pages[0]); expect(first.headers['etag']).toBeUndefined(); expect(first.headers['cache-control']).toBe('public, max-age=1');
    const asOf = vi.spyOn(f.indexer, 'asOf').mockReturnValue({ ...required(f.indexer.asOf()), block: '999' });
    try {
      const next = await send('activity', '?limit=02', '"any"', route);
      expect(next.status).toBe(200); expect(next.json()['asOf']).toMatchObject({ block: '999' }); expect(next.json()['items']).toEqual(first.json()['items']); expect(read).toHaveBeenCalledTimes(1);
      await store.writeBlock(expanded(f, 2));
      expect((await send('activity', '?limit=2', undefined, route)).json()['items']).not.toEqual(first.json()['items']); expect(read).toHaveBeenCalledTimes(2);
    } finally { asOf.mockRestore(); }
  });

  it('CC-3: no-history cache follows the applied head including same-height replacement hashes', async () => {
    const { send, source } = gateway(f, null); const read = vi.spyOn(source, 'candles');
    await send(); await send(); expect(read).toHaveBeenCalledTimes(1);
    const head = required(f.indexer.head()); const changed = vi.spyOn(f.indexer, 'head').mockReturnValue({ ...head, hash: `0x${'ac'.repeat(32)}` });
    try { await send(); await send(); expect(read).toHaveBeenCalledTimes(2); } finally { changed.mockRestore(); }
  });
});
