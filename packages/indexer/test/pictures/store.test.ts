import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryPictureCopies, PgPictureCopies, PICTURES_SCHEMA_SQL, type PictureSql } from '../../src/pictures/store';
import { PictureCopiesService } from '../../src/pictures/service';
import { GRAPHQL_ENDPOINTS } from '../../src/pictures/discovery';
import { startTempPostgres, type TempPostgres } from '../history/pg-cluster';

const hash = 'ab'.repeat(32); const id = 'a'.repeat(43); const other = 'b'.repeat(43);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it('memory stores only valid hash/id pairs and keeps the first verified id', async () => {
  const store = new MemoryPictureCopies(); await store.init();
  expect(await store.get(hash)).toBeNull(); expect(await store.put(hash, id)).toBe(id);
  expect(await store.put(hash, other)).toBe(id); expect(await store.get(hash)).toBe(id);
  await expect(store.put(hash, '../bad')).rejects.toThrow(); await expect(store.put('bytes', id)).rejects.toThrow();
  await store.close();
});

it('SQL parameters and schema contain only the hash and id, never byte buffers or URLs', async () => {
  const sql: PictureSql = { query: vi.fn(async () => ({ rows: [{ sha256: hash, arweave_id: id }] })), end: vi.fn(async () => undefined) };
  const store = new PgPictureCopies(sql); await store.init();
  expect(await store.put(hash, id)).toBe(id); expect(await store.get(hash)).toBe(id); await store.close();
  expect(vi.mocked(sql.query).mock.calls.map(call => call[1])).toEqual([undefined, [hash, id], [hash]]);
  expect(PICTURES_SCHEMA_SQL).not.toMatch(/bytea|json|blob|url|content/i);
});

it('bounds stalled SQL calls and keeps admission occupied until the driver settles', async () => {
  vi.useFakeTimers();
  let resolve!: (value: { rows: Record<string, unknown>[] }) => void;
  const held = new Promise<{ rows: Record<string, unknown>[] }>(done => { resolve = done; });
  const sql: PictureSql = { query: vi.fn(() => held), end: vi.fn(async () => undefined) };
  const store = new PgPictureCopies(sql);
  const pending = Array.from({ length: 4 }, () => store.get(hash).catch(error => error));
  await expect(store.get(hash)).rejects.toThrow('picture store busy');
  await vi.advanceTimersByTimeAsync(5000);
  expect(await Promise.all(pending)).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ message: 'picture store unavailable' })));
  await expect(store.get(hash)).rejects.toThrow('picture store busy');
  expect(sql.query).toHaveBeenCalledTimes(4);
  resolve({ rows: [] }); await vi.advanceTimersByTimeAsync(0);
  await expect(store.get(hash)).resolves.toBeNull(); await store.close();
  expect(vi.getTimerCount()).toBe(0);
});

it('contains a released idle client error in the owned pg.Pool and reconnects for picture discovery', async () => {
  const rows = new Map<string, string>(); const clients: ConnectedClient[] = []; const pools: pg.Pool[] = [];
  // Keep the real pool's acquire/release/error/reconnect lifecycle; only the wire client is fake.
  class ConnectedClient extends EventEmitter {
    _queryable = true;
    _ending = false;
    constructor() { super(); clients.push(this); }
    connect(callback: () => void): void { queueMicrotask(callback); }
    query(sql: string, values: string[] | undefined, callback: (error: null, result: { rows: Record<string, unknown>[] }) => void): void {
      const key = values?.[0] ?? '';
      if (sql.startsWith('INSERT') && !rows.has(key)) rows.set(key, values?.[1] ?? '');
      queueMicrotask(() => callback(null, { rows: rows.has(key) ? [{ arweave_id: rows.get(key) }] : [] }));
    }
    end(callback: () => void): void { this._ending = true; queueMicrotask(callback); }
  }
  const Pool = pg.Pool;
  vi.spyOn(pg, 'Pool').mockImplementation(class extends Pool {
    constructor(options?: pg.PoolConfig) {
      super({ ...options, Client: ConnectedClient as unknown as pg.PoolConfig['Client'] }); pools.push(this);
    }
  });
  const bytes = 'picture discovered after idle database disconnect';
  const committed = createHash('sha256').update(bytes).digest('hex');
  const spec = { coverSha256: committed, collectionCoverSha256: '' };
  let now = 0;
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('gateway unavailable'));
  const store = new PgPictureCopies({ host: undefined, database: 'unused' });
  const service = new PictureCopiesService(store, { fetch: fetcher, now: () => now });
  try {
    await service.run([spec]); expect(service.visible(spec)).toEqual({});
    expect(clients).toHaveLength(1); expect(pools[0]?.idleCount).toBe(1);
    const released = clients[0]; if (!released) throw new Error('no released client');
    expect(() => released.emit('error', new Error('idle connection terminated'))).not.toThrow();
    expect(released._ending).toBe(true); expect(pools[0]?.totalCount).toBe(0);
    expect(service.visible(spec)).toEqual({});
    fetcher.mockImplementation(async input => GRAPHQL_ENDPOINTS.includes(String(input))
      ? Response.json({ data: { transactions: { edges: [{ node: { id, block: { height: 1 } } }] } } }) : new Response(bytes));
    now = 60_000; await service.run([spec]);
    expect(clients).toHaveLength(2); expect(pools[0]?.idleCount).toBe(1);
    expect(service.visible(spec)).toEqual({ pictureCopies: { logo: { arweaveId: id } } });
    expect(await store.get(committed)).toBe(id); expect([...rows]).toEqual([[committed, id]]);
  } finally { await service.stop(); }
  expect(pools[0]?.totalCount).toBe(0);
});

describe.skipIf(process.env.SH_HISTORY_PG !== '1')('real Postgres picture copy persistence', () => {
  let cluster: TempPostgres | null = null;
  beforeAll(() => { cluster = startTempPostgres('squarehole_pictures_test'); if (!cluster) throw new Error('Postgres binaries unavailable'); });
  afterAll(() => cluster?.stop());
  it('a fresh connection/service keeps hinted ids and the database contains exactly two text columns', async () => {
    if (!cluster) throw new Error('no cluster');
    const options = { host: cluster.host, port: cluster.port, database: cluster.database, user: cluster.user };
    const bytes = 'a hinted picture persisted through a database reconnect';
    const committed = createHash('sha256').update(bytes).digest('hex');
    const first = new PictureCopiesService(new PgPictureCopies(options), { fetch: vi.fn(async () => new Response(bytes)) });
    expect(await first.hint(committed, id, () => true)).toEqual({ arweaveId: id });
    await first.stop();
    const second = new PgPictureCopies(options);
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('restart must not fetch'); });
    const service = new PictureCopiesService(second, { fetch: fetcher });
    const spec = { coverSha256: `0x${committed}`, collectionCoverSha256: '' }; await service.run([spec]);
    expect(service.visible(spec)).toEqual({ pictureCopies: { logo: { arweaveId: id } } });
    expect(fetcher).not.toHaveBeenCalled(); expect(await second.put(committed, other)).toBe(id);
    await service.run([]); await service.run([spec]);
    expect(service.visible(spec)).toHaveProperty('pictureCopies.logo.arweaveId', id);
    const client = new pg.Client(options); await client.connect();
    try {
      expect((await client.query('SELECT * FROM picture_copies')).rows).toEqual([{ sha256: committed, arweave_id: id }]);
      expect((await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'picture_copies' ORDER BY ordinal_position")).rows)
        .toEqual([{ column_name: 'sha256', data_type: 'text' }, { column_name: 'arweave_id', data_type: 'text' }]);
    } finally { await client.end(); await service.stop(); }
  });
});
