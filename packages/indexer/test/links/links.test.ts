import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryLinks } from '../../src/links/memory-links';
import { PgLinks, LINKS_SCHEMA_SQL, LINKS_UPSERT_SQL, type LinksSql } from '../../src/links/pg-links';
import { LinksService, startLinks } from '../../src/links/links-service';
import { MemoryHistory } from '../../src/history/memory-history';
import { PgHistory } from '../../src/history/pg-history';
import { linksContract, row } from './links.contract';
import { CHAIN, TOKEN } from './fixture';
import { startTempPostgres, type TempPostgres } from '../history/pg-cluster';

/** Scripted Postgres wire: exact SQL/parameters are asserted; never opens a connection. */
function scriptedPg() {
  const rows = new Map<string, Record<string, unknown>>();
  const columns = ['chain_id', 'token', 'website', 'x', 'telegram', 'issued_at', 'signer', 'signer_kind', 'signature', 'verified_block'];
  const sql: LinksSql = {
    query: vi.fn(async (query: string, values: readonly unknown[] = []) => {
      if (query === LINKS_SCHEMA_SQL) return { rows: [] };
      if (query === LINKS_UPSERT_SQL) {
        expect(query).toMatch(/WHERE box_links\.issued_at < EXCLUDED\.issued_at\s+RETURNING \*/);
        expect(values).toHaveLength(10);
        expect(typeof values[5]).toBe('string'); expect(typeof values[9]).toBe('string');
        const key = `${values[0]}:${values[1]}`; const old = rows.get(key);
        if (old && BigInt(String(old['issued_at'])) >= BigInt(String(values[5]))) return { rows: [] };
        const saved = Object.fromEntries(columns.map((name, i) => [name, values[i]])); rows.set(key, saved);
        return { rows: [{ ...saved }] };
      }
      if (query === 'SELECT * FROM box_links WHERE chain_id = $1 AND token = $2') {
        const r = rows.get(`${values[0]}:${values[1]}`); return { rows: r ? [{ ...r }] : [] };
      }
      expect(query).toBe('SELECT * FROM box_links WHERE chain_id = $1');
      return { rows: [...rows.values()].filter(r => r['chain_id'] === values[0]).map(r => ({ ...r })) };
    }),
    end: vi.fn(async () => undefined),
  };
  return { sql, rows };
}

linksContract('memory', () => new MemoryLinks());
linksContract('Postgres / scripted SQL client (no network)', () => new PgLinks(scriptedPg().sql));

// The same contract on a real throwaway cluster (Unix socket, no TCP port) when SH_HISTORY_PG=1, as the history store
// does; each test starts from an empty box_links table.
describe.skipIf(process.env['SH_HISTORY_PG'] !== '1')('LINKS-SRV store on a throwaway Postgres cluster', () => {
  let cluster: TempPostgres | null = null;
  beforeAll(() => {
    cluster = startTempPostgres('squarehole_links_test');
    if (!cluster) throw new Error('SH_HISTORY_PG=1 but no Postgres binaries were found (SH_PG_BIN)');
  });
  afterAll(() => cluster?.stop());
  const options = () => {
    if (!cluster) throw new Error('no cluster');
    return { host: cluster.host, port: cluster.port, database: cluster.database, user: cluster.user };
  };
  linksContract('Postgres (real cluster)', () => {
    const store = new PgLinks(options());
    const init = store.init.bind(store);
    store.init = async () => {
      await init();
      const client = new pg.Client(options());
      await client.connect();
      await client.query('TRUNCATE box_links');
      await client.end();
    };
    return store;
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('LINKS-SRV storage lifecycle', () => {
  it.each(['off', 'memory'] as const)('history=%s starts the memory links store', async history => {
    const service = await startLinks({ history, pg: { host: undefined, port: undefined, database: 'unused', user: undefined } }, CHAIN);
    expect(service.store.kind).toBe('memory'); await service.stop();
  });
  it('has its own schema, no hide field, and history wipe/dump never touches the table', async () => {
    expect(LINKS_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS box_links');
    expect(LINKS_SCHEMA_SQL).toContain('PRIMARY KEY (chain_id, token)');
    expect(LINKS_SCHEMA_SQL).not.toMatch(/hidden|hide/i);
    const store = new MemoryLinks(); await store.put(row());
    const memoryHistory = new MemoryHistory(); await memoryHistory.wipe(CHAIN); await memoryHistory.dump(CHAIN);
    expect(await store.get(CHAIN, TOKEN)).toEqual(row());
    // Run the actual PgHistory wipe/dump through its pool with a scripted query interface.
    const history = new PgHistory({ host: 'unused.invalid', database: 'unused' });
    const queries: string[] = [];
    const query = vi.fn(async (text: string) => { queries.push(text); return { rows: [] }; });
    const pool = (history as unknown as { pool: { query: typeof query; connect(): Promise<{ query: typeof query; release(): void }> } }).pool;
    vi.spyOn(pool, 'query').mockImplementation(query);
    vi.spyOn(pool, 'connect').mockResolvedValue({ query, release: () => undefined });
    await history.wipe(CHAIN); await history.dump(CHAIN); await history.close();
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.join('\n')).not.toContain('box_links');
  });

  it('reloads a tombstone at 60 s and picks up a restored older row', async () => {
    vi.useFakeTimers();
    const pg = scriptedPg(); const store = new PgLinks(pg.sql); await store.put(row('300'));
    const service = new LinksService(store, CHAIN); await service.start();
    expect(service.get(TOKEN)).toEqual(row('300'));
    pg.rows.set(`${CHAIN}:${TOKEN}`, { ...pg.rows.get(`${CHAIN}:${TOKEN}`), website: '', x: '', telegram: '', signature: '0x' });
    await vi.advanceTimersByTimeAsync(59_999); expect(service.visible(TOKEN)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1); expect(service.visible(TOKEN)).toBeNull();
    expect(service.get(TOKEN)?.issuedAt).toBe('300');
    expect(await service.save(row('299'))).toEqual({ saved: false, row: { ...row('300'), website: '', x: '', telegram: '', signature: '0x' } });
    pg.rows.set(`${CHAIN}:${TOKEN}`, { ...pg.rows.get(`${CHAIN}:${TOKEN}`), issued_at: '200', website: 'https://restored.com' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.get(TOKEN)?.issuedAt).toBe('200');
    await service.stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it('out-of-order RETURNING completion cannot roll the map back', async () => {
    const store = new MemoryLinks(); const service = new LinksService(store, CHAIN); await service.start();
    const put = store.put.bind(store); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(store, 'put').mockImplementation(async value => { const result = await put(value); if (value.issuedAt === '100') await held; return result; });
    const old = service.save(row('100')); await service.save(row('200')); release(); await old;
    expect(service.get(TOKEN)).toEqual(row('200')); await service.stop();
  });

  it('a reload in flight cannot replace a save completed during that read', async () => {
    const store = new MemoryLinks(); const service = new LinksService(store, CHAIN); await service.start();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(store, 'list').mockImplementationOnce(async () => { await held; return []; });
    const reload = service.reload(); await service.save(row()); release(); await reload;
    expect(service.get(TOKEN)).toEqual(row()); await service.stop();
  });
});


describe('LINKS-SRV fix round 1 database bounds', () => {
  it('configures connection, client query and server statement timeouts on the actual pool', async () => {
    const store = new PgLinks({ host: 'unused.invalid', database: 'unused' });
    const pool = (store as unknown as { pool: pg.Pool & { options: Record<string, unknown> } }).pool;
    expect(pool.options).toMatchObject({ max: 4, connectionTimeoutMillis: 2000, query_timeout: 4000, statement_timeout: 3000 });
    await store.close();
  });

  it.each(['init', 'get', 'list', 'put', 'close'] as const)('a stalled %s completes with a fixed unavailable error within 5 s', async operation => {
    vi.useFakeTimers(); const sql: LinksSql = {
      query: vi.fn(() => new Promise<{ rows: Record<string, unknown>[] }>(() => undefined)), end: vi.fn(() => new Promise<void>(() => undefined)),
    };
    const store = new PgLinks(sql);
    const pending = operation === 'put' ? store.put(row()) : operation === 'get' ? store.get(CHAIN, TOKEN)
      : operation === 'list' ? store.list(CHAIN) : store[operation]();
    let result: unknown = 'pending'; void pending.then(() => { result = 'resolved'; }, error => { result = error; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(result).toMatchObject({ name: 'LinksUnavailableError', message: 'links store unavailable' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds admission to eight unfinished queries, including queries whose caller has timed out', async () => {
    vi.useFakeTimers(); let release!: (result: { rows: Record<string, unknown>[] }) => void;
    const held = new Promise<{ rows: Record<string, unknown>[] }>(resolve => { release = resolve; });
    const sql: LinksSql = { query: vi.fn(() => held), end: vi.fn(async () => undefined) };
    const store = new PgLinks(sql); const pending = Array.from({ length: 8 }, () => store.list(CHAIN).catch(error => error));
    let overflow: unknown = 'pending'; void store.list(CHAIN).catch(error => { overflow = error; });
    await vi.advanceTimersByTimeAsync(0);
    expect(overflow).toMatchObject({ name: 'LinksUnavailableError' }); expect(sql.query).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 8 }, () => expect.objectContaining({ name: 'LinksUnavailableError' })));
    await expect(store.list(CHAIN)).rejects.toMatchObject({ name: 'LinksUnavailableError' });
    expect(sql.query).toHaveBeenCalledTimes(8);
    release({ rows: [] }); await vi.advanceTimersByTimeAsync(0);
    await expect(store.list(CHAIN)).resolves.toEqual([]); await store.close();
  });

  it.each(['error', 'timeout'])('a reload %s logs a fixed warning, preserves the map, clears its flag and retries next minute', async mode => {
    vi.useFakeTimers(); const pg = scriptedPg(); const service = new LinksService(new PgLinks(pg.sql), CHAIN);
    await pg.sql.query(LINKS_UPSERT_SQL, Object.values({ chain: CHAIN, token: TOKEN, website: 'https://restored.com', x: '', telegram: '', time: '100', signer: row().signer, kind: 'eoa', signature: '0x', block: '123' }));
    await service.start(); const original = service.get(TOKEN);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let release: ((value: { rows: Record<string, unknown>[] }) => void) | undefined;
    vi.mocked(pg.sql.query).mockImplementationOnce(() => mode === 'timeout' ? new Promise(resolve => { release = resolve; })
      : Promise.reject(new Error('private link and signature')));
    await vi.advanceTimersByTimeAsync(65_000);
    expect(log.mock.calls).toEqual([['[links] reload unavailable']]); expect(service.get(TOKEN)).toEqual(original);
    pg.rows.clear();
    await vi.advanceTimersByTimeAsync(55_000); expect(service.get(TOKEN)).toBeNull();
    // Late completion of the expired read cannot publish stale data.
    release?.({ rows: [{ chain_id: CHAIN, token: TOKEN, issued_at: '999', signer_kind: 'eoa' }] });
    await vi.advanceTimersByTimeAsync(0); expect(service.get(TOKEN)).toBeNull();
    await service.stop(); expect(vi.getTimerCount()).toBe(0);
  });
});
