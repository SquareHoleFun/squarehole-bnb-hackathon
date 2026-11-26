import pg from 'pg';
import type { PgHistoryOptions } from '../history/pg-history';
import type { LinkRow, LinksStore } from './types';

export const LINKS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS box_links (
  chain_id integer NOT NULL,
  token text NOT NULL CHECK (token ~ '^0x[0-9a-f]{40}$'),
  website text NOT NULL, x text NOT NULL, telegram text NOT NULL,
  issued_at numeric(20,0) NOT NULL,
  signer text NOT NULL,
  signer_kind text NOT NULL CHECK (signer_kind IN ('eoa','erc1271')),
  signature text NOT NULL,
  verified_block numeric(20,0) NOT NULL,
  PRIMARY KEY (chain_id, token));
`;
export const LINKS_UPSERT_SQL = `
INSERT INTO box_links (chain_id, token, website, x, telegram, issued_at, signer, signer_kind, signature, verified_block)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (chain_id, token) DO UPDATE SET
  website = EXCLUDED.website, x = EXCLUDED.x, telegram = EXCLUDED.telegram, issued_at = EXCLUDED.issued_at,
  signer = EXCLUDED.signer, signer_kind = EXCLUDED.signer_kind, signature = EXCLUDED.signature,
  verified_block = EXCLUDED.verified_block
WHERE box_links.issued_at < EXCLUDED.issued_at
RETURNING *;
`;

/** Small injectable SQL boundary for offline contract tests. Production owns a separate pool in the history DB. */
export interface LinksSql {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
function decode(row: Record<string, unknown>): LinkRow {
  const kind = row['signer_kind'];
  if (kind !== 'eoa' && kind !== 'erc1271') throw new Error('invalid box_links signer kind');
  return Object.freeze({ chainId: Number(row['chain_id']), token: String(row['token']), website: String(row['website']),
    x: String(row['x']), telegram: String(row['telegram']), issuedAt: String(row['issued_at']), signer: String(row['signer']),
    signerKind: kind, signature: String(row['signature']), verifiedBlock: String(row['verified_block']) });
}

/** Connection + execution have driver limits; this deadline also bounds shutdown and an unresponsive driver. */
const DEADLINE_MS = 5000;
export class LinksUnavailableError extends Error {
  constructor() { super('links store unavailable'); this.name = 'LinksUnavailableError'; }
}
async function bounded<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new LinksUnavailableError()), DEADLINE_MS);
    })]);
  } catch { throw new LinksUnavailableError(); }
  finally { clearTimeout(timer); }
}

export class PgLinks implements LinksStore {
  readonly kind = 'postgres' as const;
  private readonly pool: LinksSql;
  private readonly maxPending: number;
  private pending = 0;
  constructor(options: PgHistoryOptions | LinksSql) {
    const max = 'query' in options ? 4 : options.max ?? 4;
    this.maxPending = max + 4; // At most four waiters in addition to the pool's connections.
    this.pool = 'query' in options ? options : new pg.Pool({ ...options, max,
      connectionTimeoutMillis: 2000, statement_timeout: 3000, query_timeout: 4000 });
  }
  private query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    if (this.pending >= this.maxPending) return Promise.reject(new LinksUnavailableError());
    this.pending++;
    // A caller timeout does not free admission until the underlying query settles: a wedged driver cannot grow a queue.
    return bounded(() => Promise.resolve().then(() => this.pool.query(sql, values)).finally(() => { this.pending--; }));
  }
  async init(): Promise<void> { await this.query(LINKS_SCHEMA_SQL); }
  async close(): Promise<void> { await bounded(() => this.pool.end()); }
  async get(chainId: number, token: string): Promise<LinkRow | null> {
    const result = await this.query('SELECT * FROM box_links WHERE chain_id = $1 AND token = $2', [chainId, token.toLowerCase()]);
    return result.rows[0] ? decode(result.rows[0]) : null;
  }
  async list(chainId: number): Promise<readonly LinkRow[]> {
    return (await this.query('SELECT * FROM box_links WHERE chain_id = $1', [chainId])).rows.map(decode);
  }
  async put(row: LinkRow): Promise<LinkRow | null> {
    const result = await this.query(LINKS_UPSERT_SQL, [row.chainId, row.token.toLowerCase(), row.website, row.x,
      row.telegram, row.issuedAt, row.signer, row.signerKind, row.signature, row.verifiedBlock]);
    return result.rows[0] ? decode(result.rows[0]) : null;
  }
}
