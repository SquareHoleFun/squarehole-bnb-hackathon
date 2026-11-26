/**
 * The render-hash file `squarehole.misfits-render-hashes/1` that the batch render tool (readiness plan step 5) writes
 * and the exporter reads (docs/design/box0-commitment-export.md): JSON Lines, so a resumable tool can append.
 *
 *   line 1: { format, generatorTree, platform, encoding: { image: { format, size, quality }, avatar: {...} | null,
 *             model: { format: "glb" } } }
 *   then one line per id: { id, attributes, image: { sha256, bytes }, avatar: { sha256, bytes } | null,
 *             model: { sha256, bytes } }
 *
 * The expected encoding is a parameter (`EncodingExpectation`); its default is the founder's MF-9 and MF-10 defaults.
 * Each file must fit one raw IPFS block (MAX_RAW_BLOCK_BYTES), or its raw CID does not resolve. Hashes are sha256 as
 * 64 hex digits, with or without 0x; they come back as 0x lower case. Errors name ids, never a hash, an id that is not
 * a whole number, or a format that is not a plain name (any of those may be a misplaced trait value).
 */
import type { Hex32 } from '../hash';
import { MAX_RAW_BLOCK_BYTES } from '../misfits-commitment';

export const RENDER_HASHES_FORMAT = 'squarehole.misfits-render-hashes/1';

export interface FileEncoding {
  readonly format: string;
  /** Square edge in pixels. */
  readonly size: number;
  /** Encoder quality (WebP 0-100); unchecked when the expectation leaves it out (a lossless format has none). */
  readonly quality?: number;
}

export interface EncodingExpectation {
  readonly image: FileEncoding;
  /** null: no avatar in the leaves (bytes32(0)), the answer "no" to MF-10. */
  readonly avatar: FileEncoding | null;
  readonly model: { readonly format: string };
}

/** MF-9 (512 px) and MF-10 (WebP q90 picture plus a 256 px WebP avatar, hashed in every leaf); the model is a GLB. */
export const MF_DEFAULT_ENCODING: EncodingExpectation = {
  image: { format: 'webp', size: 512, quality: 90 },
  avatar: { format: 'webp', size: 256 },
  model: { format: 'glb' },
};

export interface FileHash {
  readonly sha256: Hex32;
  readonly bytes: number;
}

export interface RenderHeader {
  readonly format: string;
  readonly generatorTree: string;
  readonly platform: string;
  readonly encoding: EncodingExpectation;
}

export interface RenderRecord {
  readonly id: number;
  readonly attributes: unknown;
  readonly image: FileHash;
  readonly avatar: FileHash | null;
  readonly model: FileHash;
}

export interface RenderHashes {
  readonly header: RenderHeader;
  /** Index id − 1. */
  readonly records: readonly RenderRecord[];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function fileEncoding(value: unknown, what: string): FileEncoding {
  if (!isObject(value) || typeof value.format !== 'string' || !Number.isInteger(value.size)) {
    throw new Error(`the header's ${what} encoding needs a format and a whole-number size`);
  }
  if (value.quality !== undefined && !Number.isInteger(value.quality)) throw new Error(`the header's ${what} quality must be a whole number`);
  return { format: value.format, size: value.size as number, ...(value.quality === undefined ? {} : { quality: value.quality as number }) };
}

/** A format name short and plain enough to quote (webp, png, glb); anything else is not repeated in an error. */
const plainName = (text: string): boolean => /^[a-z0-9][a-z0-9+.-]{0,15}$/.test(text);

function formatError(what: string, got: string, want: string, question: string): Error {
  return new Error(plainName(got) ? `the ${what} format is ${got}; expected ${want}${question}` : `the ${what} format is not ${want}${question}`);
}

function checkEncoding(what: 'image' | 'avatar', got: FileEncoding, want: FileEncoding): void {
  const question = what === 'image' ? 'MF-9' : 'MF-10';
  if (got.format !== want.format) throw formatError(what, got.format, want.format, ' (MF-10)');
  if (got.size !== want.size) throw new Error(`the ${what} size is ${got.size}; expected ${want.size} (${question})`);
  if (want.quality === undefined || got.quality === want.quality) return;
  if (got.quality === undefined) {
    throw new Error(`the ${what} header has no quality; expected ${want.quality} (MF-10; --${what}-quality any leaves it unchecked)`);
  }
  throw new Error(`the ${what} quality is ${got.quality}; expected ${want.quality} (MF-10)`);
}

function parseHeader(line: unknown, expected: EncodingExpectation): RenderHeader {
  if (!isObject(line) || line.format !== RENDER_HASHES_FORMAT) throw new Error(`not a ${RENDER_HASHES_FORMAT} file`);
  if (typeof line.generatorTree !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(line.generatorTree)) {
    throw new Error('the header generatorTree must be a git tree id (40 or 64 lower-case hex digits)');
  }
  if (typeof line.platform !== 'string' || line.platform.length === 0) {
    throw new Error('the header platform must name the machine the files were rendered on (e.g. darwin-arm64)');
  }
  const encoding = line.encoding;
  if (!isObject(encoding) || !isObject(encoding.model) || typeof encoding.model.format !== 'string') {
    throw new Error('the header needs an encoding with image, avatar and model');
  }
  const image = fileEncoding(encoding.image, 'image');
  checkEncoding('image', image, expected.image);
  const avatar = encoding.avatar === null || encoding.avatar === undefined ? null : fileEncoding(encoding.avatar, 'avatar');
  if (expected.avatar && !avatar) throw new Error('the renders have no avatar; expected one in every leaf (MF-10)');
  if (!expected.avatar && avatar) throw new Error('the renders have an avatar; the expected encoding has none (MF-10)');
  if (expected.avatar && avatar) checkEncoding('avatar', avatar, expected.avatar);
  if (encoding.model.format !== expected.model.format) throw formatError('model', encoding.model.format, expected.model.format, '');
  return { format: RENDER_HASHES_FORMAT, generatorTree: line.generatorTree, platform: line.platform, encoding: { image, avatar, model: { format: encoding.model.format } } };
}

function fileHash(value: unknown, id: number, what: string): FileHash {
  const sha = isObject(value) ? value.sha256 : undefined;
  if (typeof sha !== 'string' || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(sha)) throw new Error(`id ${id}: the ${what} sha256 must be 64 hex digits`);
  const bytes = (value as Json).bytes;
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 1) throw new Error(`id ${id}: the ${what} size must be a whole number of bytes from 1`);
  if (bytes > MAX_RAW_BLOCK_BYTES) throw new Error(`id ${id}: the ${what} is ${bytes} bytes; one raw IPFS block holds at most ${MAX_RAW_BLOCK_BYTES}`);
  return { sha256: `0x${sha.replace(/^0x/, '').toLowerCase()}`, bytes };
}

function parseRecord(line: unknown, k: number, n: number, withAvatar: boolean): RenderRecord {
  if (!isObject(line)) throw new Error(`line ${k} is not a render record`);
  const id = line.id;
  if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error(`line ${k}: the id is not a whole number in 1..${n}`);
  if (id < 1 || id > n) throw new Error(`line ${k}: id ${id} is outside 1..${n}`);
  if (!Array.isArray(line.attributes)) throw new Error(`id ${id}: attributes must be a list`);
  const hasAvatar = line.avatar !== undefined && line.avatar !== null;
  if (!withAvatar && hasAvatar) throw new Error(`id ${id}: an avatar where the encoding has none`);
  return {
    id,
    attributes: line.attributes,
    image: fileHash(line.image, id, 'image'),
    avatar: withAvatar ? fileHash(line.avatar, id, 'avatar') : null,
    model: fileHash(line.model, id, 'model'),
  };
}

export function parseRenderHashes(text: string, n: number, expected: EncodingExpectation = MF_DEFAULT_ENCODING): RenderHashes {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const parsed = lines.flatMap((l, i) => {
    if (l.trim() === '') return [];
    try {
      return [{ k: i + 1, value: JSON.parse(l) as unknown }];
    } catch {
      throw new Error(`line ${i + 1} is not JSON`);
    }
  });
  const first = parsed[0];
  if (!first) throw new Error('the render-hash file is empty');
  const header = parseHeader(first.value, expected);
  const records: (RenderRecord | undefined)[] = Array.from({ length: n });
  for (const { k, value } of parsed.slice(1)) {
    const r = parseRecord(value, k, n, header.encoding.avatar !== null);
    if (records[r.id - 1]) throw new Error(`id ${r.id} has two render records`);
    records[r.id - 1] = r;
  }
  const missing = records.findIndex((r) => r === undefined);
  if (missing >= 0) throw new Error(`no render record for id ${missing + 1}`);
  return { header, records: records as RenderRecord[] };
}
