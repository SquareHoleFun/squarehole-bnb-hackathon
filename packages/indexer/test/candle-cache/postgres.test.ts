import { beforeAll, describe, expect, it, vi } from 'vitest';
import { candlesFromTrades } from '../../src/core/candles';
import { PgHistory } from '../../src/history/pg-history';
import { required, expanded, recorded, type Recorded } from './fixture';

const database = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.mock('pg', () => ({ default: { Pool: class {
  query = database.query;
  connect = async () => ({ query: database.query, release: database.release });
  end = async () => undefined;
} } }));
let f: Recorded;
beforeAll(async () => { f = await recorded(); });
function store() { database.query.mockReset(); return new PgHistory({ host: undefined, database: 'test' }); }

describe('CC-1/3: Postgres query and commit boundaries (offline client)', () => {
  it('12s uses numeric block/log keyset windows, includes every trade of the oldest bucket, and has a read snapshot', async () => {
    const history = store(); const template = required(required(expanded(f, 1).boxes[0]).trades[0]);
    // More than one SQL page inside a single 12-second bucket, across several blocks. Older bucket must be excluded.
    const trades = Array.from({ length: 1030 }, (_, i) => ({ ...template, block: BigInt(9 + Math.floor(i / 4)), logIndex: i % 4,
      timestamp: i < 2 ? 599n : 600n, qRaw: 10n ** 35n + BigInt(i), sqrtPriceX96After: 10n ** 25n + BigInt(i % 19) }));
    const asked: unknown[][] = [];
    database.query.mockImplementation(async (sql: string, args: unknown[] = []) => {
      if (!sql.includes('FROM trades')) return { rows: [] };
      expect(sql).toContain('ORDER BY trades.block DESC, trades.log_index DESC');
      expect(sql).not.toMatch(/AND ts|ORDER BY ts/); expect(sql).toContain('LIMIT 512');
      asked.push(args);
      const page = trades.filter(t => args.length < 3 || t.block < BigInt(String(args[2])) || (t.block === BigInt(String(args[2])) && t.logIndex < Number(args[3])))
        .reverse().slice(0, 512);
      if (args.length > 2) expect(sql).toContain('(block, log_index) < ($3::numeric, $4::integer)');
      return { rows: page.map(t => ({ block: t.block.toString(), log_index: t.logIndex, ts: t.timestamp.toString(), route: t.route, q_raw: t.qRaw.toString(), sqrt: t.sqrtPriceX96After.toString() })) };
    });
    expect(await history.candles(1, f.token, '12s', 1)).toEqual(candlesFromTrades(trades, '12s').slice(-1));
    expect(asked).toHaveLength(3); expect(required(database.query.mock.calls[0])[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(required(database.query.mock.calls.at(-1))[0]).toBe('COMMIT'); expect(history.version).toBe(0n);
  });

  it.each(['10m', '10h'] as const)('%s limits the descending numeric base scan, preserving a partial newest bucket and sparse history', async interval => {
    const history = store();
    const template = required(required(expanded(f, 1).boxes[0]).trades[0]);
    const baseSize = interval === '10m' ? 60n : 3600n;
    const trades = Array.from({ length: 66 }, (_, i) => ({ ...template, block: BigInt(i), timestamp: BigInt(i < 30 ? i : i + 30) * baseSize,
      sqrtPriceX96After: 2n ** 120n + BigInt(i % 17), qRaw: 10n ** 30n + BigInt(i) }));
    const base = candlesFromTrades(trades, interval === '10m' ? '1m' : '1h');
    database.query.mockImplementation(async (sql: string, args: unknown[]) => {
      expect(sql).toContain('ORDER BY candles.start DESC LIMIT $4');
      expect(args[2]).toBe(interval === '10m' ? '1m' : '1h');
      const selected = base.slice(-Number(args[3])).reverse();
      return { rows: selected.map(c => ({ start: c.start, o: c.openSqrtPriceX96, h: c.highSqrtPriceX96, l: c.lowSqrtPriceX96, c: c.closeSqrtPriceX96, v: c.volumeQ, trades: c.trades })) };
    });
    for (const limit of [1, 2, 3, 10]) expect(await history.candles(1, f.token, interval, limit)).toEqual(candlesFromTrades(trades, interval).slice(-limit));
  });

  it('bumps only after COMMIT resolves, and never for a rolled back write', async () => {
    const history = store(); let commit!: () => void; let started!: () => void;
    const pending = new Promise<void>(r => { commit = r; }); const entered = new Promise<void>(r => { started = r; });
    database.query.mockImplementation(async (sql: string) => { if (sql === 'COMMIT') { started(); await pending; } return { rows: [] }; });
    const writing = history.finishReplay(1, []); await entered; expect(history.version).toBe(0n);
    commit(); await writing; expect(history.version).toBe(1n);
    database.query.mockImplementation(async (sql: string) => { if (sql.startsWith('DELETE')) throw new Error('write refused'); return { rows: [] }; });
    await expect(history.wipe(1)).rejects.toThrow('write refused'); expect(history.version).toBe(1n);
    expect(required(database.query.mock.calls.at(-1))[0]).toBe('ROLLBACK');
  });
});
