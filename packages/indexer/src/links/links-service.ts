import { BOX_LINKS_LIMITS } from '../../../chain/src/core/v2/box-links-v2';
import type { CoreServiceConfig } from '../core/core-config';
import { MemoryLinks } from './memory-links';
import { PgLinks } from './pg-links';
import { hasLinks, type LinkRow, type LinksStore, type LinksView, type VisibleLinks } from './types';

/** Durable writes plus a synchronous projection for feed/box/SSE. History wipe/dump never owns these rows. */
export class LinksService {
  private rows = new Map<string, LinkRow>();
  private readonly revisions = new Map<string, number>();
  private revision = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reloading: Promise<void> | null = null;
  constructor(readonly store: LinksStore, readonly chainId: number) {}
  async start(): Promise<void> {
    await this.store.init(); await this.reload();
    this.timer = setInterval(() => { void this.reload().catch(() => undefined); }, BOX_LINKS_LIMITS.reloadMs);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.reloading?.catch(() => undefined);
    await this.store.close();
  }
  get(token: string): LinkRow | null { return this.rows.get(token.toLowerCase()) ?? null; }
  visible(token: string): VisibleLinks {
    const row = this.get(token);
    return row && hasLinks(row) ? { website: row.website, x: row.x, telegram: row.telegram, issuedAt: row.issuedAt } : null;
  }
  view(token: string, creator: string, row = this.get(token)): LinksView {
    return { schema: 'sh.box-links.v1', chainId: this.chainId, token: token.toLowerCase(), creator: creator.toLowerCase(),
      record: row && hasLinks(row) ? { website: row.website, x: row.x, telegram: row.telegram, issuedAt: row.issuedAt,
        signature: row.signature, signerKind: row.signerKind, verifiedBlock: row.verifiedBlock } : null };
  }
  async save(row: LinkRow): Promise<{ saved: boolean; row: LinkRow }> {
    if (row.chainId !== this.chainId) throw new Error('links chain mismatch');
    const returned = await this.store.put(row);
    const held = returned ?? await this.store.get(this.chainId, row.token);
    if (!held) throw new Error('box_links row missing after upsert');
    const token = held.token.toLowerCase(); const old = this.rows.get(token);
    // Never publish the submitted object: only the store's returned row, and only forward in signing time.
    if (!old || BigInt(held.issuedAt) > BigInt(old.issuedAt)) {
      this.rows.set(token, held); this.revisions.set(token, ++this.revision);
    }
    return { saved: returned !== null, row: held };
  }
  reload(): Promise<void> {
    if (this.reloading) return this.reloading;
    const started = this.revision;
    this.reloading = this.store.list(this.chainId).then(rows => {
      const next = new Map(rows.map(row => [row.token.toLowerCase(), row]));
      // Reloads also replace equal-time tombstones and older restored data. Preserve writes completed during the read.
      for (const [token, revision] of this.revisions) if (revision > started) {
        const row = this.rows.get(token); if (row) next.set(token, row);
      }
      this.rows = next;
    }).catch(error => { console.error('[links] reload unavailable'); throw error; }).finally(() => { this.reloading = null; });
    return this.reloading;
  }
}

export async function startLinks(config: Pick<CoreServiceConfig, 'history' | 'pg'>, chainId: number): Promise<LinksService> {
  const store = config.history === 'postgres' ? new PgLinks(config.pg) : new MemoryLinks();
  const service = new LinksService(store, chainId);
  try { await service.start(); return service; }
  catch (error) { await service.stop(); throw error; }
}
