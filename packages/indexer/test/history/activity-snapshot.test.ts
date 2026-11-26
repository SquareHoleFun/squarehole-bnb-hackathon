import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgHistory } from '../../src/history/pg-history';

const token = `0x${'ab'.repeat(20)}`;
const hash = (branch: string) => `0x${branch.repeat(64)}`;
const trade = (branch: string) => ({ block: '12', log_index: 1, block_hash: hash(branch), tx_hash: hash(branch), ts: '100', token,
  side: 'buy', route: 'other', q_raw: '10', t_raw: '20', fee_q: '1', fee_t: '0', tax_q: '0', trader: '', sqrt: '1000', tick: 0 });
const event = (branch: string) => ({ block: '12', log_index: 2, block_hash: hash(branch), tx_hash: hash(branch), ts: '100', kind: 'v2_event', data: { source: 'token', event: 'Transfer', amount: '20' } });
afterEach(() => vi.restoreAllMocks());

/** Schedule a committed writer rollback/replacement after the first SELECT; model READ COMMITTED vs repeatable snapshots. */
function database(fail = false, existingTrader = '') {
  let canonical = 'a'; let snapshot: string | null = null; let repeatable = false;
  let reorgs = 0;
  const commands: string[] = [];
  const query = vi.fn(async (sql: string) => {
    commands.push(sql);
    if (sql.startsWith('BEGIN')) { repeatable = /REPEATABLE READ/.test(sql); return { rows: [] }; }
    if (!sql.startsWith('SELECT')) return { rows: [] };
    if (repeatable) snapshot ??= canonical;
    const branch = snapshot ?? canonical;
    if (sql.includes('FROM transfers')) return { rows: [{ tx_hash: hash('a'), from_address: token,
      to_address: `0x${(branch === 'a' ? '11' : '22').repeat(20)}`, amount: '20' }] };
    if (sql.includes('FROM trades')) {
      canonical = 'b'; reorgs++; // undoAbove + replacement writeBlock committed before the other SELECT
      return { rows: [{ ...trade(branch), trader: existingTrader }] };
    }
    if (fail) throw new Error('read failed');
    return { rows: [event(branch)] };
  });
  const release = vi.fn(); const client = { query, release };
  const connect = vi.spyOn(pg.Pool.prototype, 'connect').mockResolvedValue(client as never);
  vi.spyOn(pg.Pool.prototype, 'query').mockImplementation(query as never);
  const store = new PgHistory({ host: undefined, database: 'unused' });
  return { store, commands, release, connect, reorgs: () => reorgs };
}

describe('ACT-4: one database snapshot per activity page', () => {
  it('fills a legacy v2 trader from the whole transaction in that same snapshot, even on a trade-only page', async () => {
    const db = database();
    const page = await db.store.activityPage(1, token, { kind: 'trade', before: null, limit: 1, v2Contracts: [token] });
    expect(page[0]).toMatchObject({ trader: `0x${'11'.repeat(20)}`, blockHash: hash('a') });
    expect(db.release).toHaveBeenCalledTimes(1);
  });

  it('keeps an existing launch buyer, lowercased, without a transfer query', async () => {
    const db = database(false, `0x${'AB'.repeat(20)}`);
    const page = await db.store.activityPage(1, token, { kind: 'trade', before: null, limit: 1, v2Contracts: [token] });
    expect(page[0]).toMatchObject({ trader: token });
    expect(db.commands.some(sql => sql.includes('FROM transfers'))).toBe(false);
  });

  it('keeps a legacy trader null when only excluded contracts move T', async () => {
    const db = database();
    const page = await db.store.activityPage(1, token, { kind: 'trade', before: null, limit: 1, v2Contracts: [token, `0x${'11'.repeat(20)}`] });
    expect(page[0]).toMatchObject({ trader: null });
  });

  it('a reorg committed between trade and event reads cannot mix branches', async () => {
    const db = database();
    const page = await db.store.activityPage(1, token, { kind: null, before: null, limit: 10 });
    expect(db.reorgs()).toBe(1);
    expect(page.map(item => item.blockHash)).toEqual([hash('a'), hash('a')]);
    expect(page.map(item => item.id)).toEqual(['12-2', '12-1']);
    expect(db.connect).toHaveBeenCalledTimes(1); expect(db.release).toHaveBeenCalledTimes(1);
    expect(db.commands.at(-1)).toBe('COMMIT');
  });

  it('rolls back and releases the connection if a page query fails', async () => {
    const db = database(true);
    await expect(db.store.activityPage(1, token, { kind: null, before: null, limit: 10 })).rejects.toThrow('read failed');
    expect(db.commands.at(-1)).toBe('ROLLBACK'); expect(db.release).toHaveBeenCalledTimes(1);
  });

  it.each(['trade', 'v2_event'])('also releases a filtered %s page', async kind => {
    const db = database();
    const page = await db.store.activityPage(1, token, { kind, before: '13-9', limit: 1 });
    expect(page).toHaveLength(1); expect(page[0]?.kind).toBe(kind);
    expect(db.commands.filter(sql => sql.startsWith('SELECT'))).toHaveLength(1);
    expect(db.release).toHaveBeenCalledTimes(1);
  });
});
