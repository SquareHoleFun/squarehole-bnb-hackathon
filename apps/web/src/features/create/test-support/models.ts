/**
 * R74-ART test models: small binary glTF 2.0 files (GLB) built byte by byte, as the site's model viewer and Create's
 * reader take them (artwork `glbSha256`: a 12-byte header, a JSON chunk first, no outside files), and the ways one is
 * refused. TEST DATA ONLY: no geometry, never a kit's model. No imports, so the browser suite (e2e) can build them too.
 */

const MAGIC = 0x46546c67; // "glTF", little-endian
const JSON_CHUNK = 0x4e4f534a; // "JSON", little-endian
const BIN_CHUNK = 0x004e4942; // "BIN\0", little-endian

export interface GlbOptions {
  /** Makes another model for the same id (other bytes, another sha256). */
  readonly variant?: string;
  /** References an outside buffer (`model.bin`): not self-contained, refused. */
  readonly external?: boolean;
  /** Pads the JSON chunk with this many spaces (an oversized model: more than 1 MiB). */
  readonly pad?: number;
  /** Adds a small binary chunk after the JSON (as an exported model has), with a buffer of its size. */
  readonly bin?: number;
}

/** A valid, distinct GLB for item `id` (glTF 2.0, its id in `extras`), or one refused for `external` / `pad`. */
export function glbOf(id: number, { variant = '', external = false, pad = 0, bin = 0 }: GlbOptions = {}): Uint8Array {
  const buffers = external ? [{ uri: 'model.bin', byteLength: 4 }] : bin > 0 ? [{ byteLength: bin }] : [];
  const json = JSON.stringify({ asset: { version: '2.0', generator: 'Square Hole test model' }, extras: { item: id, variant }, ...(buffers.length > 0 ? { buffers } : {}) });
  const text = new TextEncoder().encode(json);
  const jsonLength = Math.ceil((text.length + pad) / 4) * 4;
  const binLength = Math.ceil(bin / 4) * 4;
  const total = 12 + 8 + jsonLength + (bin > 0 ? 8 + binLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, JSON_CHUNK, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(text, 20);
  if (bin > 0) {
    const at = 20 + jsonLength;
    view.setUint32(at, binLength, true);
    view.setUint32(at + 4, BIN_CHUNK, true);
    for (let i = 0; i < bin; i += 1) out[at + 8 + i] = (id * 31 + i) & 0xff;
  }
  return out;
}

/** Bytes that are no GLB at all (a picture's signature, say): refused as not a model. */
export const NOT_A_GLB: Uint8Array = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(24).fill(0)]);

/** A GLB whose header declares another length than the file's: refused (a truncated or padded copy). */
export function truncatedGlb(id: number): Uint8Array {
  return glbOf(id).subarray(0, 24);
}
