/** Serialized public response data, separate from the live asOf envelope. One cache per gateway process. */
import { createHash } from 'node:crypto';
import { toJson } from '../model';

export const RESPONSE_CACHE_LIMITS = Object.freeze({ entries: 2_000, bodyBytes: 64 * 1024 * 1024 });
type Version = bigint | string;
export interface CachedResponseData {
  readonly version: Version;
  readonly body: Buffer;
  readonly etag: string;
}

/** Also used for legacy sources that cannot provide a reliable cache version. */
export function serializeResponseData(data: object, version: Version): CachedResponseData {
  const body = Buffer.from(toJson(data));
  return { version, body, etag: `W/"${createHash('sha256').update(body).digest('hex')}"` };
}

export class ResponseCache {
  private readonly entries = new Map<string, CachedResponseData>();
  /** Builds are shared even if retained bodies have to be evicted while the read is pending. */
  private readonly pending = new Map<string, Promise<CachedResponseData | null>>();
  private space: { promise: Promise<void>; release: () => void } | undefined;
  private bytes = 0;

  constructor(private readonly version: () => Version, private readonly limits: { readonly entries: number; readonly bodyBytes: number } = RESPONSE_CACHE_LIMITS) {}
  get size(): number { return this.entries.size + this.pending.size; }
  get bodyBytes(): number { return this.bytes; }
  isCurrent(value: CachedResponseData, version = this.version): boolean { return value.version === version(); }

  async read(key: string, build: () => Promise<object | null>, currentVersion = this.version): Promise<CachedResponseData | null> {
    for (;;) {
      const version = currentVersion(); // Capture before starting any store read.
      const held = this.entries.get(key);
      if (held) {
        this.remove(key);
        if (held.version === version) { this.entries.set(key, held); this.bytes += held.body.length; return held; }
      }
      const buildKey = JSON.stringify([key, typeof version, version.toString()]);
      let work = this.pending.get(buildKey);
      if (!work) {
        while (this.size >= this.limits.entries && this.entries.size > 0) this.evictOldest();
        if (this.size >= this.limits.entries) {
          // Every slot is building. Wait without allocating another cache entry or starting another store read.
          if (!this.space) {
            let release!: () => void;
            const promise = new Promise<void>(resolve => { release = resolve; });
            this.space = { promise, release };
          }
          await this.space.promise;
          continue;
        }
        work = Promise.resolve().then(async () => {
          try {
            const data = await build();
            if (data === null || version !== currentVersion()) return null;
            const value = serializeResponseData(data, version);
            const { body } = value;
            this.pending.delete(buildKey); // Transfer this slot from a pending read to its serialized body.
            if (body.length <= this.limits.bodyBytes) {
              this.remove(key);
              this.entries.set(key, value); this.bytes += body.length;
              while (this.size > this.limits.entries || this.bytes > this.limits.bodyBytes) this.evictOldest();
            }
            return value;
          } finally {
            this.pending.delete(buildKey);
            const space = this.space; this.space = undefined; space?.release();
          }
        });
        this.pending.set(buildKey, work);
      }
      const value = await work;
      if (version === currentVersion()) return value;
      // A write committed while reading: join/rebuild at its version. Never serve the old answer after it.
    }
  }

  private evictOldest(): void {
    const key = this.entries.keys().next().value;
    if (key !== undefined) this.remove(key);
  }

  private remove(key: string): void {
    const held = this.entries.get(key);
    if (held) { this.bytes -= held.body.length; this.entries.delete(key); }
  }
}

/** GET validators use weak comparison; each member of a list may be strong or weak. */
export function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value) return false;
  // A quoted opaque tag can itself contain a comma. Match whole tokens, not comma-split fragments.
  return (value.match(/(?:W\/)?"[^"\r\n]*"|\*/g) ?? []).some(tag => tag === '*' || tag.replace(/^W\//, '') === etag.replace(/^W\//, ''));
}
