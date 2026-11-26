import pg from 'pg';
import type { PgHistoryOptions } from '../history/pg-history';
import { arweaveIdSchema, pictureHash } from './types';

export interface PictureCopiesStore {
  readonly kind: 'memory' | 'postgres';
  init(): Promise<void>;
  get(hash: string): Promise<string | null>;
  /** Keeps the first verified ID. The API cannot accept picture bytes. */
  put(hash: string, arweaveId: string): Promise<string>;
  close(): Promise<void>;
}
function checkedHash(hash: string): string {
  if (pictureHash(hash) !== hash) throw new Error('invalid picture hash');
  return hash;
}
export class MemoryPictureCopies implements PictureCopiesStore {
  readonly kind = 'memory' as const;
  private readonly ids = new Map<string, string>();
  async init(): Promise<void> { /* No schema. */ }
  async close(): Promise<void> { /* No connection. */ }
  async get(hash: string): Promise<string | null> { return this.ids.get(checkedHash(hash)) ?? null; }
  async put(hash: string, arweaveId: string): Promise<string> {
    checkedHash(hash); arweaveIdSchema.parse(arweaveId);
    const kept = this.ids.get(hash) ?? arweaveId; this.ids.set(hash, kept); return kept;
  }
}

export const PICTURES_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS picture_copies (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  arweave_id text NOT NULL CHECK (arweave_id ~ '^[A-Za-z0-9_-]{43}$')
);`;
export interface PictureSql {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
/** Same database as history, separate table/pool. History replay/wipe never owns immutable hash proofs. */
export class PgPictureCopies implements PictureCopiesStore {
  readonly kind = 'postgres' as const;
  private readonly pool: PictureSql;
  private pending = 0;
  constructor(options: PgHistoryOptions | PictureSql) {
    if ('query' in options) { this.pool = options; return; }
    const pool = new pg.Pool({ ...options, max: 2,
      connectionTimeoutMillis: 2000, statement_timeout: 3000, query_timeout: 4000 });
    // Idle errors arrive outside query promises. pg removes the failed client; later queries reconnect.
    pool.on('error', () => { /* Optional picture storage must not terminate chain following or listing. */ });
    this.pool = pool;
  }
  private async bounded<T>(work: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([Promise.resolve().then(work), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('picture store unavailable')), 5000);
    })]); } finally { clearTimeout(timer); }
  }
  private query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    if (this.pending >= 4) return Promise.reject(new Error('picture store busy'));
    this.pending++;
    return this.bounded(() => Promise.resolve().then(() => this.pool.query(sql, values)).finally(() => { this.pending--; }));
  }
  async init(): Promise<void> { await this.query(PICTURES_SCHEMA_SQL); }
  async close(): Promise<void> { await this.bounded(() => this.pool.end()); }
  async get(hash: string): Promise<string | null> {
    const row = (await this.query('SELECT arweave_id FROM picture_copies WHERE sha256 = $1', [checkedHash(hash)])).rows[0];
    return row ? arweaveIdSchema.parse(row['arweave_id']) : null;
  }
  async put(hash: string, arweaveId: string): Promise<string> {
    const result = await this.query(`INSERT INTO picture_copies (sha256, arweave_id) VALUES ($1, $2)
ON CONFLICT (sha256) DO UPDATE SET arweave_id = picture_copies.arweave_id RETURNING arweave_id`,
    [checkedHash(hash), arweaveIdSchema.parse(arweaveId)]);
    return arweaveIdSchema.parse(result.rows[0]?.['arweave_id']);
  }
}
