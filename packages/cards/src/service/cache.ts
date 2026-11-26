/**
 * The card service's caches: a bounded map in memory (least recently used out first, each entry with its own expiry),
 * for the boxes' facts and the drawn cards, and a folder on disk for finished cards, so a restart or a new release does
 * not draw every card again. A card's file name is its box and version (`<chain>-<token>-<version>.png`), checked
 * against a fixed pattern before any file is touched.
 */
import { mkdirSync } from 'node:fs';
import { readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface Entry<V> {
  readonly value: V;
  readonly until: number;
  readonly size: number;
}

/** A map with a cap on entries and on total size; reading an entry makes it the newest. */
export class Lru<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private bytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number = Number.POSITIVE_INFINITY,
    private readonly sizeOf: (value: V) => number = () => 0,
  ) {}

  get(key: string, now: number): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    if (entry.until <= now) {
      this.bytes -= entry.size;
      return undefined;
    }
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Keeps `value` until `until` (ms; Infinity: until pushed out). A value larger than the whole cap is not kept. */
  set(key: string, value: V, until: number): void {
    const size = this.sizeOf(value);
    this.delete(key);
    if (size > this.maxBytes) return;
    this.entries.set(key, { value, until, size });
    this.bytes += size;
    for (const [oldest, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.bytes -= entry.size;
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.bytes -= entry.size;
  }

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    return this.bytes;
  }
}

/** A card's file name: chain id, lowercase token and version, nothing else. */
export const CARD_FILE = /^[0-9]{1,9}-0x[0-9a-f]{40}-[0-9a-z][0-9a-z-]{0,63}\.png$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (bytes: Uint8Array): boolean => PNG_SIGNATURE.every((b, i) => bytes[i] === b);

/** Finished cards on disk (the service's own volume): written once, read back, the oldest removed past `maxFiles`. */
export class DiskCards {
  private writes = 0;

  constructor(
    private readonly dir: string,
    private readonly maxFiles: number = 4000,
    private readonly onError: (what: string, error: unknown) => void = () => undefined,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  async get(name: string): Promise<Uint8Array | null> {
    if (!CARD_FILE.test(name)) return null;
    try {
      const bytes = new Uint8Array(await readFile(join(this.dir, name)));
      return isPng(bytes) ? bytes : null;
    } catch {
      return null;
    }
  }

  /** Writes a card (a temporary file renamed into place, so a reader never sees half of one). Never throws. */
  async put(name: string, png: Uint8Array): Promise<void> {
    if (!CARD_FILE.test(name) || !isPng(png)) return;
    const temporary = join(this.dir, `.${name}.${process.pid}.${this.writes}.tmp`);
    try {
      await writeFile(temporary, png);
      await rename(temporary, join(this.dir, name));
    } catch (error) {
      this.onError('write', error);
      await unlink(temporary).catch(() => undefined);
      return;
    }
    this.writes += 1;
    if (this.writes % 100 === 0) await this.prune();
  }

  /** Removes the oldest cards beyond `maxFiles` (and leftover temporary files). Never throws. */
  async prune(): Promise<number> {
    try {
      const names = await readdir(this.dir);
      for (const name of names.filter((n) => n.endsWith('.tmp'))) await unlink(join(this.dir, name)).catch(() => undefined);
      const cards = names.filter((n) => CARD_FILE.test(n));
      if (cards.length <= this.maxFiles) return 0;
      const dated = await Promise.all(cards.map(async (name) => ({ name, at: (await stat(join(this.dir, name)).catch(() => null))?.mtimeMs ?? 0 })));
      dated.sort((a, b) => a.at - b.at);
      const gone = dated.slice(0, cards.length - this.maxFiles);
      for (const { name } of gone) await unlink(join(this.dir, name)).catch(() => undefined);
      return gone.length;
    } catch (error) {
      this.onError('prune', error);
      return 0;
    }
  }
}
