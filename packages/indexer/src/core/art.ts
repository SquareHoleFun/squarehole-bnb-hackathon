/**
 * Committed pictures by their sha256, for the item route (core-gateway.ts `/items/<id>/art/<role>`). A spec commits each
 * picture by sha256 only; each is pinned as ONE raw IPFS block, so its CIDv1 (raw codec 0x55, sha2-256 multihash) is
 * built from that sha256 alone. `loadArt` asks `<gateway>/ipfs/<cid>` of each configured gateway in turn, checks the
 * bytes' sha256, and keeps them for good (a folder of files named by their sha256, written once, never deleted); a
 * picture already stored is not fetched again. Bytes that do not hash to the commitment are a gateway's answer,
 * refused every time: only verified bytes leave this module. Read-only HTTP GETs; no key.
 *
 * Pictures never decide whether a box is listed (SH-NO-PICTURE-GATE, founder 2026-10-24): the indexer lists every box
 * that passes the code checks, and the site shows a plain placeholder until a picture's bytes verify. The listing
 * check that lived here (BC-082's listing part, its wait list and retries) is gone.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hex } from 'viem';

import { rawCid } from './core-math';
export { rawCid } from './core-math';
const MAX_BYTES = 1_048_576;

const sha256Of = (bytes: Uint8Array): Hex => `0x${createHash('sha256').update(bytes).digest('hex')}`;

/** Where checked pictures are kept for good, by sha256. */
export interface ArtStore {
  get(sha256: Hex): Promise<Uint8Array | null>;
  put(sha256: Hex, bytes: Uint8Array): Promise<void>;
}

export class MemoryArtStore implements ArtStore {
  private readonly files = new Map<string, Uint8Array>();
  async get(sha256: Hex): Promise<Uint8Array | null> {
    return this.files.get(sha256.toLowerCase()) ?? null;
  }
  async put(sha256: Hex, bytes: Uint8Array): Promise<void> {
    this.files.set(sha256.toLowerCase(), bytes);
  }
}

/** A folder of files named by their sha256 (no 0x): written once, re-checked on read, never deleted. */
export class DirArtStore implements ArtStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  private path(sha256: Hex): string {
    return join(this.dir, sha256.toLowerCase().slice(2));
  }
  async get(sha256: Hex): Promise<Uint8Array | null> {
    try {
      const bytes = new Uint8Array(readFileSync(this.path(sha256)));
      return sha256Of(bytes) === sha256.toLowerCase() ? bytes : null;
    } catch {
      return null;
    }
  }
  async put(sha256: Hex, bytes: Uint8Array): Promise<void> {
    try {
      writeFileSync(this.path(sha256), bytes, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

export interface ArtLoadOptions {
  /** Gateway origins answering `/ipfs/<cid>`, tried in order. */
  readonly gateways: readonly string[];
  readonly store: ArtStore;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Bounded body read; cancellation also covers a gateway that sends headers and then stalls. */
async function bodyOf(response: Response, signal: AbortSignal): Promise<Uint8Array | null> {
  if (Number(response.headers.get('content-length') ?? '0') > MAX_BYTES) {
    void response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { cancel(); return null; }
      chunks.push(value);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

/**
 * Only verified bytes leave this function; the store is checked too. Gateways are tried in configuration order; null
 * when none answers with bytes that hash to `sha256`.
 */
export async function loadArt(sha256: Hex, options: ArtLoadOptions, signal?: AbortSignal): Promise<Uint8Array | null> {
  signal?.throwIfAborted();
  const cid = rawCid(sha256);
  const stored = await options.store.get(sha256);
  signal?.throwIfAborted();
  if (stored && stored.length <= MAX_BYTES && sha256Of(stored) === sha256.toLowerCase()) return stored;
  for (const gateway of options.gateways) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const expired = new Promise<null>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(null), { once: true });
        timer = setTimeout(abort, Math.min(options.timeoutMs ?? 3000, 3000));
      });
      const work = async () => {
        const response = await (options.fetch ?? fetch)(`${gateway.replace(/\/+$/, '')}/ipfs/${cid}`, { signal: controller.signal, redirect: 'error' });
        if (!response.ok) { void response.body?.cancel(); return null; }
        const bytes = await bodyOf(response, controller.signal);
        return bytes && sha256Of(bytes) === sha256.toLowerCase() ? bytes : null;
      };
      const bytes = await Promise.race([work().catch(() => null), expired]);
      signal?.throwIfAborted();
      if (bytes && !controller.signal.aborted) {
        await options.store.put(sha256, bytes);
        signal?.throwIfAborted();
        return bytes;
      }
    } finally { clearTimeout(timer); abort(); signal?.removeEventListener('abort', abort); }
  }
  signal?.throwIfAborted();
  return null;
}
