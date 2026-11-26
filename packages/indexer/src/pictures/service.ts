import type { CoreServiceConfig } from '../core/core-config';
import { findPictureCopy, verifyPictureHint, PICTURE_LIMITS } from './discovery';
import { MemoryPictureCopies, PgPictureCopies, type PictureCopiesStore } from './store';
import { pictureHash, type PictureCopies, type PictureSpec } from './types';

type HintResult = { arweaveId: string } | { error: 'already verified' | 'unverified picture' | 'box changed' | 'unavailable' };
interface Pending { attempts: number; after: number }
/** Optional enrichment: indexing and GET responses never await picture work; only a hint POST does. */
export class PictureCopiesService {
  private readonly ids = new Map<string, string>();
  private readonly pending = new Map<string, Pending>();
  private readonly stopController = new AbortController();
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private initialization: Promise<void> | null = null;
  private readonly hints = new Set<Promise<HintResult>>();
  constructor(readonly store: PictureCopiesStore, private readonly options: { fetch?: typeof fetch; now?: () => number } = {}) {}
  visible(spec: PictureSpec): { pictureCopies?: PictureCopies } {
    const logo = this.ids.get(pictureHash(spec.coverSha256) ?? '');
    const cover = this.ids.get(pictureHash(spec.collectionCoverSha256) ?? '');
    return logo || cover ? { pictureCopies: { ...(logo ? { logo: { arweaveId: logo } } : {}), ...(cover ? { cover: { arweaveId: cover } } : {}) } } : {};
  }
  private init(): Promise<void> {
    this.initialization ??= this.store.init().catch(error => { this.initialization = null; throw error; });
    return this.initialization;
  }
  hint(hash: string, id: string, current: () => boolean): Promise<HintResult> {
    const pending = this.acceptHint(hash, id, current).catch((): HintResult => ({ error: 'unavailable' }));
    this.hints.add(pending);
    void pending.then(() => { this.hints.delete(pending); });
    return pending;
  }
  private async acceptHint(hash: string, id: string, current: () => boolean): Promise<HintResult> {
    if (this.stopController.signal.aborted) return { error: 'unavailable' };
    await this.init();
    const known = await this.store.get(hash);
    if (known) {
      if (!current()) return { error: 'box changed' };
      this.ids.set(hash, known);
      return known === id ? { arweaveId: known } : { error: 'already verified' };
    }
    if (!await verifyPictureHint(hash, id, { ...this.options, signal: this.stopController.signal })) return { error: 'unverified picture' };
    if (this.stopController.signal.aborted) return { error: 'unavailable' };
    if (!current()) return { error: 'box changed' };
    const kept = await this.store.put(hash, id);
    this.ids.set(hash, kept); this.pending.delete(hash);
    return kept === id ? { arweaveId: kept } : { error: 'already verified' };
  }
  watch(specs: () => Iterable<PictureSpec>): void {
    if (this.timer || this.stopController.signal.aborted) return;
    const tick = async () => {
      await this.run(specs());
      if (!this.stopController.signal.aborted) { this.timer = setTimeout(() => { void tick(); }, 5000); this.timer.unref(); }
    };
    this.timer = setTimeout(() => { void tick(); }, 0); this.timer.unref();
  }
  run(specs: Iterable<PictureSpec>): Promise<void> {
    if (this.stopController.signal.aborted) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.cycle(specs).catch(() => undefined).finally(() => { this.running = null; });
    return this.running;
  }
  private async cycle(specs: Iterable<PictureSpec>): Promise<void> {
    await this.init();
    const active = new Set<string>();
    for (const spec of specs) for (const value of [spec.coverSha256, spec.collectionCoverSha256]) {
      const hash = pictureHash(value); if (hash) active.add(hash);
    }
    for (const hash of this.pending.keys()) if (!active.has(hash)) this.pending.delete(hash);
    for (const hash of this.ids.keys()) if (!active.has(hash)) this.ids.delete(hash);
    for (const hash of active) if (!this.ids.has(hash) && !this.pending.has(hash)) this.pending.set(hash, { attempts: 0, after: 0 });
    const now = this.options.now ?? Date.now;
    const due = [...this.pending].filter(([, state]) => state.after <= now()).sort((a, b) => a[1].after - b[1].after).slice(0, PICTURE_LIMITS.hashesPerRun);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const next = due[cursor++]; if (!next || this.stopController.signal.aborted) return;
        const [hash, state] = next;
        try {
          const known = await this.store.get(hash);
          const id = known ?? await findPictureCopy(hash, { ...this.options, signal: this.stopController.signal });
          if (id && !this.stopController.signal.aborted) {
            this.ids.set(hash, known ?? await this.store.put(hash, id)); this.pending.delete(hash); continue;
          }
        } catch { /* Store/network outages retry; neither affects listing or following health. */ }
        state.attempts = Math.min(state.attempts + 1, 7);
        state.after = now() + Math.min(3_600_000, 60_000 * 2 ** (state.attempts - 1));
      }
    };
    await Promise.all([worker(), worker()]);
  }
  async stop(): Promise<void> {
    this.stopController.abort(); clearTimeout(this.timer); await this.running; await Promise.all(this.hints); await this.store.close();
  }
}

export function createPictureCopies(config: Pick<CoreServiceConfig, 'history' | 'pg'>): PictureCopiesService {
  return new PictureCopiesService(config.history === 'postgres' ? new PgPictureCopies(config.pg) : new MemoryPictureCopies());
}
