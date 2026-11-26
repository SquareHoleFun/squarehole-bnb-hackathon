/**
 * The history store on Postgres (S10a § 4; chain-data-platform § 2.5): amounts as numeric(78,0), √P as an integer, one
 * transaction per block with the cursor, `ON CONFLICT DO NOTHING` on (chain, block, log index[, item]). Server only:
 * `pg` (pinned 8.23.0) is never in the web bundle. The same rules as memory-history.ts (one contract test).
 */
import pg from 'pg';
import type { CoreBlockResult } from '../core/chain-indexer';
import { CANDLE_INTERVALS, CANDLE_LIMIT, type ActivityPage, type Candle, type CandleInterval } from '../core/core-gateway';
import { aggregateCandles, candlesFromTrades, INTERVAL_SECONDS } from '../core/candles';
import { candlesOfRows, itemRowsFor, line, rowsOfBlock, tradeOfRow, type ItemRows, type TradeRow, type TransferRow } from './rows';
import { PICTURE_HIDDEN_PREFIX, type HistoryDump, type HistoryStore, type PictureHiddenBox } from './types';
import type { HistoryActivityOptions } from './types';
import { missingTraders, withTradersV2 } from './activity-traders';

export const HISTORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chain_blocks (
  chain_id integer NOT NULL, number numeric(20,0) NOT NULL, hash text NOT NULL, parent_hash text NOT NULL, ts numeric(20,0) NOT NULL,
  PRIMARY KEY (chain_id, number));
CREATE TABLE IF NOT EXISTS boxes (
  chain_id integer NOT NULL, registry text NOT NULL, box_id numeric(78,0) NOT NULL, token text NOT NULL, creation_block numeric(20,0) NOT NULL,
  shown boolean NOT NULL, reason text NOT NULL, row_json text NOT NULL,
  PRIMARY KEY (chain_id, registry, box_id));
CREATE TABLE IF NOT EXISTS trades (
  chain_id integer NOT NULL, block numeric(20,0) NOT NULL, log_index integer NOT NULL, block_hash text NOT NULL, tx_hash text NOT NULL,
  ts numeric(20,0) NOT NULL, token text NOT NULL, side text NOT NULL, route text NOT NULL, q_raw numeric(78,0) NOT NULL, t_raw numeric(78,0) NOT NULL,
  fee_q numeric(78,0) NOT NULL, fee_t numeric(78,0) NOT NULL, tax_q numeric(78,0) NOT NULL, trader text NOT NULL, sqrt_price_x96 numeric(78,0) NOT NULL,
  tick integer NOT NULL,
  PRIMARY KEY (chain_id, block, log_index));
CREATE INDEX IF NOT EXISTS trades_by_token ON trades (chain_id, token, block DESC, log_index DESC);
CREATE TABLE IF NOT EXISTS activity (
  chain_id integer NOT NULL, block numeric(20,0) NOT NULL, log_index integer NOT NULL, block_hash text NOT NULL, tx_hash text NOT NULL,
  ts numeric(20,0) NOT NULL, token text NOT NULL, kind text NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY (chain_id, block, log_index));
CREATE INDEX IF NOT EXISTS activity_by_token ON activity (chain_id, token, block DESC, log_index DESC);
CREATE TABLE IF NOT EXISTS batches (
  chain_id integer NOT NULL, block numeric(20,0) NOT NULL, log_index integer NOT NULL, tx_hash text NOT NULL, token text NOT NULL, amounts jsonb NOT NULL,
  PRIMARY KEY (chain_id, block, log_index));
CREATE TABLE IF NOT EXISTS depth_events (
  chain_id integer NOT NULL, block numeric(20,0) NOT NULL, log_index integer NOT NULL, tx_hash text NOT NULL, token text NOT NULL, kind text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (chain_id, block, log_index));
CREATE TABLE IF NOT EXISTS transfers (
  chain_id integer NOT NULL, block numeric(20,0) NOT NULL, log_index integer NOT NULL, sub numeric(20,0) NOT NULL, tx_hash text NOT NULL,
  token text NOT NULL, asset text NOT NULL, from_address text NOT NULL, to_address text NOT NULL, amount numeric(78,0) NOT NULL, token_id text NOT NULL,
  PRIMARY KEY (chain_id, block, log_index, sub));
CREATE TABLE IF NOT EXISTS balances (
  chain_id integer NOT NULL, token text NOT NULL, asset text NOT NULL, holder text NOT NULL, amount numeric(78,0) NOT NULL,
  PRIMARY KEY (chain_id, token, asset, holder));
CREATE TABLE IF NOT EXISTS items (
  chain_id integer NOT NULL, token text NOT NULL, asset text NOT NULL, item_id text NOT NULL, owner text NOT NULL,
  PRIMARY KEY (chain_id, token, asset, item_id));
CREATE TABLE IF NOT EXISTS candles (
  chain_id integer NOT NULL, token text NOT NULL, interval text NOT NULL, start numeric(20,0) NOT NULL,
  open_sqrt numeric(78,0) NOT NULL, high_sqrt numeric(78,0) NOT NULL, low_sqrt numeric(78,0) NOT NULL, close_sqrt numeric(78,0) NOT NULL,
  volume_q numeric(78,0) NOT NULL, trades integer NOT NULL,
  PRIMARY KEY (chain_id, token, interval, start));
CREATE TABLE IF NOT EXISTS writer_cursor (
  chain_id integer PRIMARY KEY, block numeric(20,0) NOT NULL, hash text NOT NULL);
CREATE TABLE IF NOT EXISTS history_replays (
  chain_id integer NOT NULL, registry text NOT NULL, box_id numeric(78,0) NOT NULL, token text NOT NULL,
  PRIMARY KEY (chain_id, registry, box_id));
`;

const ZERO = '0x0000000000000000000000000000000000000000';
const CHUNK = 500;

export interface PgHistoryOptions {
  /** A socket directory (Unix socket only) or a host. */
  readonly host: string | undefined;
  readonly port?: number | undefined;
  readonly database: string;
  readonly user?: string | undefined;
  readonly max?: number;
}

type Client = pg.PoolClient;

const sortedJson = (value: Record<string, unknown>): string => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

async function insertMany(client: Client, table: string, columns: readonly string[], rows: readonly (readonly unknown[])[], conflict = 'ON CONFLICT DO NOTHING', returning = ''): Promise<pg.QueryResultRow[]> {
  const out: pg.QueryResultRow[] = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => `(${row.map((v) => `$${values.push(v)}`).join(', ')})`);
    const result = await client.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')} ${conflict} ${returning}`, values);
    out.push(...result.rows);
  }
  return out;
}

export class PgHistory implements HistoryStore {
  readonly kind = 'postgres' as const;
  private generation = 0n;
  get version(): bigint { return this.generation; }
  private readonly pool: pg.Pool;

  constructor(options: PgHistoryOptions) {
    this.pool = new pg.Pool({ host: options.host, port: options.port, database: options.database, user: options.user, max: options.max ?? 4 });
  }

  async init(): Promise<void> {
    await this.pool.query(HISTORY_SCHEMA_SQL);
  }

  private async tx<T>(work: (client: Client) => Promise<T>, mode: 'write' | 'snapshot' = 'write'): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(mode === 'snapshot' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      if (mode === 'write') this.generation += 1n;
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async writeBlock(result: CoreBlockResult, fill?: ReadonlySet<string>): Promise<void> {
    const rows = rowsOfBlock(result);
    const chainId = result.chainId;
    await this.tx(async (c) => {
      const existing = await c.query('SELECT hash FROM chain_blocks WHERE chain_id = $1 AND number = $2 FOR UPDATE', [chainId, rows.block.number]);
      const held = existing.rows[0] as { hash: string } | undefined;
      if (held && held.hash === rows.block.hash) {
        // SH-NO-PICTURE-GATE upgrade: a replayed box's record and rows into the block held already, in this block's transaction.
        if (fill && fill.size > 0) {
          await insertMany(c, 'boxes', ['chain_id', 'registry', 'box_id', 'token', 'creation_block', 'shown', 'reason', 'row_json'], rows.boxes.filter((b) => fill.has(b.token)).map((b) => [chainId, b.registry, b.boxId, b.token, b.creationBlock, b.shown, b.reason, b.row]));
          await this.insertItems(c, chainId, itemRowsFor(rows, fill));
        }
        return;
      }
      if (held) await this.undoIn(c, chainId, result.block.number - 1n);
      await c.query('INSERT INTO chain_blocks (chain_id, number, hash, parent_hash, ts) VALUES ($1, $2, $3, $4, $5)', [chainId, rows.block.number, rows.block.hash, rows.block.parentHash, rows.block.timestamp]);
      await insertMany(c, 'boxes', ['chain_id', 'registry', 'box_id', 'token', 'creation_block', 'shown', 'reason', 'row_json'], rows.boxes.map((b) => [chainId, b.registry, b.boxId, b.token, b.creationBlock, b.shown, b.reason, b.row]));
      await this.insertItems(c, chainId, rows);
      await c.query('INSERT INTO writer_cursor (chain_id, block, hash) VALUES ($1, $2, $3) ON CONFLICT (chain_id) DO UPDATE SET block = EXCLUDED.block, hash = EXCLUDED.hash', [chainId, rows.block.number, rows.block.hash]);
    });
  }

  async pictureHidden(): Promise<readonly PictureHiddenBox[]> {
    const r = await this.pool.query(
      `SELECT chain_id, registry, box_id::text AS box_id, token FROM boxes WHERE shown = false AND starts_with(reason, $1)
       UNION SELECT chain_id, registry, box_id::text AS box_id, token FROM history_replays`,
      [PICTURE_HIDDEN_PREFIX],
    );
    return r.rows.map((row) => ({ chainId: Number(row.chain_id), registry: String(row.registry), boxId: String(row.box_id), token: String(row.token) }));
  }

  async startReplay(chainId: number, boxes: readonly PictureHiddenBox[]): Promise<bigint> {
    return this.tx(async (c) => {
      await insertMany(c, 'history_replays', ['chain_id', 'registry', 'box_id', 'token'], boxes.map((b) => [chainId, b.registry, b.boxId, b.token]));
      const tokens = [...new Set(boxes.map((b) => b.token))];
      for (const table of ['trades', 'activity', 'batches', 'depth_events', 'transfers', 'balances', 'items', 'candles']) {
        await c.query(`DELETE FROM ${table} WHERE chain_id = $1 AND token = ANY($2::text[])`, [chainId, tokens]);
      }
      for (const b of boxes) await c.query('DELETE FROM boxes WHERE chain_id = $1 AND registry = $2 AND box_id = $3', [chainId, b.registry, b.boxId]);
      const newest = await c.query('SELECT max(number)::text AS n FROM chain_blocks WHERE chain_id = $1', [chainId]);
      return BigInt(String((newest.rows[0] as { n: string | null } | undefined)?.n ?? '0'));
    });
  }

  async finishReplay(chainId: number, boxes: readonly PictureHiddenBox[]): Promise<void> {
    await this.tx(async (c) => {
      for (const b of boxes) await c.query('DELETE FROM history_replays WHERE chain_id = $1 AND registry = $2 AND box_id = $3', [chainId, b.registry, b.boxId]);
    });
  }

  /** Item rows (a row held already is kept), balances and owners by the new transfers in order, their candles. */
  private async insertItems(c: Client, chainId: number, rows: ItemRows): Promise<void> {
    await insertMany(
      c,
      'trades',
      ['chain_id', 'block', 'log_index', 'block_hash', 'tx_hash', 'ts', 'token', 'side', 'route', 'q_raw', 't_raw', 'fee_q', 'fee_t', 'tax_q', 'trader', 'sqrt_price_x96', 'tick'],
      rows.trades.map((t) => [chainId, t.block, t.logIndex, t.blockHash, t.txHash, t.timestamp, t.token, t.side, t.route, t.qRaw, t.tRaw, t.feeQ, t.feeT, t.taxQ, t.trader, t.sqrtPriceX96, t.tick]),
    );
    await insertMany(c, 'activity', ['chain_id', 'block', 'log_index', 'block_hash', 'tx_hash', 'ts', 'token', 'kind', 'data'], rows.activity.map((a) => [chainId, a.block, a.logIndex, a.blockHash, a.txHash, a.timestamp, a.token, a.kind, a.data]));
    await insertMany(c, 'batches', ['chain_id', 'block', 'log_index', 'tx_hash', 'token', 'amounts'], rows.batches.map((b) => [chainId, b.block, b.logIndex, b.txHash, b.token, b.values]));
    await insertMany(c, 'depth_events', ['chain_id', 'block', 'log_index', 'tx_hash', 'token', 'kind', 'data'], rows.depth.map((d) => [chainId, d.block, d.logIndex, d.txHash, d.token, d.kind, d.data]));
    const inserted = await insertMany(
      c,
      'transfers',
      ['chain_id', 'block', 'log_index', 'sub', 'tx_hash', 'token', 'asset', 'from_address', 'to_address', 'amount', 'token_id'],
      rows.transfers.map((t) => [chainId, t.block, t.logIndex, t.sub, t.txHash, t.token, t.asset, t.from, t.to, t.amount, t.tokenId]),
      'ON CONFLICT DO NOTHING',
      'RETURNING block::text AS block, log_index, sub::text AS sub',
    );
    const fresh = new Set(inserted.map((r) => `${String(r.block)}:${String(r.log_index)}:${String(r.sub)}`));
    await this.applyTransfers(c, chainId, rows.transfers.filter((t) => fresh.has(`${t.block}:${t.logIndex}:${t.sub}`)), 1);
    await this.refreshCandles(c, chainId, rows.trades);
  }

  /** Balances by delta and item owners (sign -1: undo, the owner back to the sender). The rule of memory-history.ts. */
  private async applyTransfers(c: Client, chainId: number, transfers: readonly TransferRow[], sign: 1 | -1): Promise<void> {
    const deltas = new Map<string, bigint>();
    const owners = new Map<string, string>();
    for (const t of transfers) {
      if (t.asset === 'T') {
        const amount = BigInt(t.amount) * BigInt(sign);
        if (t.from !== ZERO) deltas.set(`${t.token}|${t.from}`, (deltas.get(`${t.token}|${t.from}`) ?? 0n) - amount);
        if (t.to !== ZERO) deltas.set(`${t.token}|${t.to}`, (deltas.get(`${t.token}|${t.to}`) ?? 0n) + amount);
      } else {
        owners.set(`${t.token}|${t.asset}|${t.tokenId}`, sign === 1 ? t.to : t.from);
      }
    }
    const balanceRows = [...deltas.entries()].filter(([, d]) => d !== 0n).map(([k, d]) => {
      const [token, holder] = k.split('|');
      return [chainId, token, 'T', holder, d.toString()];
    });
    if (balanceRows.length > 0) {
      await insertMany(c, 'balances', ['chain_id', 'token', 'asset', 'holder', 'amount'], balanceRows, 'ON CONFLICT (chain_id, token, asset, holder) DO UPDATE SET amount = balances.amount + EXCLUDED.amount');
      await c.query("DELETE FROM balances WHERE chain_id = $1 AND amount = 0", [chainId]);
    }
    const set = [...owners.entries()].filter(([, owner]) => owner !== ZERO).map(([k, owner]) => {
      const [token, asset, id] = k.split('|');
      return [chainId, token, asset, id, owner];
    });
    if (set.length > 0) await insertMany(c, 'items', ['chain_id', 'token', 'asset', 'item_id', 'owner'], set, 'ON CONFLICT (chain_id, token, asset, item_id) DO UPDATE SET owner = EXCLUDED.owner');
    for (const [k, owner] of owners) {
      if (owner !== ZERO) continue;
      const [token, asset, id] = k.split('|');
      await c.query('DELETE FROM items WHERE chain_id = $1 AND token = $2 AND asset = $3 AND item_id = $4', [chainId, token, asset, id]);
    }
  }

  /** Recomputes the candle buckets the given trades touch, from every stored trade in them (1 min, 1 h, 1 d). */
  private async refreshCandles(c: Client, chainId: number, trades: readonly Pick<TradeRow, 'token' | 'timestamp'>[]): Promise<void> {
    const buckets = new Map<string, { token: string; interval: CandleInterval; start: bigint }>();
    for (const t of trades) {
      for (const interval of CANDLE_INTERVALS) {
        const size = INTERVAL_SECONDS[interval];
        const start = (BigInt(t.timestamp) / size) * size;
        buckets.set(`${t.token}|${interval}|${start}`, { token: t.token, interval, start });
      }
    }
    for (const { token, interval, start } of buckets.values()) {
      const end = start + INTERVAL_SECONDS[interval];
      const stored = await c.query(
        'SELECT block::text AS block, log_index, ts::text AS ts, route, q_raw::text AS q_raw, sqrt_price_x96::text AS sqrt FROM trades WHERE chain_id = $1 AND token = $2 AND ts >= $3 AND ts < $4',
        [chainId, token, start.toString(), end.toString()],
      );
      const rows = stored.rows.map((r) => ({ block: String(r.block), logIndex: Number(r.log_index), timestamp: String(r.ts), route: String(r.route), qRaw: String(r.q_raw), sqrtPriceX96: String(r.sqrt) }) as TradeRow);
      const [candle] = candlesOfRows(rows, interval);
      if (!candle) {
        await c.query('DELETE FROM candles WHERE chain_id = $1 AND token = $2 AND interval = $3 AND start = $4', [chainId, token, interval, start.toString()]);
        continue;
      }
      await c.query(
        `INSERT INTO candles (chain_id, token, interval, start, open_sqrt, high_sqrt, low_sqrt, close_sqrt, volume_q, trades) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (chain_id, token, interval, start) DO UPDATE SET open_sqrt = EXCLUDED.open_sqrt, high_sqrt = EXCLUDED.high_sqrt, low_sqrt = EXCLUDED.low_sqrt, close_sqrt = EXCLUDED.close_sqrt, volume_q = EXCLUDED.volume_q, trades = EXCLUDED.trades`,
        [chainId, token, interval, candle.start, candle.openSqrtPriceX96, candle.highSqrtPriceX96, candle.lowSqrtPriceX96, candle.closeSqrtPriceX96, candle.volumeQ, candle.trades],
      );
    }
  }

  async undoAbove(chainId: number, block: bigint): Promise<void> {
    await this.tx((c) => this.undoIn(c, chainId, block));
  }

  private async undoIn(c: Client, chainId: number, block: bigint): Promise<void> {
    const n = block.toString();
    const removed = await c.query(
      'SELECT block::text AS block, log_index, sub::text AS sub, token, asset, from_address, to_address, amount::text AS amount, token_id FROM transfers WHERE chain_id = $1 AND block > $2 ORDER BY block DESC, log_index DESC, sub DESC',
      [chainId, n],
    );
    // Undone newest first: an item moved twice above the ancestor ends with its first sender.
    for (const r of removed.rows) {
      await this.applyTransfers(c, chainId, [{ chainId, block: String(r.block), logIndex: Number(r.log_index), sub: String(r.sub), txHash: '', token: String(r.token), asset: String(r.asset), from: String(r.from_address), to: String(r.to_address), amount: String(r.amount), tokenId: String(r.token_id) }], -1);
    }
    const trades = await c.query('SELECT token, ts::text AS ts FROM trades WHERE chain_id = $1 AND block > $2', [chainId, n]);
    for (const table of ['transfers', 'trades', 'activity', 'batches', 'depth_events']) await c.query(`DELETE FROM ${table} WHERE chain_id = $1 AND block > $2`, [chainId, n]);
    await c.query('DELETE FROM boxes WHERE chain_id = $1 AND creation_block > $2', [chainId, n]);
    await c.query('DELETE FROM chain_blocks WHERE chain_id = $1 AND number > $2', [chainId, n]);
    await this.refreshCandles(c, chainId, trades.rows.map((r) => ({ token: String(r.token), timestamp: String(r.ts) })));
    const newest = await c.query('SELECT number::text AS number, hash FROM chain_blocks WHERE chain_id = $1 ORDER BY number DESC LIMIT 1', [chainId]);
    const top = newest.rows[0] as { number: string; hash: string } | undefined;
    if (top) await c.query('INSERT INTO writer_cursor (chain_id, block, hash) VALUES ($1, $2, $3) ON CONFLICT (chain_id) DO UPDATE SET block = EXCLUDED.block, hash = EXCLUDED.hash', [chainId, top.number, top.hash]);
    else await c.query('DELETE FROM writer_cursor WHERE chain_id = $1', [chainId]);
  }

  async wipe(chainId: number): Promise<void> {
    await this.tx(async (c) => {
      for (const table of ['chain_blocks', 'boxes', 'trades', 'activity', 'batches', 'depth_events', 'transfers', 'balances', 'items', 'candles', 'writer_cursor', 'history_replays']) {
        await c.query(`DELETE FROM ${table} WHERE chain_id = $1`, [chainId]);
      }
    });
  }

  async cursor(chainId: number): Promise<{ block: bigint; hash: string } | null> {
    const r = await this.pool.query('SELECT block::text AS block, hash FROM writer_cursor WHERE chain_id = $1', [chainId]);
    const row = r.rows[0] as { block: string; hash: string } | undefined;
    return row ? { block: BigInt(row.block), hash: row.hash } : null;
  }

  async activityPage(chainId: number, token: string, options: HistoryActivityOptions): Promise<ActivityPage['items']> {
    // The writer may commit an undo/replacement between these SELECTs. Both must see one branch.
    return this.tx(async client => {
      const who = token.toLowerCase();
      const [bb, bl] = options.before?.split('-') ?? [];
      const cursor = options.before ? [bb ?? '0', Number(bl ?? '0')] : null;
      const where = cursor ? 'AND (block < $3 OR (block = $3 AND log_index < $4))' : '';
      const params: unknown[] = [chainId, who, ...(cursor ?? [])];
      const items: { block: bigint; logIndex: number; item: ActivityPage['items'][number] }[] = [];
      if (options.kind === null || options.kind === 'trade') {
        const r = await client.query(
          `SELECT block::text AS block, log_index, block_hash, tx_hash, ts::text AS ts, token, side, route, q_raw::text AS q_raw, t_raw::text AS t_raw, fee_q::text AS fee_q, fee_t::text AS fee_t, tax_q::text AS tax_q, trader, sqrt_price_x96::text AS sqrt, tick
           FROM trades WHERE chain_id = $1 AND token = $2 ${where} ORDER BY block DESC, log_index DESC LIMIT ${options.limit}`,
          params,
        );
        for (const row of r.rows) {
          const t = tradeOfRow({ chainId, block: String(row.block), logIndex: Number(row.log_index), blockHash: String(row.block_hash), txHash: String(row.tx_hash), timestamp: String(row.ts), token: String(row.token), side: String(row.side), route: String(row.route), qRaw: String(row.q_raw), tRaw: String(row.t_raw), feeQ: String(row.fee_q), feeT: String(row.fee_t), taxQ: String(row.tax_q), trader: String(row.trader), sqrtPriceX96: String(row.sqrt), tick: Number(row.tick) });
          items.push({ block: t.block, logIndex: t.logIndex, item: t });
        }
      }
      if (options.kind !== 'trade') {
        const kindClause = options.kind === null ? '' : `AND kind = $${params.length + 1}`;
        const r = await client.query(
          `SELECT block::text AS block, log_index, block_hash, tx_hash, ts::text AS ts, kind, data FROM activity WHERE chain_id = $1 AND token = $2 ${where} ${kindClause} ORDER BY block DESC, log_index DESC LIMIT ${options.limit}`,
          options.kind === null ? params : [...params, options.kind],
        );
        for (const row of r.rows) {
          items.push({
            block: BigInt(String(row.block)),
            logIndex: Number(row.log_index),
            item: { id: `${String(row.block)}-${String(row.log_index)}`, kind: String(row.kind) as never, block: BigInt(String(row.block)), blockHash: String(row.block_hash) as `0x${string}`, timestamp: BigInt(String(row.ts)), txHash: String(row.tx_hash) as `0x${string}`, logIndex: Number(row.log_index), data: row.data as Record<string, string> },
          });
        }
      }
      const page = items
        .sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block < b.block ? 1 : -1))
        .slice(0, options.limit)
        .map((x) => x.item);
      if (!options.v2Contracts) return page;
      const missing = missingTraders(page);
      const transfers = [];
      if (missing.length > 0) {
        const params: unknown[] = [chainId, who];
        const pairs = missing.map(item => `($${params.push(item.block.toString())}::numeric, $${params.push(item.txHash.toLowerCase())}::text)`);
        const result = await client.query(
          `SELECT tx_hash, from_address, to_address, amount::text AS amount FROM transfers
           WHERE chain_id = $1 AND token = $2 AND asset = 'T' AND (block, tx_hash) IN (${pairs.join(', ')})`, params);
        for (const row of result.rows) transfers.push({ txHash: String(row.tx_hash), from: String(row.from_address), to: String(row.to_address), amount: BigInt(String(row.amount)) });
      }
      return withTradersV2(page, transfers, options.v2Contracts);
    }, 'snapshot');
  }

  async candles(chainId: number, token: string, interval: CandleInterval, limit = CANDLE_LIMIT): Promise<readonly Candle[]> {
    const who = token.toLowerCase();
    if (interval === '12s') {
      // Keyset reads walk trades_by_token backwards, never scanning/sorting the token's lifetime by ts.
      // Read one extra bucket to prove the oldest requested bucket is complete (including multiple blocks).
      return this.tx(async client => {
        const trades: Parameters<typeof candlesFromTrades>[0][number][] = [];
        let cursor: { block: string; logIndex: number } | undefined;
        const buckets = new Set<bigint>();
        for (;;) {
          const result = await client.query(
            `SELECT block::text AS block, log_index, ts::text AS ts, route, q_raw::text AS q_raw, sqrt_price_x96::text AS sqrt
             FROM trades WHERE chain_id = $1 AND token = $2 ${cursor ? 'AND (block, log_index) < ($3::numeric, $4::integer)' : ''}
             ORDER BY trades.block DESC, trades.log_index DESC LIMIT 512`,
            [chainId, who, ...(cursor ? [cursor.block, cursor.logIndex] : [])],
          );
          for (const row of result.rows) {
            const timestamp = BigInt(String(row.ts));
            buckets.add(timestamp / 12n);
            if (buckets.size > limit) return candlesFromTrades(trades, interval).slice(-limit);
            trades.push({ timestamp, block: BigInt(String(row.block)), logIndex: Number(row.log_index),
              route: String(row.route) as Parameters<typeof candlesFromTrades>[0][number]['route'],
              qRaw: BigInt(String(row.q_raw)), sqrtPriceX96After: BigInt(String(row.sqrt)) });
            cursor = { block: String(row.block), logIndex: Number(row.log_index) };
          }
          if (result.rows.length < 512) return candlesFromTrades(trades, interval).slice(-limit);
        }
      }, 'snapshot');
    }
    const aggregate = interval === '10m' || interval === '10h';
    const stored = interval === '10m' ? '1m' : interval === '10h' ? '1h' : interval;
    // Each served bucket contains at most ten base candles. Any truncated oldest bucket is outside the newest limit.
    const r = await this.pool.query(
      'SELECT start::text AS start, open_sqrt::text AS o, high_sqrt::text AS h, low_sqrt::text AS l, close_sqrt::text AS c, volume_q::text AS v, trades FROM candles WHERE chain_id = $1 AND token = $2 AND interval = $3 ORDER BY candles.start DESC LIMIT $4',
      [chainId, who, stored, limit * (aggregate ? 10 : 1)],
    );
    const candles = r.rows.reverse().map((row) => ({ start: String(row.start), openSqrtPriceX96: String(row.o), highSqrtPriceX96: String(row.h), lowSqrtPriceX96: String(row.l), closeSqrtPriceX96: String(row.c), volumeQ: String(row.v), trades: Number(row.trades) }));
    return (aggregate ? aggregateCandles(candles, interval) : candles).slice(-limit);
  }

  async dump(chainId: number): Promise<HistoryDump> {
    const q = async (sql: string): Promise<pg.QueryResultRow[]> => (await this.pool.query(sql, [chainId])).rows;
    const lines = (rows: object[]): string[] => rows.map(line).sort();
    return {
      chainBlocks: lines((await q('SELECT number::text AS number, hash, parent_hash, ts::text AS ts FROM chain_blocks WHERE chain_id = $1')).map((r) => ({ chainId, number: String(r.number), hash: String(r.hash), parentHash: String(r.parent_hash), timestamp: String(r.ts) }))),
      boxes: lines((await q('SELECT registry, box_id::text AS box_id, token, creation_block::text AS cb, shown, reason, row_json FROM boxes WHERE chain_id = $1')).map((r) => ({ chainId, registry: String(r.registry), boxId: String(r.box_id), token: String(r.token), creationBlock: String(r.cb), shown: Boolean(r.shown), reason: String(r.reason), row: String(r.row_json) }))),
      trades: lines(
        (await q('SELECT block::text AS block, log_index, block_hash, tx_hash, ts::text AS ts, token, side, route, q_raw::text AS q_raw, t_raw::text AS t_raw, fee_q::text AS fee_q, fee_t::text AS fee_t, tax_q::text AS tax_q, trader, sqrt_price_x96::text AS sqrt, tick FROM trades WHERE chain_id = $1')).map((r) => ({
          chainId,
          block: String(r.block),
          logIndex: Number(r.log_index),
          blockHash: String(r.block_hash),
          txHash: String(r.tx_hash),
          timestamp: String(r.ts),
          token: String(r.token),
          side: String(r.side),
          route: String(r.route),
          qRaw: String(r.q_raw),
          tRaw: String(r.t_raw),
          feeQ: String(r.fee_q),
          feeT: String(r.fee_t),
          taxQ: String(r.tax_q),
          trader: String(r.trader),
          sqrtPriceX96: String(r.sqrt),
          tick: Number(r.tick),
        })),
      ),
      activity: lines((await q('SELECT block::text AS block, log_index, block_hash, tx_hash, ts::text AS ts, token, kind, data FROM activity WHERE chain_id = $1')).map((r) => ({ chainId, block: String(r.block), logIndex: Number(r.log_index), blockHash: String(r.block_hash), txHash: String(r.tx_hash), timestamp: String(r.ts), token: String(r.token), kind: String(r.kind), data: sortedJson(r.data as Record<string, unknown>) }))),
      batches: lines((await q('SELECT block::text AS block, log_index, tx_hash, token, amounts FROM batches WHERE chain_id = $1')).map((r) => ({ chainId, block: String(r.block), logIndex: Number(r.log_index), txHash: String(r.tx_hash), token: String(r.token), values: sortedJson(r.amounts as Record<string, unknown>) }))),
      depthEvents: lines((await q('SELECT block::text AS block, log_index, tx_hash, token, kind, data FROM depth_events WHERE chain_id = $1')).map((r) => ({ chainId, block: String(r.block), logIndex: Number(r.log_index), txHash: String(r.tx_hash), token: String(r.token), kind: String(r.kind), data: sortedJson(r.data as Record<string, unknown>) }))),
      transfers: lines(
        (await q('SELECT block::text AS block, log_index, sub::text AS sub, tx_hash, token, asset, from_address, to_address, amount::text AS amount, token_id FROM transfers WHERE chain_id = $1')).map((r) => ({
          chainId,
          block: String(r.block),
          logIndex: Number(r.log_index),
          sub: String(r.sub),
          txHash: String(r.tx_hash),
          token: String(r.token),
          asset: String(r.asset),
          from: String(r.from_address),
          to: String(r.to_address),
          amount: String(r.amount),
          tokenId: String(r.token_id),
        })),
      ),
      balances: lines((await q('SELECT token, asset, holder, amount::text AS amount FROM balances WHERE chain_id = $1')).map((r) => ({ chainId, token: String(r.token), asset: String(r.asset), holder: String(r.holder), amount: String(r.amount) }))),
      items: lines((await q('SELECT token, asset, item_id, owner FROM items WHERE chain_id = $1')).map((r) => ({ chainId, token: String(r.token), asset: String(r.asset), id: String(r.item_id), owner: String(r.owner) }))),
      candles: lines(
        (await q('SELECT token, interval, start::text AS start, open_sqrt::text AS o, high_sqrt::text AS h, low_sqrt::text AS l, close_sqrt::text AS c, volume_q::text AS v, trades FROM candles WHERE chain_id = $1')).map((r) => ({
          chainId,
          token: String(r.token),
          interval: String(r.interval),
          start: String(r.start),
          openSqrtPriceX96: String(r.o),
          highSqrtPriceX96: String(r.h),
          lowSqrtPriceX96: String(r.l),
          closeSqrtPriceX96: String(r.c),
          volumeQ: String(r.v),
          trades: Number(r.trades),
        })),
      ),
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
