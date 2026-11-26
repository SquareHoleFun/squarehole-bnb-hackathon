import type { LinkRow, LinksStore } from './types';

/** Local development fallback. No expiry: empty-link rows still prevent stale replays. */
export class MemoryLinks implements LinksStore {
  readonly kind = 'memory' as const;
  private readonly rows = new Map<string, LinkRow>();
  async init(): Promise<void> { /* No schema. */ }
  async close(): Promise<void> { /* No connection. */ }
  async get(chainId: number, token: string): Promise<LinkRow | null> { return this.rows.get(`${chainId}:${token.toLowerCase()}`) ?? null; }
  async list(chainId: number): Promise<readonly LinkRow[]> { return [...this.rows.values()].filter(row => row.chainId === chainId); }
  async put(row: LinkRow): Promise<LinkRow | null> {
    const key = `${row.chainId}:${row.token.toLowerCase()}`;
    const old = this.rows.get(key);
    if (old && BigInt(old.issuedAt) >= BigInt(row.issuedAt)) return null;
    const saved = Object.freeze({ ...row, token: row.token.toLowerCase() });
    this.rows.set(key, saved);
    return saved;
  }
}
